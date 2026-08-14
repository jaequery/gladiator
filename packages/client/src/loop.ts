/**
 * The fixed-timestep accumulator.
 *
 * The simulation advances 125 times a second and the display refreshes at
 * whatever rate the monitor feels like. This is the piece that keeps those two
 * facts from contaminating each other: wall-clock time goes in, a whole number
 * of ticks comes out, and the remainder is carried.
 *
 * It lives in the client, not the sim, because it is the one part of the loop
 * that has to *look at a clock*. The sim knows only its tick number.
 */
import { TICK_INTERVAL_MS } from '@gladiator/sim'

/**
 * The longest frame the accumulator will believe.
 *
 * A backgrounded tab, a garbage-collection pause or a laptop lid produce a
 * frame of several seconds. Simulating all of it takes longer than a frame,
 * which produces an even longer frame — the spiral of death. Past this, time is
 * dropped on the floor: the player teleports slightly rather than the tab
 * locking up, and the server's own tick numbering is the thing that keeps the
 * two ends honest about it.
 */
export const MAX_FRAME_MS = 250

export type StepResult = {
  /** Whole ticks to simulate this frame. */
  readonly ticks: number
  /** Milliseconds carried into the next frame, always `< TICK_INTERVAL_MS`. */
  readonly accumulatorMs: number
  /** Milliseconds discarded by the {@link MAX_FRAME_MS} clamp. */
  readonly droppedMs: number
}

/**
 * Fold `elapsedMs` of wall-clock into `accumulatorMs` and say how many ticks
 * that buys. Pure — the clock is read by the caller, once.
 */
export function advance(accumulatorMs: number, elapsedMs: number): StepResult {
  const usable = elapsedMs > MAX_FRAME_MS ? MAX_FRAME_MS : elapsedMs > 0 ? elapsedMs : 0
  const droppedMs = elapsedMs > MAX_FRAME_MS ? elapsedMs - MAX_FRAME_MS : 0
  const total = accumulatorMs + usable
  const ticks = Math.floor(total / TICK_INTERVAL_MS)
  return { ticks, accumulatorMs: total - ticks * TICK_INTERVAL_MS, droppedMs }
}

/**
 * How far between the last tick and the next one we are, in `[0, 1)`.
 *
 * Rendering the newest state directly makes 125 Hz motion visibly stepped on a
 * 144 Hz display. Interpolating the *previous* and *current* states by this
 * fraction is the cheapest fix; the real interpolator, which also has to deal
 * with the opponent arriving late, is GLAD-0IDR6J.
 */
export function alphaOf(accumulatorMs: number): number {
  return accumulatorMs / TICK_INTERVAL_MS
}
