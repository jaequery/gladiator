/**
 * `drop` — run off the edge and fall; no jump, and no way back.
 *
 * A jump run backwards, and driven that way: hold the direction across the gap and
 * let gravity do the rest. Three things make it its own controller rather than a
 * walk that happens to descend.
 *
 * **It must not jump.** Jumping off a ledge adds 270 qu/s upward, which is 0.36
 * seconds of extra flight and a third of a second of a bot hanging in the air
 * unable to steer while somebody aims a rail at it. `nav/schema.ts` prices a drop
 * *below* a jump for the same reason.
 *
 * **The ledge guard is off for it**, which is the follower's doing rather than
 * this file's (`movement/move.ts`) — a guard that stopped the bot walking off a
 * ledge would stop it taking every drop link in the graph, so the exemption is
 * exactly the two kinds that mean "there is supposed to be nothing under you".
 *
 * **It arrives at the bottom, not at the edge.** {@link arrivedAt} is horizontal
 * distance *and* height within a step, so the hop is not finished until the body
 * has actually landed near the far node. Ending it at the lip would hand the next
 * hop to a follower whose bot is 48 units in the air and steering at something
 * else, which is how a drop turns into a fall into the wrong place.
 *
 * While it is falling the wish direction is still recomputed every sub-step, and
 * that is not "fighting the air-control model" — the follower latches the axes at
 * take-off and this controller's direction is only consulted again when the latch
 * is spent (`movement/move.ts`). Air acceleration is a tenth of the ground figure;
 * what it buys on a drop is the two or three units of forward travel that turn
 * landing on the lip into landing on the floor.
 */

import { arrivedAt, wishTowards } from './travel.ts'
import type { Travel, TravelIntent, Traveller } from './travel.ts'

export const dropTravel: Traveller = (travel: Travel, out: TravelIntent): TravelIntent => {
  wishTowards(travel, out)
  out.jump = false
  out.arrived = arrivedAt(travel)
  return out
}
