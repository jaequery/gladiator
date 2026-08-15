/**
 * Loading what `pnpm assets:build` produces.
 *
 * The pipeline writes `.gltf` + `.bin` with `EXT_meshopt_compression` on the
 * vertex data and `KHR_texture_basisu` pointing at `.ktx2` files beside it. All
 * three of those need something registered or configured before a load, and the
 * failure mode of forgetting one is a model that loads *partly*: geometry with
 * no textures, or an empty scene and a warning in a console nobody has open.
 *
 * The loader is behind an `await import()` for the same reason the WebGPU
 * engine is (`docs/renderer.md` §3): the arena's own surfaces are cut from the
 * collision brushes by `map/geometry.ts` and involve no glTF at all, so a page
 * that never draws a prop should never download a glTF parser.
 *
 * Textures are attached by the pipeline's rules and never by guesswork: the
 * base colour and the normal map come through the glTF, and the lightmap does
 * not — glTF 2.0 has no slot for one. `lightmap.ts` says why, and is the only
 * thing that should ever assign `lightmapTexture`.
 */

import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import type { AssetContainer } from '@babylonjs/core/assetContainer'
import type { Scene } from '@babylonjs/core/scene'

import { configureKtx2 } from './ktx2.ts'

let registered: Promise<void> | undefined

/**
 * Register the glTF loader, once.
 *
 * Importing the module is what registers it — the side effect is the point, and
 * the promise is cached so a second model does not pay for a second import.
 */
export async function ensureGltfLoader(): Promise<void> {
  configureKtx2()
  registered ??= import('@babylonjs/loaders/glTF/2.0/index.js').then(() => undefined)
  await registered
}

/**
 * Load one of the pipeline's models into a scene, without adding it.
 *
 * An `AssetContainer` rather than a scene append: a prop is placed by whoever
 * asked for it, and instanced when it appears twice, and neither of those is a
 * decision the loader should be making.
 */
export async function loadModel(scene: Scene, url: string): Promise<AssetContainer> {
  await ensureGltfLoader()
  return await LoadAssetContainerAsync(url, scene)
}
