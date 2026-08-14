/**
 * The static world the trace runs against, and the broadphase that keeps it
 * cheap. `docs/physics-spec.md` §2.1.
 *
 * Level geometry is a list of **brushes**: convex solids, each defined by the
 * outward-facing planes that bound it. Convex-and-plane-bounded is what makes
 * the swept-AABB trace in `trace.ts` a closed-form interval intersection rather
 * than a search, and it is why Quake has used this representation since 1996.
 *
 * A brush is *not* an axis-aligned box. It may be, and most of a map is, but
 * the 45-degree ramp that makes a ramp-jump possible is a brush with one
 * non-axial plane, and an AABB-only world cannot express it. The cost of
 * arbitrary planes is one dot product per plane; the cost of not having them is
 * that half of Quake's movement vocabulary is unreachable.
 *
 * Nothing in this file mutates during a tick except the query scratch, and that
 * is not part of the simulation state — the world is level data, loaded once.
 */

import type { Vec3 } from './axis.ts'
import { crossVec3, dotVec3, normalizeVec3, vec3 } from './math.ts'
import type { MutVec3 } from './math.ts'

/**
 * A half-space, `dot(normal, x) <= dist`.
 *
 * `normal` is a unit vector pointing **out** of the solid, so a point is inside
 * a brush when it is behind every one of its planes. That sign convention is
 * Quake's and is worth stating because the opposite one also "works" right up
 * until someone adds a brush by hand.
 */
export type Plane = {
  readonly normal: Vec3
  readonly dist: number
  /**
   * Bit `i` set when `normal[i] < 0`. Quake's `signbits`.
   *
   * It selects which corner of a swept box is the one that touches this plane
   * first, which turns the box-vs-plane test into the point-vs-plane test with
   * a precomputed offset. See `trace.ts`.
   */
  readonly signBits: number
}

/** A convex solid: the intersection of its planes' half-spaces. */
export type Brush = {
  readonly planes: readonly Plane[]
  /** Tight axis-aligned bounds. Derived, never authored — see {@link brush}. */
  readonly mins: Vec3
  readonly maxs: Vec3
}

/** A plane before its `signBits` are worked out. `normal` need not be unit. */
export type PlaneSpec = {
  readonly normal: Vec3
  readonly dist: number
}

/* --------------------------------------------------------------------------
 * Planes
 * ----------------------------------------------------------------------- */

/** `signBits` for a normal: bit `i` set when component `i` is negative. */
function signBitsOf(normal: Vec3): number {
  let bits = 0
  if (normal[0] < 0) bits |= 1
  if (normal[1] < 0) bits |= 2
  if (normal[2] < 0) bits |= 4
  return bits
}

/**
 * Normalise a plane's normal, scaling `dist` to match.
 *
 * The normal has to be unit length for two reasons that are easy to conflate:
 * `PM_ClipVelocity` subtracts `normal * dot(v, normal)` and only removes the
 * whole normal component if `|normal| === 1`, and the trace's box offset is a
 * distance along the normal. A plane authored as `(1, 0, 1)` instead of
 * `(0.7071, 0, 0.7071)` produces a ramp that eats speed, which reads as a
 * "feel" problem rather than as the arithmetic bug it is.
 */
export function plane(normal: Vec3, dist: number): Plane {
  const unit = vec3()
  const length = normalizeVec3(unit, normal)
  if (length === 0) throw new Error('gladiator: a plane needs a non-zero normal')
  const scaled = dist / length
  return { normal: unit, dist: scaled, signBits: signBitsOf(unit) }
}

/* --------------------------------------------------------------------------
 * Brushes
 * ----------------------------------------------------------------------- */

/**
 * Where the vertex enumeration below considers a point to be on a plane.
 *
 * Generous on purpose: a vertex of a brush lies exactly on three planes and
 * within rounding of the rest, and rejecting it for being 1e-9 outside would
 * shrink the derived bounds below the brush itself — which is a tunnelling bug
 * dressed up as a rounding error.
 */
const VERTEX_EPSILON = 0.001

/**
 * A brush from its planes, with bounds derived by enumerating its corners.
 *
 * Every corner of a convex polyhedron is the intersection of three of its
 * planes, so the bounds are found by solving each triple and keeping the
 * solutions that are inside every other plane. That is `O(n^3)` in the plane
 * count, which for the six-to-ten planes a brush actually has is nothing, and
 * it happens once at load time.
 *
 * The alternative — asking the map author for the bounds — is what makes
 * broadphase bugs so nasty: bounds one unit too small do not fail loudly, they
 * make one brush invisible to the trace from one direction, and a player falls
 * through the world once every few rounds.
 */
export function brush(specs: readonly PlaneSpec[]): Brush {
  if (specs.length < 4) {
    throw new Error('gladiator: a brush needs at least four planes to be bounded')
  }
  const planes = specs.map((spec) => plane(spec.normal, spec.dist))

  const mins: MutVec3 = [Infinity, Infinity, Infinity]
  const maxs: MutVec3 = [-Infinity, -Infinity, -Infinity]
  const point = vec3()
  let corners = 0

  for (let i = 0; i < planes.length; i++) {
    const a = planes[i]
    if (a === undefined) continue
    for (let j = i + 1; j < planes.length; j++) {
      const b = planes[j]
      if (b === undefined) continue
      for (let k = j + 1; k < planes.length; k++) {
        const c = planes[k]
        if (c === undefined) continue
        if (!intersectPlanes(point, a, b, c)) continue
        if (!insideAll(planes, point)) continue

        corners += 1
        if (point[0] < mins[0]) mins[0] = point[0]
        if (point[1] < mins[1]) mins[1] = point[1]
        if (point[2] < mins[2]) mins[2] = point[2]
        if (point[0] > maxs[0]) maxs[0] = point[0]
        if (point[1] > maxs[1]) maxs[1] = point[1]
        if (point[2] > maxs[2]) maxs[2] = point[2]
      }
    }
  }

  if (corners < 4) {
    throw new Error('gladiator: brush is degenerate — fewer than four corners')
  }
  if (recessionDirection(planes, point)) {
    throw new Error(
      `gladiator: brush is unbounded — it runs to infinity along (${point[0]}, ${point[1]}, ${point[2]}). A missing plane is the usual cause.`,
    )
  }

  return { planes, mins: [mins[0], mins[1], mins[2]], maxs: [maxs[0], maxs[1], maxs[2]] }
}

/**
 * Find a direction the brush extends forever in, if there is one. Writes it
 * into `out` and returns whether it found one.
 *
 * The derived bounds of an unbounded brush are a lie — they are the bounds of
 * its *corners*, which is a strictly smaller set — and a lying bound is worse
 * than no bound: the broadphase stops offering the brush to the trace outside
 * them, so a wall with a plane missing becomes a wall you fall through from one
 * direction and only sometimes. Loud at load is much cheaper.
 *
 * A brush runs to infinity along `y` exactly when `n . y <= 0` for every plane.
 * The set of such `y` is a convex cone, and a cone in three dimensions is
 * either `{0}` or has an extreme ray — and an extreme ray lies on two of the
 * bounding planes, so it is the cross product of their normals. Testing every
 * pair of normals, both ways round, therefore settles the question.
 */
function recessionDirection(planes: readonly Plane[], out: MutVec3): boolean {
  for (let i = 0; i < planes.length; i++) {
    const a = planes[i]
    if (a === undefined) continue
    for (let j = i + 1; j < planes.length; j++) {
      const b = planes[j]
      if (b === undefined) continue
      crossVec3(out, a.normal, b.normal)
      if (normalizeVec3(out, out) === 0) continue
      if (escapesAlong(planes, out)) return true
      out[0] = -out[0]
      out[1] = -out[1]
      out[2] = -out[2]
      if (escapesAlong(planes, out)) return true
    }
  }
  return false
}

/** Whether every plane lets a ray travel forever along `direction`. */
function escapesAlong(planes: readonly Plane[], direction: Vec3): boolean {
  for (const p of planes) {
    if (dotVec3(p.normal, direction) > 1e-9) return false
  }
  return true
}

/** The point where three planes meet, by Cramer's rule. False if they do not. */
function intersectPlanes(out: MutVec3, a: Plane, b: Plane, c: Plane): boolean {
  const [ax, ay, az] = a.normal
  const [bx, by, bz] = b.normal
  const [cx, cy, cz] = c.normal

  const det =
    ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  // Parallel or coincident planes: no single corner, and dividing by a
  // near-zero determinant would invent one out at 1e17.
  if (det > -1e-9 && det < 1e-9) return false

  const inverse = 1 / det
  out[0] =
    (a.dist * (by * cz - bz * cy) - ay * (b.dist * cz - bz * c.dist) +
      az * (b.dist * cy - by * c.dist)) * inverse
  out[1] =
    (ax * (b.dist * cz - bz * c.dist) - a.dist * (bx * cz - bz * cx) +
      az * (bx * c.dist - b.dist * cx)) * inverse
  out[2] =
    (ax * (by * c.dist - b.dist * cy) - ay * (bx * c.dist - b.dist * cx) +
      a.dist * (bx * cy - by * cx)) * inverse
  return true
}

/** Whether a point is behind (or on) every plane. */
function insideAll(planes: readonly Plane[], point: Vec3): boolean {
  for (const p of planes) {
    if (dotVec3(p.normal, point) - p.dist > VERTEX_EPSILON) return false
  }
  return true
}

/**
 * The six-plane brush for an axis-aligned box.
 *
 * Most of a map is this, and spelling out six normals by hand every time is
 * how a sign gets flipped and a wall becomes solid from one side only.
 */
export function boxBrush(mins: Vec3, maxs: Vec3): Brush {
  if (maxs[0] <= mins[0] || maxs[1] <= mins[1] || maxs[2] <= mins[2]) {
    throw new Error('gladiator: a box brush needs maxs strictly greater than mins on every axis')
  }
  return brush([
    { normal: [1, 0, 0], dist: maxs[0] },
    { normal: [-1, 0, 0], dist: -mins[0] },
    { normal: [0, 1, 0], dist: maxs[1] },
    { normal: [0, -1, 0], dist: -mins[1] },
    { normal: [0, 0, 1], dist: maxs[2] },
    { normal: [0, 0, -1], dist: -mins[2] },
  ])
}

/* --------------------------------------------------------------------------
 * The world and its broadphase
 * ----------------------------------------------------------------------- */

/**
 * Preferred grid cell size, in Quake units.
 *
 * 128 is four player-widths: big enough that an ordinary wall brush lands in a
 * handful of cells rather than hundreds, small enough that a one-tick sweep
 * (24 units at the speed clamp) touches at most two cells per axis.
 */
const PREFERRED_CELL_SIZE = 128

/** Grid cells per axis are capped here, so a large map cannot allocate a gigabyte. */
const MAX_CELLS_PER_AXIS = 64

/**
 * A loaded map: the brushes, plus a uniform grid over them.
 *
 * The grid is stored the way a compressed sparse row matrix is — one flat
 * `cellItems` array of brush indices and a `cellStart` array of offsets into it
 * — rather than as an array of arrays. That is one allocation instead of
 * thousands, it keeps the whole broadphase in two contiguous typed arrays, and
 * it makes the traversal order a property of the data rather than of whichever
 * order a `Map` happened to be built in.
 */
export type CollisionWorld = {
  readonly brushes: readonly Brush[]
  readonly mins: Vec3
  readonly maxs: Vec3
  readonly cellSize: number
  /** Cells per axis. */
  readonly counts: Vec3
  readonly cellStart: Int32Array
  readonly cellItems: Int32Array
  /** Query scratch — see {@link queryBrushes}. Never part of the sim state. */
  readonly marks: Int32Array
  /** Bumped once per query so `marks` need not be cleared. */
  stamp: number
  /** Brush indices the last query found, ascending. */
  readonly candidates: number[]
}

/** An empty world. Every trace through it reports a clean miss. */
export function createCollisionWorld(brushes: readonly Brush[]): CollisionWorld {
  const mins: MutVec3 = [0, 0, 0]
  const maxs: MutVec3 = [0, 0, 0]
  if (brushes.length > 0) {
    mins[0] = Infinity
    mins[1] = Infinity
    mins[2] = Infinity
    maxs[0] = -Infinity
    maxs[1] = -Infinity
    maxs[2] = -Infinity
    for (const b of brushes) {
      if (b.mins[0] < mins[0]) mins[0] = b.mins[0]
      if (b.mins[1] < mins[1]) mins[1] = b.mins[1]
      if (b.mins[2] < mins[2]) mins[2] = b.mins[2]
      if (b.maxs[0] > maxs[0]) maxs[0] = b.maxs[0]
      if (b.maxs[1] > maxs[1]) maxs[1] = b.maxs[1]
      if (b.maxs[2] > maxs[2]) maxs[2] = b.maxs[2]
    }
  }

  // One cell size for all three axes: a cubic cell keeps the mapping from a
  // sweep's bounds to a cell range a single divide, and a map is never so
  // lopsided that per-axis sizes would pay for themselves.
  let cellSize = PREFERRED_CELL_SIZE
  for (const extent of [maxs[0] - mins[0], maxs[1] - mins[1], maxs[2] - mins[2]]) {
    const needed = extent / MAX_CELLS_PER_AXIS
    if (needed > cellSize) cellSize = needed
  }

  const counts: MutVec3 = [
    axisCellCount(maxs[0] - mins[0], cellSize),
    axisCellCount(maxs[1] - mins[1], cellSize),
    axisCellCount(maxs[2] - mins[2], cellSize),
  ]

  const cellCount = counts[0] * counts[1] * counts[2]

  // Two passes: count how many brushes land in each cell, prefix-sum that into
  // `cellStart`, then fill. Brushes are visited in index order in both passes,
  // so every cell's list comes out ascending and the whole structure is a pure
  // function of the brush list.
  const counted = new Int32Array(cellCount + 1)
  const range: CellRange = [0, 0, 0, 0, 0, 0]

  for (const b of brushes) {
    cellRange(range, mins, counts, cellSize, b.mins, b.maxs)
    for (let z = range[2]; z <= range[5]; z += 1) {
      for (let y = range[1]; y <= range[4]; y += 1) {
        for (let x = range[0]; x <= range[3]; x += 1) {
          const cell = cellIndex(counts, x, y, z) + 1
          counted[cell] = (counted[cell] ?? 0) + 1
        }
      }
    }
  }
  for (let i = 0; i < cellCount; i += 1) {
    counted[i + 1] = (counted[i + 1] ?? 0) + (counted[i] ?? 0)
  }

  const cellStart = counted
  const cellItems = new Int32Array(cellStart[cellCount] ?? 0)
  const cursor = new Int32Array(cellCount)

  for (let index = 0; index < brushes.length; index += 1) {
    const b = brushes[index]
    if (b === undefined) continue
    cellRange(range, mins, counts, cellSize, b.mins, b.maxs)
    for (let z = range[2]; z <= range[5]; z += 1) {
      for (let y = range[1]; y <= range[4]; y += 1) {
        for (let x = range[0]; x <= range[3]; x += 1) {
          const cell = cellIndex(counts, x, y, z)
          cellItems[(cellStart[cell] ?? 0) + (cursor[cell] ?? 0)] = index
          cursor[cell] = (cursor[cell] ?? 0) + 1
        }
      }
    }
  }

  return {
    brushes,
    mins: [mins[0], mins[1], mins[2]],
    maxs: [maxs[0], maxs[1], maxs[2]],
    cellSize,
    counts: [counts[0], counts[1], counts[2]],
    cellStart,
    cellItems,
    marks: new Int32Array(brushes.length),
    stamp: 0,
    candidates: [],
  }
}

function cellIndex(counts: Vec3, x: number, y: number, z: number): number {
  return (z * counts[1] + y) * counts[0] + x
}

/** Cells along one axis for an extent. At least one, so an empty world has a grid. */
function axisCellCount(extent: number, cellSize: number): number {
  const count = Math.floor(extent / cellSize) + 1
  return count < 1 ? 1 : count
}

/** An inclusive cell range, `[x0, y0, z0, x1, y1, z1]`. */
type CellRange = [number, number, number, number, number, number]

/**
 * The cell coordinate a world coordinate falls in, clamped to the grid.
 *
 * Clamping rather than rejecting is what makes an out-of-bounds query still
 * find the wall it is about to be pushed back through: a body that has somehow
 * ended up past the edge of the map gets the boundary cells, not an empty
 * answer and a free fall.
 */
function clampCell(value: number, origin: number, cellSize: number, limit: number): number {
  const cell = Math.floor((value - origin) / cellSize)
  if (cell < 0) return 0
  if (cell > limit) return limit
  return cell
}

/** The inclusive cell range an AABB covers. */
function cellRange(
  range: CellRange,
  origin: Vec3,
  counts: Vec3,
  cellSize: number,
  mins: Vec3,
  maxs: Vec3,
): void {
  range[0] = clampCell(mins[0], origin[0], cellSize, counts[0] - 1)
  range[1] = clampCell(mins[1], origin[1], cellSize, counts[1] - 1)
  range[2] = clampCell(mins[2], origin[2], cellSize, counts[2] - 1)
  range[3] = clampCell(maxs[0], origin[0], cellSize, counts[0] - 1)
  range[4] = clampCell(maxs[1], origin[1], cellSize, counts[1] - 1)
  range[5] = clampCell(maxs[2], origin[2], cellSize, counts[2] - 1)
}

/**
 * The brushes whose bounds overlap `[mins, maxs]`, as ascending indices.
 *
 * Returns `world.candidates`, which is reused between calls — copy it if you
 * mean to keep it. Reusing it is what makes a trace allocation-free in the
 * steady state, and it is safe for the same reason the hash writer in
 * `state.ts` is: the simulation is single-threaded and synchronous by
 * construction, with `await` a lint error inside this package.
 *
 * The result is sorted by brush index rather than by the order the grid
 * happened to visit, so a trace's answer does not depend on the cell size. Two
 * peers that somehow built the grid differently still resolve the same hit.
 */
export function queryBrushes(world: CollisionWorld, mins: Vec3, maxs: Vec3): number[] {
  const candidates = world.candidates
  candidates.length = 0
  if (world.brushes.length === 0) return candidates

  world.stamp += 1
  const stamp = world.stamp
  const marks = world.marks
  const { cellStart, cellItems, counts, cellSize } = world

  const range = queryRange
  cellRange(range, world.mins, counts, cellSize, mins, maxs)

  for (let z = range[2]; z <= range[5]; z += 1) {
    for (let y = range[1]; y <= range[4]; y += 1) {
      for (let x = range[0]; x <= range[3]; x += 1) {
        const cell = cellIndex(counts, x, y, z)
        const end = cellStart[cell + 1] ?? 0
        for (let i = cellStart[cell] ?? 0; i < end; i += 1) {
          const index = cellItems[i] ?? 0
          if (marks[index] === stamp) continue
          marks[index] = stamp
          const b = world.brushes[index]
          if (b === undefined) continue
          if (b.mins[0] > maxs[0] || b.maxs[0] < mins[0]) continue
          if (b.mins[1] > maxs[1] || b.maxs[1] < mins[1]) continue
          if (b.mins[2] > maxs[2] || b.maxs[2] < mins[2]) continue
          candidates.push(index)
        }
      }
    }
  }

  candidates.sort(ascending)
  return candidates
}

/** Scratch for {@link queryBrushes}; see the note there on reuse. */
const queryRange: CellRange = [0, 0, 0, 0, 0, 0]

function ascending(a: number, b: number): number {
  return a - b
}

/* --------------------------------------------------------------------------
 * Penetration
 * ----------------------------------------------------------------------- */

/**
 * How far a box at `origin` is inside solid geometry, in Quake units.
 *
 * Zero when it is clear. This is the measurement the fuzz gate in
 * `property.test.ts` asserts against, and it is deliberately a *depth* rather
 * than a boolean: "is the player stuck" is a question with a yes/no answer only
 * after someone has picked a tolerance, and picking it here, once, beats every
 * caller picking their own.
 *
 * For one convex brush the depth is the smallest distance by which the box
 * fails to clear any of its planes — the amount you would have to push it along
 * that plane's normal to be free of the brush.
 */
export function boxPenetration(
  world: CollisionWorld,
  origin: Vec3,
  mins: Vec3,
  maxs: Vec3,
): number {
  const lo = penetrationLo
  const hi = penetrationHi
  lo[0] = origin[0] + mins[0]
  lo[1] = origin[1] + mins[1]
  lo[2] = origin[2] + mins[2]
  hi[0] = origin[0] + maxs[0]
  hi[1] = origin[1] + maxs[1]
  hi[2] = origin[2] + maxs[2]

  const candidates = queryBrushes(world, lo, hi)
  let worst = 0

  for (const index of candidates) {
    const b = world.brushes[index]
    if (b === undefined) continue
    let depth = Infinity
    for (const p of b.planes) {
      const offset = planeOffset(p, mins, maxs)
      const distance = dotVec3(p.normal, origin) - (p.dist - offset)
      if (distance >= 0) {
        depth = 0
        break
      }
      if (-distance < depth) depth = -distance
    }
    if (depth > worst) worst = depth
  }

  return worst
}

const penetrationLo: MutVec3 = [0, 0, 0]
const penetrationHi: MutVec3 = [0, 0, 0]

/**
 * `dot(offset, normal)` for the box corner this plane sees first.
 *
 * This is the Minkowski expansion that turns "does a 30x30x56 box cross this
 * plane" into "does its origin cross a plane pushed out by the box's support
 * distance". Quake precomputes the eight corners and indexes them by
 * `signBits`; computing the dot product directly is the same arithmetic without
 * the table.
 */
export function planeOffset(p: Plane, mins: Vec3, maxs: Vec3): number {
  const n = p.normal
  const x = n[0] < 0 ? maxs[0] : mins[0]
  const y = n[1] < 0 ? maxs[1] : mins[1]
  const z = n[2] < 0 ? maxs[2] : mins[2]
  return n[0] * x + n[1] * y + n[2] * z
}
