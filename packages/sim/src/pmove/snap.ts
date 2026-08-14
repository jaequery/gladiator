/**
 * Integer velocity snapping. Quake's `SnapVector`, and
 * `docs/physics-spec.md` §0.1 and §1.6.
 *
 * Quake snapped velocity to whole units so it would survive being sent over the
 * network as an integer. Gladiator does not need that — a `f64` crosses the
 * wire intact — and keeps it anyway, because two decades of movement was tuned
 * *through* the rounding and the numbers do not survive its removal.
 *
 * The worked example is gravity. `GRAVITY * TICK_DT` is 6.4 qu/s of downward
 * velocity per sub-step; a whole number minus 6.4 always has a fractional part
 * of .6 and always rounds up, so the velocity a player actually loses is **6**,
 * every tick, in both directions. The gravity that is *felt* is therefore
 * `6 / 0.008` = 750, not 800, and the jump apex is `270^2 / 1500` = 48.6 units
 * rather than 45.6. Three units is the difference between clearing a ledge and
 * not.
 *
 * ## Round to nearest, not truncate
 *
 * Quake 3 on x86 snapped with `fistp`, which rounds to nearest. The portable
 * fallback in the released source is a C cast, which truncates — and truncation
 * would decrement velocity by 7 rather than 6 every tick, giving an effective
 * gravity of 875 and a 41.6-unit jump. Gladiator specifies round-to-nearest
 * (`Math.round`) so there is exactly one answer, and `pmove.test.ts` asserts
 * the resulting decrement is 6 rather than trusting the reading.
 *
 * `Math.round` is exactly specified by ECMA-262 — unlike `Math.sin` and
 * friends, it is not "implementation-approximated" — so this is safe inside the
 * simulation boundary.
 */

import type { MutVec3 } from '../math.ts'

/**
 * Round every component of `velocity` to the nearest whole unit, in place.
 *
 * The `+ 0` is not decoration: `Math.round(-0.4)` is `-0`, and while the state
 * hash folds `-0` to `+0` before digesting (`encoding.ts`), a `-0` sitting in
 * the live state still makes `Object.is` comparisons and test assertions
 * disagree with the arithmetic. `-0 + 0` is `+0` in IEEE 754, exactly, so one
 * addition removes the whole class of surprise.
 */
export function snapVelocity(velocity: MutVec3): void {
  velocity[0] = Math.round(velocity[0]) + 0
  velocity[1] = Math.round(velocity[1]) + 0
  velocity[2] = Math.round(velocity[2]) + 0
}
