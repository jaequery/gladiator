/**
 * What each texture class actually produces.
 *
 * The assertions that matter are not "the options object has these keys" — they
 * are what comes out of the encoder, read back out of the KTX2 container. A
 * normal map tagged sRGB and an albedo tagged linear both encode fine and both
 * light the level wrong, and the only place that is visible before a screenshot
 * is the data-format descriptor.
 */

import { describe, expect, it } from 'vitest'
import { PNG } from 'pngjs'
import { read } from 'ktx-parse'

import { TEXTURE_CLASSES } from './registry.ts'
import { decodePng, encodeOptionsFor, encodeTexture, rejectImage } from './texture.ts'

/** KHR_DF colour models, from the Khronos data-format specification. */
const COLOR_MODEL_ETC1S = 163
const COLOR_MODEL_UASTC = 166

/** KHR_DF transfer functions. */
const TRANSFER_LINEAR = 1
const TRANSFER_SRGB = 2

/** KTX2 supercompression schemes. */
const SUPERCOMPRESSION_BASISLZ = 1
const SUPERCOMPRESSION_ZSTD = 2

function png(size: number, height = size): Uint8Array {
  const image = new PNG({ width: size, height })
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      image.data[i] = (x * 7) & 255
      image.data[i + 1] = (y * 5) & 255
      image.data[i + 2] = ((x ^ y) * 3) & 255
      image.data[i + 3] = 255
    }
  }
  return new Uint8Array(PNG.sync.write(image))
}

describe('what each class means', () => {
  it('gives UASTC to the two that cannot survive a codebook', () => {
    // A normal map's channels are a direction, not a colour: ETC1S quantises
    // chroma hard, and quantised chroma on a normal map is lighting that swims.
    expect(encodeOptionsFor('albedo').isUASTC).toBe(true)
    expect(encodeOptionsFor('normal').isUASTC).toBe(true)
    expect(encodeOptionsFor('srgb').isUASTC).toBe(false)
    expect(encodeOptionsFor('linear').isUASTC).toBe(false)
  })

  it('never separates the perceptual flag from the transfer function', () => {
    // Encoding perceptually and tagging linear means the texture is brightened
    // twice at sample time, and it looks like a lighting bug rather than a
    // texture one. They move together or not at all.
    for (const textureClass of TEXTURE_CLASSES) {
      const options = encodeOptionsFor(textureClass)
      expect(options.isPerceptual).toBe(options.isSetKTX2SRGBTransferFunc)
    }
  })

  it('treats a normal map as neither colour nor sRGB', () => {
    const options = encodeOptionsFor('normal')
    expect(options.isNormalMap).toBe(true)
    expect(options.isPerceptual).toBe(false)
  })

  it('never flips the image', () => {
    // glTF's texture origin is the top-left texel, which is the order a PNG is
    // already in. Flipping here and again at load is upside down on one path.
    for (const textureClass of TEXTURE_CLASSES) {
      expect(encodeOptionsFor(textureClass).isYFlip).toBe(false)
    }
  })
})

describe('what a source image has to be', () => {
  it('accepts a power-of-two image', () => {
    expect(rejectImage(decodePng(png(64)))).toBeNull()
  })

  it('rejects one that is not, and says the size', () => {
    expect(rejectImage(decodePng(png(48)))).toMatch(/48x48/)
    expect(rejectImage(decodePng(png(64, 48)))).toMatch(/power of two/)
  })

  it('rejects one too small for a block', () => {
    expect(rejectImage(decodePng(png(2)))).toMatch(/at least 4/)
  })
})

describe('what comes out', () => {
  it('encodes an albedo as UASTC, zstd-supercompressed, tagged sRGB', async () => {
    const container = read(await encodeTexture(png(64), 'albedo'))
    expect(container.dataFormatDescriptor[0]?.colorModel).toBe(COLOR_MODEL_UASTC)
    expect(container.dataFormatDescriptor[0]?.transferFunction).toBe(TRANSFER_SRGB)
    expect(container.supercompressionScheme).toBe(SUPERCOMPRESSION_ZSTD)
    // A full mip chain: 64 -> 1 is seven levels, and the distant floor needs
    // every one of them not to shimmer.
    expect(container.levels.length).toBe(7)
  })

  it('encodes a normal map as UASTC, tagged linear', async () => {
    const container = read(await encodeTexture(png(64), 'normal'))
    expect(container.dataFormatDescriptor[0]?.colorModel).toBe(COLOR_MODEL_UASTC)
    expect(container.dataFormatDescriptor[0]?.transferFunction).toBe(TRANSFER_LINEAR)
  })

  it('encodes a mask as ETC1S, tagged linear', async () => {
    const container = read(await encodeTexture(png(64), 'linear'))
    expect(container.dataFormatDescriptor[0]?.colorModel).toBe(COLOR_MODEL_ETC1S)
    expect(container.dataFormatDescriptor[0]?.transferFunction).toBe(TRANSFER_LINEAR)
    expect(container.supercompressionScheme).toBe(SUPERCOMPRESSION_BASISLZ)
  })

  it('is reproducible, which is what lets --check compare bytes', async () => {
    const [a, b] = await Promise.all([encodeTexture(png(64), 'srgb'), encodeTexture(png(64), 'srgb')])
    expect(Array.from(a)).toEqual(Array.from(b))
  })

  it('refuses a source the pipeline cannot compress well', async () => {
    await expect(encodeTexture(png(48), 'albedo')).rejects.toThrow(/power of two/)
  })
})
