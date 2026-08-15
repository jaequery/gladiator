/**
 * The host. One world, the two peers duelling in it, and nothing else.
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
 * - **It never calls `setInterval`.** A beat is something the host is given —
 *   `scheduler.ts` on Fly, the animation frame in a tab — which is what lets a
 *   test drive thousands of ticks in microseconds instead of waiting a minute
 *   for a timer.
 * - **It never constructs a server.** It takes transports. `net/wsTransport.ts`
 *   is the thin `ws` adapter on the Node side and `net/loopbackTransport.ts` is
 *   the in-process one, and this module cannot tell them apart.
 *
 * ## The world advances on a schedule, and the schedule is not in here
 *
 * {@link Room.advance} takes a whole number of sub-steps and runs exactly that
 * many. It does not read a clock to decide how many, and there is no wall-clock
 * anywhere near `tick()`: the scheduler measures the elapsed time, folds it into
 * sub-steps (`scheduler.ts`), and hands the count to every room on the machine.
 *
 * That split is what makes a recorded input stream reproducible. A test can run
 * ten thousand sub-steps at a single instant of its manual clock and get the
 * same hashes a real server produces over a real minute, which is what
 * `net/parity.test.ts` asserts — and the moment a room decided for itself how
 * far to advance, the two would agree only by luck.
 *
 * ## Two seats, one command per seat per sub-step
 *
 * Each peer has a jitter buffer (`inputQueue.ts`) and every sub-step drains
 * exactly one command from each. That is the answer to the question a
 * single-seat room could dodge — whose command does a shared tick carry when
 * only one of them has sent anything — and the answer is *both*, with a
 * documented fallback for the one that is silent. A tick never stalls waiting
 * for a peer, because a stall on one peer's socket is a hitch in the other
 * peer's game.
 *
 * ## Nothing is read before it has been let in
 *
 * Every frame goes through `validate.ts` first — a size cap, a frame rate, a
 * byte rate and "the protocol is text" — and only what survives reaches
 * `JSON.parse`. That door is a *room's*, not the Node edge's, because the listen
 * server is a room behind a loopback and a limit that only existed on the socket
 * path would be a limit single-player never exercises. The socket has its own
 * copy of the size cap (`ws`'s `maxPayload`), which is the one that keeps an
 * oversized frame from ever being assembled.
 *
 * ## It does hold a stopwatch, and it is the only one
 *
 * The one wall-clock measurement a room makes about a peer is the round trip,
 * and it makes it itself: `clockSync.ts` mints a ping, the peer echoes the id
 * back, and the subtraction happens here against this room's clock. That
 * direction is not a style choice — lag compensation rewinds by this number
 * (GLAD-5QGO11), so a client that reported it could ask to be rewound further.
 * A pong is therefore taken off the wire in `receive` and never reaches
 * `session.ts`, which deliberately has no clock to measure with.
 */
import {
  CloseReason,
  DUEL_SLOTS,
  MatchPhase,
  NO_SLOT,
  SKELETON_SEED,
  TransportState,
  UNKNOWN_RTT,
  buildSpawnPlan,
  createMapState,
  hashState,
  parseClientMessage,
  snapshotFrame,
  startMatch,
  tick as simTick,
  type ClientMessage,
  type Demo,
  type DemoRecorder,
  type GameState,
  type LoadedMap,
  type MatchRules,
  type ServerMessage,
  type SpawnPlan,
  type Transport,
  type TransportMessage,
  type UserCmd,
} from '@gladiator/sim'

import type { Clock } from './clock.ts'
import { createClockSync, type ServerClockSync } from './clockSync.ts'
import { createInputQueue, type InputQueue } from './inputQueue.ts'
import { NO_LOG, scopeToRoom, type Log } from './log.ts'
import {
  CLOSE_ROOM_FULL,
  applyMessage,
  createSession,
  rejectBadFrame,
  type ServerIdentity,
  type SessionState,
} from './session.ts'
import { createFrameGuard, type FrameGuard, type FrameGuardOptions } from './validate.ts'

/** How long a peer may say nothing before the room lets go of it. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000

/**
 * Seats. Two, because the game is a duel.
 *
 * Derived from `DUEL_SLOTS` rather than written as `2`, so the one place that
 * decides how many players a world has is the one place the slots are named.
 */
export const DUEL_CAPACITY = DUEL_SLOTS.length

export type RoomOptions = {
  /** The world this room is authoritative over, already loaded and verified. */
  readonly map: LoadedMap
  /** Wall-clock, injected. See `clock.ts` for why it is not read here. */
  readonly clock: Clock
  /** Which commit. Sent in the welcome so a stale client can be told so. */
  readonly build: string
  /**
   * The room code, which is also this room's name in the logs.
   *
   * Minted by `rooms.ts`; it is a value here rather than something this module
   * generates, because a room that minted its own code could not be the same
   * room a browser tab runs behind a loopback (`roomCode.ts` draws from Web
   * Crypto, and the listen server has no registry to be unique within).
   */
  readonly id?: string
  readonly seed?: number
  /** How many peers may be seated. Two; see {@link DUEL_CAPACITY}. */
  readonly capacity?: number
  /** The match this room plays. Defaults to the Rocket Arena best-of-five. */
  readonly rules?: MatchRules
  /**
   * Where a round may stand its players.
   *
   * A function of the map, so it costs `spawns² × 9` traces to build and is
   * worth building once per *map* rather than once per room. The server passes
   * the one it built at boot (`map.ts`); a caller that does not gets a fresh
   * one, which is the right default for a test and the wrong one for a registry
   * minting a room per match.
   */
  readonly plan?: SpawnPlan
  readonly idleTimeoutMs?: number
  /**
   * Peer ids, injected.
   *
   * `randomUUID` lives in `node:crypto` and `crypto.randomUUID` needs a secure
   * context, so neither is something a module that has to run in both places
   * may reach for. The Node server passes the real one; a test passes a counter.
   */
  readonly peerId?: (index: number) => string
  /**
   * What a connection is allowed to send. `validate.ts`.
   *
   * A room's business rather than the Node edge's, because the listen server is
   * a room behind a loopback and the door has to be the same one — a limit that
   * only existed on the socket path would be a limit single-player never
   * exercises. Defaults are the shipping ones; a test passes smaller numbers so
   * it can reach them in a handful of frames.
   */
  readonly frameGuard?: FrameGuardOptions
  /**
   * Where this room's events go. One JSON object per event (`log.ts`).
   *
   * The room stamps its own code and its own live tick on to everything it
   * writes, so a call site here never has to remember to — see
   * {@link scopeToRoom}.
   */
  readonly log?: Log
  /**
   * Record the command stream this room executes, for playback later.
   *
   * Off by default: a recorder is a growing array, and a machine holding two
   * hundred rooms should not be holding two hundred of them unless somebody
   * asked. `sim/src/demo.ts` explains the format, and the *file* is written a
   * layer up — nothing in here has a filesystem (`demoFile.ts`).
   */
  readonly recorder?: DemoRecorder
}

export type RoomPeer = {
  readonly id: string
  /** The player slot this peer steers, or {@link NO_SLOT} if it was refused. */
  readonly slot: number
  /** The peer's live session state, for diagnostics and tests. */
  readonly session: SessionState
  /** The last time anything was heard from it, on the room's clock. */
  readonly lastHeardMs: number
  /**
   * The round trip to this peer in whole milliseconds, or `-1` before one has
   * been measured.
   *
   * Measured here, from a ping this room minted, against this room's clock —
   * never a number the client sent. `clockSync.ts` has the argument for why
   * that direction is not negotiable.
   */
  readonly rttMs: number
  /** Commands buffered for this peer and not yet executed. */
  readonly queued: number
  readonly open: boolean
  close(code?: number, reason?: string): void
}

export type RoomSnapshot = {
  readonly id: string
  readonly tick: number
  readonly hash: number
  readonly peers: number
  readonly capacity: number
  readonly phase: MatchPhase
  readonly round: number
  /** Commands offered by every peer, whatever became of them. */
  readonly commands: number
  readonly gaps: number
  /** Sub-steps in which some peer's buffer was empty and the fallback ran. */
  readonly starved: number
  /** Frames turned away at the door: binary, oversized, or too fast. */
  readonly refused: number
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
  /**
   * Advance the world by exactly `steps` sub-steps, then tell every peer where
   * it got to. Returns the steps run.
   *
   * The count comes from the scheduler and is never decided here — see the
   * header. Zero is a legal and common answer: two of every three host frames
   * at 62.5 Hz are worth two sub-steps and the rest are worth one or three, and
   * a frame worth none is simply a frame that arrived early.
   */
  advance(steps: number): number
  /**
   * Wall-clock housekeeping: peers that have gone quiet, and the clock-sync
   * pings. Never advances the simulation.
   *
   * `nowMs` **must** be a reading of the same {@link RoomOptions.clock} the room
   * was given. It is compared against readings this room took itself — when a
   * peer was last heard from, and when a ping went out — and a second clock's
   * origin would make an idle timeout arbitrary and a round trip meaningless.
   */
  sweep(nowMs: number): void
  hash(): number
  snapshot(): RoomSnapshot
  /**
   * The recording so far, or `null` when this room was not asked to keep one.
   *
   * A value rather than a file: nothing on this side of the line has a
   * filesystem. `server/src/demoFile.ts` is what writes one on Node, and a
   * browser tab downloads it.
   */
  demo(): Demo | null
  close(code?: number, reason?: string): void
}

type PeerRecord = {
  readonly id: string
  readonly slot: number
  readonly transport: Transport
  /** Per peer, because a round trip is a property of one link, not of a room. */
  readonly clockSync: ServerClockSync
  /** Per peer, because a jitter buffer is a property of one link too. */
  readonly queue: InputQueue
  /** Per peer, because a rate limit shared between peers is one peer's DoS. */
  readonly guard: FrameGuard
  session: SessionState
  lastHeardMs: number
  open: boolean
}

/** One reply, framed. JSON text today; the binary protocol is GLAD-OOELC5. */
function frameOf(message: ServerMessage): string {
  return JSON.stringify(message)
}

export function createRoom(options: RoomOptions): Room {
  const capacity = options.capacity ?? DUEL_CAPACITY
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const clock = options.clock
  const id = options.id ?? 'room'
  const recorder = options.recorder ?? null

  const identity: ServerIdentity = {
    build: options.build,
    mapHash: options.map.hash,
    room: id,
  }

  // One world, created once. Which peers exist and when they arrive does not
  // change it — `createMapState` stands a player in slot 0 and the rest of the
  // round rules are `match/round.ts`'s business, driven by `startMatch` once
  // there are two players to start a match for.
  const state: GameState = createMapState(
    options.map.source,
    options.seed ?? SKELETON_SEED,
    options.rules,
  )

  // Level data, like the collision world beside it: a function of the map
  // alone, never written by a sub-step, and therefore never cloned, hashed or
  // snapshotted. Built here only when nobody handed one over; see the note on
  // `RoomOptions.plan`.
  const plan: SpawnPlan = options.plan ?? buildSpawnPlan(options.map.source, options.map.world)
  const world = options.map.world

  // Scoped once, here, rather than at each call site: every line this room
  // writes carries its code and the tick the world is on at the moment of
  // writing. Those two are the coordinates a bug report arrives in.
  const log = scopeToRoom(options.log ?? NO_LOG, id, () => state.tick)

  const peers: PeerRecord[] = []
  let joined = 0
  let starved = 0
  // Frames refused at the door by peers that have since gone. A fuzzer is
  // closed on and then forgotten, and a counter that only summed *live* peers
  // would forget what it did on the way out.
  let refused = 0

  /**
   * The commands for one sub-step, reused.
   *
   * A room ticks 125 times a second for the length of a match and `tick()`
   * allocates nothing in the steady state; a fresh two-element array per
   * sub-step would make this the only thing on the authoritative side producing
   * garbage. Every slot is written before `tick()` reads one.
   */
  const inputs: (UserCmd | null)[] = [null, null]

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
    get rttMs() {
      return record.clockSync.rttMs
    },
    get queued() {
      return record.queue.depth
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
    if (at < 0) return
    peers.splice(at, 1)
    refused += record.guard.stats.refused
  }

  const send = (record: PeerRecord, message: ServerMessage): void => {
    record.transport.send(frameOf(message))
  }

  /** Peers whose commands count: seated, still open, and past the handshake. */
  const playing = (record: PeerRecord): boolean =>
    record.open && record.session.greeted && !record.session.rejected

  const receive = (record: PeerRecord, message: TransportMessage): void => {
    // Read once, and used for the idle sweep, the round trip and the rate
    // limit in front of the input buffer. Two readings of a clock inside one
    // delivery is two opinions about when the frame arrived.
    const nowMs = clock.nowMs()
    record.lastHeardMs = nowMs

    // The door, before anything reads the frame: size, rate, and "the protocol
    // is text". `validate.ts` owns every one of those numbers and the argument
    // for why a flood is dropped in silence until it is closed on.
    const verdict = record.guard.admit(message, nowMs)
    if (verdict.text === null) {
      if (verdict.fault !== null) send(record, verdict.fault)
      if (verdict.close !== null) {
        // One line per closed connection, never one per refused frame: the
        // throttle is silent for the same reason it does not reply, and a log
        // an attacker can fill is a log nobody can read. `refused` rides along
        // because "closed on the first binary frame" and "closed after a
        // hundred" are the two different stories this event tells.
        log('room.peer_refused', {
          level: 'warn',
          peer: record.id,
          slot: record.slot,
          fate: verdict.fate,
          refused: record.guard.stats.refused,
        })
        record.transport.close(verdict.close.code, verdict.close.reason)
      }
      return
    }

    // Parsed here rather than inside `applyFrame`, because a pong has to be
    // stopped at this layer: timing a round trip needs the clock, and the
    // session state machine deliberately has none.
    const parsed: ClientMessage | null = parseClientMessage(verdict.text)
    if (parsed !== null && parsed.t === 'pong') {
      record.clockSync.pong(parsed.id, nowMs)
      return
    }

    const step =
      parsed === null
        ? rejectBadFrame(record.session)
        : applyMessage(record.session, parsed, identity, nowMs)
    record.session = step.session
    for (const reply of step.replies) send(record, reply)
    if (step.close !== undefined) record.transport.close(step.close.code, step.close.reason)
  }

  /**
   * Start the match once every seat is filled by a peer that has greeted.
   *
   * The one edge out of warmup, and it is here rather than in the simulation
   * because the simulation is not the layer that knows both players have
   * arrived (`match/round.ts`). Called between sub-steps, never inside one, so
   * the first tick of round one is a tick both players can act on.
   */
  const startWhenFull = (): void => {
    if (state.match.phase !== MatchPhase.Warmup) return
    if (peers.filter(playing).length < capacity) return
    log('room.match_start', { peers: peers.length, capacity })
    // Recorded before the edge is taken, because a replay has to take it at the
    // same tick — `startMatch` is the one thing that happens to a world that is
    // not in the command stream. `sim/src/demo.ts`.
    recorder?.matchStarted(state.tick)
    startMatch(state, plan)
  }

  /**
   * Tell every peer where the world got to.
   *
   * The hash first, then the state it is the hash of. The order is the one the
   * walking skeleton was built around: the hash is an *independent* statement
   * about the authoritative world, and a client comparing it against what it
   * predicted is the desync canary. Reconciliation reads the second frame; the
   * instrument reads the first.
   *
   * Once per host frame rather than once per sub-step. At 125 Hz a frame per
   * tick would be 125 frames a second in each direction to say "still fine",
   * and the client is comparing against its own history anyway — one per host
   * frame finds a desync within 16 ms of it happening at half the traffic.
   *
   * The `ack` is this peer's own, and it is a *client* tick label rather than a
   * server one: how much of that peer's input is in the world, which is a
   * different question from how far the world has been advanced. They came
   * apart the moment this scheduler started draining a buffer at a fixed rate.
   * `sim/src/protocol.ts` argues it at length under `ServerSnapshot`.
   */
  const report = (): void => {
    const hash = hashState(state)
    for (const record of peers) {
      if (!playing(record)) continue
      send(record, { t: 'hash', tick: state.tick, hash })
      send(record, snapshotFrame(state, record.queue.executedTick))
    }
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
        log('room.join_refused', {
          level: 'warn',
          peer: peerId,
          seated: peers.length,
          capacity,
        })
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
          session: createSession(peerId, NO_SLOT),
          lastHeardMs: clock.nowMs(),
          rttMs: UNKNOWN_RTT,
          queued: 0,
          open: false,
          close: (code = CloseReason.Normal, reason = '') => transport.close(code, reason),
        }
      }

      // The buffer's admission window opens at zero rather than at the world's
      // current tick, because **a tick label is the peer's, not the world's**.
      // A client counts its own predicted ticks from one and the server counts
      // sub-steps from one, and the two numbers are equal only by coincidence —
      // a player joining a room that has been running for a minute would
      // otherwise have every command they ever send refused as late. `ack` is
      // in this space too, which is exactly why it is a separate field from
      // `state[0]` in a snapshot (`sim/src/protocol.ts`).
      const queue = createInputQueue()
      const record: PeerRecord = {
        id: peerId,
        slot,
        transport,
        clockSync: createClockSync(),
        queue,
        guard: createFrameGuard(options.frameGuard),
        session: createSession(peerId, slot, queue),
        lastHeardMs: clock.nowMs(),
        open: true,
      }
      peers.push(record)
      log('room.join', { peer: peerId, slot, seated: peers.length, capacity })

      transport.setHandlers({
        onOpen: () => {
          record.lastHeardMs = clock.nowMs()
        },
        onMessage: (message) => receive(record, message),
        onClose: () => forget(record),
        onError: (error) => {
          log('room.peer_error', { level: 'error', peer: peerId, slot, error: error.message })
        },
      })

      return viewOf(record)
    },

    advance(steps: number): number {
      if (!Number.isInteger(steps) || steps <= 0) return 0

      // An empty room does not tick. A machine holding two hundred rooms that
      // players have created and not yet joined would otherwise be running
      // 25,000 sub-steps a second over worlds nobody is in — and a room's tick
      // counter would stop meaning "how long has this match been running".
      // A peer that is seated but has not finished the handshake still counts:
      // it is a player arriving, and the handful of ticks that takes is a
      // rounding error next to a room sitting empty for a minute.
      if (peers.length === 0) return 0

      startWhenFull()

      for (let step = 0; step < steps; step += 1) {
        inputs[DUEL_SLOTS[0]] = null
        inputs[DUEL_SLOTS[1]] = null
        for (const record of peers) {
          if (!playing(record)) continue
          const taken = record.queue.take()
          if (taken.consumed === 0) starved += 1
          inputs[record.slot] = taken.cmd
        }
        // Before the sub-step, with the world it is about to run on: a demo is
        // the *input* stream, so what is recorded is what `tick()` is handed
        // rather than what it produced. `sim/src/demo.ts`.
        recorder?.record(state, inputs)
        simTick(state, inputs, world, plan)
      }

      report()
      return steps
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
        if (nowMs - record.lastHeardMs >= idleTimeoutMs) {
          log('room.peer_idle', {
            level: 'warn',
            peer: record.id,
            slot: record.slot,
            quietMs: Math.round(nowMs - record.lastHeardMs),
            timeoutMs: idleTimeoutMs,
          })
          record.transport.close(CloseReason.Abnormal, 'idle')
          forget(record)
          continue
        }

        // Clock sync rides on the housekeeping beat rather than a timer of its
        // own, for the same reason the room has no timer at all: a beat is
        // something the host is given, so a test drives a conversation of
        // hundreds of pings in the microseconds it takes to run them. A peer
        // that has not greeted us is not pinged — it may be a client one deploy
        // behind that is about to be told so.
        if (!record.session.greeted || record.session.rejected) continue
        if (!record.clockSync.due(nowMs)) continue
        send(record, record.clockSync.ping(nowMs, state.tick, record.queue.depth))
      }
    },

    hash: () => hashState(state),

    snapshot: () => ({
      id,
      tick: state.tick,
      hash: hashState(state),
      peers: peers.length,
      capacity,
      phase: state.match.phase,
      round: state.match.round,
      commands: peers.reduce((total, peer) => total + peer.session.commands, 0),
      gaps: peers.reduce((total, peer) => total + peer.session.gaps, 0),
      starved,
      refused: refused + peers.reduce((total, peer) => total + peer.guard.stats.refused, 0),
    }),

    demo: () => recorder?.finish(state) ?? null,

    close(code = CloseReason.Normal, reason = '') {
      for (const record of [...peers]) {
        record.transport.close(code, reason)
        forget(record)
      }
    },
  }
}
