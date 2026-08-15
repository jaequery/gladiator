/**
 * What a traversal controller is, and the two questions every one of them
 * answers. GLAD-TSED8V.
 *
 * `nav/schema.ts` declares four link kinds — `walk`, `jump`, `drop`, `teleport` —
 * and says that each maps to **exactly one** traversal controller here, mirroring
 * Quake 3's `BotTravel_*` split. That is the reason the set is small and closed:
 * a kind nothing can execute is a route the bot walks into and stops on, so the
 * dispatch in `travel/index.ts` is exhaustive by *type* rather than by review.
 *
 * ## Two questions, and neither of them is "where should I go"
 *
 * A controller is handed a link it is already on and the body that is on it. It
 * answers:
 *
 * - **which horizontal direction** to ask for this sub-step, as a unit vector in
 *   world space — never as axes, because axes depend on the yaw and the yaw
 *   belongs to the aim controller (`movement/steer.ts`);
 * - **whether to press jump**, once, this sub-step;
 *
 * and it reports **whether the hop is done**, which is what makes the follower ask
 * the graph for the next one (`movement/move.ts`).
 *
 * It does not choose the link, it does not know what the route is, and it does not
 * touch the ledge guard — a `drop` controller that had to remember to switch the
 * guard off would be one refactor away from a bot that walks off every ledge in
 * the arena. The follower owns all three.
 */

import { vec3 } from '@gladiator/sim'
import type { MutVec3, Vec3 } from '@gladiator/sim'

import { NAV_MAX_STEP } from '../nav/schema.ts'
import { NAV_ARRIVE_RADIUS } from '../nav/validate.ts'

/** The body, and the link it is on. Read-only: a controller writes nothing. */
export type Travel = {
  /** The bot's own feet. */
  readonly origin: Vec3
  readonly velocity: Vec3
  /** `EntityFlag.OnGround` — `walking`, not merely touching a surface. */
  readonly onGround: boolean
  /** The node the hop started from. */
  readonly from: Vec3
  /** Where the hop ends: a node, or the goal itself on the last leg. */
  readonly to: Vec3
  /** Horizontal distance from {@link origin} to {@link to}. Precomputed once. */
  readonly flat: number
  /** `to[2] - origin[2]`: how much of the climb is left. */
  readonly rise: number
}

/** One sub-step of intent from a traversal controller. */
export type TravelIntent = {
  /** A horizontal unit vector to travel along, or all zeroes for "stand". */
  readonly wish: MutVec3
  /** Whether this controller wants the jump button held this sub-step. */
  jump: boolean
  /** Whether the hop is finished and the follower should ask for the next one. */
  arrived: boolean
}

/** An intent asking for nothing. */
export function createIntent(): TravelIntent {
  return { wish: vec3(), jump: false, arrived: false }
}

/** A traversal controller: one link kind's worth of driving. */
export type Traveller = (travel: Travel, out: TravelIntent) => TravelIntent

/**
 * Point the wish at the far end of the hop.
 *
 * Every controller starts here, because every controller is trying to get to the
 * same place — they differ in what they do with the jump button and in what
 * counts as having arrived. Recomputed every sub-step rather than held from the
 * start of the hop: the axes are quantised to eight directions
 * (`movement/steer.ts`), so a heading held from the start would miss by up to
 * 24.5 degrees over the whole link, and one recomputed every sub-step zig-zags into
 * the target instead.
 */
export function wishTowards(travel: Travel, out: TravelIntent): void {
  const dx = travel.to[0] - travel.origin[0]
  const dy = travel.to[1] - travel.origin[1]
  const length = Math.sqrt(dx * dx + dy * dy)
  out.wish[0] = length === 0 ? 0 : dx / length
  out.wish[1] = length === 0 ? 0 : dy / length
  out.wish[2] = 0
}

/**
 * Has the bot got there?
 *
 * {@link NAV_ARRIVE_RADIUS} horizontally — imported from the validator, because
 * "close enough to let go of this node and steer at the next one" is the same
 * question `nav/validate.ts` asks when it decides whether a link is walkable, and
 * two answers to it would be two different graphs.
 *
 * And within a step vertically, which is the half that matters: the floor and the
 * mound ring in `arena1` are 24 units apart horizontally at the ring's corners and
 * 48 apart vertically, so a bot that arrived on horizontal distance alone would
 * count standing underneath a walkway as standing on it.
 */
export function arrivedAt(travel: Travel): boolean {
  return travel.flat <= NAV_ARRIVE_RADIUS && Math.abs(travel.rise) <= NAV_MAX_STEP
}
