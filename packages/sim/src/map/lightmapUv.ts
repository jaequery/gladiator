/**
 * The lightmap atlas: where every brush face's light lives. §4.6.
 *
 * A lightmap is a second, *unique* unwrap of the level. The first UV set tiles
 * a material across a surface — `render/mapMesh.ts` derives it from Quake's
 * axial projection — and the second gives every triangle its own,
 * non-overlapping patch of one atlas. This file is the second one.
 *
 * ## Why it lives in the simulation package
 *
 * Nothing in here is drawn, and no tick reads it, so on the face of it this is
 * renderer code sitting on the wrong side of the fence. It is here for the same
 * reason `map/geometry.ts` is: **two programs have to agree about it exactly**.
 *
 *   - `tools/bake-lightmap.ts` walks the atlas texel by texel, works out where
 *     in the world each one is, and traces light to it.
 *   - `packages/client/src/render/mapMesh.ts` writes the matching `uv2` on the
 *     arena mesh, at load, in a browser.
 *
 * If those two ever computed the layout separately, a change to one would light
 * the level from another wall — and the symptom, per `docs/assets.md` §3, is a
 * *plausible* picture rather than an obviously broken one. One function,
 * imported by both, makes the agreement structural rather than remembered. The
 * package they can both reach is this one, and the code is what the rest of
 * `packages/sim` already is: arithmetic over map geometry with no dependencies
 * and no clock.
 *
 * ## The layout
 *
 * One rectangle per face, packed on shelves. A face is planar and convex, so it
 * projects with no distortion onto its own plane: pick an orthonormal basis
 * from the normal, project every vertex into it, and the face's rectangle is
 * the bounding box of the result divided by {@link DEFAULT_LUXEL_SIZE}.
 *
 * The mapping puts the face's extremes on the **centres** of the first and last
 * texel of its rectangle rather than on its edges. That is the whole trick that
 * keeps a bilinear tap inside the patch it belongs to: a sample anywhere on the
 * face reads between texel centres, so its four taps are texels of this face,
 * never of the neighbour packed against it.
 *
 * Everything is derived from the geometry and nothing is authored, so a brush
 * that moves takes its light with it and a brush that is deleted frees its
 * texels — with no atlas file to re-cut by hand.
 */

import type { MapGeometry } from './geometry.ts'

/**
 * Quake units per lightmap texel.
 *
 * 8 — an eighth of the 64-unit texture scale, and twice Quake's own lightmap
 * density, which was chosen for 1996's memory rather than for 1996's taste.
 * Baked light on a static level is low-frequency by construction: it is the
 * *soft* part of the lighting, and the hard part — the albedo's own detail —
 * comes through the tiling UVs at full resolution. The one place the density
 * shows is the edge of a shadow, and at 16 units a texel the edge of a pillar's
 * shadow is visibly stepped across a floor a player is looking straight at.
 */
export const DEFAULT_LUXEL_SIZE = 8

/**
 * The atlas width, in texels. Power of two: every block format compresses 4x4
 * texels at a time and a mip chain has to halve cleanly. `docs/assets.md` §2.
 */
export const DEFAULT_ATLAS_WIDTH = 1024

/**
 * The tallest atlas the packer may grow to before it gives up, in texels.
 *
 * The height is not authored — see {@link LightmapUnwrap.atlasHeight}. This is
 * the ceiling on what it is allowed to become, so that a map that has grown
 * past what this density can hold fails the bake with a sentence instead of
 * shipping a four-megabyte texture nobody looked at.
 */
export const DEFAULT_MAX_ATLAS_HEIGHT = 1024

/**
 * Texels of empty space between two packed rectangles.
 *
 * One. The centre-sampling rule above already keeps a face's own bilinear taps
 * inside its own rectangle, so this is not filtering headroom — it is room for
 * the baker to bleed a border outwards, which is what stops a mip level (which
 * averages 2x2 texels with no idea where a patch ends) from mixing two faces.
 */
export const DEFAULT_PADDING = 1

export type LightmapUvOptions = {
  /** Quake units per texel. Defaults to {@link DEFAULT_LUXEL_SIZE}. */
  readonly luxelSize?: number
  /** Atlas width in texels. Defaults to {@link DEFAULT_ATLAS_WIDTH}. */
  readonly atlasWidth?: number
  /** The ceiling on the derived height. Defaults to {@link DEFAULT_MAX_ATLAS_HEIGHT}. */
  readonly maxAtlasHeight?: number
  /** Texels between rectangles. Defaults to {@link DEFAULT_PADDING}. */
  readonly padding?: number
}

/**
 * Where one face's light sits in the atlas, and how to walk it.
 *
 * The baker reads this; the renderer reads {@link LightmapUnwrap.uv2}. Both
 * come out of one call, so they cannot describe different layouts.
 */
export type LightmapPatch = {
  /** Index into {@link MapGeometry.faces}. */
  readonly face: number
  /** Left texel of the rectangle. */
  readonly x: number
  /** Top texel of the rectangle. */
  readonly y: number
  /** Rectangle width in texels. At least one. */
  readonly width: number
  /** Rectangle height in texels. At least one. */
  readonly height: number
  /** World position of the texel at `(x, y)`, Quake frame. */
  readonly origin: readonly [number, number, number]
  /** World step from one texel to the next along `+x` in the atlas. */
  readonly right: readonly [number, number, number]
  /** World step from one texel to the next along `+y` in the atlas. */
  readonly down: readonly [number, number, number]
  /** The face's outward unit normal, Quake frame. */
  readonly normal: readonly [number, number, number]
  /** Index into `MapSource.surfaces` — the albedo a bounce off this face carries. */
  readonly surface: number
}

export type LightmapUnwrap = {
  /** Two floats per vertex, in {@link MapGeometry.positions} order. */
  readonly uv2: Float32Array
  readonly patches: readonly LightmapPatch[]
  readonly atlasWidth: number
  /**
   * The atlas height, derived rather than authored.
   *
   * The smallest power of two the packed shelves fit in. A map does not get to
   * choose it, which is what stops the artifact from carrying a few hundred
   * rows of black texels nobody has any use for — and, because the baker and
   * the renderer both read it off the same call, neither can disagree about how
   * tall the picture they are sharing is.
   */
  readonly atlasHeight: number
  readonly luxelSize: number
  /** Texels the patches occupy, of `atlasWidth * atlasHeight`. For the bake log. */
  readonly usedTexels: number
}

/** A `[x, y, z]` triple being built. Mutable so the arithmetic below allocates once. */
type Basis = [number, number, number]

/**
 * An orthonormal basis for a plane, chosen from its normal alone.
 *
 * The same rule `geometry.ts` uses to seed a base polygon, and for the same
 * reason: the axis a normal leans on *least* is the one that gives a usable
 * tangent when projected out of it. 0.57735 is 1/sqrt(3) — no unit vector has
 * two components at or above it unless all three are exactly that, and the
 * third axis is fine in that case.
 *
 * It has to be a pure function of the normal and of nothing else, because the
 * baker and the renderer both call it and neither can see the other's answer.
 */
function planeBasis(
  normal: readonly [number, number, number],
  tangent: Basis,
  bitangent: Basis,
): void {
  const seed: Basis =
    Math.abs(normal[0]) < 0.57735 ? [1, 0, 0] : Math.abs(normal[1]) < 0.57735 ? [0, 1, 0] : [0, 0, 1]

  const along = seed[0] * normal[0] + seed[1] * normal[1] + seed[2] * normal[2]
  tangent[0] = seed[0] - normal[0] * along
  tangent[1] = seed[1] - normal[1] * along
  tangent[2] = seed[2] - normal[2] * along
  const length = Math.sqrt(
    tangent[0] * tangent[0] + tangent[1] * tangent[1] + tangent[2] * tangent[2],
  )
  const scale = length > 0 ? 1 / length : 0
  tangent[0] *= scale
  tangent[1] *= scale
  tangent[2] *= scale

  bitangent[0] = normal[1] * tangent[2] - normal[2] * tangent[1]
  bitangent[1] = normal[2] * tangent[0] - normal[0] * tangent[2]
  bitangent[2] = normal[0] * tangent[1] - normal[1] * tangent[0]
}

/** A shelf in the packer: a row of rectangles, all sharing a top edge. */
type Shelf = {
  /** Top texel of the row. */
  readonly top: number
  /** Next free texel along the row. */
  cursor: number
  /** The tallest rectangle placed on it so far. */
  height: number
}

/**
 * Unwrap a map's faces into one lightmap atlas.
 *
 * Deterministic: the same geometry and options produce the same layout on every
 * machine, which is the property the whole file exists for. Throws rather than
 * overlapping two faces when the atlas is too small — a lightmap that silently
 * shares texels between two walls is the failure this is meant to make
 * impossible, so it is not allowed to be the quiet outcome.
 */
export function lightmapUnwrap(
  geometry: MapGeometry,
  options: LightmapUvOptions = {},
): LightmapUnwrap {
  const luxelSize = options.luxelSize ?? DEFAULT_LUXEL_SIZE
  const atlasWidth = options.atlasWidth ?? DEFAULT_ATLAS_WIDTH
  const maxAtlasHeight = options.maxAtlasHeight ?? DEFAULT_MAX_ATLAS_HEIGHT
  const padding = options.padding ?? DEFAULT_PADDING

  const uv2 = new Float32Array((geometry.positions.length / 3) * 2)
  // Which vertices actually got a `v` written in texels, so the divide at the
  // end cannot turn an untouched zero into something else.
  const rows = new Uint8Array(geometry.positions.length / 3)
  const tangent: Basis = [0, 0, 0]
  const bitangent: Basis = [0, 0, 0]

  /** Everything about a face the packer needs before it knows where it goes. */
  type Pending = {
    readonly face: number
    readonly width: number
    readonly height: number
    readonly minS: number
    readonly minT: number
    readonly stepS: number
    readonly stepT: number
    readonly tangent: readonly [number, number, number]
    readonly bitangent: readonly [number, number, number]
    readonly normal: readonly [number, number, number]
  }

  const pending: Pending[] = []

  for (const [index, face] of geometry.faces.entries()) {
    const first = face.vertexStart
    const normal: readonly [number, number, number] = [
      geometry.normals[first * 3] ?? 0,
      geometry.normals[first * 3 + 1] ?? 0,
      geometry.normals[first * 3 + 2] ?? 0,
    ]
    planeBasis(normal, tangent, bitangent)

    let minS = Number.POSITIVE_INFINITY
    let maxS = Number.NEGATIVE_INFINITY
    let minT = Number.POSITIVE_INFINITY
    let maxT = Number.NEGATIVE_INFINITY
    for (let v = 0; v < face.vertexCount; v += 1) {
      const at = (first + v) * 3
      const x = geometry.positions[at] ?? 0
      const y = geometry.positions[at + 1] ?? 0
      const z = geometry.positions[at + 2] ?? 0
      const s = x * tangent[0] + y * tangent[1] + z * tangent[2]
      const t = x * bitangent[0] + y * bitangent[1] + z * bitangent[2]
      if (s < minS) minS = s
      if (s > maxS) maxS = s
      if (t < minT) minT = t
      if (t > maxT) maxT = t
    }

    // One more texel than the extent needs: a face 16 units across at 8 units a
    // texel spans *three* texel centres — 0, 8 and 16 — not two.
    const width = Math.max(1, Math.ceil((maxS - minS) / luxelSize) + 1)
    const height = Math.max(1, Math.ceil((maxT - minT) / luxelSize) + 1)
    pending.push({
      face: index,
      width,
      height,
      minS,
      minT,
      stepS: width > 1 ? (maxS - minS) / (width - 1) : 0,
      stepT: height > 1 ? (maxT - minT) / (height - 1) : 0,
      tangent: [tangent[0], tangent[1], tangent[2]],
      bitangent: [bitangent[0], bitangent[1], bitangent[2]],
      normal,
    })
  }

  // Tallest first, so a shelf's wasted strip is as thin as the packer can make
  // it. Ties break on the face index, which is what keeps the layout a function
  // of the geometry rather than of the sort's stability.
  const order = [...pending].sort((a, b) => b.height - a.height || a.face - b.face)

  const shelves: Shelf[] = []
  const patches: LightmapPatch[] = []
  let usedTexels = 0

  for (const item of order) {
    const face = geometry.faces[item.face]
    if (face === undefined) continue

    let shelf = shelves.find(
      (candidate) =>
        candidate.cursor + item.width <= atlasWidth && item.height <= candidate.height,
    )
    if (shelf === undefined) {
      // No shelf both wide enough and tall enough. Because the list is sorted
      // tallest-first, a new shelf is always at least as tall as anything that
      // will be asked of it afterwards.
      const previous = shelves[shelves.length - 1]
      const top = previous === undefined ? 0 : previous.top + previous.height + padding
      if (top + item.height > maxAtlasHeight || item.width > atlasWidth) {
        throw new Error(
          `gladiator: this map's ${geometry.faces.length} faces do not fit in a ${atlasWidth}x${maxAtlasHeight} lightmap at ${luxelSize} units per texel. Raise DEFAULT_MAX_ATLAS_HEIGHT or DEFAULT_LUXEL_SIZE in packages/sim/src/map/lightmapUv.ts.`,
        )
      }
      shelf = { top, cursor: 0, height: item.height }
      shelves.push(shelf)
    }

    const x = shelf.cursor
    const y = shelf.top
    shelf.cursor += item.width + padding
    usedTexels += item.width * item.height

    // The world position of the texel at `(x, y)`, and the world step between
    // texels. The baker reconstructs every luxel from exactly these three
    // vectors, so it walks the same grid the UVs below sample.
    const origin: readonly [number, number, number] = [
      item.tangent[0] * item.minS + item.bitangent[0] * item.minT,
      item.tangent[1] * item.minS + item.bitangent[1] * item.minT,
      item.tangent[2] * item.minS + item.bitangent[2] * item.minT,
    ]
    // The projection threw away the component along the normal; put it back
    // from any vertex of the face, all of which share it.
    const anchor = face.vertexStart * 3
    const lift =
      ((geometry.positions[anchor] ?? 0) - origin[0]) * item.normal[0] +
      ((geometry.positions[anchor + 1] ?? 0) - origin[1]) * item.normal[1] +
      ((geometry.positions[anchor + 2] ?? 0) - origin[2]) * item.normal[2]

    patches.push({
      face: item.face,
      x,
      y,
      width: item.width,
      height: item.height,
      origin: [
        origin[0] + item.normal[0] * lift,
        origin[1] + item.normal[1] * lift,
        origin[2] + item.normal[2] * lift,
      ],
      right: [
        item.tangent[0] * item.stepS,
        item.tangent[1] * item.stepS,
        item.tangent[2] * item.stepS,
      ],
      down: [
        item.bitangent[0] * item.stepT,
        item.bitangent[1] * item.stepT,
        item.bitangent[2] * item.stepT,
      ],
      normal: item.normal,
      surface: face.surface,
    })

    for (let v = 0; v < face.vertexCount; v += 1) {
      const at = (face.vertexStart + v) * 3
      const px = geometry.positions[at] ?? 0
      const py = geometry.positions[at + 1] ?? 0
      const pz = geometry.positions[at + 2] ?? 0
      const s = px * item.tangent[0] + py * item.tangent[1] + pz * item.tangent[2]
      const t = px * item.bitangent[0] + py * item.bitangent[1] + pz * item.bitangent[2]
      // Texel *centres*, not edges. See the header: this is what keeps a
      // bilinear tap on this face rather than on whatever is packed beside it.
      const u = x + 0.5 + (item.stepS > 0 ? (s - item.minS) / item.stepS : 0)
      const w = y + 0.5 + (item.stepT > 0 ? (t - item.minT) / item.stepT : 0)
      uv2[(face.vertexStart + v) * 2] = u / atlasWidth
      uv2[(face.vertexStart + v) * 2 + 1] = w
      rows[face.vertexStart + v] = 1
    }
  }

  // Back into geometry order. The renderer does not care, but a baker that
  // walks patches in a stable order writes a stable atlas, and a stable atlas
  // is what makes `pnpm lightmap:bake --check` a check rather than a coin toss.
  patches.sort((a, b) => a.face - b.face)

  // The height is whatever the shelves came to, rounded up to a power of two —
  // see `LightmapUnwrap.atlasHeight`. It cannot be known until the packing is
  // done, which is why the `v` coordinates above are written in texels and
  // divided here.
  const bottom = shelves.reduce((deepest, shelf) => Math.max(deepest, shelf.top + shelf.height), 0)
  let atlasHeight = 4
  while (atlasHeight < bottom) atlasHeight *= 2
  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i] === 1) uv2[i * 2 + 1] = (uv2[i * 2 + 1] ?? 0) / atlasHeight
  }

  return { uv2, patches, atlasWidth, atlasHeight, luxelSize, usedTexels }
}
