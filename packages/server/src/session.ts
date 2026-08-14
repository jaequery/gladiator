/**
 * One connected client's world, and the rules for advancing it.
 *
 * Written as a pure state machine — `(session, frame) -> { session, replies }`
 * — with no socket anywhere in sight, because the interesting failure modes
 * (a command batch with a gap in it, a client one deploy behind, a hostile
 * frame) are all much easier to test than to reproduce over a network.
 *
 * A session is one player in their own private world. Two players in one room
 * is GLAD-FHKBN8 and GLAD-DVDV6P; this ticket only has to prove that the
 * simulation is genuinely shared.
 */
import {
  PROTOCOL_VERSION,
  SKELETON_SEED,
  type ClientMessage,
  type GameState,
  type ServerMessage,
  createMapState,
  decodeCmd,
  hashState,
  parseClientMessage,
  tick as simTick,
} from '@gladiator/sim'

import { SERVER_MAP } from './map.ts'

/**
 * What the server tells a client about itself at the handshake.
 *
 * Two strings that both answer "are we the same deploy", from two angles.
 * `build` is which commit; `mapHash` is which world. Passed as one value
 * rather than two positional strings, because two adjacent strings of the same
 * type is a swap waiting to happen and the swap would not fail a typecheck.
 */
export type ServerIdentity = {
  readonly build: string
  /** `map/load.ts`: eight hex digits over the map's content. */
  readonly mapHash: string
}

export type SessionState = {
  readonly id: string
  /**
   * This session's world.
   *
   * `readonly` on the *reference* only: `tick()` advances a `GameState` in
   * place (see `AGENTS.md`), so the object a step returns is the same object it
   * was given, with new numbers in it. A caller that needs the state as it was
   * before calls `cloneGameState` itself.
   */
  readonly state: GameState
  /** The last tick this session has simulated. Always `state.tick`. */
  readonly tick: number
  readonly greeted: boolean
  /** Set once the client has proven it is not the deploy we are: wrong
   *  protocol, or a different map. */
  readonly rejected: boolean
  /** Command batches whose `startTick` did not follow on from `tick`. */
  readonly gaps: number
  readonly commands: number
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

export function createSession(id: string): SessionState {
  return {
    id,
    state: createMapState(SERVER_MAP.source, SKELETON_SEED),
    tick: 0,
    greeted: false,
    rejected: false,
    gaps: 0,
    commands: 0,
  }
}

/**
 * Apply one already-parsed frame.
 *
 * The reply to a command batch is a single hash, at the last tick applied —
 * not one per tick. At 125 Hz a hash per tick would be 125 frames a second in
 * the other direction to say "still fine", and the client is comparing against
 * its own history anyway, so one per batch finds a desync within a frame of it
 * happening at a fraction of the traffic.
 */
export function applyMessage(
  session: SessionState,
  message: ClientMessage,
  identity: ServerIdentity,
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

  // A batch that does not start where we left off means frames were lost or
  // reordered. Counted rather than corrected: reconciliation is GLAD-6RT64L,
  // and quietly renumbering here would hide exactly the desync this ticket
  // exists to expose.
  const gapped = message.startTick !== session.tick + 1

  // One command per sub-step, into slot 0 — the only slot a session has. Two
  // players sharing one world is GLAD-FHKBN8.
  const state = session.state
  for (const wire of message.cmds) {
    simTick(state, [decodeCmd(wire)], SERVER_MAP.world)
  }

  return {
    session: {
      ...session,
      state,
      tick: state.tick,
      gaps: session.gaps + (gapped ? 1 : 0),
      commands: session.commands + message.cmds.length,
    },
    replies: [{ t: 'hash', tick: state.tick, hash: hashState(state) }],
  }
}

/** Apply one raw frame from the wire. */
export function applyFrame(
  session: SessionState,
  raw: string,
  identity: ServerIdentity,
): SessionStep {
  const message: ClientMessage | null = parseClientMessage(raw)
  if (message === null) {
    return {
      session,
      replies: [{ t: 'fault', code: 'bad-frame', detail: 'could not parse that frame' }],
      close: { code: CLOSE_BAD_FRAME, reason: 'bad frame' },
    }
  }
  return applyMessage(session, message, identity)
}
