/**
 * Asking the nav graph things, at 125 Hz, without searching for anything.
 *
 * Every function below is a table read. Not "a fast search", not "a search with
 * a cache in front of it" — a read, of an index computed by one multiply and
 * one add. There is no frontier, no priority queue, no visited set and no
 * allocation anywhere in this file, because all of that already happened once
 * in `bake.ts` and its answers are in the artifact.
 *
 * That is the property worth protecting, so it is worth saying what would break
 * it: any loop in here whose length depends on {@link LoadedNav.nodeCount}.
 * `navPath` walks a route, which is bounded by the *route's* length and does
 * one read per hop; {@link nodeNear} reads nine grid cells, which is a constant
 * chosen at bake time. `query.test.ts` measures both by counting table reads
 * and comparing a seventy-node graph against a three-node one — if the counts
 * ever start to differ, a search has appeared.
 *
 * ## Indices, not ids
 *
 * Everything is a node *index*. Ids are for authoring and for diagnostics;
 * {@link nodeIndexOf} is the one place a string turns into a number, and a bot
 * calls it during setup rather than during a tick.
 */

import type { MutVec3, Vec3 } from '@gladiator/sim'

import type { LoadedNav } from './load.ts'
import { NAV_LINK_KINDS, NO_NODE, type NavLinkKind } from './schema.ts'

/**
 * The node to move towards *right now* in order to reach `to`, or
 * {@link NO_NODE}.
 *
 * One read. A path follower asks this every time it arrives somewhere and never
 * holds a plan, which is why a bot knocked off its route by a rocket recovers
 * without replanning: it lands somewhere, asks again, and the answer is already
 * correct for where it landed.
 */
export function nextHop(nav: LoadedNav, from: number, to: number): number {
  return nav.nextHop[from * nav.nodeCount + to] ?? NO_NODE
}

/**
 * What the whole route from `from` to `to` costs, in Quake units of equivalent
 * walking, or `Infinity` if there is no route.
 *
 * `Infinity` rather than a sentinel, so that the comparison a bot actually
 * writes — "which of these three positions is cheapest to get to" — cannot
 * accidentally pick the unreachable one.
 */
export function routeCost(nav: LoadedNav, from: number, to: number): number {
  const cost = nav.cost[from * nav.nodeCount + to] ?? -1
  return cost < 0 ? Infinity : cost
}

/**
 * Can a player standing on `a` see one standing on `b`, eye to eye.
 *
 * One read and a shift. This is the lookup the whole bake exists for: breaking
 * line of sight is the thing a duel bot does that a bad one does not, and
 * without this it is a ray trace per candidate position per tick.
 */
export function canSee(nav: LoadedNav, a: number, b: number): boolean {
  const word = nav.vis[a * nav.visWords + (b >>> 5)] ?? 0
  return (word & (1 << (b & 31))) !== 0
}

/**
 * How to get from `from` to the node next door, or `null` if they are not
 * neighbours.
 *
 * The companion to {@link nextHop}: that says *where*, this says *which
 * traversal controller*. Each kind maps to exactly one of them in the bot's
 * movement (GLAD-TSED8V), which is why the set is small and closed.
 */
export function hopKind(nav: LoadedNav, from: number, to: number): NavLinkKind | null {
  const kind = nav.linkKind[from * nav.nodeCount + to] ?? NO_NODE
  return kind === NO_NODE ? null : (NAV_LINK_KINDS[kind] ?? null)
}

/**
 * Write the whole route into `out`, `from` first and `to` last, and return how
 * many nodes it wrote. Zero when there is no route.
 *
 * One read per hop, and the hop count is bounded by the node count because a
 * shortest path never visits a node twice — the bound is a backstop against a
 * corrupt table, not a search.
 *
 * A path follower does not need this; it needs {@link nextHop}. This is for the
 * things that want to look at a route rather than walk it: a debug overlay, a
 * test, and the bot deciding whether the way to a position goes past the
 * player it is trying to avoid.
 */
export function navPath(nav: LoadedNav, from: number, to: number, out: number[]): number {
  out.length = 0
  if (nextHop(nav, from, to) === NO_NODE) return 0

  let at = from
  out.push(at)
  while (at !== to) {
    at = nextHop(nav, at, to)
    if (at === NO_NODE || out.length > nav.nodeCount) {
      out.length = 0
      return 0
    }
    out.push(at)
  }
  return out.length
}

/* --------------------------------------------------------------------------
 * Getting on to the graph
 * ----------------------------------------------------------------------- */

/**
 * How much a unit of height counts for against a unit of ground distance when
 * deciding which node a position is "at".
 *
 * Sixteen, and `map/reachability.ts` weights its own nearest-cell search the
 * same way for the same reason: a player on a walkway is at the walkway under
 * their feet, not at the floor two hundred units below it, even when the floor
 * is nearer in a straight line.
 */
const HEIGHT_WEIGHT = 16

/**
 * The node nearest `origin`, or {@link NO_NODE} if there is none close by.
 *
 * Nine cells of the locate grid — the one containing the point and its eight
 * neighbours — and whatever nodes are in them. That is constant work in the
 * size of the graph, bounded by how many nodes stack in one 128-unit column,
 * which in a duel arena is the floor, a walkway and a roof.
 *
 * It answers {@link NO_NODE} rather than widening the search, and the
 * difference matters: widening is a search, and "there is no node within a
 * cell of here" is a real answer a bot can act on — it means the bot is
 * somewhere the graph does not describe, which is a thing to walk out of, not
 * to route from.
 */
export function nodeNear(nav: LoadedNav, origin: Vec3): number {
  const grid = nav.grid
  const cx = Math.floor((origin[0] - grid.minX) / grid.cell)
  const cy = Math.floor((origin[1] - grid.minY) / grid.cell)

  let best = NO_NODE
  let bestScore = Infinity

  for (let oy = -1; oy <= 1; oy += 1) {
    const y = cy + oy
    if (y < 0 || y >= grid.ny) continue
    for (let ox = -1; ox <= 1; ox += 1) {
      const x = cx + ox
      if (x < 0 || x >= grid.nx) continue
      const c = y * grid.nx + x
      const end = grid.cellStart[c + 1] ?? 0
      for (let s = grid.cellStart[c] ?? 0; s < end; s += 1) {
        const i = grid.cellNodes[s] ?? NO_NODE
        if (i < 0) continue
        const dx = (nav.origins[i * 3] ?? 0) - origin[0]
        const dy = (nav.origins[i * 3 + 1] ?? 0) - origin[1]
        const dz = (nav.origins[i * 3 + 2] ?? 0) - origin[2]
        const score = dx * dx + dy * dy + HEIGHT_WEIGHT * dz * dz
        if (score >= bestScore) continue
        bestScore = score
        best = i
      }
    }
  }

  return best
}

/** The index of a node by its authored id, or {@link NO_NODE}. Setup, not a tick. */
export function nodeIndexOf(nav: LoadedNav, id: string): number {
  return nav.index.get(id) ?? NO_NODE
}

/** Write node `i`'s origin — the player's feet — into `out`. */
export function nodeOrigin(nav: LoadedNav, i: number, out: MutVec3): MutVec3 {
  out[0] = nav.origins[i * 3] ?? 0
  out[1] = nav.origins[i * 3 + 1] ?? 0
  out[2] = nav.origins[i * 3 + 2] ?? 0
  return out
}

/** Is node `i` on the routing network, as opposed to a perch nothing reaches yet. */
export function isGround(nav: LoadedNav, i: number): boolean {
  return nav.ground[i] === 1
}
