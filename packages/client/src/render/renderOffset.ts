/**
 * The render-only correction offset: the difference between where the player
 * was drawn and where the server says they are, decayed away over a tenth of a
 * second so that nobody sees it happen.
 *
 * This is the *only* place a reconciliation is allowed to be soft.
 * `net/reconcile.ts` states the rule it exists to keep: **the simulation always
 * takes the authoritative value immediately; only rendering lags.** A world
 * that was left half-corrected is the world the next replay starts from, so the
 * error compounds instead of decaying and the two peers drift apart while every
 * individual correction looks reassuringly small. Holding the difference *here*
 * — outside the state, in a value the simulation cannot read — is what makes
 * the smoothing safe.
 *
 * ## It is added to the eye, and to nothing else
 *
 * The camera is a puppet of simulation state (`docs/renderer.md` §1). This does
 * not break that: the offset is a pure function of corrections that have already
 * happened, applied after the interpolation and never read back. Nothing
 * downstream can reach `GameState` through it, and no simulation value is ever
 * computed from it.
 *
 * ## Linear, not exponential
 *
 * An exponential decay has a tail: it is never quite finished, so the camera
 * spends the rest of the session a fraction of a unit behind the simulation and
 * every measurement of "did prediction track" has that bias baked in. A linear
 * ramp is over exactly when it says it is over, which is what "decaying over
 * 100 ms" means and what a test can assert. It also makes the rate a function of
 * the distance, so a 100-unit correction and a 5-unit one take the same time
 * rather than the same speed.
 */
import type { Vec3 } from '@gladiator/sim'

export type RenderOffset = {
  /**
   * What to add to the interpolated eye position, in Quake units.
   *
   * Live — the same array every frame, mutated in place. Copy it if you need to
   * keep one.
   */
  readonly value: Vec3
  /** Milliseconds left before it reaches zero. */
  readonly remainingMs: number
  /** Whether there is anything left to draw. */
  readonly active: boolean
  /**
   * Carry `delta` for `decayMs`.
   *
   * Added to whatever is already in flight rather than replacing it, because
   * two corrections in quick succession are two things the camera owes the
   * player and dropping one of them would put a step back in.
   */
  push(delta: Vec3, decayMs: number): void
  /** Decay by one frame of wall-clock. */
  advance(elapsedMs: number): void
  /** Drop it. What a hard snap does: there is nothing honest left to smooth. */
  clear(): void
}

export function createRenderOffset(): RenderOffset {
  const value: [number, number, number] = [0, 0, 0]
  let remainingMs = 0

  return {
    value,

    get remainingMs() {
      return remainingMs
    },

    get active() {
      return remainingMs > 0
    },

    push(delta: Vec3, decayMs: number) {
      if (decayMs <= 0) return
      value[0] += delta[0]
      value[1] += delta[1]
      value[2] += delta[2]
      // The longer of the two windows. A large correction that is mid-decay
      // should not be hurried along by a small one landing on top of it — the
      // speed of the travel is what a player would notice, and shortening the
      // window is what makes it fast.
      if (decayMs > remainingMs) remainingMs = decayMs
    },

    advance(elapsedMs: number) {
      if (remainingMs <= 0 || !(elapsedMs > 0)) return
      if (elapsedMs >= remainingMs) {
        value[0] = 0
        value[1] = 0
        value[2] = 0
        remainingMs = 0
        return
      }
      // Scale by the fraction of the window that is left, which is exactly a
      // straight line to zero at the deadline whatever the frame rate is.
      const keep = (remainingMs - elapsedMs) / remainingMs
      value[0] *= keep
      value[1] *= keep
      value[2] *= keep
      remainingMs -= elapsedMs
    },

    clear() {
      value[0] = 0
      value[1] = 0
      value[2] = 0
      remainingMs = 0
    },
  }
}

/** `origin` with `offset` added. A fresh vector; the caller draws from it. */
export function withRenderOffset(origin: Vec3, offset: Vec3): Vec3 {
  return [origin[0] + offset[0], origin[1] + offset[1], origin[2] + offset[2]]
}
