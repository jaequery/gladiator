/**
 * The server's half of clock sync: it pings, it times the echo, it reports.
 *
 * ## Why the *server* pings
 *
 * Whoever sends the ping is the one holding the stopwatch, and the stopwatch
 * has to be the server's. Round-trip time is not a diagnostic here — it decides
 * how far lag compensation rewinds the world before it traces a railgun shot
 * (GLAD-5QGO11), and how big a lead the client is told to run at. A client that
 * reported its own RTT could report a bigger one and be handed extra rewind: it
 * would shoot at where you *were*, and win duels it did not win. So the number
 * is measured here, from a ping this module minted, against this module's
 * clock, and `ClientPong` carries nothing but the id back.
 *
 * The residual cheat is answering *late*, which inflates your own RTT and helps
 * nobody: a longer trip means a longer lead and more of your own input buffered
 * before it executes. That direction defends itself.
 *
 * ## The filter is a minimum, not an average
 *
 * Jitter is one-sided. A packet can be delayed and cannot be hurried, so every
 * sample is the true path delay plus something non-negative, and the *smallest*
 * sample in a window is the least contaminated estimate of the floor. An
 * average is dragged upward by exactly the outliers it should be ignoring, and
 * a single 300 ms hiccough would move it for as long as it stayed in the
 * window. NTP has picked minima for the same reason since 1985.
 *
 * The window slides, so a route that genuinely gets slower is followed rather
 * than remembered forever — {@link RTT_WINDOW} samples at
 * {@link PING_INTERVAL_MS} apart is a couple of seconds of memory.
 *
 * ## No clock, no timer
 *
 * `nowMs` arrives as an argument, exactly as it does everywhere else on the
 * authoritative side. This module has to run inside a browser tab as part of
 * the listen server, and `room.isomorphic.test.ts` reads the import graph from
 * `room.ts` and fails on a `Date.now()`, a `setInterval` or a `node:` import.
 */
import { UNKNOWN_RTT, type ServerPing } from '@gladiator/sim'

/**
 * How often a peer is pinged, in milliseconds.
 *
 * Five a second. Fast enough that {@link RTT_WINDOW} samples — the whole
 * filter — fills in under two seconds, which is how long a player waits before
 * their clock estimate is trustworthy. Slow enough that it is a rounding error
 * next to 125 command frames a second going the other way.
 */
export const PING_INTERVAL_MS = 200

/**
 * How many round-trip samples the minimum is taken over.
 *
 * Eight, at 200 ms apart, is 1.6 seconds of memory. Long enough that a single
 * delayed pong cannot move the estimate; short enough that a route change is
 * followed within a couple of seconds rather than being averaged away.
 */
export const RTT_WINDOW = 8

/**
 * How many pings may be outstanding before the oldest is given up on.
 *
 * A peer that has stopped answering must not be able to make the server hold a
 * growing table of send times — that is a memory leak with a one-line exploit.
 * At {@link PING_INTERVAL_MS} this is 1.6 seconds of silence, well inside the
 * room's idle timeout, so a peer that is merely slow is not forgotten.
 */
export const MAX_OUTSTANDING_PINGS = 8

export type ClockSyncStats = {
  /** Pings minted. */
  readonly sent: number
  /** Pongs that matched an outstanding ping and produced a sample. */
  readonly matched: number
  /**
   * Pongs that matched nothing: an id never minted, an id already answered, or
   * one so old it had been given up on.
   *
   * Worth counting rather than ignoring. A client answering ids it was never
   * sent is a client trying to manufacture a round trip, and that is exactly
   * the shape GLAD-V7M6PQ will want to close a socket over.
   */
  readonly unmatched: number
  /** Pings given up on because the peer never answered. */
  readonly abandoned: number
}

export type ServerClockSync = {
  /** Whether {@link ServerClockSync.ping} is due at `nowMs`. */
  due(nowMs: number): boolean
  /**
   * Mint the next ping, and remember when it went out.
   *
   * `tick` is the server's tick right now and `queued` the depth of this peer's
   * input buffer — both read by the caller, which is the layer that has them.
   */
  ping(nowMs: number, tick: number, queued: number): ServerPing
  /**
   * Take a pong. Returns the round trip it measured, or {@link UNKNOWN_RTT} if
   * it matched no outstanding ping.
   */
  pong(id: number, nowMs: number): number
  /**
   * The filtered round trip in whole milliseconds, or {@link UNKNOWN_RTT}.
   *
   * Whole milliseconds because that is what goes on the wire, and two names for
   * one number is the drift this repo is built to prevent.
   */
  readonly rttMs: number
  readonly samples: number
  readonly outstanding: number
  readonly stats: ClockSyncStats
}

export type ClockSyncOptions = {
  readonly intervalMs?: number
  readonly window?: number
  readonly maxOutstanding?: number
}

type Outstanding = {
  readonly id: number
  readonly sentMs: number
}

export function createClockSync(options: ClockSyncOptions = {}): ServerClockSync {
  const intervalMs = options.intervalMs ?? PING_INTERVAL_MS
  const window = options.window ?? RTT_WINDOW
  const maxOutstanding = options.maxOutstanding ?? MAX_OUTSTANDING_PINGS

  // Ids are minted from zero and never reused, so a pong that arrives after its
  // ping was given up on cannot be mistaken for the answer to a later one.
  let nextId = 0
  let dueMs = Number.NEGATIVE_INFINITY
  const outstanding: Outstanding[] = []
  const samples: number[] = []
  const stats = { sent: 0, matched: 0, unmatched: 0, abandoned: 0 }

  const filtered = (): number => {
    if (samples.length === 0) return UNKNOWN_RTT
    let smallest = Number.POSITIVE_INFINITY
    for (const sample of samples) if (sample < smallest) smallest = sample
    return Math.round(smallest)
  }

  return {
    due: (nowMs: number) => nowMs >= dueMs,

    ping(nowMs: number, tick: number, queued: number): ServerPing {
      // Scheduled from *now* rather than from the last due time. A room whose
      // beat was late must not then fire a burst of pings catching up on a
      // measurement that is only useful when it is current.
      dueMs = nowMs + intervalMs
      const id = nextId
      nextId += 1
      outstanding.push({ id, sentMs: nowMs })
      while (outstanding.length > maxOutstanding) {
        outstanding.shift()
        stats.abandoned += 1
      }
      stats.sent += 1
      return { t: 'ping', id, tick, rttMs: filtered(), queued }
    },

    pong(id: number, nowMs: number): number {
      const at = outstanding.findIndex((entry) => entry.id === id)
      if (at < 0) {
        stats.unmatched += 1
        return UNKNOWN_RTT
      }
      const [entry] = outstanding.splice(at, 1)
      if (entry === undefined) return UNKNOWN_RTT

      // Everything minted before this one is written off rather than left to be
      // answered later: a pong that overtook its predecessors tells us the
      // predecessors are not coming, and keeping them would let a client answer
      // a stale ping at leisure and call it a round trip.
      stats.abandoned += at
      outstanding.splice(0, at)

      // Never negative: the clock is monotonic (`clock.ts`), so this is a
      // subtraction of two readings of the same one.
      const rtt = nowMs - entry.sentMs
      samples.push(rtt)
      while (samples.length > window) samples.shift()
      stats.matched += 1
      return rtt
    },

    get rttMs() {
      return filtered()
    },

    get samples() {
      return samples.length
    },

    get outstanding() {
      return outstanding.length
    },

    get stats(): ClockSyncStats {
      return { ...stats }
    },
  }
}
