/**
 * `teleport` — step on to the pad; the distance travelled is not a distance.
 *
 * There is no teleporter in `arena1` and there is none in the simulation: nothing
 * in `packages/sim` moves a body because it stood somewhere. The kind exists in
 * `nav/schema.ts` because leaving it out would mean the first map that wants one
 * changes the format version, and this controller exists because the kind does —
 * a link kind with no controller is a route the bot walks into and stops on, and
 * the dispatch in `travel/index.ts` is exhaustive by type precisely so that
 * cannot happen quietly.
 *
 * Walking on to a pad is all a teleport ever asks of the *player*, so this is a
 * walk with one difference, and the difference is the whole reason it is not
 * `walkTravel` under another name: **arrival is horizontal only**. The far end of
 * a teleport link is wherever the pad's exit is, at whatever height, so the
 * height test {@link arrivedAt} applies would compare the bot against a node it is
 * never going to be within a step of. The hop is over when the bot reaches the
 * pad; what happens next is the pad's business.
 *
 * When a teleporter does arrive, the thing to check here is whether `to` should
 * name the pad or the exit. Today the graph has no way to say both, which is the
 * honest reason this is the thinnest file in the directory.
 */

import { NAV_ARRIVE_RADIUS } from '../nav/validate.ts'
import { wishTowards } from './travel.ts'
import type { Travel, TravelIntent, Traveller } from './travel.ts'

export const teleportTravel: Traveller = (travel: Travel, out: TravelIntent): TravelIntent => {
  wishTowards(travel, out)
  out.jump = false
  out.arrived = travel.flat <= NAV_ARRIVE_RADIUS
  return out
}
