/**
 * `jump` — run up and press jump; there is air under the middle of it.
 *
 * ## When to press it, and how that number was arrived at
 *
 * The gate is **as soon as the arc reaches**: on the ground, with the remaining
 * horizontal distance no further than {@link horizontalReachOf} says a jump with
 * this much climb left in it travels. That is the same envelope
 * `nav/validate.ts` accepts the link under, so the bot is executing exactly the
 * claim the bake checked rather than a second guess at it.
 *
 * "As soon as" rather than "at the last moment" is a measurement. On `arena1`'s
 * crate link — 80 units across, 40 up, with the crate's own face 63 units short
 * of the far node — every jump pressed from further out than that face arrives,
 * and every jump pressed nearer than it does not, because the body is already
 * standing against the wall by then. Pressing early costs nothing (the bot is on
 * the crate 21 sub-steps sooner than the latest arc that works) and it is the
 * gate that needs no second constant.
 *
 * There is one thing worth knowing about how it arrives, because it looks wrong
 * in a trace and is not: the body rises **into the lip** and slides up it. The
 * two-leg model the bake uses — rise at the near end, travel at the far height —
 * is the arc the *validator* checks, and a real parabola from a running start
 * clips the riser on the way up. `SlideMove` removes the velocity into the face,
 * the body keeps rising past the ledge on the jump it already has, and air
 * acceleration puts the two or three units of forward travel back once there is
 * nothing left to clip against. That is a Quake player getting on to a crate.
 *
 * ## Why the button is released in the air
 *
 * `PM_CheckJump` will not fire while `PMF_JUMP_HELD` is latched (`pmove/index.ts`),
 * and the latch is only cleared by a sub-step with the button *up*. So a
 * controller that held jump would make exactly one jump and then never another —
 * which is the bug the ticket names, and the reason this returns `jump: false` the
 * moment the body is off the ground.
 *
 * Quake has a second reason and this game does not: there, `upmove` counts in
 * `PM_CmdScale`'s denominator, so holding jump drops the air wishspeed from 320 to
 * 226. `pmove/cmdscale.ts` excludes the jump axis on purpose and `UserCmd` has no
 * `upmove` field for it to exclude, so that tax is gone. The latch is enough on
 * its own.
 */

import { JUMP_VELOCITY, horizontalReachOf } from '@gladiator/sim'

import { arrivedAt, wishTowards } from './travel.ts'
import type { Travel, TravelIntent, Traveller } from './travel.ts'

export const jumpTravel: Traveller = (travel: Travel, out: TravelIntent): TravelIntent => {
  wishTowards(travel, out)
  // A climb that has already been made is not a climb: mid-flight `rise` goes
  // negative, and `horizontalReachOf` of a negative climb is the reach of a fall,
  // which is not what is being asked. The clamp keeps the gate about the link.
  const climb = travel.rise > 0 ? travel.rise : 0
  out.jump = travel.onGround && travel.flat <= horizontalReachOf(JUMP_VELOCITY, climb)
  out.arrived = arrivedAt(travel)
  return out
}
