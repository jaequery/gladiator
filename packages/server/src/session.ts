/**
 * One connected peer: the handshake, and the door its commands come in through.
 *
 * Written as a pure state machine — `(session, frame, nowMs) -> { session,
 * replies }` — with no socket anywhere in sight, because the interesting
 * failure modes (a client one deploy behind, a batch with a gap in it, a
 * hostile frame) are all much easier to test than to reproduce over a network.
 *
 * ## What it does *not* do any more
 *
 * It does not tick the world. Until GLAD-FHKBN8 a command batch advanced the
 * simulation by exactly its own commands, the moment it landed, and the reply
 * was the hash and the snapshot of what that produced. That rule is what made a
 * room single-seat: with two peers, "the world advances by the batch it was
 * handed" has no answer — whose batch does a shared tick carry when only one of
 * them has sent anything?
 *
 * The answer is the one `inputQueue.ts` argues for. A batch is now *admitted*
 * to this peer's jitter buffer and nothing else happens; the world is advanced
 * by the tick scheduler (`scheduler.ts`), which drains one command from every
 * peer per sub-step, and the hash and the snapshot go out once per host frame
 * from `room.ts`. So this file's whole share of a command is the door policy:
 * has this peer said hello, does the batch follow on from the last one, and
 * what did the buffer make of each command in it.
 *
 * ## The clock arrives as an argument
 *
 * `nowMs` is passed in, as it is everywhere on the authoritative side, because
 * the rate limit in front of the buffer is measured in commands per wall-clock
 * second and this module must still run inside a browser tab.
 * `room.isomorphic.test.ts` fails the build on a `Date.now()` reachable from
 * `room.ts`.
 */
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  decodeCmd,
  parseClientMessage,
} from '@gladiator/sim'

import { CommandFate, createInputQueue, type InputQueue } from './inputQueue.ts'

/**
 * What the server tells a client about itself at the handshake.
 *
 * Three strings that answer "are we the same deploy, and which match is this",
 * from three angles. `build` is which commit; `mapHash` is which world; `room`
 * is which code this peer ended up in — the host's own answer, so a player who
 * created a match can be shown the code to send rather than having to invent
 * one. Passed as one value rather than three positional strings, because three
 * adjacent strings of the same type is a swap waiting to happen and the swap
 * would not fail a typecheck.
 */
export type ServerIdentity = {
  readonly build: string
  /** `map/load.ts`: eight hex digits over the map's content. */
  readonly mapHash: string
  /** The room code. `roomCode.ts`. */
  readonly room: string
}

export type SessionState = {
  readonly id: string
  /** Which player slot this peer's commands land in. */
  readonly slot: number
  /**
   * The seat token this peer must come back with, minted by `lifecycle.ts`.
   *
   * A property of the *seat* rather than of the server, which is why it is here
   * and not in {@link ServerIdentity}: two peers in one room are handed the same
   * build, the same map and the same room code, and two different tokens. Empty
   * for a peer that was never seated — it is on its way to a fault frame and a
   * close, and there is no seat to give it the key to.
   */
  readonly token: string
  /**
   * This peer's jitter buffer.
   *
   * A live object held by reference rather than a value carried through the
   * fold: it is a buffer, and the room drains it from the other side on every
   * sub-step. Everything else in this state is a value, and the split is the
   * honest one — the handshake is a state machine and the buffer is a queue.
   */
  readonly queue: InputQueue
  readonly greeted: boolean
  /** Set once the client has proven it is not the deploy we are: wrong
   *  protocol, or a different map. */
  readonly rejected: boolean
  /** Command batches whose `startTick` did not follow on from the last one. */
  readonly gaps: number
  /** Commands offered to the buffer, whatever became of them. */
  readonly commands: number
  /** Commands the buffer took. */
  readonly accepted: number
  /** Commands the buffer turned away: duplicate, late, overflowing or too fast. */
  readonly refused: number
  /** The highest tick label this peer has offered. Zero before the first. */
  readonly lastOfferedTick: number
}

export type SessionStep = {
  readonly session: SessionState
  readonly replies: readonly ServerMessage[]
  /** Set when the session must be closed after the replies are flushed. */
  readonly close?: { readonly code: number; readonly reason: string }
}

/** Close code for a protocol version the server does not speak. */
export const CLOSE_VERSION_MISMATCH = 4001

/** Close code for a frame the server could not parse. */
export const CLOSE_BAD_FRAME = 4002

/** Close code for a client that sent commands before saying hello. */
export const CLOSE_NO_HELLO = 4003

/** Close code for a client holding a different map than the server. */
export const CLOSE_MAP_MISMATCH = 4004

/** Close code for a peer arriving at a room that has no seat for it. */
export const CLOSE_ROOM_FULL = 4005

/**
 * Close code for a room code that names no room.
 *
 * Its own code rather than a reused 4005, because the two are different
 * sentences to a player — "that match is full" and "that match does not exist,
 * check the code" — and a client that had to guess between them would show the
 * wrong one.
 */
export const CLOSE_NO_SUCH_ROOM = 4006

/**
 * Close code for a match that is over and cannot be rejoined.
 *
 * A reconnect that arrives after the grace window has closed, or a token for a
 * seat that has been forfeited. Its own code because it is the one refusal a
 * client must **not** retry: the room may still exist for another minute, so a
 * policy that treated this like a dropped connection would back off and try
 * again for as long as the reaper let it (`client/net/reconnect.ts`).
 */
export const CLOSE_MATCH_ENDED = 4007

/**
 * Close code for a socket displaced by a newer one holding the same seat token.
 *
 * The old socket is told what happened rather than simply dropped, because from
 * its side those two look identical and only one of them means "you are now
 * playing in another tab".
 */
export const CLOSE_REPLACED = 4008

export function createSession(
  id: string,
  slot = 0,
  queue = createInputQueue(),
  token = '',
): SessionState {
  return {
    id,
    slot,
    token,
    queue,
    greeted: false,
    rejected: false,
    gaps: 0,
    commands: 0,
    accepted: 0,
    refused: 0,
    lastOfferedTick: 0,
  }
}

/**
 * Apply one already-parsed frame.
 *
 * A `cmds` batch is answered with **nothing**. The acknowledgement a client
 * needs — the hash, and the authoritative world behind it — is a statement
 * about the world at the tick the *scheduler* has reached, so it is sent once
 * per host frame by `room.ts` rather than once per batch by whoever happened to
 * send one. A batch that produced a reply of its own would be a second, faster
 * clock in the same conversation.
 */
export function applyMessage(
  session: SessionState,
  message: ClientMessage,
  identity: ServerIdentity,
  nowMs: number,
): SessionStep {
  if (message.t === 'hello') {
    if (message.protocol !== PROTOCOL_VERSION) {
      return {
        session: { ...session, rejected: true },
        replies: [
          {
            t: 'version_mismatch',
            serverProtocol: PROTOCOL_VERSION,
            clientProtocol: message.protocol,
            serverBuild: identity.build,
          },
        ],
        close: { code: CLOSE_VERSION_MISMATCH, reason: 'protocol version' },
      }
    }

    // The protocol check first, then the map: a client that cannot parse our
    // frames cannot read a map-mismatch frame either, and being told the wrong
    // thing is worse than being told nothing.
    //
    // Refusing rather than adopting the client's map is the whole point. The
    // server is authoritative, and a server that quietly played whichever
    // arena the client claimed would be a server that can be told where the
    // walls are.
    if (message.mapHash !== identity.mapHash) {
      return {
        session: { ...session, rejected: true },
        replies: [
          {
            t: 'map_mismatch',
            serverMapHash: identity.mapHash,
            clientMapHash: message.mapHash,
          },
        ],
        close: { code: CLOSE_MAP_MISMATCH, reason: 'map mismatch' },
      }
    }

    return {
      session: { ...session, greeted: true },
      replies: [
        {
          t: 'welcome',
          protocol: PROTOCOL_VERSION,
          build: identity.build,
          session: session.id,
          mapHash: identity.mapHash,
          room: identity.room,
          // The key to this seat, and the only thing that gets this player back
          // into *this side* of *this match* after their socket dies
          // (`lifecycle.ts`). Sent in the welcome rather than on demand because
          // the moment a client needs it is the moment it has no socket to ask
          // over.
          token: session.token,
          // Which player this peer is. The seat was decided by `lifecycle.ts`
          // before this frame was built, and this is the only place it is ever
          // told to the client — a snapshot carries both bodies and nothing in
          // it says which one is theirs (`sim/src/protocol.ts`).
          slot: session.slot,
        },
      ],
    }
  }

  if (!session.greeted) {
    return {
      session,
      replies: [{ t: 'fault', code: 'no-hello', detail: 'send a hello frame first' }],
      close: { code: CLOSE_NO_HELLO, reason: 'no hello' },
    }
  }

  // A pong is not this layer's business. Timing a round trip needs a clock, and
  // the clock belongs to the room (`clock.ts`), so `room.ts` takes pongs off
  // the wire before they reach here and hands them to that peer's
  // `clockSync.ts`. One arriving anyway — a caller driving `applyFrame`
  // directly — is dropped rather than treated as an error: it costs a
  // measurement, not a session.
  if (message.t === 'pong') return { session, replies: [] }

  // A batch that does not follow on from the last one means frames were lost or
  // reordered. Counted rather than corrected: the transport is TCP and does not
  // lose frames, so a gap means somebody is speaking a protocol this one is
  // not. What a *command* out of order costs is `inputQueue.ts`'s business and
  // is answered there — kept if its moment has not passed, dropped if it has.
  const gapped = message.startTick !== session.lastOfferedTick + 1

  let accepted = 0
  let refused = 0
  let lastOfferedTick = session.lastOfferedTick
  for (let index = 0; index < message.cmds.length; index += 1) {
    const wire = message.cmds[index]
    // The tick a command carries is the one the client predicted it into, and
    // the batch numbers from `startTick` upward. It admits the command and
    // orders the buffer; it does not schedule it. See `inputQueue.ts`.
    const tick = message.startTick + index
    const fate = session.queue.offer(tick, decodeCmd(wire), nowMs)
    if (fate === CommandFate.Queued) accepted += 1
    else refused += 1
    if (tick > lastOfferedTick) lastOfferedTick = tick
  }

  return {
    session: {
      ...session,
      gaps: session.gaps + (gapped ? 1 : 0),
      commands: session.commands + message.cmds.length,
      accepted: session.accepted + accepted,
      refused: session.refused + refused,
      lastOfferedTick,
    },
    replies: [],
  }
}

/**
 * The step for a frame that could not be parsed.
 *
 * Exported because `room.ts` parses frames itself — it has to, to take pongs
 * off the wire before they reach a layer with no clock — and two spellings of
 * "we could not read that" is two things a test can pin and one of them being
 * wrong.
 */
export function rejectBadFrame(session: SessionState): SessionStep {
  return {
    session,
    replies: [{ t: 'fault', code: 'bad-frame', detail: 'could not parse that frame' }],
    close: { code: CLOSE_BAD_FRAME, reason: 'bad frame' },
  }
}

/** Apply one raw frame from the wire. */
export function applyFrame(
  session: SessionState,
  raw: string,
  identity: ServerIdentity,
  nowMs: number,
): SessionStep {
  const message: ClientMessage | null = parseClientMessage(raw)
  if (message === null) return rejectBadFrame(session)
  return applyMessage(session, message, identity, nowMs)
}
