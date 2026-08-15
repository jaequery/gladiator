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
 * forgotten.
 *
 * It is deliberately blunt, and it is now *downstream* of a policy rather than
 * standing in for one. Whether a disconnected player may come back, and what a
 * timeout does to the score, are `lifecycle.ts`'s questions (GLAD-DVDV6P). What
 * this file owes that answer is one inequality: the TTL is at least
 * `RECONNECT_GRACE_MS`, or a room whose only peer dropped would be reaped out
 * from under a reconnect that was still inside its window. `lifecycle.test.ts`
 * asserts it, because it is exactly the kind of relationship that survives right
 * up until somebody tunes one of the two numbers.
 */
import { CloseReason, NEW_MATCH_SCORE, hashString, type MatchScore } from '@gladiator/sim'

import type { Clock } from './clock.ts'
import { NO_LOG, type Log } from './log.ts'
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
 * connections cannot fill {@link MAX_ROOMS} and keep it full.
 *
 * And at least twice `RECONNECT_GRACE_MS`, which is the constraint that is not
 * about hospitality: a match both of whose players dropped is a room with no
 * peers in it, and reaping that before their windows had closed would turn a
 * reconnect into "no such room" — the sentence a player reads as "the server
 * lost my match".
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
}

export type RoomRegistry = {
  /**
   * Mint a code and open a room under it, or `null` when the machine is full.
   *
   * `null` rather than a throw: "this server is full" is a sentence a player
   * has to be told, and an exception is not a sentence.
   */
  create(): RoomEntry | null
  /**
   * Open a room under a code somebody already holds, at a score.
   *
   * The other way a room comes into being, and the only one that does not mint:
   * a deploy took the machine that held this match away, and both players are
   * arriving at its replacement with a signed ticket naming the code they were
   * in and the score they were on (`resume.ts`, `shutdown.ts`). Whichever of
   * the two reaches the new machine first rebuilds the room; the second one
   * finds it through {@link RoomRegistry.get} like any other join, which is why
   * this does not need to know there are two of them.
   *
   * `null` when the machine is full or the code is not a code. A code that is
   * already live is *not* an error — the caller looked it up first, and one
   * that appeared in between belongs to the peer that got there first.
   */
  adopt(code: string, score: MatchScore): RoomEntry | null
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
   * Open a room under `code`, at `score`.
   *
   * A callback rather than the map and the build, so the registry knows nothing
   * about what a room is made of — which is what lets a test register rooms
   * over loopbacks without loading an arena. The score is passed straight
   * through for the same reason: a resumed match is the room's business, and
   * all the registry has to know is that a room can be opened at one.
   */
  readonly create: (code: string, score: MatchScore) => Room
  /** Injected, so a test can fix the draw. `roomCode.ts`. */
  readonly random?: Uint32Source
  /**
   * Called with a room the instant before it is closed and forgotten.
   *
   * The seam demo capture hangs off: a recording is only worth writing once the
   * match it recorded is over, and this is the one place every ending goes
   * through — reaped, removed, or the whole machine shutting down. It runs
   * *before* the close so the room's peers and world are still readable.
   */
  readonly onClosing?: (code: string, room: Room) => void
  readonly maxRooms?: number
  readonly emptyTtlMs?: number
  /**
   * Where the registry's own events go. One JSON object per event (`log.ts`).
   *
   * Passed straight through to every room this registry opens, which is what
   * makes a room's lines carry its code without the registry having to know
   * that they do.
   */
  readonly log?: Log
}

export function createRoomRegistry(options: RoomRegistryOptions): RoomRegistry {
  const clock = options.clock
  const maxRooms = options.maxRooms ?? MAX_ROOMS
  const emptyTtlMs = options.emptyTtlMs ?? EMPTY_ROOM_TTL_MS
  const log = options.log ?? NO_LOG

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

  const viewOf = (live: Live): RoomEntry => ({
    code: live.code,
    room: live.room,
    createdMs: live.createdMs,
    emptySinceMs: live.emptySinceMs,
  })

  const drop = (live: Live, closeCode: number, reason: string): void => {
    rooms.delete(live.code)
    // Before the close, so whoever is listening still has a world to read. A
    // throw in here would take a shutdown down with it, and writing a demo to a
    // full disk is not a reason to lose the other hundred rooms.
    try {
      options.onClosing?.(live.code, live.room)
    } catch (cause) {
      log('registry.on_closing_failed', {
        level: 'error',
        room: live.code,
        tick: live.room.tick,
        error: String(cause),
      })
    }
    live.room.close(closeCode, reason)
  }

  /** Put a room in the map under a code that is known to be free. */
  const open = (code: string, score: MatchScore, nowMs: number): Live => {
    const live: Live = {
      code,
      room: options.create(code, score),
      createdMs: nowMs,
      // Empty from the instant it exists. The host's own connection lands a
      // moment later and clears this; if it never does, the reaper takes the
      // room a minute later and the code goes back into the space.
      emptySinceMs: nowMs,
    }
    rooms.set(code, live)
    created += 1
    return live
  }

  return {
    create(): RoomEntry | null {
      if (rooms.size >= maxRooms) {
        // No room and no world, so both index fields are null — see `log.ts`
        // on why they are written rather than left out.
        log('registry.full', { level: 'warn', live: rooms.size, capacity: maxRooms })
        return null
      }

      const nowMs = clock.nowMs()
      for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt += 1) {
        const code = mintRoomCode(options.random)
        if (rooms.has(code)) continue
        const live = open(code, NEW_MATCH_SCORE, nowMs)
        log('registry.opened', { room: code, tick: 0, live: rooms.size, capacity: maxRooms })
        return viewOf(live)
      }

      // Unreachable in practice; see MINT_ATTEMPTS. Refusing beats looping.
      log('registry.mint_failed', { level: 'error', attempts: MINT_ATTEMPTS, live: rooms.size })
      return null
    },

    adopt(code: string, score: MatchScore): RoomEntry | null {
      const normalized = normalizeRoomCode(code)
      if (normalized === null) return null
      const existing = rooms.get(normalized)
      if (existing !== undefined) return viewOf(existing)
      if (rooms.size >= maxRooms) {
        log('registry.full', {
          level: 'warn',
          room: normalized,
          tick: 0,
          resume: true,
          live: rooms.size,
          capacity: maxRooms,
        })
        return null
      }
      const live = open(normalized, score, clock.nowMs())
      log('registry.resumed', {
        room: normalized,
        tick: 0,
        score: `${score.wins[0]}-${score.wins[1]}`,
        roundsPlayed: score.roundsPlayed,
        live: rooms.size,
      })
      return viewOf(live)
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
      for (const live of rooms.values()) live.room.advance(steps)
    },

    sweep(nowMs: number) {
      // Over a copy: a reaped room is deleted from the map being walked, and a
      // `Map` iterator tolerates that but the sweep below also closes peers,
      // which reenters through `onClose`. One list, taken once.
      for (const live of [...rooms.values()]) {
        live.room.sweep(nowMs)

        if (live.room.peers.length > 0) {
          live.emptySinceMs = null
          continue
        }
        if (live.emptySinceMs === null) {
          live.emptySinceMs = nowMs
          continue
        }
        if (nowMs - live.emptySinceMs >= emptyTtlMs) {
          log('registry.reaped', {
            room: live.code,
            tick: live.room.tick,
            emptyMs: Math.round(nowMs - live.emptySinceMs),
            ttlMs: emptyTtlMs,
          })
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
      return { rooms: rooms.size, capacity: maxRooms, peers, created, reaped, missed }
    },

    closeAll(closeCode = CloseReason.Normal, reason = '') {
      for (const live of [...rooms.values()]) drop(live, closeCode, reason)
    },
  }
}
