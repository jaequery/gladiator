/**
 * Reachability — can the movement actually get to every ledge in this map.
 * `docs/physics-spec.md` §5.
 *
 * A duel arena is designed *around* four numbers, and they are not opinions:
 * how high a player steps, jumps, rocket-jumps, and jumps-and-rocket-jumps.
 * §5.4 states them; {@link TECHNIQUES} is the executable copy, derived from the
 * movement constants rather than typed out beside them, and
 * `reachability.test.ts` measures every one against the real `pmove`.
 *
 * What this file adds on top of the numbers is the machine check. It samples
 * every place in the map a player can stand, joins the ones a player can walk
 * between, floods out from the spawns, and asks of everything left over: what
 * is the cheapest technique that gets on to it? A surface no technique reaches
 * is a level-design bug, and the bake refuses it (`validate.ts`).
 *
 * ## Falling does not count as reaching
 *
 * The flood uses walk edges and *climbs* — never drops. That is stricter than
 * the movement is, on purpose: a ledge you can only fall onto is a ledge you
 * can only leave, and in an arena with no items and no teleporters, a player
 * who takes it is stuck there until someone kills them. Treating a drop as a
 * route would make exactly that shape of map validate.
 *
 * ## What it proves, and what it does not
 *
 * It proves the *geometry* is inside the movement's envelope: for every
 * standable surface there is another standable surface below it, near enough
 * horizontally and low enough vertically that one of the four techniques spans
 * the gap. It does not trace the arc — a pillar in the middle of the jump is
 * not modelled — and it assumes {@link RUN_SPEED} horizontally, which is the
 * slowest a moving player goes. Both make it *optimistic* about a jump that is
 * geometrically possible and awkward, and neither lets an unreachable ledge
 * through.
 *
 * It is also not bot navigation data. GLAD-OB46VC owns that, and it wants
 * something with different properties — persisted, versioned, and shaped for
 * routing at 125 Hz. This is a bake-time assertion that throws its graph away.
 */

import type { Vec3 } from '../axis.ts'
import { PLAYER_HEIGHT, PLAYER_MAXS, PLAYER_MINS } from '../bbox.ts'
import { boxPenetration } from '../collide.ts'
import type { CollisionWorld } from '../collide.ts'
import type { MutVec3 } from '../math.ts'
import { FELT_GRAVITY, JUMP_VELOCITY, RUN_SPEED } from '../pmove/index.ts'
import { MIN_WALK_NORMAL, STEP_SIZE } from '../slidemove.ts'
import { SURFACE_CLIP_EPSILON, createTrace, traceBox } from '../trace.ts'
import type { TraceResult } from '../trace.ts'
import { createMapWorld, rampAxis } from './collide.ts'
import { RAMP_SLOPES } from './schema.ts'
import type { MapBrush, MapSource } from './schema.ts'

/* --------------------------------------------------------------------------
 * The four techniques
 * ----------------------------------------------------------------------- */

/**
 * The upward speed a rocket at your own feet gives you, in qu/s.
 *
 * Quake 3's arithmetic, transcribed: `G_Damage` pushes the victim by
 * `g_knockback * knockback / mass`, which is `1000 * knockback / 200`, and a
 * rocket that lands under you does its full 100 points of splash. 100 * 5 =
 * 500.
 *
 * **GLAD-0QWRYK owns the rocket.** When the weapon lands, its knockback has to
 * agree with this number or the map is designed around a jump the game does not
 * have — so it imports this rather than restating it, and the day it wants a
 * different number is the day every ledge height in `maps/` is re-checked.
 */
export const ROCKET_JUMP_LAUNCH = 500

/** Which of the four ways up a climb needs. */
export type TechniqueKey = 'step' | 'jump' | 'rocket-jump' | 'jump-rocket'

/** One way up, and how far up it goes. */
export type Technique = {
  readonly key: TechniqueKey
  /** How an author says it out loud, for a diagnostic. */
  readonly label: string
  /** Upward launch speed in qu/s. Zero for the step, which is not a launch. */
  readonly launch: number
  /** The tallest climb it makes, in whole Quake units. */
  readonly height: number
}

/**
 * How high a body launched at `launch` gets before gravity wins, in Quake
 * units.
 *
 * `FELT_GRAVITY`, not `GRAVITY`: velocity snapping means a player loses six
 * units of upward speed per tick rather than 6.4, and the three-unit difference
 * in the jump apex is the difference between clearing a ledge and not
 * (`pmove/snap.ts`).
 */
export function apexOf(launch: number): number {
  return (launch * launch) / (2 * FELT_GRAVITY)
}

/**
 * How far a body launched at `launch` travels horizontally before it drops
 * back below `climb`, at {@link RUN_SPEED}.
 *
 * The two roots of `climb = launch * t - g * t^2 / 2` are the tick it first
 * gets that high and the tick it stops being that high; the later one is the
 * last moment it can still land on the ledge, so it is the one that bounds the
 * gap. At `climb = 0` this is the whole flight; at the apex it is exactly half
 * of it, which is the sanity check worth carrying in your head.
 *
 * Zero when the launch cannot reach `climb` at all.
 */
export function horizontalReachOf(launch: number, climb: number): number {
  const discriminant = launch * launch - 2 * FELT_GRAVITY * climb
  if (discriminant < 0) return 0
  return (RUN_SPEED * (launch + Math.sqrt(discriminant))) / FELT_GRAVITY
}

/**
 * The four ways up, cheapest first. `docs/physics-spec.md` §5.4.
 *
 * Every height is *derived* — floored to a whole unit, because a map is
 * authored in whole units and a ledge at the apex to three decimal places is a
 * ledge nobody can reliably land on. The launches are the movement's own
 * constants, so a change to `JUMP_VELOCITY` moves the design metric with it
 * rather than leaving this file quietly wrong.
 */
export const TECHNIQUES: readonly Technique[] = [
  { key: 'step', label: 'a step', launch: 0, height: STEP_SIZE },
  {
    key: 'jump',
    label: 'a jump',
    launch: JUMP_VELOCITY,
    height: Math.floor(apexOf(JUMP_VELOCITY)),
  },
  {
    key: 'rocket-jump',
    label: 'a standing rocket jump',
    launch: ROCKET_JUMP_LAUNCH,
    height: Math.floor(apexOf(ROCKET_JUMP_LAUNCH)),
  },
  {
    key: 'jump-rocket',
    label: 'a jump-plus-rocket',
    launch: JUMP_VELOCITY + ROCKET_JUMP_LAUNCH,
    height: Math.floor(apexOf(JUMP_VELOCITY + ROCKET_JUMP_LAUNCH)),
  },
]

/** The tallest climb any technique makes. Above this, nothing gets up. */
export const MAX_CLIMB = TECHNIQUES.reduce((tallest, t) => Math.max(tallest, t.height), 0)

/* --------------------------------------------------------------------------
 * Sampling where a player can stand
 * ----------------------------------------------------------------------- */

/**
 * How far apart the standing samples are, in Quake units.
 *
 * Sixteen, and the number is load-bearing rather than a resolution knob: a 1:1
 * ramp — the steepest thing in the format — climbs exactly 16 across it, which
 * is under {@link STEP_SIZE}. So the sampler sees a ramp as a run of ordinary
 * walk edges, which is what a ramp *is*, without needing a special case that
 * would then have to be kept in step with `map/collide.ts`.
 *
 * Samples sit at cell centres, on the half-grid, so a map authored on the usual
 * 16-unit grid gets one sample per tread rather than one straddling every edge.
 */
export const SAMPLE_SPACING = 16

/**
 * How far apart two resting heights in one column have to be to be two
 * surfaces, in Quake units.
 *
 * Several brushes meeting at one height — a floor and the plinth of the ramp
 * sunk into it — all drop the box to the same place, and one place a player can
 * stand is one cell.
 */
const SAME_SURFACE = 1

/** Where a player can stand: one sample point, at the feet. */
export type StandCell = {
  readonly x: number
  readonly y: number
  readonly z: number
  /** Which column of the sample grid it belongs to. */
  readonly column: number
}

/**
 * The sampled world: every standable point, and which of them a player can
 * walk between.
 *
 * Thrown away as soon as the bake is over — see the note about GLAD-OB46VC at
 * the top of this file.
 */
export type ReachabilityGraph = {
  readonly cells: readonly StandCell[]
  /** Columns per axis. */
  readonly nx: number
  readonly ny: number
  /** Sample position of column zero. */
  readonly x0: number
  readonly y0: number
  /** Cell indices in each column, low to high. */
  readonly columns: readonly (readonly number[])[]
  /** `walk[i]` are the cells a player can walk to from cell `i`. */
  readonly walk: readonly (readonly number[])[]
}

/** The top of `brushDef` at `(x, y)`, or `null` if it is not over that point. */
function surfaceHeightAt(brushDef: MapBrush, x: number, y: number): number | null {
  if (x < brushDef.mins[0] || x > brushDef.maxs[0]) return null
  if (y < brushDef.mins[1] || y > brushDef.maxs[1]) return null
  if (brushDef.kind === 'box') return brushDef.maxs[2]

  // A ramp's top is the sloped plane: full height at the high end of the run,
  // falling at the gradient from there. The same arithmetic `rampSlopePlane`
  // does, asked for one point rather than for a plane.
  const { axis, sign } = rampAxis(brushDef)
  const slope = RAMP_SLOPES[brushDef.slope]
  const high = sign > 0 ? brushDef.maxs[axis] : brushDef.mins[axis]
  const along = axis === 0 ? x : y
  return brushDef.maxs[2] - (Math.abs(high - along) * slope.rise) / slope.run
}

/**
 * Is the sealed play volume above this point?
 *
 * The outside of a map's shell is covered in perfectly good standable surfaces
 * — the tops of the walls, the top of the ceiling — and none of them is in the
 * arena. A sealed map has geometry above every point a player can legally
 * stand, so sweeping the player box straight up and hitting nothing is the
 * cheapest true statement of "this is outside".
 */
function underCover(world: CollisionWorld, trace: TraceResult, at: Vec3): boolean {
  sky[0] = at[0]
  sky[1] = at[1]
  sky[2] = world.maxs[2] + PLAYER_HEIGHT + 1
  traceBox(trace, world, at, sky, PLAYER_MINS, PLAYER_MAXS)
  return trace.fraction < 1
}

const sky: MutVec3 = [0, 0, 0]

/**
 * Every place in the map a player can stand, and the walk edges between them.
 *
 * "Can stand" is asked with the real player box and the real trace, exactly as
 * `pmove` would: the box has to be clear, and the quarter-unit ground trace
 * under it has to find a walkable plane. Reimplementing either with a cheaper
 * point test is how a validator blesses a ledge no player fits on.
 */
export function buildReachabilityGraph(map: MapSource): ReachabilityGraph {
  const world = createMapWorld(map)
  const trace = createTrace()
  const solid = map.brushes.filter((b) => b.nonSolid !== true)

  // Cell centres on the half-grid, covering the whole world.
  const x0 = Math.floor(world.mins[0] / SAMPLE_SPACING) * SAMPLE_SPACING + SAMPLE_SPACING / 2
  const y0 = Math.floor(world.mins[1] / SAMPLE_SPACING) * SAMPLE_SPACING + SAMPLE_SPACING / 2
  const nx = Math.max(1, Math.ceil((world.maxs[0] - x0) / SAMPLE_SPACING))
  const ny = Math.max(1, Math.ceil((world.maxs[1] - y0) / SAMPLE_SPACING))

  const cells: StandCell[] = []
  const columns: number[][] = []
  const from: MutVec3 = [0, 0, 0]
  const to: MutVec3 = [0, 0, 0]
  const foot: MutVec3 = [0, 0, 0]
  const tops: number[] = []
  const resting: number[] = []

  for (let cy = 0; cy < ny; cy += 1) {
    for (let cx = 0; cx < nx; cx += 1) {
      const column = cy * nx + cx
      columns[column] = []
      const x = x0 + cx * SAMPLE_SPACING
      const y = y0 + cy * SAMPLE_SPACING

      tops.length = 0
      resting.length = 0
      for (const brushDef of solid) {
        const top = surfaceHeightAt(brushDef, x, y)
        if (top !== null && !tops.includes(top)) tops.push(top)
      }
      tops.sort((a, b) => a - b)

      for (const top of tops) {
        // Drop the box on to the surface rather than placing it on the number
        // the brush says. On a slope those are not the same: an axis-aligned
        // box rests on its *uphill* edge, so its origin sits half a box-width's
        // worth of rise above the plane under it — 7.5 units on a 1:2 ramp, 15
        // on a 1:1. Asking the trace is how the sampler stands a player exactly
        // where `pmove` would, seams and all.
        from[0] = x
        from[1] = y
        from[2] = top + STEP_SIZE
        to[0] = x
        to[1] = y
        to[2] = top - 1
        traceBox(trace, world, from, to, PLAYER_MINS, PLAYER_MAXS)
        if (trace.startsolid || trace.fraction === 1) continue
        if (trace.planeNormal[2] < MIN_WALK_NORMAL) continue

        const stand = trace.endpos[2]
        if (resting.some((z) => Math.abs(z - stand) < SAME_SURFACE)) continue

        foot[0] = x
        foot[1] = y
        foot[2] = stand
        if (boxPenetration(world, foot, PLAYER_MINS, PLAYER_MAXS) > 0) continue
        if (!underCover(world, trace, foot)) continue

        resting.push(stand)
        columns[column]?.push(cells.length)
        cells.push({ x, y, z: stand, column })
      }
    }
  }

  const walk = walkEdges(world, cells, columns, nx, ny)
  return { cells, nx, ny, x0, y0, columns, walk }
}

/**
 * Join every pair of nearby cells a player can walk between.
 *
 * Three questions, and each of them is a bug somebody has shipped:
 *
 * 1. **Is the height difference a step?** {@link STEP_SIZE} or less, which is
 *    the same number `StepSlideMove` uses.
 * 2. **Is the way across clear?** Lift to the higher of the two surfaces and
 *    sweep the player box, which is `StepSlideMove` in miniature. A height rule
 *    on its own walks a player through a wall with a ledge on the far side, and
 *    under a ceiling too low to stand up in.
 * 3. **Is there ground the whole way?** The box has to find something walkable
 *    at the midpoint too. Without it, a chasm exactly two samples across reads
 *    as a step — and *with* it, a 16-unit slot still reads as walkable, because
 *    the test is the 30-unit-wide player box rather than a point, and a player
 *    does simply stride over a gap narrower than their own feet.
 */
function walkEdges(
  world: CollisionWorld,
  cells: readonly StandCell[],
  columns: readonly (readonly number[])[],
  nx: number,
  ny: number,
): number[][] {
  const trace = createTrace()
  const from: MutVec3 = [0, 0, 0]
  const to: MutVec3 = [0, 0, 0]
  const walk: number[][] = cells.map(() => [])

  for (let i = 0; i < cells.length; i += 1) {
    const a = cells[i]
    if (a === undefined) continue
    const cx = (a.column % nx) | 0
    const cy = (a.column / nx) | 0

    for (const [dx, dy] of NEIGHBOURS) {
      const nxi = cx + dx
      const nyi = cy + dy
      if (nxi < 0 || nyi < 0 || nxi >= nx || nyi >= ny) continue
      // Each pair is considered once, from the lower-numbered cell.
      const neighbour = columns[nyi * nx + nxi]
      if (neighbour === undefined) continue

      for (const j of neighbour) {
        if (j <= i) continue
        const b = cells[j]
        if (b === undefined) continue
        if (Math.abs(b.z - a.z) > STEP_SIZE) continue

        const lifted = Math.max(a.z, b.z) + SURFACE_CLIP_EPSILON
        from[0] = a.x
        from[1] = a.y
        from[2] = lifted
        to[0] = b.x
        to[1] = b.y
        to[2] = lifted
        traceBox(trace, world, from, to, PLAYER_MINS, PLAYER_MAXS)
        if (trace.fraction < 1 || trace.startsolid) continue
        if (!groundBetween(world, trace, a, b)) continue

        walk[i]?.push(j)
        walk[j]?.push(i)
      }
    }
  }

  return walk
}

/** Is there something walkable to stand on halfway from `a` to `b`. */
function groundBetween(
  world: CollisionWorld,
  trace: TraceResult,
  a: StandCell,
  b: StandCell,
): boolean {
  const low = Math.min(a.z, b.z)
  const high = Math.max(a.z, b.z)
  const mid: MutVec3 = [(a.x + b.x) / 2, (a.y + b.y) / 2, high + SURFACE_CLIP_EPSILON]
  const under: MutVec3 = [mid[0], mid[1], low - SURFACE_CLIP_EPSILON]
  traceBox(trace, world, mid, under, PLAYER_MINS, PLAYER_MAXS)
  return trace.fraction < 1 && trace.planeNormal[2] >= MIN_WALK_NORMAL
}

/**
 * Four-connected, and out to two columns on each axis.
 *
 * The second column is not resolution, it is the player's width. A sample one
 * column short of a step is a sample where the 30-unit-wide box is already
 * inside the riser, so it is never standable — the last standable sample below
 * a step and the first one above it are two columns apart, and an adjacency
 * that only looked one column out would decide that no staircase in any map has
 * ever been walkable.
 *
 * Diagonals are left out: two of these in sequence covers them, and the ground
 * check above is what stops the pair from cutting a corner through a wall.
 */
const NEIGHBOURS: readonly (readonly [number, number])[] = [
  [1, 0],
  [2, 0],
  [-1, 0],
  [-2, 0],
  [0, 1],
  [0, 2],
  [0, -1],
  [0, -2],
]

/* --------------------------------------------------------------------------
 * The analysis
 * ----------------------------------------------------------------------- */

/** One patch of standable surface, and how a player gets on to it. */
export type Ledge = {
  /** A point on it — the sample the flood arrived at. */
  readonly origin: Vec3
  /** How many samples the patch covers. Size, in units of `SAMPLE_SPACING^2`. */
  readonly cells: number
  /** The cheapest technique that reaches it, or `null` if nothing does. */
  readonly technique: TechniqueKey | null
  /** How far up the climb on to it is. */
  readonly climb: number
}

/** What {@link analyzeReachability} found. */
export type ReachabilityReport = {
  /** Every standable sample in the sealed volume. */
  readonly cells: number
  /** How many samples each technique is the cheapest way on to. */
  readonly byTechnique: Readonly<Record<TechniqueKey, number>>
  /** The ledges each technique opens, one entry per connected patch. */
  readonly ledges: readonly Ledge[]
  /** Patches nothing reaches. Empty is the property the bake wants. */
  readonly unreachable: readonly Ledge[]
  /**
   * The tallest step-up any walk edge crosses.
   *
   * Zero says every walkable surface in the map is at one height — which is a
   * flat box, and a flat box does not exercise the movement this game is built
   * around. It is the one thing about the *step* technique worth asserting,
   * because unlike the other three, walking is not something a map has to earn.
   */
  readonly tallestStep: number
  readonly graph: ReachabilityGraph
}

/** The cell nearest `origin`, preferring one at the same height. */
function cellNear(graph: ReachabilityGraph, origin: Vec3): number {
  let best = -1
  let bestScore = Infinity
  for (let i = 0; i < graph.cells.length; i += 1) {
    const cell = graph.cells[i]
    if (cell === undefined) continue
    const dx = cell.x - origin[0]
    const dy = cell.y - origin[1]
    const dz = cell.z - origin[2]
    // Height counts for more than distance: a spawn on a walkway is nearer the
    // walkway under its feet than the floor two hundred units below it.
    const score = dx * dx + dy * dy + 16 * dz * dz
    if (score >= bestScore) continue
    bestScore = score
    best = i
  }
  return best
}

/** Flood `reached` outwards along walk edges from everything already in `queue`. */
function floodWalk(graph: ReachabilityGraph, reached: Int8Array, queue: number[]): void {
  while (queue.length > 0) {
    const i = queue.pop()
    if (i === undefined) continue
    for (const j of graph.walk[i] ?? []) {
      if (reached[j] !== UNREACHED) continue
      reached[j] = reached[i] ?? 0
      queue.push(j)
    }
  }
}

const UNREACHED = -1

/**
 * Work out how a player gets on to every standable surface in the map.
 *
 * Walk out from the spawns first, then take the cheapest technique that opens
 * anything new, walk out from *that*, and keep going until nothing more can be
 * reached. Cheapest-first is what makes the answer meaningful: a ledge is
 * labelled with the technique a player would actually use to get on to it, not
 * with the most expensive one that also happens to work.
 */
export function analyzeReachability(map: MapSource): ReachabilityReport {
  const graph = buildReachabilityGraph(map)
  const reached = new Int8Array(graph.cells.length).fill(UNREACHED)
  const climbOf = new Float64Array(graph.cells.length)

  const seeds: number[] = []
  for (const spawn of map.spawns) {
    const at = cellNear(graph, spawn.origin)
    if (at < 0 || reached[at] !== UNREACHED) continue
    reached[at] = 0
    seeds.push(at)
  }
  floodWalk(graph, reached, [...seeds])

  // Rounds, cheapest technique first, until a whole pass adds nothing.
  for (;;) {
    let opened = false
    for (let t = 1; t < TECHNIQUES.length; t += 1) {
      const technique = TECHNIQUES[t]
      if (technique === undefined) continue
      const found = climbableWith(graph, reached, technique)
      if (found.length === 0) continue
      for (const { cell, climb } of found) {
        reached[cell] = t
        climbOf[cell] = climb
      }
      floodWalk(
        graph,
        reached,
        found.map((f) => f.cell),
      )
      opened = true
      break
    }
    if (!opened) break
  }

  return report(graph, reached, climbOf)
}

/**
 * Every unreached cell this technique can climb on to from somewhere already
 * reached.
 *
 * The search is over the columns inside the technique's horizontal reach, which
 * shrinks as the climb approaches the apex — a jump that only just gets high
 * enough has no time left to travel.
 */
function climbableWith(
  graph: ReachabilityGraph,
  reached: Int8Array,
  technique: Technique,
): { cell: number; climb: number }[] {
  const found: { cell: number; climb: number }[] = []
  const widest = horizontalReachOf(technique.launch, 0)
  const span = Math.ceil(widest / SAMPLE_SPACING)

  for (let i = 0; i < graph.cells.length; i += 1) {
    if (reached[i] !== UNREACHED) continue
    const cell = graph.cells[i]
    if (cell === undefined) continue
    const cx = (cell.column % graph.nx) | 0
    const cy = (cell.column / graph.nx) | 0

    let best = Infinity
    for (let oy = -span; oy <= span && best === Infinity; oy += 1) {
      const ny = cy + oy
      if (ny < 0 || ny >= graph.ny) continue
      for (let ox = -span; ox <= span; ox += 1) {
        const nxi = cx + ox
        if (nxi < 0 || nxi >= graph.nx) continue
        for (const j of graph.columns[ny * graph.nx + nxi] ?? []) {
          if (reached[j] === UNREACHED) continue
          const other = graph.cells[j]
          if (other === undefined) continue
          const climb = cell.z - other.z
          if (climb < 0 || climb > technique.height) continue
          const dx = cell.x - other.x
          const dy = cell.y - other.y
          const distance = Math.sqrt(dx * dx + dy * dy)
          if (distance > horizontalReachOf(technique.launch, climb)) continue
          best = climb
          break
        }
        if (best !== Infinity) break
      }
    }

    if (best !== Infinity) found.push({ cell: i, climb: best })
  }

  return found
}

/** Group the flood's answer into patches an author can read. */
function report(
  graph: ReachabilityGraph,
  reached: Int8Array,
  climbOf: Float64Array,
): ReachabilityReport {
  const byTechnique: Record<TechniqueKey, number> = {
    step: 0,
    jump: 0,
    'rocket-jump': 0,
    'jump-rocket': 0,
  }
  for (const t of reached) {
    const technique = TECHNIQUES[t]
    if (technique !== undefined) byTechnique[technique.key] += 1
  }

  // A patch is a set of cells joined by walk edges that share a verdict: the
  // technique that opened them, or the fact that nothing did.
  const seen = new Uint8Array(graph.cells.length)
  const ledges: Ledge[] = []
  const unreachable: Ledge[] = []
  let tallestStep = 0

  for (let i = 0; i < graph.cells.length; i += 1) {
    const a = graph.cells[i]
    if (a === undefined) continue
    for (const j of graph.walk[i] ?? []) {
      const b = graph.cells[j]
      if (b === undefined) continue
      tallestStep = Math.max(tallestStep, Math.abs(b.z - a.z))
    }
  }

  for (let i = 0; i < graph.cells.length; i += 1) {
    if (seen[i] === 1) continue
    const verdict = reached[i] ?? UNREACHED
    // Cells the walk flood reached from a spawn are the arena's floor, not a
    // ledge somebody had to climb.
    if (verdict === 0) {
      seen[i] = 1
      continue
    }

    const stack = [i]
    seen[i] = 1
    let count = 0
    let climb = climbOf[i] ?? 0
    while (stack.length > 0) {
      const k = stack.pop()
      if (k === undefined) continue
      count += 1
      climb = Math.max(climb, climbOf[k] ?? 0)
      for (const j of graph.walk[k] ?? []) {
        if (seen[j] === 1 || reached[j] !== verdict) continue
        seen[j] = 1
        stack.push(j)
      }
    }

    const cell = graph.cells[i]
    if (cell === undefined) continue
    const ledge: Ledge = {
      origin: [cell.x, cell.y, cell.z],
      cells: count,
      technique: TECHNIQUES[verdict]?.key ?? null,
      climb,
    }
    if (verdict === UNREACHED) unreachable.push(ledge)
    else ledges.push(ledge)
  }

  return { cells: graph.cells.length, byTechnique, ledges, unreachable, tallestStep, graph }
}

/* --------------------------------------------------------------------------
 * Walking distance
 * ----------------------------------------------------------------------- */

/**
 * How far a player has to walk to get from `from` to `to`, in Quake units, or
 * `Infinity` if they cannot walk it at all.
 *
 * Dijkstra over the walk edges, which is what makes "how big is this arena"
 * answerable in seconds-of-running rather than in units-across — the number a
 * duel map is actually judged on. It measures *walking*: a route that needs a
 * rocket jump is not one of the paths considered.
 */
export function walkRouteLength(graph: ReachabilityGraph, from: Vec3, to: Vec3): number {
  const start = cellNear(graph, from)
  const goal = cellNear(graph, to)
  if (start < 0 || goal < 0) return Infinity

  const best = new Float64Array(graph.cells.length).fill(Infinity)
  best[start] = 0
  // A binary heap would be tidier; a map this size settles in a few passes of a
  // plain scan, and the bake is not a hot loop.
  const pending = new Set<number>([start])

  while (pending.size > 0) {
    let current = -1
    let currentCost = Infinity
    for (const i of pending) {
      const cost = best[i] ?? Infinity
      if (cost >= currentCost) continue
      currentCost = cost
      current = i
    }
    if (current < 0) break
    pending.delete(current)
    if (current === goal) return currentCost

    const a = graph.cells[current]
    if (a === undefined) continue
    for (const j of graph.walk[current] ?? []) {
      const b = graph.cells[j]
      if (b === undefined) continue
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dz = b.z - a.z
      const cost = currentCost + Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (cost >= (best[j] ?? Infinity)) continue
      best[j] = cost
      pending.add(j)
    }
  }

  return best[goal] ?? Infinity
}
