/**
 * KTX2: where the transcoders come from, and what they are allowed to transcode
 * to.
 *
 * The second half is the one that matters, and it is not obvious. A `.ktx2` is
 * not a GPU format — it is a *universal* format that gets transcoded, in the
 * browser, into whichever compressed format the GPU in front of it actually
 * supports. Babylon picks that format from a decision tree over the engine's
 * capabilities, and two of its defaults will hand you uncompressed RGBA
 * instead:
 *
 *   - `useRGBAIfOnlyBC1BC3AvailableWhenUASTC`, **which defaults to `true`**.
 *     On a GPU that exposes S3TC but neither BC7 nor ASTC — every pre-Skylake
 *     Intel part, and a lot of what is still in laptops — a UASTC texture is
 *     decoded to RGBA32 rather than recompressed to BC3, because transcoding
 *     UASTC to BC1/BC3 goes via uncompressed and Babylon would rather spend the
 *     memory than the milliseconds.
 *   - `useRGBAIfASTCBC7NotAvailableWhenUASTC`, the same trade one branch
 *     earlier.
 *
 * On the machines this game exists to run well on, that default is exactly
 * backwards. A 1024x1024 albedo is 1 MB as BC3 and 4 MB as RGBA32; an integrated
 * GPU shares its memory with the operating system, and the moment the working
 * set stops fitting, the cost is not a slower frame, it is a *stutter* — the
 * driver evicting and re-uploading a texture in the middle of a duel. Paying a
 * few milliseconds once, at load, behind the loading screen, to avoid that is
 * not a close call.
 *
 * So both are turned off, and `ktx2.test.ts` drives Babylon's own decision tree
 * over every combination of capabilities a browser can report and asserts that
 * a compressed source never lands uncompressed — and that with the defaults it
 * would have.
 */

import { KhronosTextureContainer2 } from '@babylonjs/core/Misc/khronosTextureContainer2.js'
import { MeshoptCompression } from '@babylonjs/core/Meshes/Compression/meshoptCompression.js'
import type { IKTX2DecoderOptions } from '@babylonjs/core/Materials/Textures/ktx2decoderTypes.js'

/**
 * Where the transcoders are served from.
 *
 * Same origin, always. Babylon's defaults point at `cdn.babylonjs.com`, which
 * is a third party this project does not run, on an unversioned path that means
 * "latest". `pnpm assets:vendor` puts the pinned files here; the paths are
 * relative to the site root, which is `packages/client/public/`.
 */
export const KTX2_BASE = '/ktx2'
export const MESHOPT_BASE = '/meshopt'

/** Exactly the URLs Babylon asks for, so a missing one is a 404 and not a CDN hit. */
export const KTX2_URLS = {
  jsDecoderModule: `${KTX2_BASE}/babylon.ktx2Decoder.js`,
  wasmUASTCToASTC: `${KTX2_BASE}/uastc_astc.wasm`,
  wasmUASTCToBC7: `${KTX2_BASE}/uastc_bc7.wasm`,
  wasmUASTCToRGBA_UNORM: `${KTX2_BASE}/uastc_rgba8_unorm_v2.wasm`,
  wasmUASTCToRGBA_SRGB: `${KTX2_BASE}/uastc_rgba8_srgb_v2.wasm`,
  wasmUASTCToR8_UNORM: `${KTX2_BASE}/uastc_r8_unorm.wasm`,
  wasmUASTCToRG8_UNORM: `${KTX2_BASE}/uastc_rg8_unorm.wasm`,
  jsMSCTranscoder: `${KTX2_BASE}/msc_basis_transcoder.js`,
  wasmMSCTranscoder: `${KTX2_BASE}/msc_basis_transcoder.wasm`,
  wasmZSTDDecoder: `${KTX2_BASE}/zstddec.wasm`,
} as const

/**
 * The decoder options this game runs with.
 *
 * Exported as data so the test can put them through the real decision tree
 * rather than assert that two booleans have the values the source says they
 * have — which would test nothing.
 */
export const KTX2_DECODER_OPTIONS: IKTX2DecoderOptions = {
  useRGBAIfASTCBC7NotAvailableWhenUASTC: false,
}

/**
 * Whether a transcoded texture is still compressed once it is on the GPU.
 *
 * Babylon reports the choice as a GL enum. Everything below is a block format;
 * the three that are not are the uncompressed fallbacks, and seeing one of them
 * for a texture this pipeline produced means the pipeline stopped working.
 */
const UNCOMPRESSED_ENGINE_FORMATS: ReadonlySet<number> = new Set([
  32856, // RGBA8
  33321, // R8
  33323, // RG8
])

export function isCompressedEngineFormat(engineFormat: number): boolean {
  return !UNCOMPRESSED_ENGINE_FORMATS.has(engineFormat)
}

/**
 * Point Babylon at our copies and at our policy.
 *
 * Called once, before anything loads a texture. It touches only static
 * configuration — there is no engine to hand it, because the decision it
 * configures is made per texture, later, by the worker pool.
 */
export function configureKtx2(): void {
  Object.assign(KhronosTextureContainer2.URLConfig, KTX2_URLS)

  const options = KhronosTextureContainer2.DefaultDecoderOptions
  options.useRGBAIfASTCBC7NotAvailableWhenUASTC = false
  // The default is `true`. See the note at the top of this file: this is the
  // one that costs four times the texture memory on an integrated GPU.
  options.useRGBAIfOnlyBC1BC3AvailableWhenUASTC = false

  MeshoptCompression.Configuration = { decoder: { url: `${MESHOPT_BASE}/meshopt_decoder.js` } }
}
