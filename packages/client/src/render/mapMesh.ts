/**
 * The arena, as one mesh.
 *
 * The vertices are not modelled: `mapGeometry` cuts them out of the very planes
 * the trace collides against (`packages/sim/src/map/geometry.ts`), so a wall
 * that looks solid and is not cannot be built. What is left for the renderer is
 * everything the simulation has no opinion about — which frame the numbers are
 * in, how they are grouped into draw calls, what they are shaded with, and
 * where the texture goes.
 *
 * ## One mesh, one submesh per surface
 *
 * An arena is a few hundred brushes and a few thousand triangles. A mesh per
 * brush would cost more in draw-call overhead than the geometry costs to
 * rasterise, so everything shares one vertex and index buffer and each surface
 * becomes a `SubMesh` over a contiguous slice of it. `mapGeometry` already
 * emits the slices contiguously, surface by surface, which is what makes this
 * a slice rather than a sort.
 *
 * ## The frame conversion happens here, once
 *
 * Positions and normals arrive in the Quake frame like everything else the
 * simulation produces. `quakeToEngine` is applied at this boundary and nowhere
 * else, at load, never per frame. Its determinant is `+1`, so triangle winding
 * survives and front faces stay front faces. `docs/physics-spec.md` §0.3.
 *
 * ## Texture coordinates are derived too
 *
 * Quake's axial projection: each face is projected onto whichever plane its
 * normal leans on hardest, in Quake units, and divided by {@link TEXEL_SCALE}.
 * The result is one texel density everywhere in the map, with no authored UVs
 * to drift out of step with a brush somebody moved.
 */
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { Material } from '@babylonjs/core/Materials/material'
import { MultiMaterial } from '@babylonjs/core/Materials/multiMaterial'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { SubMesh } from '@babylonjs/core/Meshes/subMesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import type { Scene } from '@babylonjs/core/scene'
import { type MapGeometry, type MapSource, type MapSurface, quakeToEngine } from '@gladiator/sim'

import { applyAnisotropy } from './scene.ts'

/**
 * Quake units per texture repeat.
 *
 * 64 — Quake's own texel scale, and the width of a step. It makes the grid on
 * the floor a unit a player can measure a jump in, which is most of what a
 * pre-art texture is for.
 */
export const TEXEL_SCALE = 64

/**
 * How a logical surface material is drawn.
 *
 * `MapSurface.material` is a *logical* name — the map format deliberately
 * refuses to know what a file path is (GLAD-PGS73O owns the asset pipeline), so
 * the renderer resolves the name to a look. Unknown names fall back to the
 * opaque default rather than failing: a map that names a material this build
 * has never heard of should still be playable.
 */
type MaterialPreset = {
  readonly alpha: number
  readonly specular: number
  readonly gloss: number
}

const DEFAULT_PRESET: MaterialPreset = { alpha: 1, specular: 0, gloss: 16 }

const MATERIAL_PRESETS: Record<string, MaterialPreset> = {
  concrete: DEFAULT_PRESET,
  metal: { alpha: 1, specular: 0.18, gloss: 48 },
  glass: { alpha: 0.28, specular: 0.4, gloss: 96 },
}

export type MapMesh = {
  readonly mesh: Mesh
  readonly vertices: number
  readonly triangles: number
  /** In `map.surfaces` order, minus any surface with no visible face. */
  readonly surfaces: readonly string[]
  /** Stop re-deciding, every frame, something that was settled at load. */
  freeze(): void
  dispose(): void
}

/**
 * A grid, drawn once into a canvas texture.
 *
 * Stands in for the art (GLAD-PGS73O) and earns its place until then: an
 * untextured room gives a player nothing to judge speed or distance against,
 * and strafe-jumping is a skill built entirely on judging speed.
 */
export function createGridTexture(scene: Scene, engine: AbstractEngine): DynamicTexture {
  const size = 256
  const texture = new DynamicTexture('grid', { width: size, height: size }, scene, true)
  const context = texture.getContext() as unknown as CanvasRenderingContext2D

  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, size, size)

  // Two weights of line: the cell edge, and a quarter-cell hairline. The
  // hairline is what stops a wall from looking like a flat colour when you are
  // close enough to it that one cell fills the screen.
  context.strokeStyle = 'rgba(0, 0, 0, 0.10)'
  context.lineWidth = 1
  for (let i = 1; i < 4; i += 1) {
    const at = (i * size) / 4
    context.beginPath()
    context.moveTo(at, 0)
    context.lineTo(at, size)
    context.moveTo(0, at)
    context.lineTo(size, at)
    context.stroke()
  }

  context.strokeStyle = 'rgba(0, 0, 0, 0.38)'
  context.lineWidth = 3
  context.strokeRect(1.5, 1.5, size - 3, size - 3)

  texture.update(false)
  texture.wrapU = Texture.WRAP_ADDRESSMODE
  texture.wrapV = Texture.WRAP_ADDRESSMODE
  applyAnisotropy(texture, engine)
  return texture
}

/** One material per surface: the map's tint, over the shared grid. */
function createSurfaceMaterial(
  scene: Scene,
  surface: MapSurface,
  grid: BaseTexture | null,
): StandardMaterial {
  const preset = MATERIAL_PRESETS[surface.material] ?? DEFAULT_PRESET
  const material = new StandardMaterial(`surface:${surface.name}`, scene)
  const [r, g, b] = surface.tint

  material.diffuseColor = new Color3(r, g, b)
  if (grid !== null) material.diffuseTexture = grid
  // Tinted ambient, so a surface facing away from every light keeps its
  // identity instead of going the same grey as its neighbour.
  material.ambientColor = new Color3(r, g, b)
  material.specularColor = new Color3(preset.specular, preset.specular, preset.specular)
  material.specularPower = preset.gloss
  material.alpha = preset.alpha
  material.backFaceCulling = preset.alpha >= 1
  // The fill light plus up to `MAX_MAP_LIGHTS` point lights. Babylon's default
  // is 4, which would silently drop one.
  material.maxSimultaneousLights = 5
  return material
}

/**
 * Texture coordinates for a face, from its normal. Quake's axial projection.
 *
 * Whichever axis the normal leans on hardest is the one projected *away*; the
 * other two become u and v. All three cases are written out rather than
 * computed from an index, because getting the pairing wrong mirrors the texture
 * on one class of surface only, which is exactly the sort of thing that ships.
 */
function faceUv(
  position: readonly [number, number, number],
  normal: readonly [number, number, number],
): [number, number] {
  const [x, y, z] = position
  const ax = Math.abs(normal[0])
  const ay = Math.abs(normal[1])
  const az = Math.abs(normal[2])

  if (az >= ax && az >= ay) return [x / TEXEL_SCALE, y / TEXEL_SCALE]
  if (ax >= ay) return [y / TEXEL_SCALE, z / TEXEL_SCALE]
  return [x / TEXEL_SCALE, z / TEXEL_SCALE]
}

/**
 * The vertex range a slice of the index buffer touches.
 *
 * `SurfaceGroup` records where a surface's *indices* start, not where its
 * vertices do; Babylon's `SubMesh` wants both. Scanning the slice is exact and
 * costs one pass at load, where guessing "all of them" would defeat the vertex
 * range hint the submesh exists to give.
 */
function vertexRange(indices: Uint32Array, start: number, count: number): [number, number] {
  let low = Number.POSITIVE_INFINITY
  let high = -1
  for (let i = start; i < start + count; i += 1) {
    const index = indices[i] ?? 0
    if (index < low) low = index
    if (index > high) high = index
  }
  if (high < 0) return [0, 0]
  return [low, high - low + 1]
}

/**
 * Build the arena.
 *
 * Allocates freely: this runs once, at load, behind the loading screen — not in
 * a frame.
 */
export function buildMapMesh(
  scene: Scene,
  map: MapSource,
  geometry: MapGeometry,
  /** The shared surface texture, or `null` where there is no canvas to draw one. */
  grid: BaseTexture | null,
): MapMesh {
  const vertexCount = geometry.positions.length / 3
  const positions = new Float32Array(geometry.positions.length)
  const normals = new Float32Array(geometry.normals.length)
  const uvs = new Float32Array(vertexCount * 2)

  for (let v = 0; v < vertexCount; v += 1) {
    const qx = geometry.positions[v * 3] ?? 0
    const qy = geometry.positions[v * 3 + 1] ?? 0
    const qz = geometry.positions[v * 3 + 2] ?? 0
    const nx = geometry.normals[v * 3] ?? 0
    const ny = geometry.normals[v * 3 + 1] ?? 0
    const nz = geometry.normals[v * 3 + 2] ?? 0

    // The texture is projected in the Quake frame, where the map's integers
    // are, so the grid lines up with the geometry that was authored.
    const [u, w] = faceUv([qx, qy, qz], [nx, ny, nz])
    uvs[v * 2] = u
    uvs[v * 2 + 1] = w

    const [ex, ey, ez] = quakeToEngine([qx, qy, qz])
    positions[v * 3] = ex
    positions[v * 3 + 1] = ey
    positions[v * 3 + 2] = ez

    const [enx, eny, enz] = quakeToEngine([nx, ny, nz])
    normals[v * 3] = enx
    normals[v * 3 + 1] = eny
    normals[v * 3 + 2] = enz
  }

  const mesh = new Mesh('arena', scene)
  const data = new VertexData()
  data.positions = positions
  data.normals = normals
  data.uvs = uvs
  data.indices = geometry.indices
  data.applyToMesh(mesh, false)

  // The winding, declared.
  //
  // `mapGeometry` emits triangles counter-clockwise seen from *outside* the
  // solid, and `QUAKE_TO_ENGINE` has determinant +1, so they still are after the
  // frame change. Babylon does not assume that: a `Mesh` built by hand defaults
  // to `ClockWiseSideOrientation`, which in a right-handed scene reverses the
  // cull face — and the symptom is not an obviously broken picture. It is a
  // *plausible* one: from inside a sealed room you go on seeing a room, because
  // the near face of every wall is culled and the far face of the same wall is
  // drawn 64 units behind it, unlit, from the wrong side. The reference
  // screenshot is what caught this; the line below is what fixes it.
  mesh.sideOrientation = Material.CounterClockWiseSideOrientation

  // The arena never moves, so its world matrix and bounding info are computed
  // once instead of every frame.
  mesh.freezeWorldMatrix()
  mesh.isPickable = false
  mesh.alwaysSelectAsActiveMesh = true

  const multi = new MultiMaterial('arena', scene)
  const surfaces: string[] = []

  // Replacing the auto-generated submesh rather than adding to it: Babylon
  // creates one covering the whole buffer the moment indices are set.
  mesh.subMeshes = []
  for (const group of geometry.groups) {
    const surface = map.surfaces.find((candidate) => candidate.name === group.surface)
    if (surface === undefined) continue
    const materialIndex = multi.subMaterials.length
    multi.subMaterials.push(createSurfaceMaterial(scene, surface, grid))
    surfaces.push(surface.name)
    const [vertexStart, vertexTotal] = vertexRange(
      geometry.indices,
      group.indexStart,
      group.indexCount,
    )
    new SubMesh(
      materialIndex,
      vertexStart,
      vertexTotal,
      group.indexStart,
      group.indexCount,
      mesh,
      mesh,
      true,
    )
  }
  mesh.material = multi

  return {
    freeze() {
      // Babylon re-checks every material for "is this still ready to draw"
      // once per submesh per frame. None of these ever changes after load, so
      // that is a fixed cost paid for a question with a fixed answer. Anything
      // that later mutates a surface material has to `unfreeze()` first — which
      // is why this is a method rather than something `buildMapMesh` does on
      // its way out, and why the renderer only calls it once the scene is ready
      // (freezing a material that has not compiled yet freezes it broken).
      for (const material of multi.subMaterials) material?.freeze()
      multi.freeze()
    },

    mesh,
    vertices: vertexCount,
    triangles: geometry.indices.length / 3,
    surfaces,
    dispose() {
      // Not the grid: it is the renderer's, and shared.
      multi.dispose(true, true)
      mesh.dispose()
    },
  }
}
