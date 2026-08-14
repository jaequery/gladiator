/**
 * `PM_Accelerate` — the four lines of arithmetic that *are* strafe-jumping.
 * `docs/physics-spec.md` §1.4.
 *
 * ## The mechanic, stated plainly
 *
 * The gate is
 *
 * ```
 * addspeed = wishspeed - dot(velocity, wishdir)
 * ```
 *
 * — a **projection**, not a magnitude. The question it asks is not "are you
 * already going 320?" but "are you already going 320 *in the direction you are
 * asking for*?". Turn 85 degrees away from your velocity and the projection
 * collapses toward zero, the gate swings open however fast you are travelling,
 * and the acceleration that lands is mostly perpendicular — which adds to the
 * length of the vector rather than replacing it. Do that every tick while
 * airborne and speed compounds without bound.
 *
 * id shipped this deliberately. The alternative is right there in `bg_pmove.c`
 * behind `#if 0`, commented *"proper way (avoids strafe jump maxspeed bug), but
 * feels bad"*. **Preserve this exactly. It is the mechanic, not a bug**, and a
 * future refactor that "fixes" it deletes the skill ceiling of the game.
 *
 * `pmove.test.ts` asserts that accelerating *perpendicular* to the velocity
 * increases total speed, precisely so that such a refactor fails a test instead
 * of a playtest.
 *
 * ## What is deliberately not here
 *
 * `airControl` stays **0** and the CPM strafe path is cut. CPM's `pm_airControl`
 * rotates velocity toward the wish direction when the player holds W alone,
 * which makes a second, easier acceleration technique discoverable — but it
 * accelerates at roughly half the rate of the diagonal path it is meant to
 * teach, so a player who finds it first learns the slower movement and has to
 * unlearn it. One movement vocabulary, not two.
 */

import { dotVec3 } from '../math.ts'
import type { Vec3 } from '../axis.ts'
import type { MutVec3 } from '../math.ts'

/**
 * Ground acceleration, in units of wishspeed per second. Quake 3's
 * `pm_accelerate`.
 *
 * 10 means the accelerate step is worth `10 * dt * wishspeed` = 25.6 qu/s per
 * tick at full stick, so a standing start reaches 320 ups in 19 ticks — 152 ms
 * — once friction has taken its cut on the way up.
 */
export const PM_ACCELERATE = 10

/**
 * Air acceleration. Quake 3's `pm_airaccelerate`.
 *
 * A tenth of the ground figure: 2.56 qu/s per tick. Small enough that it
 * cannot turn you in the air, large enough that pointing it 85 degrees off your
 * velocity every tick compounds into 830 ups over four jumps.
 */
export const PM_AIR_ACCELERATE = 1

/**
 * Air acceleration when the wish direction *opposes* the velocity. CPMA's
 * `pm_airstopaccelerate`.
 *
 * The one borrowing from Challenge ProMode in the whole movement port, and it
 * is here because VQ3's air control is otherwise so weak that a mistimed jump
 * cannot be corrected at all — you commit to a trajectory at take-off and ride
 * it into a wall. 2.5 gives an airborne player enough authority to kill speed
 * they did not want, and none to gain speed they did not earn: it applies **if
 * and only if** `dot(velocity, wishdir) < 0`, so it can only ever slow you down
 * along your current heading.
 */
export const AIR_STOP_ACCELERATE = 2.5

/**
 * CPM-style air control. **Zero, deliberately** — see the note at the top of
 * this file. Named rather than absent so that "is air control on?" has an
 * answer in the code rather than in a commit message.
 */
export const AIR_CONTROL = 0

/**
 * Add `accel * dt * wishspeed` of speed along `wishdir`, gated on the
 * projection of the current velocity onto it. Mutates `velocity` in place.
 *
 * `wishdir` must be unit length or zero; `wishspeed` is in qu/s.
 */
export function accelerate(
  velocity: MutVec3,
  wishdir: Vec3,
  wishspeed: number,
  accel: number,
  dt: number,
): void {
  // The projection. Everything interesting about Quake movement is this line.
  const currentspeed = dotVec3(velocity, wishdir)
  const addspeed = wishspeed - currentspeed
  if (addspeed <= 0) return

  let accelspeed = accel * dt * wishspeed
  if (accelspeed > addspeed) accelspeed = addspeed

  velocity[0] += accelspeed * wishdir[0]
  velocity[1] += accelspeed * wishdir[1]
  velocity[2] += accelspeed * wishdir[2]
}

/**
 * Which air acceleration applies to this wish direction.
 *
 * Split out so the "if and only if" in {@link AIR_STOP_ACCELERATE} is a
 * function someone can read and test, rather than a ternary buried in
 * `PM_AirMove`.
 */
export function airAccelerationFor(velocity: Vec3, wishdir: Vec3): number {
  return dotVec3(velocity, wishdir) < 0 ? AIR_STOP_ACCELERATE : PM_AIR_ACCELERATE
}
