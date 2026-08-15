/**
 * The room registry: every match on this machine, addressed by its code.
 *
 * A `Map` from six characters to a `Room`, and that is the whole lobby. There
 * is no matchmaking service, no database and no session store — one player
 * creates a match, is handed a code, and sends it to somebody.
 *
 * ## Why an in-memory `Map` is not a shortcut
 *
 * Two players in one room have to reach the *same process*, because a room is a
 * live `GameState` being advanced 125 times a second and there is no version of
 * this that shards. A registry in Redis would tell a second machine which room
 * a code belongs to and then have nothing useful to do with the answer.
 *
 * So v1 pins to one machine — `fly.toml`'s `min_machines_running = 1` with
 * `auto_stop_machines = "off"` — and the registry is a `Map`, which is
 * definitionally consistent because there is only one of it. Scaling out means a
 * room-to-machine directory and a way to route an upgrade at it, and that is
 * explicitly GLAD-G41FQ9's problem and not this file's.
 *
 * ## Rooms do not leak
 *
 * A code minted and never used, and a room whose players have both gone, are
 * the same leak with two causes: a `Map` entry holding a `GameState` that
 * nobody will ever tick again. {@link RoomRegistryOptions.emptyTtlMs} is the one
 * rule that covers both — a room with no peers for a minute is closed and
 * forgotten. It is deliberately blunt: *when* a peer counts as gone, whether a
 * disconnected player may come back to the same room, and what a forfeit does to
 * the score are the connection lifecycle's questions (GLAD-DVDV6P), and that
 * ticket will want a longer grace period than this. Lengthening one number is
 * the seam it inherits.
 *
 * ## One room's bad day is one room's
 *
 * Every world on the machine is advanced by one call from one timer, so an
 * exception out of any room's sub-step would unwind through the scheduler's
 * frame and leave every *other* room silently un-ticked — two hundred duels
 * ended by one hostile client. So `advance` and `sweep` run each room behind a
 * try/catch, and a room that threw is closed and counted (`faulted`) rather than
 * left in the map to throw again on the next frame. GLAD-V7M6PQ.
 */
import { CloseReason, hashString } from '@gladiator/sim'

import type { Clock } from './clock.ts'
import type { Room } from './room.ts'
import { mintRoomCode, normalizeRoomCode, type Uint32Source } from './roomCode.ts'

/**
 * How many rooms one machine will hold.
 *
 * Two hundred, which is `fly.toml`'s `hard_limit` on *connections* — so it is
 * the number of rooms that could exist if every single connection created one
 * and nobody ever joined an existing match. A real mix of hosts and joiners
 * never gets near it, which is what makes this a backstop against a script
 * opening sockets rather than a capacity plan.
 */
export const MAX_ROOMS = 200

/**
 * How long a room with nobody in it survives, in milliseconds.
 *
 * A minute. Long enough that a host can create a match, paste the link into a
 * chat window and wait for somebody to read it; short enough that a bot opening
 * connections cannot fill {@link MAX_ROOMS} and keep it full. See the header for
 * why this is not the room GC.
 */
export const EMPTY_ROOM_TTL_MS = 60_000

/**
 * How many times a mint may collide before the registry gives up.
 *
 * At {@link MAX_ROOMS} rooms in a billion codes the chance of one collision is
 * about one in five million, and of eight in a row is a number with fifty zeros
 * in it. The loop is here because "draw until unique" with no bound is an
 * infinite loop the day somebody shrinks the alphabet, not because a collision
 * is expected.
 */
export const MINT_ATTEMPTS = 8

/**
 * The seed a room's world runs on: the room code, hashed.
 *
 * A match is a function of its seed — which pair of spawns a round starts on
 * and which end each player gets are draws from it — so two rooms with the same
 * seed would play the same coin flips in the same order. The code is the one
 * thing both peers already know before a socket is open, it is 30 bits of
 * entropy by construction, and it is the same number on both ends without
 * anybody having to send it.
 */
export function seedForRoom(code: string): number {
  return hashString(code) >>> 0
}

export type RoomEntry = {
  readonly code: string
  readonly room: Room
  /** When this room was created, on the registry's clock. */
  readonly createdMs: number
  /** When it last became empty, or `null` while somebody is in it. */
  readonly emptySinceMs: number | null
}

export type RegistryStats = {
  readonly rooms: number
  readonly capacity: number
  readonly peers: number
  /** Rooms created over the life of the process. */
  readonly created: number
  /** Rooms closed because they sat empty. */
  readonly reaped: number
  /** Joins that named a code no room had. */
  readonly missed: number
  /**
   * Rooms closed because ticking or sweeping one threw.
   *
   * Should be zero forever. It is served from `/healthz` rather than only
   * logged because a nonzero reading is the signal that some frame is reaching
   * code that treats it as trustworthy, and that is worth finding before it is
   * found for us.
   */
  readonly faulted: number
}

export type RoomRegistry = {
  /**
   * Mint a code and open a room under it, or `null` when the machine is full.
   *
   * `null` rather than a throw: "this server is full" is a sentence a player
   * has to be told, and an exception is not a sentence.
   */
  create(): RoomEntry | null
  /** The room a player typed, or `null`. Folds the code first. */
  get(code: string | undefined | null): RoomEntry | null
  /** Close and forget a room. Returns whether there was one. */
  remove(code: string, closeCode?: number, reason?: string): boolean
  /** Advance every room by `steps` sub-steps. The scheduler's frame. */
  advance(steps: number): void
  /** Housekeeping for every room, plus the empty-room reaper. */
  sweep(nowMs: number): void
  readonly size: number
  /** Every live code, for diagnostics. Not ordered. */
  codes(): readonly string[]
  stats(): RegistryStats
  closeAll(closeCode?: number, reason?: string): void
}

export type RoomRegistryOptions = {
  /** Read for the empty-room reaper. Never reaches a simulation. */
  readonly clock: Clock
  /**
   * Open a room under `code`.
   *
   * A callback rather than the map and the build, so the registry knows nothing
   * about what a room is made of — which is what lets a test register rooms
   * over loopbacks without loading an arena.
   */
  readonly create: (code: string) => Room
  /** Injected, so a test can fix the draw. `roomCode.ts`. */
  readonly random?: Uint32Source
  readonly maxRooms?: number
  readonly emptyTtlMs?: number
  readonly log?: (line: string) => void
}

export function createRoomRegistry(options: RoomRegistryOptions): RoomRegistry {
  const clock = options.clock
  const maxRooms = options.maxRooms ?? MAX_ROOMS
  const emptyTtlMs = options.emptyTtlMs ?? EMPTY_ROOM_TTL_MS
  const log = options.log ?? (() => undefined)

  type Live = {
    readonly code: string
    readonly room: Room
    readonly createdMs: number
    emptySinceMs: number | null
  }

  const rooms = new Map<string, Live>()
  let created = 0
  let reaped = 0
  let missed = 0
  let faulted = 0

  const viewOf = (live: Live): RoomEntry => ({
    code: live.code,
    room: live.room,
    createdMs: live.createdMs,
    emptySinceMs: live.emptySinceMs,
  })

  const drop = (live: Live, closeCode: number, reason: string): void => {
    rooms.delete(live.code)
    live.room.close(closeCode, reason)
  }

  /**
   * Run `what` for one room, and let the others carry on if it throws.
   *
   * The whole machine's worth of worlds is advanced by one call from one timer
   * (`scheduler.ts`), so an exception out of any room's sub-step unwinds through
   * the scheduler's frame and every *other* room silently stops being ticked.
   * That is the blast radius GLAD-V7M6PQ is about: a hostile client should be
   * able to end its own match and nobody else's.
   *
   * A room that threw is closed rather than left in the registry. Whatever put
   * it in that state is still in its `GameState`, so the next frame would throw
   * again — a room that fails forever is a room that has to be told about, and
   * both peers are better off reconnecting into a new one than watching a world
   * that has stopped.
   */
  const isolate = (live: Live, what: string, run: () => void): void => {
    try {
      run()
    } catch (thrown) {
      const detail = thrown instanceof Error ? thrown.message : String(thrown)
      log(`registry: room ${live.code} threw during ${what}, closing it — ${detail}`)
      faulted += 1
      drop(live, CloseReason.Abnormal, 'room faulted')
    }
  }

  return {
    create(): RoomEntry | null {
      if (rooms.size >= maxRooms) {
        log(`registry: refused a new room, ${rooms.size}/${maxRooms} in use`)
        return null
      }

      const nowMs = clock.nowMs()
      for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
        const code = mintRoomCode(options.random)
        if (rooms.has(code)) continue
        const live: Live = {
          code,
          room: options.create(code),
          createdMs: nowMs,
          // Empty from the instant it exists. The host's own connection lands a
          // moment later and clears this; if it never does, the reaper takes the
          // room a minute later and the code goes back into the space.
          emptySinceMs: nowMs,
        }
        rooms.set(code, live)
        created += 1
        log(`registry: opened room ${code}, ${rooms.size} live`)
        return viewOf(live)
      }

      // Unreachable in practice; see MINT_ATTEMPTS. Refusing beats looping.
      log(`registry: gave up minting a code after ${MINT_ATTEMPTS} collisions`)
      return null
    },

    get(code: string | undefined | null): RoomEntry | null {
      const normalized = normalizeRoomCode(code)
      if (normalized === null) {
        missed += 1
        return null
      }
      const live = rooms.get(normalized)
      if (live === undefined) {
        missed += 1
        return null
      }
      return viewOf(live)
    },

    remove(code: string, closeCode = CloseReason.Normal, reason = ''): boolean {
      const normalized = normalizeRoomCode(code)
      if (normalized === null) return false
      const live = rooms.get(normalized)
      if (live === undefined) return false
      drop(live, closeCode, reason)
      return true
    },

    advance(steps: number) {
      if (steps <= 0) return
      // Over a copy, and one room at a time behind `isolate`: a room that throws
      // is closed and dropped from the map being walked.
      for (const live of [...rooms.values()]) {
        isolate(live, 'advance', () => live.room.advance(steps))
      }
    },

    sweep(nowMs: number) {
      // Over a copy: a reaped room is deleted from the map being walked, and a
      // `Map` iterator tolerates that but the sweep below also closes peers,
      // which reenters through `onClose`. One list, taken once.
      for (const live of [...rooms.values()]) {
        isolate(live, 'sweep', () => live.room.sweep(nowMs))
        if (!rooms.has(live.code)) continue

        if (live.room.peers.length > 0) {
          live.emptySinceMs = null
          continue
        }
        if (live.emptySinceMs === null) {
          live.emptySinceMs = nowMs
          continue
        }
        if (nowMs - live.emptySinceMs >= emptyTtlMs) {
          log(`registry: reaping room ${live.code}, empty for ${emptyTtlMs} ms`)
          reaped += 1
          drop(live, CloseReason.Normal, 'room expired')
        }
      }
    },

    get size() {
      return rooms.size
    },

    codes: () => [...rooms.keys()],

    stats: (): RegistryStats => {
      let peers = 0
      for (const live of rooms.values()) peers += live.room.peers.length
      return { rooms: rooms.size, capacity: maxRooms, peers, created, reaped, missed, faulted }
    },

    closeAll(closeCode = CloseReason.Normal, reason = '') {
      for (const live of [...rooms.values()]) drop(live, closeCode, reason)
    },
  }
}
