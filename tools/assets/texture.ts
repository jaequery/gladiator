/**
 * PNG in, KTX2 out.
 *
 * The interesting part is not the encoding, it is the *class*: what a texture
 * is for decides which of the two Basis formats it gets, and getting that
 * backwards is either a visibly mushy normal map or four times the file size
 * for a surface nobody looks at closely.
 *
 * ### UASTC, for normal maps and hero albedo
 *
 * UASTC is a fixed 8 bits per texel with a real rate-distortion story: it
 * transcodes to ASTC and BC7 without re-encoding, so on the GPUs that matter it
 * arrives as the format it was designed against. It is four times the bytes of
 * ETC1S on disk, which Zstandard supercompression takes most of the way back —
 * and unlike ETC1S it survives the two things that show every artefact: a
 * tangent-space normal map, where a wrong texel is a wrong *direction* and the
 * lighting swims; and a surface the player's face is two metres from.
 *
 * ### ETC1S, everywhere the artefacts will not show
 *
 * ETC1S is a codebook format — endpoints and selectors, shared across the whole
 * image, compressed again with its own LZ. It is roughly a quarter of UASTC's
 * size and it *looks* like a quarter of UASTC's size on anything with fine
 * chroma detail. On a roughness mask, an ambient-occlusion bake or a lightmap
 * that is already low-frequency by construction, the difference is not visible
 * and the bytes are real.
 *
 * ### The two flags that are not about size
 *
 * `isPerceptual` tells the encoder its input is sRGB, so error is weighted the
 * way an eye weights it. `isSetKTX2SRGBTransferFunc` writes that into the
 * container's data-format descriptor, which is what makes the GPU sample it
 * back through the right curve. They are set together, always, because a
 * texture encoded perceptually and tagged linear is one that gets brightened
 * twice — and the failure looks like a lighting bug, not a texture bug.
 *
 * A normal map is neither: its channels are a vector, not a colour, and running
 * either flag over it is the classic way to get lighting that is subtly,
 * unfixably wrong.
 */

import { PNG } from 'pngjs'
import { encodeToKTX2 } from 'ktx2-encoder'

import type { TextureClass } from './registry.ts'

export type DecodedImage = {
  readonly width: number
  readonly height: number
  /** RGBA, 8 bits per channel, top-left texel first. */
  readonly data: Uint8Array
}

/**
 * Decode a PNG to RGBA.
 *
 * `pngjs` handles every colour type and bit depth the export paths produce and
 * pulls in nothing native, which matters more here than speed: a build tool
 * that needs a compiler to install is a build tool half the contributors
 * cannot run.
 */
export function decodePng(bytes: Uint8Array): DecodedImage {
  const png = PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))
  return { width: png.width, height: png.height, data: new Uint8Array(png.data) }
}

function isPowerOfTwo(value: number): boolean {
  return value >= 4 && (value & (value - 1)) === 0
}

/**
 * Why a source image is unacceptable, or `null`.
 *
 * Power-of-two is not superstition here. Every block format compresses 4x4
 * texels at a time, so a non-multiple-of-four edge is padded and the padding is
 * sampled; mip chains that halve cleanly are the reason a distant floor does
 * not shimmer; and PVRTC — the only compressed format some iOS GPUs expose
 * through WebGL — is *specified* to need it, so a non-power-of-two texture is
 * the one that quietly lands uncompressed on the device with the least memory
 * to spare.
 */
export function rejectImage(image: DecodedImage): string | null {
  if (!isPowerOfTwo(image.width) || !isPowerOfTwo(image.height)) {
    return `is ${image.width}x${image.height}; every dimension must be a power of two and at least 4`
  }
  return null
}

/** The Basis encoder options a class implies. Data, so a test can read them. */
export type TextureEncodeOptions = {
  readonly isUASTC: boolean
  readonly isKTX2File: true
  readonly generateMipmap: true
  readonly isYFlip: false
  readonly isPerceptual: boolean
  readonly isSetKTX2SRGBTransferFunc: boolean
  readonly isNormalMap?: boolean
  readonly needSupercompression?: boolean
  readonly uastcLDRQualityLevel?: number
  readonly qualityLevel?: number
  readonly compressionLevel?: number
}

/**
 * Shared by every class.
 *
 * `isYFlip: false` is load-bearing and easy to get wrong twice. glTF's texture
 * origin is the top-left texel, which is the order a PNG is already in and the
 * order this encoder writes. Flipping here and flipping again at load — Babylon
 * does the second one — puts the texture back the right way up on one code path
 * and upside down on the other, and the one that breaks is whichever nobody
 * screenshotted.
 */
const SHARED = {
  isKTX2File: true,
  generateMipmap: true,
  isYFlip: false,
} as const

/**
 * The UASTC effort level, 0–4. Two is the knee: the quality above it is not
 * visible at arena distance and the encode time is several times over.
 */
const UASTC_EFFORT = 2

/**
 * ETC1S quality, 1–255, and its effort level, 0–6.
 *
 * 192 is high on the codebook-size dial, because the assets that get ETC1S are
 * the ones where its artefacts are already invisible — spending the bytes there
 * costs little and removes the argument.
 */
const ETC1S_QUALITY = 192
const ETC1S_EFFORT = 2

export function encodeOptionsFor(textureClass: TextureClass): TextureEncodeOptions {
  switch (textureClass) {
    case 'albedo':
      return {
        ...SHARED,
        isUASTC: true,
        uastcLDRQualityLevel: UASTC_EFFORT,
        needSupercompression: true,
        isPerceptual: true,
        isSetKTX2SRGBTransferFunc: true,
      }
    case 'normal':
      return {
        ...SHARED,
        isUASTC: true,
        uastcLDRQualityLevel: UASTC_EFFORT,
        needSupercompression: true,
        isNormalMap: true,
        isPerceptual: false,
        isSetKTX2SRGBTransferFunc: false,
      }
    case 'srgb':
      return {
        ...SHARED,
        isUASTC: false,
        qualityLevel: ETC1S_QUALITY,
        compressionLevel: ETC1S_EFFORT,
        isPerceptual: true,
        isSetKTX2SRGBTransferFunc: true,
      }
    case 'linear':
      return {
        ...SHARED,
        isUASTC: false,
        qualityLevel: ETC1S_QUALITY,
        compressionLevel: ETC1S_EFFORT,
        isPerceptual: false,
        isSetKTX2SRGBTransferFunc: false,
      }
  }
}

/**
 * Encode one texture.
 *
 * Byte-for-byte reproducible: the same PNG and the same class produce the same
 * `.ktx2`, which is what lets `pnpm assets:build --check` compare the committed
 * artifact against a fresh encode instead of trusting a timestamp.
 */
export async function encodeTexture(
  png: Uint8Array,
  textureClass: TextureClass,
): Promise<Uint8Array> {
  const image = decodePng(png)
  const rejection = rejectImage(image)
  if (rejection !== null) throw new Error(`gladiator: source texture ${rejection}`)

  return await encodeToKTX2(png, {
    ...encodeOptionsFor(textureClass),
    imageDecoder: () => Promise.resolve(image),
  })
}
