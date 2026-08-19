import { describe, expect, it } from 'vitest'

import {
  MAX_PIXEL_RATIO,
  PIXEL_RATIO_LADDER,
  RECOVER_FRACTION,
  WEBGPU_TEXTURE_FEATURES,
  clampPixelRatio,
  createWebGPUOptions,
  hardwareScalingFor,
  ladderRung,
  loadWebGPU,
  nextPixelRatio,
  renderFrame,
} from './engine.ts'
import { FRAME_BUDGET_MS, summarise } from './frameStats.ts'

describe('clampPixelRatio', () => {
  it('caps what a very dense display asks for', () => {
    expect(clampPixelRatio(3)).toBe(MAX_PIXEL_RATIO)
    expect(clampPixelRatio(1.5)).toBe(1.5)
    expect(clampPixelRatio(1)).toBe(1)
  })

  it('falls back to 1 for a ratio a browser could not answer', () => {
    expect(clampPixelRatio(0)).toBe(1)
    expect(clampPixelRatio(-2)).toBe(1)
    expect(clampPixelRatio(Number.NaN)).toBe(1)
    // Not the cap: an infinite ratio is a broken answer, not a dense display,
    // and capping it would render four times the pixels on a guess.
    expect(clampPixelRatio(Number.POSITIVE_INFINITY)).toBe(1)
  })
})

describe('hardwareScalingFor', () => {
  it('inverts, because Babylon counts CSS pixels per device pixel', () => {
    expect(hardwareScalingFor(2)).toBe(0.5)
    expect(hardwareScalingFor(1)).toBe(1)
    expect(hardwareScalingFor(0.5)).toBe(2)
  })
})

describe('ladderRung', () => {
  it('starts on the highest rung the display can justify', () => {
    expect(ladderRung(2)).toBe(2)
    expect(ladderRung(1.75)).toBe(1.5)
    expect(ladderRung(1)).toBe(1)
  })

  it('never returns something off the bottom of the ladder', () => {
    expect(ladderRung(0.1)).toBe(PIXEL_RATIO_LADDER[PIXEL_RATIO_LADDER.length - 1])
  })
})

describe('nextPixelRatio', () => {
  const budget = FRAME_BUDGET_MS
  const over = budget * 2
  const comfortable = budget * RECOVER_FRACTION * 0.5

  it('steps down when the typical frame misses the budget', () => {
    expect(nextPixelRatio(2, over, budget, 2)).toBe(1.5)
    expect(nextPixelRatio(1, over, budget, 2)).toBe(0.85)
  })

  it('stops at the bottom rung rather than rendering nothing', () => {
    const floor = PIXEL_RATIO_LADDER[PIXEL_RATIO_LADDER.length - 1] ?? 0.5
    expect(nextPixelRatio(floor, over, budget, 2)).toBe(floor)
  })

  it('steps back up when there is room, and no further than the ceiling', () => {
    expect(nextPixelRatio(1, comfortable, budget, 2)).toBe(1.25)
    expect(nextPixelRatio(1, comfortable, budget, 1)).toBe(1)
  })

  it('holds still in the band between, so it does not hunt', () => {
    const inBand = budget * 0.9
    expect(nextPixelRatio(1, inBand, budget, 2)).toBe(1)
  })

  it('leaves a ratio that was set by hand alone', () => {
    expect(nextPixelRatio(1.13, over, budget, 2)).toBe(1.13)
  })

  it('does nothing before there is anything to judge', () => {
    expect(nextPixelRatio(1, 0, budget, 2)).toBe(1)
  })

  it('leaves a display that is keeping perfect time alone', () => {
    // The measured interval on a 60 Hz display is 16.7 or 16.8 ms and the
    // budget is 1000/60 = 16.667. Without a tolerance, every 60 Hz machine
    // reads as permanently over budget and walks its own image down to the
    // bottom rung while hitting every single frame.
    expect(nextPixelRatio(1, 16.7, budget, 2)).toBe(1)
    expect(nextPixelRatio(1, 16.8, budget, 2)).toBe(1)
  })

  it('is driven by the median, so a tail of stalls does not soften the image', () => {
    // The window this stands for: a loop keeping the 60 Hz cadence exactly,
    // with a handful of frames descheduled by the operating system. Its p99 is
    // 250 ms and its median is 16.7, and fewer pixels would not have helped
    // with either. A dial fed the percentile would walk the image down to the
    // bottom rung chasing a number it has no influence over.
    const window = [
      ...Array.from({ length: 588 }, () => 1000 / 60),
      ...Array.from({ length: 12 }, () => 250),
    ]
    const stalling = summarise(window)
    expect(stalling.p99Ms).toBeGreaterThan(budget)
    expect(nextPixelRatio(1, stalling.medianMs, budget, 2)).toBe(1)
    expect(nextPixelRatio(1, stalling.p99Ms, budget, 2)).toBe(0.85)
  })
})

describe('loadWebGPU', () => {
  /**
   * GLAD-ZCEQMN. This is the one part of the WebGPU path a machine with no GPU
   * can check, and it is the part that broke: whether the engine prototype came
   * up carrying the methods the renderer is about to call. Registering an
   * extension is a module side effect, so it is decided at import time and has
   * nothing to say to an adapter.
   *
   * It is worth the file it takes up because every other check runs on WebGL —
   * the reference screenshot and the e2e pin `forceWebGL`, and these tests run
   * on `NullEngine`, which is a `ThinEngine` and self-registers. That is a whole
   * backend whose startup nothing was asserting anything about.
   *
   * `createDynamicTexture` is the one the client needs today; `docs/renderer.md`
   * §3 has the rule for the next one, because the failure mode of getting this
   * wrong is a blank page rather than a missing texture.
   */
  it('brings the dynamic-texture extension up with the engine', async () => {
    const WebGPUEngine = await loadWebGPU()
    // Reached off the prototype rather than an instance on purpose: there is no
    // adapter here to make one with, and the defect was never in the instance.
    const proto = WebGPUEngine.prototype as unknown as Record<string, unknown>

    // `render/materials.ts` builds three detail textures before the first frame
    // — so an engine missing this one does not degrade, it fails to start.
    expect(typeof proto.createDynamicTexture).toBe('function')
    // Its other half, and `DynamicTexture.update()` is what calls it: the same
    // import registers both, and a fix that only satisfied the assertion above
    // would still fall over on the first `finishDetail`.
    expect(typeof proto.updateDynamicTexture).toBe('function')
  })
})

describe('WebGPU texture features', () => {
  it('requests every compressed 2D target the KTX2 pipeline can choose', () => {
    const requested = createWebGPUOptions().deviceDescriptor?.requiredFeatures ?? []
    expect(Array.from(requested)).toEqual(WEBGPU_TEXTURE_FEATURES)
    expect(WEBGPU_TEXTURE_FEATURES).toEqual([
      'texture-compression-bc',
      'texture-compression-etc2',
      'texture-compression-astc',
    ])
  })
})

describe('renderFrame', () => {
  it('brackets a draw with the engine frame that submits WebGPU commands', () => {
    const calls: string[] = []
    const engine = {
      beginFrame: () => calls.push('begin'),
      endFrame: () => calls.push('end'),
    }
    const scene = { render: () => calls.push('render') }

    renderFrame(engine, scene)

    expect(calls).toEqual(['begin', 'render', 'end'])
  })

  it('ends a frame whose scene render throws', () => {
    const calls: string[] = []
    const engine = {
      beginFrame: () => calls.push('begin'),
      endFrame: () => calls.push('end'),
    }
    const scene = {
      render: () => {
        calls.push('render')
        throw new Error('draw failed')
      },
    }

    expect(() => renderFrame(engine, scene)).toThrow('draw failed')
    expect(calls).toEqual(['begin', 'render', 'end'])
  })
})
