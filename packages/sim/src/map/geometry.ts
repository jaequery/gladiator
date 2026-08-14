/**
 * Render geometry, derived from the collision planes. §4.3.
 *
 * This file is the load-bearing half of the map format's one idea. The client
 * does not get a mesh a level designer drew next to the brushes; it gets the
 * brushes' own faces, cut out of the very planes `map/collide.ts` hands to the
 * trace. A wall that looks solid and is not, or is solid and looks like air, is
 * therefore not a bug that has to be caught — it is a shape that cannot be
 * expressed, unless someone writes `nonSolid` or `noRender` in the map file,
 * where it shows up in a diff.
 *
 * ## How a face is found
 *
 * Quake's winding algorithm, unchanged since 1996 and still the shortest
 * correct one. For each plane of a convex brush, start with a large quadrilateral
 * lying *on* that plane and clip it by every other plane of the brush. What
 * survives is exactly the brush's face on that plane — or nothing, for a plane
 * the brush's other planes have already cut away entirely.
 *
 * Deriving the faces this way rather than enumerating "a box has six quads"
 * means a brush kind added later gets its geometry for free and cannot get it
 * wrong: there is no second description of the shape to keep in step.
 *
 * ## Frame
 *
 * Positions and normals come out in the **Quake frame**, like everything else
 * this package produces. `QUAKE_TO_ENGINE` is applied once, by the renderer, at
 * its own boundary (`docs/physics-spec.md` §0.3). Its determinant is `+1`, so
 * the conversion preserves triangle winding and the front faces stay front
 * faces.
 *
 * This runs at map load, not in a tick, so unlike the rest of the sim it
 * allocates freely.
 */

import type { Vec3 } from '../axis.ts'
import { plane } from '../collide.ts'
import type { Plane } from '../collide.ts'
import { crossVec3, dotVec3, normalizeVec3, vec3 } from '../math.ts'
import type { MutVec3 } from '../math.ts'
import { mapBrushPlanes } from './collide.ts'
import type { MapSource } from './schema.ts'

/**
 * How far off a plane a winding vertex may sit before the clipper calls it
 * "on", in Quake units.
 *
 * A thousandth of a unit. Brush coordinates are integers and plane normals are
 * unit vectors over integer components, so a genuine on-plane vertex lands
 * within a few ULPs of zero; anything a thousandth out is a real crossing.
 * Quake's own `ON_EPSILON` is 0.1, which suited a level compiler reading
 * floating-point `.map` files and is far looser than this format needs.
 */
const ON_EPSILON = 1 / 1024

/** One drawable run of the index buffer: every triangle sharing a surface. */
export type SurfaceGroup = {
  /** Name of the {@link MapSource.surfaces} entry these triangles use. */
  readonly surface: string
  /** First index into {@link MapGeometry.indices}. */
  readonly indexStart: number
  readonly indexCount: number
}

/**
 * The whole map as one merged mesh, grouped by surface.
 *
 * One buffer rather than one mesh per brush: an arena is a few hundred brushes
 * and a few thousand triangles, and a draw call per brush would cost more than
 * the geometry does. Vertices are per-face — a box corner appears three times,
 * once per face — because the faces have different normals and welding them
 * would round the corners of the world.
 */
export type MapGeometry = {
  /** `x, y, z` per vertex, Quake frame, Quake units. */
  readonly positions: Float32Array
  /** Flat face normal per vertex, Quake frame. */
  readonly normals: Float32Array
  /** Triangles, counter-clockwise seen from outside the solid. */
  readonly indices: Uint32Array
  /** In `MapSource.surfaces` order. A surface with no visible face is omitted. */
  readonly groups: readonly SurfaceGroup[]
}

/**
 * A convex polygon being clipped. Flat `[x, y, z, x, y, z, …]`, because the
 * clipper swaps two of these back and forth and an array of triples would
 * allocate a vector per vertex per plane.
 */
type Winding = number[]

/**
 * A large quadrilateral lying on `p`, wound counter-clockwise about its normal.
 *
 * Centred near `about` rather than at the plane's own foot (`normal * dist`):
 * the foot of a distant plane can be thousands of units from the brush it
 * belongs to, and starting the clip there spends precision travelling back.
 */
function basePolygon(p: Plane, about: Vec3, extent: number): Winding {
  // Any axis the normal leans on least gives a usable first tangent. 0.57735 is
  // 1/sqrt(3): no unit vector has two components at or above it unless all
  // three are exactly that, and the third axis is fine in that case.
  const seed: MutVec3 =
    Math.abs(p.normal[0]) < 0.57735
      ? [1, 0, 0]
      : Math.abs(p.normal[1]) < 0.57735
        ? [0, 1, 0]
        : [0, 0, 1]

  const tangent = vec3()
  const along = dotVec3(seed, p.normal)
  tangent[0] = seed[0] - p.normal[0] * along
  tangent[1] = seed[1] - p.normal[1] * along
  tangent[2] = seed[2] - p.normal[2] * along
  normalizeVec3(tangent, tangent)

  // `cross(tangent, bitangent) === normal`, which is what makes the corner
  // order below counter-clockwise seen from outside rather than inside.
  const bitangent = vec3()
  crossVec3(bitangent, p.normal, tangent)

  const lift = dotVec3(p.normal, about) - p.dist
  const origin: MutVec3 = [
    about[0] - p.normal[0] * lift,
    about[1] - p.normal[1] * lift,
    about[2] - p.normal[2] * lift,
  ]

  const winding: Winding = []
  for (const [s, t] of BASE_CORNERS) {
    winding.push(
      origin[0] + (tangent[0] * s + bitangent[0] * t) * extent,
      origin[1] + (tangent[1] * s + bitangent[1] * t) * extent,
      origin[2] + (tangent[2] * s + bitangent[2] * t) * extent,
    )
  }
  return winding
}

/** The four corners of {@link basePolygon}, counter-clockwise about the normal. */
const BASE_CORNERS: readonly (readonly [number, number])[] = [
  [-1, -1],
  [1, -1],
  [1, 1],
  [-1, 1],
]

/**
 * Keep the part of `winding` behind `p`. Sutherland–Hodgman, one half-space.
 *
 * Returns a new winding, empty when the polygon is entirely in front of the
 * plane. Vertices within {@link ON_EPSILON} of the plane are kept as-is and
 * never generate a crossing, which is what stops a face that meets another
 * plane exactly along an edge — every edge of a box — from sprouting a sliver
 * of degenerate triangles.
 */
function clipWinding(winding: Winding, p: Plane): Winding {
  const count = winding.length / 3
  if (count === 0) return winding

  const distances: number[] = []
  let front = false
  for (let i = 0; i < count; i += 1) {
    const d =
      (winding[i * 3] ?? 0) * p.normal[0] +
      (winding[i * 3 + 1] ?? 0) * p.normal[1] +
      (winding[i * 3 + 2] ?? 0) * p.normal[2] -
      p.dist
    distances.push(d)
    if (d > ON_EPSILON) front = true
  }
  if (!front) return winding

  const out: Winding = []
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count
    const di = distances[i] ?? 0
    const dj = distances[j] ?? 0
    const ax = winding[i * 3] ?? 0
    const ay = winding[i * 3 + 1] ?? 0
    const az = winding[i * 3 + 2] ?? 0

    if (di <= ON_EPSILON) out.push(ax, ay, az)
    // An endpoint sitting on the plane already contributed the crossing point.
    if ((di > ON_EPSILON) === (dj > ON_EPSILON)) continue
    if (di > -ON_EPSILON && di < ON_EPSILON) continue
    if (dj > -ON_EPSILON && dj < ON_EPSILON) continue

    const t = di / (di - dj)
    out.push(
      ax + ((winding[j * 3] ?? 0) - ax) * t,
      ay + ((winding[j * 3 + 1] ?? 0) - ay) * t,
      az + ((winding[j * 3 + 2] ?? 0) - az) * t,
    )
  }
  return out
}

/** Drop vertices a clip left on top of their neighbour. */
function pruneWinding(winding: Winding): Winding {
  const count = winding.length / 3
  if (count < 3) return []
  const out: Winding = []
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count
    const dx = (winding[j * 3] ?? 0) - (winding[i * 3] ?? 0)
    const dy = (winding[j * 3 + 1] ?? 0) - (winding[i * 3 + 1] ?? 0)
    const dz = (winding[j * 3 + 2] ?? 0) - (winding[i * 3 + 2] ?? 0)
    if (dx * dx + dy * dy + dz * dz < ON_EPSILON * ON_EPSILON) continue
    out.push(winding[i * 3] ?? 0, winding[i * 3 + 1] ?? 0, winding[i * 3 + 2] ?? 0)
  }
  return out.length / 3 < 3 ? [] : out
}

/**
 * The merged, surface-grouped mesh for a map.
 *
 * Brushes flagged `noRender` contribute nothing; brushes flagged `nonSolid`
 * contribute here and nowhere else. Everything else appears in both this mesh
 * and the collision world, from the same planes.
 */
export function mapGeometry(map: MapSource): MapGeometry {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  const groups: SurfaceGroup[] = []

  for (const surface of map.surfaces) {
    const indexStart = indices.length

    for (const brushDef of map.brushes) {
      if (brushDef.noRender === true) continue
      if (brushDef.surface !== surface.name) continue

      const planes = mapBrushPlanes(brushDef).map((spec) => plane(spec.normal, spec.dist))
      const centre: Vec3 = [
        (brushDef.mins[0] + brushDef.maxs[0]) / 2,
        (brushDef.mins[1] + brushDef.maxs[1]) / 2,
        (brushDef.mins[2] + brushDef.maxs[2]) / 2,
      ]
      // Twice the brush's longest edge is comfortably larger than any face of
      // it, and small enough that the clip arithmetic stays near the geometry.
      const extent =
        Math.max(
          brushDef.maxs[0] - brushDef.mins[0],
          brushDef.maxs[1] - brushDef.mins[1],
          brushDef.maxs[2] - brushDef.mins[2],
        ) *
          2 +
        64

      for (let i = 0; i < planes.length; i += 1) {
        const face = planes[i]
        if (face === undefined) continue

        let winding = basePolygon(face, centre, extent)
        for (let j = 0; j < planes.length && winding.length > 0; j += 1) {
          const other = planes[j]
          if (j === i || other === undefined) continue
          winding = clipWinding(winding, other)
        }
        winding = pruneWinding(winding)
        if (winding.length === 0) continue

        const first = positions.length / 3
        for (let v = 0; v < winding.length; v += 3) {
          positions.push(winding[v] ?? 0, winding[v + 1] ?? 0, winding[v + 2] ?? 0)
          normals.push(face.normal[0], face.normal[1], face.normal[2])
        }
        // A convex polygon fans from any vertex, and these are convex by
        // construction — every clip of a convex polygon by a half-space is.
        for (let v = 1; v + 1 < winding.length / 3; v += 1) {
          indices.push(first, first + v, first + v + 1)
        }
      }
    }

    if (indices.length > indexStart) {
      groups.push({
        surface: surface.name,
        indexStart,
        indexCount: indices.length - indexStart,
      })
    }
  }

  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    indices: Uint32Array.from(indices),
    groups,
  }
}
