/**
 * The swept-AABB trace. `docs/physics-spec.md` §2.2.
 *
 * One primitive: *move this box from A to B and tell me what it hit, and when*.
 * Player movement, rocket flight, railgun hitscan, line-of-sight for the bot
 * and spawn-point clearance are all this function with different arguments.
 *
 * ## Why it is swept, and never a point test
 *
 * Testing the destination and stepping back if it is solid is the version
 * everyone writes first, and it tunnels. At the 3000 qu/s speed clamp a body
 * covers 24 units in one 8 ms tick; a rocket at 900 covers 7.2 and a
 * rocket-jumping player covers about 8. Those are large fractions of a 30-unit
 * player box and larger than plenty of real level geometry, so a discrete test
 * misses a wall that a continuous one cannot.
 *
 * ## How the box disappears
 *
 * The box is folded into the geometry instead of being carried through it.
 * For each plane of a brush, the plane is pushed outwards by the box's support
 * distance along its normal — the Minkowski sum of the box and the solid — and
 * what remains is a *ray* against a fattened convex volume. Quake precomputes
 * the eight box corners and selects one by the plane's `signBits`;
 * `planeOffset` in `collide.ts` computes the same dot product directly.
 *
 * The ray-vs-convex test is then the classic interval intersection: walk the
 * planes accumulating the latest entry and the earliest exit, and if entry
 * still precedes exit the ray is inside the brush over that interval.
 *
 * ## The epsilon is not a fudge factor
 *
 * The trace stops {@link SURFACE_CLIP_EPSILON} short of contact. Landing
 * *exactly* on a plane leaves the next tick's trace starting on the boundary,
 * where a rounding error in either direction decides whether the body is inside
 * solid or not, and being inside solid is unrecoverable in a way that being
 * an eighth of a unit clear of it is not. Every Quake derivative carries this
 * constant for the same reason and at the same value.
 */

import type { Vec3 } from './axis.ts'
import { POINT_MAXS, POINT_MINS } from './bbox.ts'
import { planeOffset, queryBrushes } from './collide.ts'
import type { Brush, CollisionWorld } from './collide.ts'
import { dotVec3, vec3 } from './math.ts'
import type { MutVec3 } from './math.ts'

/**
 * How far short of a surface a trace stops, in Quake units.
 *
 * Quake 3's `SURFACE_CLIP_EPSILON`. An eighth of a unit is exactly
 * representable in binary floating point, which is worth having: the gap a
 * trace leaves is then the same gap on every machine, rather than the same
 * decimal rounded two different ways.
 */
export const SURFACE_CLIP_EPSILON = 0.125

/**
 * How far the swept bounds are grown before the broadphase is asked, in units.
 *
 * Pure belt and braces: it costs one extra candidate brush now and again and
 * removes any dependence on whether a brush that exactly touches the sweep
 * bounds counts as overlapping them.
 */
const TRACE_BOUNDS_SLOP = 1

/**
 * What a trace found.
 *
 * Filled in place by {@link traceBox} so a caller in the tick loop can hold one
 * of these and allocate nothing. `slideMove` performs up to ten traces per
 * player per tick, 125 times a second, per room.
 */
export type TraceResult = {
  /**
   * How much of the move was completed, in `[0, 1]`.
   *
   * Exactly `1` means nothing was hit — test it with `=== 1`, not with a
   * tolerance, because `slideMove` branches on it.
   */
  fraction: number
  /** Where the box ended up: `start + fraction * (end - start)`. */
  endpos: MutVec3
  /** Outward unit normal of the surface hit. All zeroes when nothing was hit. */
  planeNormal: MutVec3
  /** `dot(planeNormal, x) === planeDist` on the surface hit. */
  planeDist: number
  /** The box was already inside solid geometry at `start`. */
  startsolid: boolean
  /** The box was inside solid geometry for the whole move; `fraction` is 0. */
  allsolid: boolean
  /** Index into `world.brushes` of what was hit, or -1. */
  brushIndex: number
}

/** A `TraceResult` to be filled in later. Allocate once, reuse. */
export function createTrace(): TraceResult {
  return {
    fraction: 1,
    endpos: vec3(),
    planeNormal: vec3(),
    planeDist: 0,
    startsolid: false,
    allsolid: false,
    brushIndex: -1,
  }
}

/**
 * Sweep the box `[mins, maxs]` from `start` to `end` through the world.
 *
 * `mins` and `maxs` are relative to the box's origin, so a player is
 * `PLAYER_MINS`/`PLAYER_MAXS` and a hitscan is `POINT_MINS`/`POINT_MAXS`.
 * Writes into `out` and returns it.
 *
 * `out` may not alias `start` or `end`; and because the broadphase reuses one
 * candidate buffer per world, a trace must not be interleaved with another
 * query on the same world. Neither is a real constraint on a synchronous
 * simulation, and both are cheaper than the allocation avoiding them would
 * cost.
 */
export function traceBox(
  out: TraceResult,
  world: CollisionWorld,
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
): TraceResult {
  out.fraction = 1
  out.planeNormal[0] = 0
  out.planeNormal[1] = 0
  out.planeNormal[2] = 0
  out.planeDist = 0
  out.startsolid = false
  out.allsolid = false
  out.brushIndex = -1

  sweepLo[0] = (start[0] < end[0] ? start[0] : end[0]) + mins[0] - TRACE_BOUNDS_SLOP
  sweepLo[1] = (start[1] < end[1] ? start[1] : end[1]) + mins[1] - TRACE_BOUNDS_SLOP
  sweepLo[2] = (start[2] < end[2] ? start[2] : end[2]) + mins[2] - TRACE_BOUNDS_SLOP
  sweepHi[0] = (start[0] > end[0] ? start[0] : end[0]) + maxs[0] + TRACE_BOUNDS_SLOP
  sweepHi[1] = (start[1] > end[1] ? start[1] : end[1]) + maxs[1] + TRACE_BOUNDS_SLOP
  sweepHi[2] = (start[2] > end[2] ? start[2] : end[2]) + maxs[2] + TRACE_BOUNDS_SLOP

  const candidates = queryBrushes(world, sweepLo, sweepHi)
  for (const index of candidates) {
    const b = world.brushes[index]
    if (b === undefined) continue
    traceThroughBrush(out, b, index, start, end, mins, maxs)
    // Nothing later can beat a fraction of zero, and Quake stops here too.
    if (out.fraction === 0) break
  }

  if (out.fraction === 1) {
    out.endpos[0] = end[0]
    out.endpos[1] = end[1]
    out.endpos[2] = end[2]
  } else {
    const f = out.fraction
    out.endpos[0] = start[0] + f * (end[0] - start[0])
    out.endpos[1] = start[1] + f * (end[1] - start[1])
    out.endpos[2] = start[2] + f * (end[2] - start[2])
  }

  return out
}

const sweepLo: MutVec3 = [0, 0, 0]
const sweepHi: MutVec3 = [0, 0, 0]

/**
 * Sweep a point rather than a box: hitscan, line of sight, a rocket's tip.
 *
 * Deliberately the same code path with a zero-extent box, so there is no second
 * implementation to fall out of step with the first when the epsilon or the
 * plane convention changes.
 */
export function traceRay(
  out: TraceResult,
  world: CollisionWorld,
  start: Vec3,
  end: Vec3,
): TraceResult {
  return traceBox(out, world, start, end, POINT_MINS, POINT_MAXS)
}

/**
 * Clip a swept box against one convex brush, tightening `out` if it hits
 * sooner than whatever is already recorded there.
 *
 * `enterFrac` starts below zero and `leaveFrac` above one so that the two
 * carry "no constraint yet" without a separate flag. A brush is entered over
 * `[enterFrac, leaveFrac]`, and that interval being empty is exactly the
 * statement that the swept box misses it.
 */
function traceThroughBrush(
  out: TraceResult,
  b: Brush,
  index: number,
  start: Vec3,
  end: Vec3,
  mins: Vec3,
  maxs: Vec3,
): void {
  let enterFrac = -1
  let leaveFrac = 1
  let clip: Vec3 | null = null
  let clipDist = 0
  let startOut = false
  let getOut = false

  for (const p of b.planes) {
    const dist = p.dist - planeOffset(p, mins, maxs)
    const d1 = dotVec3(start, p.normal) - dist
    const d2 = dotVec3(end, p.normal) - dist

    if (d2 > 0) getOut = true
    if (d1 > 0) startOut = true

    // Entirely in front of this face: outside a convex solid, so outside the
    // brush, and no other face can change that.
    if (d1 > 0 && (d2 >= SURFACE_CLIP_EPSILON || d2 >= d1)) return
    // Behind the face for the whole move: this face does not bound the answer.
    if (d1 <= 0 && d2 <= 0) continue

    if (d1 > d2) {
      let f = (d1 - SURFACE_CLIP_EPSILON) / (d1 - d2)
      if (f < 0) f = 0
      if (f > enterFrac) {
        enterFrac = f
        clip = p.normal
        clipDist = p.dist
      }
    } else {
      let f = (d1 + SURFACE_CLIP_EPSILON) / (d1 - d2)
      if (f > 1) f = 1
      if (f < leaveFrac) leaveFrac = f
    }
  }

  if (!startOut) {
    // The box began inside this brush. There is no surface to clip against —
    // the caller's recovery (`correctAllSolid`) is what gets it out.
    out.startsolid = true
    if (!getOut) {
      out.allsolid = true
      out.fraction = 0
    }
    return
  }

  if (enterFrac < leaveFrac && enterFrac > -1 && enterFrac < out.fraction && clip !== null) {
    out.fraction = enterFrac < 0 ? 0 : enterFrac
    out.planeNormal[0] = clip[0]
    out.planeNormal[1] = clip[1]
    out.planeNormal[2] = clip[2]
    out.planeDist = clipDist
    out.brushIndex = index
  }
}
