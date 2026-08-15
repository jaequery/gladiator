/**
 * The second UV set, and the bug it exists to prevent.
 *
 * A lightmap is baked into its own UV layout: the first UV set tiles a material
 * across a surface, the second one gives every triangle in the level a unique,
 * non-overlapping patch of one atlas. They are different unwraps of the same
 * mesh and they are not interchangeable, so *which* set a lightmap samples
 * through is the whole question.
 *
 * Get it wrong and the lightmap samples through the tiling UVs. What you see is
 * not a warning — it is a level lit from an atlas cell that belongs to another
 * wall, or, where the tiling UVs run outside `[0,1]` and the atlas has a black
 * gutter, a level that is simply **black**. It looks like a broken bake, so
 * that is where the day goes.
 *
 * ## The convention, verified against this engine
 *
 * Three links in a chain, each checked in `lightmap.test.ts` against the real
 * Babylon in `package.json` rather than against documentation:
 *
 *   1. **Blender** writes the mesh's UV maps in the order they appear in the
 *      object's UV Maps list. The second one becomes `TEXCOORD_1`. Rename them
 *      as you like — glTF carries the *order*, never the name.
 *   2. **The glTF loader** maps `TEXCOORD_1` to `VertexBuffer.UV2Kind`, whose
 *      value is the string `"uv2"`. `TEXCOORD_0` becomes `"uv"`.
 *   3. **The material** samples `lightmapTexture` through the set named by
 *      `coordinatesIndex`, where `1` means `uv2`. Its default is `0`, which is
 *      the wrong one, which is why {@link applyLightmap} exists and why nothing
 *      should assign `lightmapTexture` without it.
 *
 * ## What this deliberately does not do
 *
 * It does not read the lightmap out of the glTF. glTF 2.0 has no lightmap slot
 * — `occlusionTexture` is ambient occlusion, a different quantity — so the bake
 * ships as its own `.ktx2` and is attached here, by name. That is a choice with
 * a payoff: the lightmap is a property of the *level*, and a prop used in two
 * arenas gets the right one in each without being exported twice.
 */

import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture'
import type { Material } from '@babylonjs/core/Materials/material'

/**
 * Which UV set a lightmap samples through.
 *
 * `1`, meaning the second — the value `coordinatesIndex` takes. The name of the
 * matching vertex buffer is {@link LIGHTMAP_VERTEX_KIND}, and the two have to
 * agree; the test asserts they do rather than leaving it to a reader.
 */
export const LIGHTMAP_UV_SET = 1

/** The vertex data a lightmapped mesh must carry: Babylon calls it `"uv2"`. */
export const LIGHTMAP_VERTEX_KIND = VertexBuffer.UV2Kind

/** A material that can carry a lightmap. `Material` itself cannot. */
type LightmappableMaterial = Material & {
  lightmapTexture: BaseTexture | null
  useLightmapAsShadowmap: boolean
}

function isLightmappable(material: Material): material is LightmappableMaterial {
  return 'lightmapTexture' in material && 'useLightmapAsShadowmap' in material
}

/**
 * Attach a baked lightmap to a mesh.
 *
 * Refuses a mesh with no second UV set, loudly, because the alternative is the
 * failure this whole file is about: a lightmap sampled through the tiling UVs
 * draws *something*, and something is much harder to notice than nothing.
 *
 * `useLightmapAsShadowmap` is on: the bake carries the direct light as well as
 * the bounce, so it multiplies the material rather than adding to it. Off, the
 * lit surfaces would be lit twice and the level would wash out.
 */
export function applyLightmap(mesh: AbstractMesh, lightmap: BaseTexture): void {
  if (!mesh.isVerticesDataPresent(LIGHTMAP_VERTEX_KIND)) {
    throw new Error(
      `gladiator: ${mesh.name} has no ${LIGHTMAP_VERTEX_KIND} and cannot carry a lightmap. Export it with a second UV map — glTF's TEXCOORD_1 — from the second slot of Blender's UV Maps list. See packages/client/src/render/lightmap.ts.`,
    )
  }

  const material = mesh.material
  if (material === null || !isLightmappable(material)) {
    throw new Error(`gladiator: ${mesh.name} has no material that can carry a lightmap.`)
  }

  lightmap.coordinatesIndex = LIGHTMAP_UV_SET
  material.lightmapTexture = lightmap
  material.useLightmapAsShadowmap = true
}
