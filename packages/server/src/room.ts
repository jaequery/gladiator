/**
 * The host. One world, the peers connected to it, and nothing else.
 *
 * This is the module the whole listen-server pattern turns on: it is the
 * authoritative side of a duel, and it runs unchanged on Fly behind a WebSocket
 * and inside a browser tab behind a loopback. There is one host, not a server
 * and an offline mode that resemble each other.
 *
 * ## Isomorphic, and mechanically so
 *
 * No `node:` import, no `process`, no `Buffer`, no `ws`, no `setInterval`, no
 * `Date.now()`. Everything from outside arrives as a constructor argument: the
 * map, the {@link Clock}, the peer-id generator, and every peer as a
 * `Transport`. `room.isomorphic.test.ts` reads this file and the modules it
 * imports and fails if any of those names appears, because a constraint that is
 * only a paragraph is a constraint that lasts until the first hurry.
 *
 * The two things it deliberately does not do are the two things that would
 * break that:
 *
 * - **It never calls `setInterval`.** A beat is something the host is given
 *   (`loop.ts`), which is what lets a test drive thousands of ticks in
 *   microseconds instead of waiting a minute for a timer.
 * - **It never constructs a server.** It takes transports. `net/wsTransport.ts`
 *   is the thin `ws` adapter on the Node side and `net/loopbackTransport.ts` is
 *   the in-process one, and this module cannot tell them apart.
 *
 * ## The world advances by commands, not by wall-clock
 *
 * The clock is here for the room's *life* — a peer that has stopped talking —
 * and never reaches `tick()`. That is not squeamishness: it is the property
 * that makes one recorded input stream produce the same final state hash
 * in-process and over a real socket, which is what `net/parity.test.ts`
 * asserts. The moment wall-clock decided how many ticks a batch was worth, the
 * two paths would agree only by luck.
 *
 * The tick scheduler that will eventually drive a room at a steady 125 Hz is
 * GLAD-FHKBN8, and the input-buffer policy in front of it is GLAD-5995PA. Both
 * hang off this shape rather than replacing it.
 *
 * ## One peer, for now
 *
 * {@link RoomOptions.capacity} defaults to one, and a second peer is refused
 * rather than quietly given a slot. With one peer, "a batch advances the world
 * by its own commands" is unambiguous; with two it is not — whose command does
 * a shared tick carry when only one of them has sent anything? — and answering
 * that question *is* GLAD-5995PA. A room that silently seated two players and
 * guessed would be a room that desyncs under load and looks fine in a test.
 */
import {
  CloseReason,
  DUEL_SLOTS,
  NO_SLOT,
  SKELETON_SEED,
  TransportState,
  createMapState,
  hashState,
  type GameState,
  type LoadedMap,
  type ServerMessage,
  type SpawnPlan,
  type Transport,
  type TransportMessage,
} from '@gladiator/sim'

import type { Clock } from './clock.ts'
import {
  CLOSE_BAD_FRAME,
  CLOSE_ROOM_FULL,
  applyFrame,
  createSession,
  type ServerIdentity,
  type SessionSim,
  type SessionState,
} from './session.ts'

/** How long a peer may say nothing before the room lets go of it. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000

export type RoomOptions = {
  /** The world this room is authoritative over, already loaded and verified. */
  readonly map: LoadedMap
  /** Wall-clock, injected. See `clock.ts` for why it is not read here. */
  readonly clock: Clock
  /** Which commit. Sent in the welcome so a stale client can be told so. */
  readonly build: string
  /** Names this room in logs. The room registry that will mint these is GLAD-FHKBN8. */
  readonly id?: string
  readonly seed?: number
  /** How many peers may be seated. See the note in the header. */
  readonly capacity?: number
  readonly idleTimeoutMs?: number
  /**
   * Peer ids, injected.
   *
   * `randomUUID` lives in `node:crypto` and `crypto.randomUUID` needs a secure
   * context, so neither is something a module that has to run in both places
   * may reach for. The Node server passes the real one; a test passes a counter.
   */
  readonly peerId?: (index: number) => string
  readonly log?: (line: string) => void
}

export type RoomPeer = {
  readonly id: string
  /** The player slot this peer steers, or {@link NO_SLOT} if it was refused. */
  readonly slot: number
  /** The peer's live session state, for diagnostics and tests. */
  readonly session: SessionState
  /** The last time anything was heard from it, on the room's clock. */
  readonly lastHeardMs: number
  readonly open: boolean
  close(code?: number, reason?: string): void
}

export type RoomSnapshot = {
  readonly id: string
  readonly tick: number
  readonly hash: number
  readonly peers: number
  readonly capacity: number
  readonly commands: number
  readonly gaps: number
}

export type Room = {
  readonly id: string
  readonly identity: ServerIdentity
  /** The one world. Advanced in place by `tick()`; never replaced. */
  readonly state: GameState
  readonly tick: number
  readonly peers: readonly RoomPeer[]
  readonly capacity: number
  /**
   * Seat a peer.
   *
   * Takes the transport already open — a loopback always is, and a `ws` socket
   * is by the time `connection` fires — and installs its own handlers on it.
   * A room with no seat left replies with a fault and closes, rather than
   * dropping the connection with no explanation.
   */
  join(transport: Transport): RoomPeer
  /** Wall-clock housekeeping. Never advances the simulation. */
  sweep(nowMs: number): void
  hash(): number
  snapshot(): RoomSnapshot
  close(code?: number, reason?: string): void
}

type PeerRecord = {
  readonly id: string
  readonly slot: number
  readonly transport: Transport
  session: SessionState
  lastHeardMs: number
  open: boolean
}

/** One reply, framed. JSON text today; the binary protocol is GLAD-OOELC5. */
function frameOf(message: ServerMessage): string {
  return JSON.stringify(message)
}

export function createRoom(options: RoomOptions): Room {
  const capacity = options.capacity ?? 1
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const log = options.log ?? (() => undefined)
  const clock = options.clock
  const id = options.id ?? 'room'

  const identity: ServerIdentity = { build: options.build, mapHash: options.map.hash }

  // One world, created once. Which peers exist and when they arrive does not
  // change it — `createMapState` stands a player in slot 0 and the rest of the
  // round rules are `match/round.ts`'s business, driven by `startMatch` when
  // there is somebody to start a match for.
  const state: GameState = createMapState(options.map.source, options.seed ?? SKELETON_SEED)

  // No spawn plan while nothing has started a match. A world with no match in
  // it is a match in warmup, which is exactly what the walking skeleton and
  // every physics test have always been. `sim/src/match/match.ts`.
  const plan: SpawnPlan | null = null
  const sim: SessionSim = { state, world: options.map.world, plan }

  const peers: PeerRecord[] = []
  let joined = 0

  const freeSlot = (): number => {
    for (const slot of DUEL_SLOTS) {
      if (!peers.some((peer) => peer.slot === slot)) return slot
    }
    return NO_SLOT
  }

  const viewOf = (record: PeerRecord): RoomPeer => ({
    id: record.id,
    slot: record.slot,
    get session() {
      return record.session
    },
    get lastHeardMs() {
      return record.lastHeardMs
    },
    get open() {
      return record.open
    },
    close(code = CloseReason.Normal, reason = '') {
      record.transport.close(code, reason)
    },
  })

  const forget = (record: PeerRecord): void => {
    record.open = false
    const at = peers.indexOf(record)
    if (at >= 0) peers.splice(at, 1)
  }

  const send = (record: PeerRecord, message: ServerMessage): void => {
    record.transport.send(frameOf(message))
  }

  const receive = (record: PeerRecord, message: TransportMessage): void => {
    record.lastHeardMs = clock.nowMs()

    if (typeof message !== 'string') {
      // The protocol is JSON text. A binary frame is either a client speaking
      // something else or a client speaking the *next* protocol, and guessing
      // which is worse than saying so.
      send(record, { t: 'fault', code: 'binary', detail: 'this protocol is JSON text' })
      record.transport.close(CLOSE_BAD_FRAME, 'binary frame')
      return
    }

    const step = applyFrame(record.session, message, identity)
    record.session = step.session
    for (const reply of step.replies) send(record, reply)
    if (step.close !== undefined) record.transport.close(step.close.code, step.close.reason)
  }

  return {
    id,
    identity,
    state,

    get tick() {
      return state.tick
    },

    get peers() {
      return peers.map(viewOf)
    },

    capacity,

    join(transport: Transport): RoomPeer {
      const slot = peers.length >= capacity ? NO_SLOT : freeSlot()
      joined += 1
      const peerId = options.peerId?.(joined) ?? `${id}-${joined}`

      if (slot === NO_SLOT) {
        log(`room ${id}: refused ${peerId}, ${peers.length}/${capacity} seats taken`)
        transport.send(
          frameOf({
            t: 'fault',
            code: 'room-full',
            detail: `this room seats ${capacity}`,
          }),
        )
        transport.close(CLOSE_ROOM_FULL, 'room full')
        return {
          id: peerId,
          slot: NO_SLOT,
          session: createSession(peerId, sim, NO_SLOT),
          lastHeardMs: clock.nowMs(),
          open: false,
          close: (code = CloseReason.Normal, reason = '') => transport.close(code, reason),
        }
      }

      const record: PeerRecord = {
        id: peerId,
        slot,
        transport,
        session: createSession(peerId, sim, slot),
        lastHeardMs: clock.nowMs(),
        open: true,
      }
      peers.push(record)

      transport.setHandlers({
        onOpen: () => {
          record.lastHeardMs = clock.nowMs()
        },
        onMessage: (message) => receive(record, message),
        onClose: () => forget(record),
        onError: (error) => {
          log(`room ${id}: ${peerId} errored: ${error.message}`)
        },
      })

      return viewOf(record)
    },

    sweep(nowMs: number) {
      // Iterated over a copy: closing a peer runs its `onClose` and takes it
      // out of the list, and a loop that spliced the array it was walking would
      // skip the peer after every one it closed.
      for (const record of [...peers]) {
        if (record.transport.readyState === TransportState.Closed) {
          forget(record)
          continue
        }
        if (nowMs - record.lastHeardMs < idleTimeoutMs) continue
        log(`room ${id}: ${record.id} went quiet for ${idleTimeoutMs} ms`)
        record.transport.close(CloseReason.Abnormal, 'idle')
        forget(record)
      }
    },

    hash: () => hashState(state),

    snapshot: () => ({
      id,
      tick: state.tick,
      hash: hashState(state),
      peers: peers.length,
      capacity,
      commands: peers.reduce((total, peer) => total + peer.session.commands, 0),
      gaps: peers.reduce((total, peer) => total + peer.session.gaps, 0),
    }),

    close(code = CloseReason.Normal, reason = '') {
      for (const record of [...peers]) {
        record.transport.close(code, reason)
        forget(record)
      }
    },
  }
}
