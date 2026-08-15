/**
 * The host's clock, as a value somebody hands you.
 *
 * `packages/sim` has no clock at all — it advances by a fixed timestep and
 * knows only its tick number, and `Date.now()` is a lint error in there. The
 * host is the layer that *does* look at wall-clock, and this is the seam that
 * keeps that from being an ambient global.
 *
 * Two reasons it is injected rather than read:
 *
 * 1. **Tests.** A room's wall-clock behaviour — a peer that has gone quiet, a
 *    session that has been open too long — is otherwise only testable by
 *    waiting for it, and a suite that waits is a suite nobody runs. With a
 *    `manualClock` the same behaviour is a function call.
 * 2. **The listen server.** The same `Room` runs on Fly and in a browser tab
 *    (GLAD-4G4W2T). A module that reached for a Node timer would not be
 *    isomorphic, and the whole point of the pattern is that there is one host,
 *    not two.
 *
 * Nothing here reaches the simulation. A room's world advances by the commands
 * it receives, never by how much wall-clock has gone past — which is precisely
 * what makes one recorded input stream produce the same state hash over a
 * socket and in-process. See `room.ts`.
 */

export type Clock = {
  /**
   * Milliseconds, monotonic, with an arbitrary origin.
   *
   * Only ever compared against another reading from the *same* clock. It is not
   * a wall-clock date and must never be sent to a peer as one. Agreeing on time
   * between two machines is clock sync, and the only reading of this clock that
   * ever leaves the process is a *difference* between two of them: the round
   * trip `clockSync.ts` measures from a ping it minted itself.
   */
  nowMs(): number
}

/**
 * The real one.
 *
 * `performance.now()` rather than `Date.now()`: it is monotonic, so an NTP step
 * or a daylight-saving jump cannot make an interval come out negative, and both
 * Node and every browser this game supports have had it global for years.
 */
export function systemClock(): Clock {
  return { nowMs: () => performance.now() }
}

export type ManualClock = Clock & {
  /** Move time forward. Returns the new reading. */
  advance(ms: number): number
  /** Put the clock at an absolute reading. */
  set(ms: number): void
}

/**
 * A clock that only moves when a test says so.
 *
 * This is what lets an integration test run a full match — thousands of ticks —
 * in the time it takes to run them, rather than in the minute they would take
 * on a wall clock.
 */
export function manualClock(startMs = 0): ManualClock {
  let nowMs = startMs
  return {
    nowMs: () => nowMs,
    advance(ms: number) {
      nowMs += ms
      return nowMs
    },
    set(ms: number) {
      nowMs = ms
    },
  }
}
