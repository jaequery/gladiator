/**
 * The quick-match queue: how a player with nobody to send a code to gets a duel.
 *
 * `?queue=1` on the upgrade instead of `?room=ABC123`. The host either seats
 * this peer in the room somebody else is already waiting in, or opens one and
 * parks them in it until the next arrival. Room codes are untouched and remain
 * the way two people who know each other play (GLAD-FHKBN8); this is the path
 * for the stranger, and it was deliberately built second.
 *
 * ## It is a line of rooms, not a line of sockets
 *
 * The obvious shape — hold the sockets, pair two of them, then build a room —
 * is the wrong one here, and the reason is `net/wsTransport.ts`. A socket with
 * no handlers installed silently drops what arrives on it, and the very first
 * thing a client sends is its `hello`; a socket parked in a lobby would
 * therefore have to buffer frames and replay them into a room that has not been
 * built yet, which is a second delivery path for the one message whose loss
 * takes the whole session down.
 *
 * So a player who asks to be matched is put straight into a real room with a
 * real code, and *the code* goes in the line. Everything downstream — the
 * handshake, the welcome, `startWhenFull`, the reaper — is the code path room
 * codes already take, and the queue's whole job is to decide which room the
 * next arrival is handed. It also means the answer to "the wait ran out" is a
 * sentence with something in it: this player is already holding a code they can
 * send a friend.
 *
 * ## An entry is a claim about a room, and it is checked rather than trusted
 *
 * Nothing tells this module that a queued player disconnected — the socket
 * closes, `room.ts` forgets the peer, and the entry here still names a code. So
 * an entry is never *believed*: {@link liveEntry} re-reads the registry every
 * time one is about to be used, and a room that has gone, emptied or filled up
 * by some other route is dropped on the spot rather than handed to the next
 * arrival. That check is what makes "a player who queues and walks away is
 * never paired with anybody" true by construction rather than by remembering to
 * call a `leave()` from every path a socket can die on.
 *
 * ## One machine, again
 *
 * The registry pins a room to a process because a room is a live `GameState`
 * (`rooms.ts`), and the queue inherits that pin for free by being a line of
 * codes *in* that registry. Two machines would need the room-to-machine
 * directory `NOTES.md` §1 argues about, and the queue would need to agree with
 * it about where a match lives — which is exactly the scaling question v1 does
 * not answer. Nothing here is in the way of it; this is a `Map` on the same
 * machine as the other `Map`.
 */
import type { Clock } from './clock.ts'
import { NO_LOG, type Log } from './log.ts'
import type { RoomEntry, RoomRegistry } from './rooms.ts'

/**
 * How long a player waits for a stranger before the queue gives up, in
 * milliseconds.
 *
 * A minute. Long enough to cover a genuinely empty minute on a small deploy,
 * short enough that nobody sits in front of a spinner wondering whether it is
 * broken — and it is deliberately the same number as `rooms.ts`'s
 * `EMPTY_ROOM_TTL_MS`, because a player who has been told the wait is over and
 * then closes the tab leaves behind exactly the room that reaper is for.
 *
 * The timeout is not a close. The peer keeps its socket, its room and its code,
 * and is told all three: "nobody is waiting, here is a code to send a friend"
 * is an outcome, and an indefinite spinner is not.
 */
export const QUEUE_WAIT_TIMEOUT_MS = 60_000

/** What became of an arrival that asked to be matched. */
export type QueueAdmission =
  | {
      readonly kind: 'paired'
      /** The room both peers are now in. The arrival takes the free seat. */
      readonly entry: RoomEntry
      /** How long the peer already in there had been waiting. */
      readonly waitedMs: number
    }
  | {
      readonly kind: 'waiting'
      /** A room of this arrival's own, opened to wait in. */
      readonly entry: RoomEntry
      readonly timeoutMs: number
    }
  /** The machine is holding as many rooms as it can. Nothing was opened. */
  | { readonly kind: 'full' }

export type QueueStats = {
  /** Players in the line right now, as of the last {@link MatchQueue.sweep}. */
  readonly waiting: number
  /** Arrivals that had to wait, over the life of the process. */
  readonly parked: number
  /** Pairs made. Two players each time. */
  readonly paired: number
  /** Waits that ran out with nobody arriving. */
  readonly timedOut: number
  /** Waiting players whose room emptied or filled before anyone was paired. */
  readonly dropped: number
}

export type MatchQueue = {
  /**
   * Pair this arrival with whoever is waiting, or open them a room and park
   * them in it.
   *
   * The caller is what seats the socket — this returns the room to seat it in,
   * because a queue that held transports would be the lobby this module's
   * header argues against.
   */
  admit(): QueueAdmission
  /**
   * Drop entries whose room has gone, emptied or filled, and expire the waits
   * that have run out.
   *
   * Rides the tick scheduler's frame beside the registry's own sweep
   * (`server.ts`), so "waiting" is never more than a host frame stale.
   */
  sweep(nowMs: number): void
  /** How long an arrival is told the wait may last. */
  readonly timeoutMs: number
  readonly size: number
  /** Every code in the line, oldest first. For diagnostics. */
  codes(): readonly string[]
  stats(): QueueStats
}

export type MatchQueueOptions = {
  /** Where rooms come from and where they are looked up. `rooms.ts`. */
  readonly rooms: RoomRegistry
  /** Read for the wait timer. Never reaches a simulation. `clock.ts`. */
  readonly clock: Clock
  /**
   * Called with a peer whose wait ran out, before it is taken out of the line.
   *
   * A callback rather than a frame sent from in here, for the same reason the
   * registry takes one: this module knows about codes and clocks and nothing
   * about what a peer is. `server.ts` is what turns it into a `ServerQueue`
   * frame.
   */
  readonly onTimeout?: (entry: RoomEntry, waitedMs: number) => void
  readonly waitTimeoutMs?: number
  readonly log?: Log
}

export function createMatchQueue(options: MatchQueueOptions): MatchQueue {
  const rooms = options.rooms
  const clock = options.clock
  const log = options.log ?? NO_LOG
  const waitTimeoutMs = options.waitTimeoutMs ?? QUEUE_WAIT_TIMEOUT_MS

  type Waiting = {
    readonly code: string
    /** When this player joined the line, on the queue's clock. */
    readonly sinceMs: number
  }

  /** Oldest first: the longest wait is the next one paired. */
  const line: Waiting[] = []
  let parked = 0
  let paired = 0
  let timedOut = 0
  let dropped = 0

  /**
   * The room an entry names, if it is still one an arrival can be put into.
   *
   * `null` for all three ways an entry goes stale, and they are one question
   * rather than three: is there still a room under this code with somebody in
   * it and a seat free. A room that emptied is a player who left; one that
   * filled was joined by code while its owner waited (which is a *good*
   * outcome, and the queue's part in it is to get out of the way).
   */
  const liveEntry = (waiting: Waiting): RoomEntry | null => {
    const entry = rooms.get(waiting.code)
    if (entry === null) return null
    const seated = entry.room.peers.length
    if (seated === 0 || seated >= entry.room.capacity) return null
    return entry
  }

  return {
    timeoutMs: waitTimeoutMs,

    admit(): QueueAdmission {
      const nowMs = clock.nowMs()

      // Walk from the front, dropping the stale as they are found. The head is
      // the longest wait, and a stale head is a player who is not there any
      // more — pairing an arrival into their room would be a duel against a
      // socket that closed a minute ago.
      while (line.length > 0) {
        const waiting = line[0]
        if (waiting === undefined) break
        const entry = liveEntry(waiting)
        if (entry === null) {
          line.shift()
          dropped += 1
          log('queue.dropped', {
            room: waiting.code,
            tick: 0,
            waitedMs: Math.round(nowMs - waiting.sinceMs),
            waiting: line.length,
          })
          continue
        }
        line.shift()
        paired += 1
        const waitedMs = Math.round(nowMs - waiting.sinceMs)
        log('queue.paired', {
          room: entry.code,
          tick: entry.room.tick,
          waitedMs,
          waiting: line.length,
        })
        return { kind: 'paired', entry, waitedMs }
      }

      const opened = rooms.create()
      if (opened === null) {
        // The registry has already said why in its own line; this one says who
        // it happened to, because "the queue is not working" and "the machine
        // is full" are the same event seen from two places.
        log('queue.refused', { level: 'warn', waiting: line.length })
        return { kind: 'full' }
      }

      line.push({ code: opened.code, sinceMs: nowMs })
      parked += 1
      log('queue.parked', {
        room: opened.code,
        tick: 0,
        timeoutMs: waitTimeoutMs,
        waiting: line.length,
      })
      return { kind: 'waiting', entry: opened, timeoutMs: waitTimeoutMs }
    },

    sweep(nowMs: number) {
      // Over a copy of the indices rather than in place: `onTimeout` sends a
      // frame, and a caller that answered by closing the socket would mutate
      // the array this loop is walking.
      for (const waiting of [...line]) {
        const at = line.indexOf(waiting)
        if (at < 0) continue

        const entry = liveEntry(waiting)
        if (entry === null) {
          line.splice(at, 1)
          dropped += 1
          log('queue.dropped', {
            room: waiting.code,
            tick: 0,
            waitedMs: Math.round(nowMs - waiting.sinceMs),
            waiting: line.length,
          })
          continue
        }

        const waitedMs = nowMs - waiting.sinceMs
        if (waitedMs < waitTimeoutMs) continue

        // Out of the line, but not out of a room: the peer keeps its socket and
        // its code. What the timeout ends is the *matching*, and telling
        // somebody that is the whole difference between an outcome and a
        // spinner.
        line.splice(at, 1)
        timedOut += 1
        log('queue.timed_out', {
          room: entry.code,
          tick: entry.room.tick,
          waitedMs: Math.round(waitedMs),
          timeoutMs: waitTimeoutMs,
          waiting: line.length,
        })
        options.onTimeout?.(entry, Math.round(waitedMs))
      }
    },

    get size() {
      return line.length
    },

    codes: () => line.map((waiting) => waiting.code),

    stats: (): QueueStats => ({
      waiting: line.length,
      parked,
      paired,
      timedOut,
      dropped,
    }),
  }
}
