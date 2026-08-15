/**
 * Three things have to be true before a model from `pnpm assets:build` loads,
 * and forgetting any one of them produces a *partial* failure — geometry with
 * no textures, or an empty scene and a warning in a console nobody has open.
 *
 * That the glTF loader is actually registered by `ensureGltfLoader` is proved
 * in `lightmap.test.ts`, which loads a real `.glb` through it. What is left,
 * and what is here, is that it also does the two configuration jobs.
 */

import { KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js'
import { MeshoptCompression } from '@babylonjs/core/Meshes/Compression/meshoptCompression.js'
import { describe, expect, it } from 'vitest'

import { ensureGltfLoader } from './gltf.ts'
import { KTX2_URLS } from './ktx2.ts'

describe('ensureGltfLoader', () => {
  it('configures the KTX2 and meshopt decoders on the way in', async () => {
    // A model whose textures are `KHR_texture_basisu` and whose vertex data is
    // `EXT_meshopt_compression` needs both, and Babylon's defaults for both
    // point at cdn.babylonjs.com.
    await ensureGltfLoader()

    expect(KhronosTextureContainer2.URLConfig).toMatchObject(KTX2_URLS)
    expect(MeshoptCompression.Configuration.decoder.url).toBe('/meshopt/meshopt_decoder.js')
  })

  it('is safe to call for every model', async () => {
    // The import is cached: a second prop must not pay for a second parse of
    // the loader, and must not reset the configuration underneath the first.
    await Promise.all([ensureGltfLoader(), ensureGltfLoader(), ensureGltfLoader()])
    expect(MeshoptCompression.Configuration.decoder.url).toBe('/meshopt/meshopt_decoder.js')
  })
})
