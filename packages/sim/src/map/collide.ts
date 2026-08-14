/**
 * Map brushes to collision brushes. `docs/physics-spec.md` §4.2.
 *
 * `collide.ts` one directory up owns the general convex-brush world and the
 * broadphase over it; this file is the narrow bridge from the authored format
 * to that world, and it is the *only* place a map's geometry is turned into
 * planes. `map/geometry.ts` derives the render meshes from the planes this
 * file produces, which is what makes "what you can walk on is what you can
 * see" a property of the code rather than of the level designer's discipline.
 *
 * Everything here is closed-form. A ramp is an AABB with its top face swapped
 * for one analytic plane whose normal is an integer vector before
 * normalisation, so two peers compute the same plane from the same map by
 * arithmetic rather than by luck.
 */

import { boxBrush, brush, createCollisionWorld } from '../collide.ts'
import type { Brush, CollisionWorld, PlaneSpec } from '../collide.ts'
import { RAMP_SLOPES } from './schema.ts'
import type { MapBrush, MapRampBrush, MapSource } from './schema.ts'

/** Which coordinate a ramp's rise runs along, and which way. */
export type RampAxis = {
  /** 0 for `x`, 1 for `y`. */
  readonly axis: 0 | 1
  /** `+1` when the surface climbs towards `maxs`, `-1` when towards `mins`. */
  readonly sign: 1 | -1
}

/** Decompose a {@link MapRampBrush.rise} into an axis and a direction. */
export function rampAxis(brushDef: MapRampBrush): RampAxis {
  switch (brushDef.rise) {
    case '+x':
      return { axis: 0, sign: 1 }
    case '-x':
      return { axis: 0, sign: -1 }
    case '+y':
      return { axis: 1, sign: 1 }
    case '-y':
      return { axis: 1, sign: -1 }
  }
}

/**
 * How far the sloped face falls across the ramp's footprint, in Quake units.
 *
 * Exact for both slopes a map may use: a whole run at `1:1`, and a run halved
 * at `1:2`. Halving is exact in binary floating point, which is the reason the
 * gradients are written as integer ratios rather than as angles.
 */
export function rampDrop(brushDef: MapRampBrush): number {
  const { axis } = rampAxis(brushDef)
  const slope = RAMP_SLOPES[brushDef.slope]
  return ((brushDef.maxs[axis] - brushDef.mins[axis]) * slope.rise) / slope.run
}

/**
 * The `z` the sloped face reaches at the low end of the run.
 *
 * The bake requires this to sit strictly above `mins[2]`, so the brush always
 * has a plinth under its whole footprint. A ramp whose slope runs out before
 * the end of its box would be a knife edge terminating in mid-air, and the
 * geometry it produced would be a shape the author did not draw.
 */
export function rampLowHeight(brushDef: MapRampBrush): number {
  return brushDef.maxs[2] - rampDrop(brushDef)
}

/**
 * The sloped top plane of a ramp.
 *
 * The normal is handed over unnormalised, as integers: `plane()` normalises it
 * and scales `dist` to match, and giving it `(-1, 0, 2)` rather than a
 * hand-typed `(-0.4472, 0, 0.8944)` means the unit normal is whatever
 * `Math.sqrt` says it is on both peers, rather than whatever a human rounded it
 * to.
 */
export function rampSlopePlane(brushDef: MapRampBrush): PlaneSpec {
  const { axis, sign } = rampAxis(brushDef)
  const slope = RAMP_SLOPES[brushDef.slope]

  // The surface climbs towards `sign`, so it faces back the other way.
  const normal: [number, number, number] = [0, 0, slope.run]
  normal[axis] = -sign * slope.rise

  // It passes through the top face at the high end of the run.
  const high = sign > 0 ? brushDef.maxs[axis] : brushDef.mins[axis]
  const dist = normal[axis] * high + slope.run * brushDef.maxs[2]

  return { normal, dist }
}

/**
 * The outward-facing planes of a map brush, in a fixed order.
 *
 * The order is part of the format: `map/geometry.ts` emits one polygon per
 * plane in this order, so a surface's triangles come out in the same order on
 * every machine, and a render mesh diffs as cleanly as the map does.
 */
export function mapBrushPlanes(brushDef: MapBrush): PlaneSpec[] {
  const { mins, maxs } = brushDef
  const sides: PlaneSpec[] = [
    { normal: [1, 0, 0], dist: maxs[0] },
    { normal: [-1, 0, 0], dist: -mins[0] },
    { normal: [0, 1, 0], dist: maxs[1] },
    { normal: [0, -1, 0], dist: -mins[1] },
    { normal: [0, 0, -1], dist: -mins[2] },
  ]
  sides.push(
    brushDef.kind === 'ramp' ? rampSlopePlane(brushDef) : { normal: [0, 0, 1], dist: maxs[2] },
  )
  return sides
}

/**
 * One map brush as a collision brush.
 *
 * A box goes through `boxBrush` rather than through the general path, because
 * `boxBrush` is the version that has already been used by every other brush in
 * the repo and there is no reason for a map's floor to be built by different
 * code than a test fixture's floor.
 */
export function mapCollisionBrush(brushDef: MapBrush): Brush {
  if (brushDef.kind === 'box') return boxBrush(brushDef.mins, brushDef.maxs)
  return brush(mapBrushPlanes(brushDef))
}

/**
 * The solid brushes of a map, in source order, and where each came from.
 *
 * `nonSolid` brushes are dropped, which renumbers everything after them — so
 * the mapping back to `source.brushes` is returned rather than left for a
 * caller to reconstruct. A trace reports the brush it hit by index into
 * `world.brushes`; going from that to the surface it was drawn with is how an
 * impact decal or a footstep sound finds its material, and getting the
 * renumbering wrong there produces a wrong answer that still looks plausible.
 */
export function mapCollisionBrushes(map: MapSource): {
  brushes: Brush[]
  sourceBrush: Int32Array
} {
  const brushes: Brush[] = []
  const sources: number[] = []
  for (let i = 0; i < map.brushes.length; i += 1) {
    const brushDef = map.brushes[i]
    if (brushDef === undefined || brushDef.nonSolid === true) continue
    brushes.push(mapCollisionBrush(brushDef))
    sources.push(i)
  }
  return { brushes, sourceBrush: Int32Array.from(sources) }
}

/** The collision world for a map. Level data: built once, never mutated. */
export function createMapWorld(map: MapSource): CollisionWorld {
  return createCollisionWorld(mapCollisionBrushes(map).brushes)
}
