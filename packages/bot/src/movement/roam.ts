/**
 * Where a bot goes when it has nothing to go towards.
 *
 * `brain.ts` says it, and this is the file it is pointing at: *"Sweeping for a
 * target is search behaviour and belongs with the movement that would carry it
 * out."* So the decision layer fills in a goal when it has a reason to, and the
 * absence of one is answered here rather than by standing still.
 *
 * Standing still is not a neutral default. A bot with no contact is the *normal*
 * state of a duel on `arena1` — the tower breaks the spawn-to-spawn sightline on
 * purpose, so neither player can see the other until somebody moves — and a bot
 * that waited would make the map's central design decision into a stalemate.
 *
 * ## A node, drawn from the bot's own stream
 *
 * One `ground` node at a time, uniformly, from the bot's seeded PRNG (`bot.ts`).
 * Uniform rather than weighted towards the last known contact, and the reason is
 * the fairness boundary: a search that biased towards where the opponent *is* would
 * be reading ground truth through the choice of where to look. Biasing towards the
 * last *believed* position is legitimate and is a decision the brain can make by
 * setting a goal, which is exactly the seam that already exists.
 *
 * Uniform over `ground` — never `perch` — because a perch is a position no v1 link
 * reaches (`nav/schema.ts`), so routing to one is a route that does not exist.
 * `isGround` is the predicate and the bake guarantees every ground node reaches
 * every other, which is what makes "pick one at random" total rather than a gamble.
 *
 * ## Why it is re-drawn on arrival and not on a timer
 *
 * A timer would abandon a route halfway for no reason a player could read. Arrival
 * is the event that means "this destination is spent"; the only other thing that
 * ends a roam is a contact, and that is the caller's business.
 */

import { rngInt } from '@gladiator/sim'
import type { RngHolder } from '@gladiator/sim'

import type { LoadedNav } from '../nav/load.ts'
import { isGround, routeCost } from '../nav/query.ts'
import { NO_NODE } from '../nav/schema.ts'

/**
 * How many draws to make before giving up and staying put.
 *
 * A graph with `ground` nodes in it will answer on the first draw almost always;
 * the loop exists because "pick a node that is not the one I am standing on and
 * that I can get to" is a rejection sample, and a rejection sample with no bound is
 * a hang. Eight is enough that failing is a graph with one reachable node in it,
 * which is a graph `nav/bake.ts` would have refused.
 */
const DRAWS = 8

/**
 * Pick somewhere to go, or {@link NO_NODE}.
 *
 * `from` is where the bot is on the graph; the answer is never `from`, and never
 * somewhere there is no route to. Advances `rng`.
 */
export function roamTarget(nav: LoadedNav, rng: RngHolder, from: number): number {
  if (nav.nodeCount === 0) return NO_NODE

  for (let draw = 0; draw < DRAWS; draw += 1) {
    const candidate = rngInt(rng, nav.nodeCount)
    if (candidate === from) continue
    if (!isGround(nav, candidate)) continue
    // `Infinity` rather than a sentinel is what makes this one comparison rather
    // than two (`nav/query.ts`), and the case it catches is real: a bot that has
    // fallen on to a `perch` is standing somewhere with no outgoing route at all.
    if (from !== NO_NODE && !Number.isFinite(routeCost(nav, from, candidate))) continue
    return candidate
  }

  return NO_NODE
}
