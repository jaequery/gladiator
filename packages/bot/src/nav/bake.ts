/**
 * The nav baker: validate, then turn a graph into three tables of numbers.
 *
 * Everything expensive happens exactly once, here, and never again. That is the
 * whole design: a bot asks "where do I go next" up to 125 times a second, and
 * the answer has to be an array read rather than a search. `query.ts` is what
 * does the reading; this is what makes the reading possible.
 *
 * ## Why all-pairs, and why that is not extravagant
 *
 * Floyd-Warshall is O(n³), which sounds like a reason not to. At seventy nodes
 * it is three hundred thousand iterations of an add and a compare — a couple of
 * milliseconds, once, at bake time. In exchange every path query in the game
 * becomes one indexed read, forever.
 *
 * This is exactly the trade Quake 3's AAS could not make. AAS routes across
 * hundreds of areas on maps it has never seen, so it needs a two-level
 * cluster-and-portal cache computed lazily at runtime. We have one arena and
 * seventy nodes, so the entire cache collapses into a table small enough to
 * commit to the repository and read in a diff.
 *
 * ## Why the visibility bitset is the most valuable thing in here
 *
 * Four and a half thousand ray traces at bake time buys the bot an O(1) answer
 * to "can I see that node", which is the question underneath *breaking* line of
 * sight — the single most important thing a duel bot does that a bad one does
 * not. GLAD-V7CMHR builds perception on top of it.
 *
 * ## Why the artifact is committed rather than computed at boot
 *
 * The same reason `maps/baked/*.json` is: a build should not need a bake step
 * in front of it, and a table you can read in a pull request is a table whose
 * mistakes are visible. `tools/nav-bake.test.ts` re-bakes in memory and fails
 * if what is committed is stale, so the tree cannot hold a graph nobody can
 * reproduce.
 */

import {
  PLAYER_VIEW_HEIGHT,
  createTrace,
  traceRay,
} from '@gladiator/sim'
import type { CollisionWorld, LoadedMap, Vec3 } from '@gladiator/sim'

import { navHashOf, parseNavSource, wordsFor } from './load.ts'
import {
  NAV_FORMAT_VERSION,
  NAV_GRID_CELL,
  NAV_LINK_COST_PERCENT,
  NAV_TELEPORT_COST,
  NO_NODE,
  type BakedNav,
  type NavGrid,
  type NavLinkKind,
  type NavNode,
  type NavRoutes,
  type NavSource,
  type NavVisibility,
} from './schema.ts'
import {
  linkNavDiagnostics,
  placeNodes,
  routingNavDiagnostics,
  structuralNavDiagnostics,
  type NavDiagnostic,
} from './validate.ts'

export type NavBakeOutcome =
  | { readonly ok: true; readonly baked: BakedNav }
  | { readonly ok: false; readonly diagnostics: readonly NavDiagnostic[] }

/* --------------------------------------------------------------------------
 * The bake
 * ----------------------------------------------------------------------- */

/**
 * Normalise, validate, route, and precompute.
 *
 * Normalising *before* validating matters for the same reason it does in
 * `tools/bake-map.ts`: `parseNavSource` is the same parser the bot runs over
 * the artifact, so a graph that validates here is a graph that survives the
 * round trip rather than one that happened to be fine in the shape an authoring
 * helper produced.
 */
export function bakeNav(source: NavSource, map: LoadedMap): NavBakeOutcome {
  const normalised = parseNavSource(source)

  const structural = structuralNavDiagnostics(normalised, map.source)
  if (structural.length > 0) return { ok: false, diagnostics: structural }

  const placed = placeNodes(normalised, map.world)
  if (placed.diagnostics.length > 0) return { ok: false, diagnostics: placed.diagnostics }

  const links = linkNavDiagnostics(placed.nodes, normalised.links, map.world)
  if (links.length > 0) return { ok: false, diagnostics: links }

  const nav: NavSource = { map: normalised.map, nodes: placed.nodes, links: normalised.links }
  const routes = computeRoutes(nav)

  const routing = routingNavDiagnostics(nav.nodes, routes.nextHop)
  if (routing.length > 0) return { ok: false, diagnostics: routing }

  return {
    ok: true,
    baked: {
      format: NAV_FORMAT_VERSION,
      hash: navHashOf(nav),
      mapHash: map.hash,
      nav,
      routes,
      visibility: computeVisibility(nav.nodes, map.world),
      grid: buildGrid(nav.nodes),
    },
  }
}

/* --------------------------------------------------------------------------
 * What a hop costs
 * ----------------------------------------------------------------------- */

function distance3(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const dz = b[2] - a[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * What one traversal costs, in whole Quake units of equivalent walking.
 *
 * Rounded to the unit, and the rounding is not laziness: these numbers go into
 * a committed JSON file that a human reads in a diff, and `723` can be checked
 * against a ruler where `723.4142135623731` is noise that moves whenever
 * anything anywhere does. Whole units also keep the routing tables exact
 * integers all the way through Floyd-Warshall, so the artifact is bit-identical
 * on every machine that bakes it.
 *
 * Never zero: a free edge is a cycle the route walk can sit in forever.
 */
export function navLinkCost(kind: NavLinkKind, from: Vec3, to: Vec3): number {
  if (kind === 'teleport') return NAV_TELEPORT_COST
  return Math.max(1, Math.round((distance3(from, to) * NAV_LINK_COST_PERCENT[kind]) / 100))
}

/* --------------------------------------------------------------------------
 * All-pairs routing
 * ----------------------------------------------------------------------- */

/**
 * Floyd-Warshall over the whole graph.
 *
 * `nextHop[i * n + j]` is where to go *now* to end up at `j`, which is the form
 * a path follower wants: it never needs the whole route, only the next node,
 * and it re-asks every time it arrives somewhere. That also means a bot knocked
 * off its path by a rocket recovers by asking again from wherever it landed,
 * with no replanning and no search.
 */
export function computeRoutes(nav: NavSource): NavRoutes {
  const nodes = nav.nodes
  const n = nodes.length
  const index = new Map(nodes.map((node, i) => [node.id, i] as const))

  const cost: number[] = new Array<number>(n * n).fill(Infinity)
  const nextHop: number[] = new Array<number>(n * n).fill(NO_NODE)

  for (let i = 0; i < n; i += 1) {
    cost[i * n + i] = 0
    nextHop[i * n + i] = i
  }

  for (const link of nav.links) {
    const from = index.get(link.from)
    const to = index.get(link.to)
    if (from === undefined || to === undefined) continue
    const a = nodes[from]
    const b = nodes[to]
    if (a === undefined || b === undefined) continue
    const weight = navLinkCost(link.kind, a.origin, b.origin)
    if (weight >= (cost[from * n + to] ?? Infinity)) continue
    cost[from * n + to] = weight
    nextHop[from * n + to] = to
  }

  for (let k = 0; k < n; k += 1) {
    for (let i = 0; i < n; i += 1) {
      const viaK = cost[i * n + k] ?? Infinity
      if (viaK === Infinity) continue
      const hopToK = nextHop[i * n + k] ?? NO_NODE
      for (let j = 0; j < n; j += 1) {
        const rest = cost[k * n + j] ?? Infinity
        if (rest === Infinity) continue
        const through = viaK + rest
        if (through >= (cost[i * n + j] ?? Infinity)) continue
        cost[i * n + j] = through
        nextHop[i * n + j] = hopToK
      }
    }
  }

  return {
    nextHop,
    cost: cost.map((c) => (c === Infinity ? NO_NODE : c)),
  }
}

/* --------------------------------------------------------------------------
 * Visibility
 * ----------------------------------------------------------------------- */

/** Where a player standing on this node has their eyes. */
function eyesAt(node: NavNode): Vec3 {
  return [node.origin[0], node.origin[1], node.origin[2] + PLAYER_VIEW_HEIGHT]
}

/**
 * Which nodes can see which, eye to eye, with the trace the railgun will use.
 *
 * Each unordered pair is traced **once** and both bits are set. A trace stops
 * an epsilon short of a surface, so tracing `a -> b` and `b -> a` separately can
 * legitimately disagree when the line grazes a corner — and a visibility
 * relation that disagrees with itself makes a bot that hides from someone who
 * can see it, which is unfalsifiable from the outside and maddening to debug.
 * Symmetry by construction costs half the traces and removes the question.
 *
 * Eye height on both ends, not the feet: the feet of a player on the far side
 * of a 48-unit mound are behind it and their head is not.
 */
export function computeVisibility(
  nodes: readonly NavNode[],
  world: CollisionWorld,
): NavVisibility {
  const n = nodes.length
  const words = wordsFor(n)
  const bits: number[] = new Array<number>(n * words).fill(0)
  const trace = createTrace()

  const set = (i: number, j: number): void => {
    const at = i * words + (j >>> 5)
    bits[at] = ((bits[at] ?? 0) | (1 << (j & 31))) >>> 0
  }

  for (let i = 0; i < n; i += 1) {
    set(i, i)
    const a = nodes[i]
    if (a === undefined) continue
    const from = eyesAt(a)
    for (let j = i + 1; j < n; j += 1) {
      const b = nodes[j]
      if (b === undefined) continue
      traceRay(trace, world, from, eyesAt(b))
      if (trace.fraction < 1) continue
      set(i, j)
      set(j, i)
    }
  }

  return { words, bits }
}

/* --------------------------------------------------------------------------
 * The locate grid
 * ----------------------------------------------------------------------- */

/**
 * Bucket the nodes by XY cell, so "which node am I near" is a fixed nine-cell
 * read rather than a scan.
 *
 * A cell holds a *list*, not an answer, because one column of an arena holds
 * several nodes at different heights — the floor, the mound ring above it, the
 * tower top above that — and picking between them needs the query's own `z`.
 *
 * Stored in CSR form (offsets plus a flat member array) rather than as an array
 * of arrays, for the same reason the routing tables are flat: it is two reads
 * to get at a cell's contents instead of an object dereference per cell, and it
 * serialises to JSON as two lines instead of eighty.
 */
export function buildGrid(nodes: readonly NavNode[]): NavGrid {
  const cell = NAV_GRID_CELL
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    minX = Math.min(minX, node.origin[0])
    minY = Math.min(minY, node.origin[1])
    maxX = Math.max(maxX, node.origin[0])
    maxY = Math.max(maxY, node.origin[1])
  }
  if (nodes.length === 0) {
    minX = 0
    minY = 0
    maxX = 0
    maxY = 0
  }

  const originX = Math.floor(minX / cell) * cell
  const originY = Math.floor(minY / cell) * cell
  const nx = Math.max(1, Math.floor((maxX - originX) / cell) + 1)
  const ny = Math.max(1, Math.floor((maxY - originY) / cell) + 1)

  const cellOf = (node: NavNode): number => {
    const cx = Math.min(nx - 1, Math.max(0, Math.floor((node.origin[0] - originX) / cell)))
    const cy = Math.min(ny - 1, Math.max(0, Math.floor((node.origin[1] - originY) / cell)))
    return cy * nx + cx
  }

  const counts: number[] = new Array<number>(nx * ny).fill(0)
  for (const node of nodes) counts[cellOf(node)] = (counts[cellOf(node)] ?? 0) + 1

  const cellStart: number[] = new Array<number>(nx * ny + 1).fill(0)
  for (let c = 0; c < nx * ny; c += 1) cellStart[c + 1] = (cellStart[c] ?? 0) + (counts[c] ?? 0)

  const cursor = cellStart.slice(0, nx * ny)
  const cellNodes: number[] = new Array<number>(nodes.length).fill(0)
  for (let i = 0; i < nodes.length; i += 1) {
    const node = nodes[i]
    if (node === undefined) continue
    const c = cellOf(node)
    cellNodes[cursor[c] ?? 0] = i
    cursor[c] = (cursor[c] ?? 0) + 1
  }

  return { cell, minX: originX, minY: originY, nx, ny, cellStart, cellNodes }
}
