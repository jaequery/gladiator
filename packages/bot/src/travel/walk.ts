/**
 * `walk` — hold forward; the ground carries you, steps and ramps included.
 *
 * The simplest controller and the one the bot spends almost all of its time in,
 * which is why the interesting things about it are all things it deliberately does
 * **not** do.
 *
 * **It never presses jump.** A walk link is a link whose every rise is at most
 * {@link NAV_MAX_STEP} (`nav/schema.ts`), which is precisely the definition of "a
 * rise `StepSlideMove` climbs for you". Jumping on a walk would cost the bot the
 * one thing this link kind is priced for: a jump commits you to an arc you cannot
 * steer out of, which is the worst thing to be doing when a rocket arrives. The
 * one jump a walk ever produces is the circle jump, and that is the follower's
 * decision on a straight run rather than this controller's
 * (`movement/circleJump.ts`).
 *
 * **It does not slow down to arrive.** {@link NAV_ARRIVE_RADIUS} exists so that
 * arriving is a radius rather than a coordinate — no movement code that carries
 * momentum can stop dead on a point, and asking it to would produce a bot that
 * stutters at every waypoint. It overshoots, the follower asks the graph again
 * from wherever it actually is, and the answer is already correct.
 *
 * **It does not steer around anything.** Obstacle avoidance on a hand-authored
 * graph is a category error: if there is something in the way of a link, the link
 * is wrong and `nav/validate.ts` is what should have said so — it walks every walk
 * link with the real `pmove` at bake time. What is left at run time is the ledge
 * guard, which is about the ground rather than about obstacles, and it belongs to
 * the follower.
 */

import { arrivedAt, wishTowards } from './travel.ts'
import type { Travel, TravelIntent, Traveller } from './travel.ts'

export const walkTravel: Traveller = (travel: Travel, out: TravelIntent): TravelIntent => {
  wishTowards(travel, out)
  out.jump = false
  out.arrived = arrivedAt(travel)
  return out
}
