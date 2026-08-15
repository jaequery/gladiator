/**
 * The dispatch: one link kind, one controller, and a type error if that ever
 * stops being true.
 *
 * `satisfies Record<NavLinkKind, Traveller>` is the whole enforcement. Adding a
 * fifth kind to `nav/schema.ts` — `rocketjump` is the one that is coming — fails
 * to compile here until it has a controller, which is the difference between a
 * closed set and a set that is closed because nobody has added to it yet.
 *
 * There is deliberately no default case and no fallback controller. A fallback
 * would turn "this kind is not implemented" into "the bot walks at it and hopes",
 * which is the failure mode the exhaustive table exists to make impossible: on a
 * `rocketjump` link a walking bot would stand under a balcony holding forward
 * until the round ended.
 */

import type { NavLinkKind } from '../nav/schema.ts'
import { dropTravel } from './drop.ts'
import { jumpTravel } from './jump.ts'
import { teleportTravel } from './teleport.ts'
import type { Traveller } from './travel.ts'
import { walkTravel } from './walk.ts'

/** Every kind's controller. */
export const TRAVELLERS = {
  walk: walkTravel,
  jump: jumpTravel,
  drop: dropTravel,
  teleport: teleportTravel,
} as const satisfies Record<NavLinkKind, Traveller>

/** The controller for a link kind. Total, by construction. */
export function travellerFor(kind: NavLinkKind): Traveller {
  return TRAVELLERS[kind]
}

export { dropTravel } from './drop.ts'
export { jumpTravel } from './jump.ts'
export { teleportTravel } from './teleport.ts'
export { arrivedAt, createIntent, wishTowards } from './travel.ts'
export type { Travel, TravelIntent, Traveller } from './travel.ts'
export { walkTravel } from './walk.ts'
