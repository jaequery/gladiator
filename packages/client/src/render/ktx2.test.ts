/**
 * The question this file answers: on a machine that can hold a compressed
 * texture in video memory, does ours stay compressed?
 *
 * It is not answered by reading the two booleans `configureKtx2` sets. It is
 * answered by driving **Babylon's own decision tree** — the same class the KTX2
 * decoder instantiates per texture — over every combination of capabilities a
 * browser can report, and looking at what comes out.
 *
 * The last test is the one that makes the others mean something: with Babylon's
 * defaults, a UASTC texture on an S3TC-only GPU is decoded to uncompressed
 * RGBA32. That is a real machine — any pre-Skylake Intel part — and 4x the
 * texture memory on exactly the hardware with the least of it.
 */

import { describe, expect, it } from 'vitest'
import { TranscodeDecisionTree } from '@babylonjs/ktx2decoder/transcodeDecisionTree.js'
import {
  DefaultKTX2DecoderOptions,
  KhronosTextureContainer2,
} from '@babylonjs/core/Misc/khronosTextureContainer2.js'
import {
  EngineFormat,
  SourceTextureFormat,
} from '@babylonjs/core/Materials/Textures/ktx2decoderTypes.js'
import type {
  ICompressedFormatCapabilities,
  IKTX2DecoderOptions,
} from '@babylonjs/core/Materials/Textures/ktx2decoderTypes.js'

import { KTX2_URLS, configureKtx2, isCompressedEngineFormat } from './ktx2.ts'

/** Every compressed-format capability a WebGL or WebGPU context can expose. */
const CAPS = ['astc', 'bptc', 's3tc', 'pvrtc', 'etc2', 'etc1'] as const

/** All 64 subsets, so no branch of the tree goes unvisited. */
function everyCapability(): ICompressedFormatCapabilities[] {
  const all: ICompressedFormatCapabilities[] = []
  for (let mask = 0; mask < 1 << CAPS.length; mask++) {
    const caps: Record<string, boolean> = {}
    CAPS.forEach((cap, bit) => {
      caps[cap] = (mask & (1 << bit)) !== 0
    })
    all.push(caps as ICompressedFormatCapabilities)
  }
  return all
}

function describeCaps(caps: ICompressedFormatCapabilities): string {
  const on = CAPS.filter((cap) => caps[cap])
  return on.length === 0 ? 'no compressed formats' : on.join('+')
}

/**
 * Whether a capability set describes a machine this game can run on.
 *
 * The renderer is WebGPU first and WebGL2 everywhere else (`docs/renderer.md`
 * §3), and both of those mean GLES 3.0-class hardware or better. ETC2 is
 * *mandatory* in GLES 3.0, so a context that exposes ASTC or ETC1 exposes ETC2
 * as well — the reverse does not hold, and a desktop GPU exposing S3TC and BPTC
 * and neither of the ETCs is the common case.
 *
 * The sets this rejects are not conservatism. They are the two the engine's
 * ETC1S tree cannot serve, and the test below pins that so the exclusion cannot
 * outlive the reason for it.
 */
function isReachableGpu(caps: ICompressedFormatCapabilities): boolean {
  if ((caps.astc === true || caps.etc1 === true) && caps.etc2 !== true) return false
  return CAPS.some((cap) => caps[cap] === true)
}

/**
 * What Babylon would choose, exactly as `KTX2Decoder._decodeDataAsync` chooses
 * it: build the tree from the built-in decision tree, then re-run it through
 * the caller's override if there is one. Those two lines are the whole of the
 * engine's selection logic, and they are reproduced rather than reimplemented.
 */
function chooseEngineFormat(
  source: SourceTextureFormat,
  hasAlpha: boolean,
  isPowerOfTwo: boolean,
  caps: ICompressedFormatCapabilities,
  options: IKTX2DecoderOptions,
): number {
  const tree = new TranscodeDecisionTree(source, hasAlpha, isPowerOfTwo, caps, options)
  if (options.transcodeFormatDecisionTree) tree.parseTree(options.transcodeFormatDecisionTree)
  return tree.engineFormat
}

/** The options the client actually runs with, read back off Babylon's statics. */
function configuredOptions(): IKTX2DecoderOptions {
  configureKtx2()
  return KhronosTextureContainer2.DefaultDecoderOptions._getKTX2DecoderOptions()
}

describe('the transcoders are served from our own origin', () => {
  it('never points at a CDN', () => {
    configureKtx2()
    for (const url of Object.values(KhronosTextureContainer2.URLConfig)) {
      expect(url).not.toBeNull()
      expect(url).toMatch(/^\/(ktx2|meshopt)\//)
    }
  })

  it('asks for exactly the files the vendoring script writes', () => {
    configureKtx2()
    expect(KhronosTextureContainer2.URLConfig).toMatchObject(KTX2_URLS)
  })
})

describe('a compressed source stays compressed in GPU memory', () => {
  it.each([
    ['UASTC', SourceTextureFormat.UASTC4x4],
    ['ETC1S', SourceTextureFormat.ETC1S],
  ])('%s, on every GPU that can hold a compressed texture', (_name, source) => {
    const options = configuredOptions()
    const uncompressed: string[] = []

    for (const caps of everyCapability()) {
      if (!isReachableGpu(caps)) continue
      for (const hasAlpha of [false, true]) {
        // Power-of-two only: the pipeline rejects anything else at encode time
        // (`rejectImage`), and PVRTC is specified to require it.
        const engineFormat = chooseEngineFormat(source, hasAlpha, true, caps, options)
        if (!isCompressedEngineFormat(engineFormat)) {
          uncompressed.push(`${describeCaps(caps)}${hasAlpha ? ' +alpha' : ''}`)
        }
      }
    }

    expect(uncompressed).toEqual([])
  })

  it('picks the format the GPU is best at', () => {
    const options = configuredOptions()
    const uastc = (caps: ICompressedFormatCapabilities) =>
      chooseEngineFormat(SourceTextureFormat.UASTC4x4, true, true, caps, options)

    expect(uastc({ astc: true })).toBe(EngineFormat.COMPRESSED_RGBA_ASTC_4X4_KHR)
    expect(uastc({ bptc: true })).toBe(EngineFormat.COMPRESSED_RGBA_BPTC_UNORM_EXT)
    expect(uastc({ etc2: true })).toBe(EngineFormat.COMPRESSED_RGBA8_ETC2_EAC)
    expect(uastc({ s3tc: true })).toBe(EngineFormat.COMPRESSED_RGBA_S3TC_DXT5_EXT)
  })

  it('has nothing left to compress to when the GPU supports no block format', () => {
    // Not a failure — a fact. There is no compressed format to land in, so RGBA
    // is the only answer, and the test says so rather than leaving the gap.
    const options = configuredOptions()
    const engineFormat = chooseEngineFormat(SourceTextureFormat.UASTC4x4, true, true, {}, options)
    expect(engineFormat).toBe(EngineFormat.RGBA8Format)
  })

  it('names the two GPUs the engine cannot serve an ETC1S texture to', () => {
    // Babylon's ETC1S decision tree has no ASTC branch, and its ETC1 branch is
    // gated on the texture having no alpha — ETC1 cannot carry one. So two
    // capability sets fall through to RGBA32, and `isReachableGpu` excludes
    // them because neither describes a WebGL2-or-better context.
    //
    // This test is here so the exclusion cannot outlive its reason: the day
    // Babylon adds an ASTC branch, it fails, and the exclusion gets deleted.
    const options = configuredOptions()
    const gaps: string[] = []

    for (const caps of everyCapability()) {
      if (!CAPS.some((cap) => caps[cap] === true)) continue
      for (const hasAlpha of [false, true]) {
        const format = chooseEngineFormat(SourceTextureFormat.ETC1S, hasAlpha, true, caps, options)
        if (!isCompressedEngineFormat(format)) {
          gaps.push(`${describeCaps(caps)}${hasAlpha ? ' +alpha' : ''}`)
        }
      }
    }

    expect(gaps).toEqual(['astc', 'astc +alpha', 'etc1 +alpha', 'astc+etc1 +alpha'])
    expect(gaps.every((gap) => !isReachableGpu(capsFrom(gap)))).toBe(true)
  })
})

/** The inverse of {@link describeCaps}, so the gap list can be re-checked. */
function capsFrom(description: string): ICompressedFormatCapabilities {
  const names = new Set((description.split(' ')[0] ?? '').split('+'))
  const caps: Record<string, boolean> = {}
  for (const cap of CAPS) caps[cap] = names.has(cap)
  return caps as ICompressedFormatCapabilities
}

describe('the settings that make that true', () => {
  it('would have landed uncompressed with Babylon defaults', () => {
    // The counterfactual, and the reason this file exists. `s3tc` alone is a
    // real configuration — every pre-Skylake Intel GPU reports it and neither
    // BPTC nor ASTC — and Babylon's default trades 4x the memory for a faster
    // transcode there.
    const defaults = new DefaultKTX2DecoderOptions()
    expect(defaults.useRGBAIfOnlyBC1BC3AvailableWhenUASTC).toBe(true)

    const withDefaults = chooseEngineFormat(
      SourceTextureFormat.UASTC4x4,
      true,
      true,
      { s3tc: true },
      defaults._getKTX2DecoderOptions(),
    )
    expect(withDefaults).toBe(EngineFormat.RGBA8Format)

    const withOurs = chooseEngineFormat(
      SourceTextureFormat.UASTC4x4,
      true,
      true,
      { s3tc: true },
      configuredOptions(),
    )
    expect(withOurs).toBe(EngineFormat.COMPRESSED_RGBA_S3TC_DXT5_EXT)
  })

  it('injects no decision-tree override once configured', () => {
    // Babylon implements `useRGBAIfOnlyBC1BC3AvailableWhenUASTC` by injecting an
    // override tree. Its absence is the switch being off, at the layer that
    // actually decides.
    expect(configuredOptions().transcodeFormatDecisionTree).toBeUndefined()
  })
})
