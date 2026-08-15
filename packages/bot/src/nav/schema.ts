/**
 * The navigation format — what the bot walks on. GLAD-OB46VC.
 *
 * A **nav graph** is a hand-placed list of nodes and the directed links between
 * them, authored in TypeScript under `maps/*.nav.ts`, compiled by
 * `pnpm nav:bake` to JSON in `maps/baked/*.nav.json`, and loaded by the bot as
 * a set of flat arrays it only ever indexes into.
 *
 * ## Why a waypoint graph and not a navmesh
 *
 * Quake 3's AAS was built to need *zero* authoring across thirty shipped maps
 * plus every map a stranger would ever make. For q3tourney2 — a duel map about
 * this size — it produced 626 areas and 2826 reachabilities and took 88 seconds
 * to compile. Gladiator has **one** hand-authored arena, so it is paying that
 * complexity to solve a problem it does not have.
 *
 * The deciding argument is not the compile time, though. It is that **the link
 * types are the design**. "This gap is a jump", "you drop off here and cannot
 * get back up" is level-design intent, and a generator that discovers it can
 * only discover what the geometry happens to admit. A navmesh would hand back
 * every non-walk traversal as a hand-authored off-mesh connection anyway, which
 * on a small arena is most of the interesting movement.
 *
 * ## Links are directed, always
 *
 * A ledge you can drop off and cannot climb back on to is the single most
 * common shape in an arena, and an undirected graph cannot say it. So every
 * link is one-way, and `maps/nav-helpers.ts` emits the pair for a `walk` —
 * which is the only kind that is symmetric by definition, because the rule that
 * makes it a walk (a step at most {@link NAV_MAX_STEP} tall) reads the same in
 * both directions.
 *
 * ## The kinds, and what owns them
 *
 * Each kind maps to exactly one traversal controller in the bot's movement
 * (GLAD-TSED8V), mirroring Quake's `BotTravel_*` split. That is the reason the
 * set is small and closed: a kind nothing can execute is a route the bot walks
 * into and stops on.
 *
 * `rocketjump` is deliberately **not** here. It is a v2 kind, and until it
 * exists the positions only a rocket reaches are tagged `perch` rather than
 * `ground` — see {@link NavTag}. That is not a gap in the data; it is the data
 * saying, accurately, that the bot cannot get up there yet.
 */

import { STEP_SIZE } from '@gladiator/sim'
import type { Vec3 } from '@gladiator/sim'

/**
 * Bumped when the shape below changes in a way a previously baked graph would
 * not survive. Folded into the nav hash, so an old artifact and a new loader
 * disagree loudly instead of quietly routing a bot into a wall.
 */
export const NAV_FORMAT_VERSION = 1

/**
 * No node. One sentinel, for every table and every query that can come back
 * empty: no next hop, no direct link, no route, no node near that point.
 *
 * One name rather than three, because three names for -1 is the drift
 * `AGENTS.md` spends a section on. A caller testing `< 0` is testing all four
 * conditions at once, which is what it wants: there is nothing to move towards.
 */
export const NO_NODE = -1

/**
 * How a body gets from one node to the next.
 *
 * | Kind       | What the bot does                                       |
 * | ---------- | ------------------------------------------------------- |
 * | `walk`     | hold forward; the ground carries you, steps and ramps included |
 * | `jump`     | run up and press jump; there is air under the middle of it |
 * | `drop`     | run off the edge and fall; no jump, and no way back      |
 * | `teleport` | step on to the pad; the distance travelled is not a distance |
 */
export type NavLinkKind = 'walk' | 'jump' | 'drop' | 'teleport'

/** Every kind, in the order the artifact and the diagnostics use. */
export const NAV_LINK_KINDS: readonly NavLinkKind[] = ['walk', 'jump', 'drop', 'teleport']

/**
 * What a node is *for*. A closed set: adding one is a format change.
 *
 * - `ground` — on the v1 traversal network. **Every ground node must route to
 *   every other ground node**, and the bake refuses a graph where one does not.
 *   That single rule is what makes "the bot can always get there" a property of
 *   the data rather than a hope.
 * - `perch` — a position worth knowing about that no v1 link reaches: the
 *   balconies and the tower, which cost a rocket. It can have outgoing links
 *   (you can always fall off) and usually has no incoming one. Excluded from
 *   the routing guarantee on purpose, so that the guarantee stays honest
 *   instead of being weakened until it passes.
 * - `spawn` — sits on one of the map's spawn points. Every map spawn must have
 *   one within {@link NAV_SPAWN_RADIUS}, so the bot's first tick has an anchor.
 */
export type NavTag = 'ground' | 'perch' | 'spawn'

/** Every tag. */
export const NAV_TAGS: readonly NavTag[] = ['ground', 'perch', 'spawn']

/**
 * One place worth standing.
 *
 * `origin` is the player origin, which is **at the feet** (`bbox.ts`), authored
 * in whole Quake units. The bake *drops* it on to the surface underneath before
 * anything else looks at it — an axis-aligned box rests on its uphill edge, so
 * a node on a 1:2 ramp sits 7.5 units above the plane an author would read off
 * the map file, and asking the trace is the only way to place it exactly where
 * `pmove` would. `map/reachability.ts` samples the map the same way and for the
 * same reason.
 */
export type NavNode = {
  /** Stable, unique, human-readable. It is what links name and what a diff shows. */
  readonly id: string
  /** The player's feet, Quake frame, whole units. Snapped to the surface at bake time. */
  readonly origin: Vec3
  /** At least one of `ground` or `perch`, and never both. */
  readonly tags: readonly NavTag[]
}

/** One directed traversal. */
export type NavLink = {
  readonly from: string
  readonly to: string
  readonly kind: NavLinkKind
}

/** A nav graph, as authored. */
export type NavSource = {
  /** The map this graph is for. Must match `MapSource.name`. */
  readonly map: string
  readonly nodes: readonly NavNode[]
  readonly links: readonly NavLink[]
}

/* --------------------------------------------------------------------------
 * What a traversal costs
 * ----------------------------------------------------------------------- */

/**
 * What each kind costs, as a percentage of the distance travelled.
 *
 * Integers, and multiplied out into integers, because the routing tables are
 * committed to a JSON file that a human reads in a diff: a cost of `723` is a
 * number you can check against a ruler, and `723.4142135623731` is noise that
 * changes whenever anything anywhere moves.
 *
 * The numbers are not measurements — they are preferences, and the preference
 * is *walking*. A jump commits you to an arc you cannot steer out of, which is
 * the worst thing to be doing when a rocket arrives, so it is priced above a
 * walk of the same length even though it is faster. A drop is cheaper than a
 * jump and dearer than a walk for the same reason and to a smaller degree.
 */
export const NAV_LINK_COST_PERCENT = {
  walk: 100,
  jump: 130,
  drop: 110,
  teleport: 100,
} as const satisfies Record<NavLinkKind, number>

/**
 * What a teleporter costs, flat, in Quake units of equivalent walking.
 *
 * The distance between two pads is not a distance anybody travels, so pricing a
 * teleport by it would make the bot avoid the fastest route on the map for
 * being the longest one. 64 is about the walk on to the pad and off the far
 * end, which is the only part of it that takes time.
 *
 * There is no teleporter in `arena1`. The kind exists because leaving it out
 * would mean the first map that wants one changes the format version.
 */
export const NAV_TELEPORT_COST = 64

/* --------------------------------------------------------------------------
 * The rules the format guarantees
 * ----------------------------------------------------------------------- */

/**
 * The tallest rise a `walk` link may cross, in Quake units.
 *
 * `STEP_SIZE`, imported rather than restated: it is the number
 * `StepSlideMove` uses, and a walk link that crosses more than a player steps
 * is a link the bot holds forward on and never completes.
 */
export const NAV_MAX_STEP = STEP_SIZE

/**
 * The widest hole in the floor a `walk` link may stride over, in Quake units.
 *
 * Also `STEP_SIZE`, and the coincidence is worth one sentence because it is not
 * one. A gap this narrow is spanned by the 30-unit player box from both sides
 * at once, so the box never loses its support and the walk is exactly as
 * uneventful as it looks — the same argument `map/reachability.ts` makes about
 * a 16-unit slot reading as walkable. Reusing the movement's own number rather
 * than inventing a second one is the point: two names for one quantity is the
 * drift `AGENTS.md` exists to prevent.
 */
export const NAV_MAX_STRIDE = STEP_SIZE

/**
 * How near a `spawn`-tagged node has to be to the map spawn it stands for, in
 * Quake units.
 *
 * Four grid squares. Close enough that a bot's first move is towards the fight
 * rather than towards its own first waypoint.
 */
export const NAV_SPAWN_RADIUS = 64

/**
 * Side of one cell of the locate grid, in Quake units.
 *
 * The grid exists so that "which node am I near" is a fixed nine-cell read
 * rather than a scan of every node — see `query.ts`. 128 is wide enough that
 * the three-by-three window around any point inside a validated graph contains
 * a node, and narrow enough that a cell holds one or two of them.
 */
export const NAV_GRID_CELL = 128

/* --------------------------------------------------------------------------
 * The baked artifact
 * ----------------------------------------------------------------------- */

/**
 * All-pairs routing, flattened.
 *
 * Both tables are `n * n`, indexed `from * n + to`. `nextHop[i * n + j]` is the
 * node to move to *now* in order to get to `j` eventually, or -1 if there is no
 * route; `cost[i * n + j]` is what the whole route costs, or -1.
 *
 * Flat rather than nested because the whole reason for precomputing is that a
 * query is one indexed read, and an array of arrays is two.
 */
export type NavRoutes = {
  readonly nextHop: readonly number[]
  readonly cost: readonly number[]
}

/**
 * Which nodes can see which, as a bitset.
 *
 * `words` uint32s per node, so node `i` sees node `j` when bit `j` of row `i`
 * is set. Symmetric by construction — the bake traces each unordered pair once
 * and sets both bits, because a visibility relation that disagrees with itself
 * produces a bot that hides from someone who can see it.
 */
export type NavVisibility = {
  /** Uint32s per row: `ceil(nodeCount / 32)`. */
  readonly words: number
  readonly bits: readonly number[]
}

/**
 * The locate grid: XY cells to the nodes standing in them, in CSR form.
 *
 * `cellStart` has `nx * ny + 1` entries and `cellNodes[cellStart[c]]` up to
 * `cellStart[c + 1]` are the nodes in cell `c`. One column of the arena can
 * hold several nodes at different heights — the floor, the mound ring above it,
 * the tower top above that — which is exactly why a cell holds a list and not
 * an answer.
 */
export type NavGrid = {
  readonly cell: number
  readonly minX: number
  readonly minY: number
  readonly nx: number
  readonly ny: number
  readonly cellStart: readonly number[]
  readonly cellNodes: readonly number[]
}

/** What `pnpm nav:bake` writes, and what the bot loads. */
export type BakedNav = {
  readonly format: number
  /** Eight hex digits over the authored graph. See `load.ts`. */
  readonly hash: string
  /**
   * The hash of the map this was baked against.
   *
   * A nav graph is a set of claims about geometry — this is standable, that is
   * a 48-unit drop — and every one of them expires the moment a brush moves.
   * Carrying the map's hash means a stale graph is refused at load with a
   * sentence, instead of walking the bot into a wall that used to be a doorway.
   */
  readonly mapHash: string
  /** The authored graph, normalised, with every node snapped to its surface. */
  readonly nav: NavSource
  readonly routes: NavRoutes
  readonly visibility: NavVisibility
  readonly grid: NavGrid
}
