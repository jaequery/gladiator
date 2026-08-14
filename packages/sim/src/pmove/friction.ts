/**
 * `PM_Friction` — Quake 3's `bg_pmove.c`, and `docs/physics-spec.md` §1.3.
 *
 * Friction is a *fraction of the current speed* removed every tick, with a
 * floor under it. The floor is {@link PM_STOPSPEED}: below 100 ups the drop is
 * computed as though you were doing 100, which is what makes a player come to
 * a stop in finite time instead of asymptotically creeping toward zero.
 *
 * Two things about this function decide how the game feels, and neither is the
 * coefficient:
 *
 * 1. **It only applies while `walking`.** In the air there is no friction at
 *    all — that is the whole reason speed carried into a jump survives it, and
 *    the reason strafe-jumping compounds. The one thing that still happens in
 *    the air is the `speed < 1` snap to rest, which is Quake's and keeps a
 *    denormal drift from living forever in the state hash.
 * 2. **The caller decides whether it runs at all.** `PM_CheckJump` runs
 *    *before* this inside `PM_WalkMove` and clears `walking` when it succeeds,
 *    so a frame-perfect landing-then-jump pays no friction whatsoever. Miss the
 *    tick and you pay 4.8% of your speed. That difference is the bunny hop.
 */

import { lengthVec2, lengthVec3 } from '../math.ts'
import type { MoveBody } from '../slidemove.ts'

/**
 * How much of the current speed ground friction removes per second. Quake 3's
 * `pm_friction`.
 *
 * At the 8 ms sub-step that is `6 * 0.008` = **4.8% of your speed per tick**,
 * which is the number a bunny hop is measured against: one missed jump costs
 * 4.8%, and at 800 ups that is 38 units of speed for one tick of sloppiness.
 */
export const PM_FRICTION = 6

/**
 * The speed friction pretends you are doing when you are slower than it, in
 * qu/s. Quake 3's `pm_stopspeed`.
 *
 * Without the floor, `drop = speed * friction * dt` is proportional to speed
 * and a player decelerating from a walk never actually arrives at zero. With
 * it, everything under 100 ups sheds a flat 4.8 qu/s per tick and stops.
 */
export const PM_STOPSPEED = 100

/**
 * Below this speed a body is simply stopped, in qu/s. Quake 3's bare `1`.
 *
 * Horizontal only: `z` is left alone so that a body which is barely moving
 * sideways but falling keeps falling.
 */
const REST_SPEED = 1

/**
 * Shed friction from `body.velocity`, in place.
 *
 * `dt` is seconds — `TICK_DT` in the simulation, and a parameter here only so
 * that a test can state a rate rather than count ticks.
 */
export function friction(body: MoveBody, dt: number): void {
  const velocity = body.velocity

  // Quake zeroes `vec[2]` before measuring while walking: on a slope you are
  // moving vertically as a consequence of moving horizontally, and charging
  // friction for it would make ramps sticky.
  const speed = body.walking ? lengthVec2(velocity) : lengthVec3(velocity)

  if (speed < REST_SPEED) {
    velocity[0] = 0
    velocity[1] = 0
    return
  }

  let drop = 0

  // No friction while being knocked back. This is Quake's `PMF_TIME_KNOCKBACK`
  // and it is what stops the floor from filing a rocket jump's speed off in the
  // first few ticks, before the player has left the ground.
  if (body.walking && body.knockbackTicks === 0) {
    const control = speed < PM_STOPSPEED ? PM_STOPSPEED : speed
    drop += control * PM_FRICTION * dt
  }

  let newspeed = speed - drop
  if (newspeed < 0) newspeed = 0
  newspeed /= speed

  velocity[0] *= newspeed
  velocity[1] *= newspeed
  velocity[2] *= newspeed
}
