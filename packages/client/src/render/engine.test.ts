import { describe, expect, it } from 'vitest'

import {
  LEAP_SHARE,
  MAX_PIXEL_RATIO,
  PIXEL_RATIO_LADDER,
  QUALITY_TOLERANCE,
  STEP_DOWN_SHARE,
  STEP_UP_SHARE,
  WEBGPU_TEXTURE_FEATURES,
  clampPixelRatio,
  createWebGPUOptions,
  hardwareScalingFor,
  ladderRung,
  loadWebGPU,
  nextPixelRatio,
  renderFrame,
} from './engine.ts'
import { FRAME_BUDGET_MS, createFrameMeter, summarise } from './frameStats.ts'

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
  /** The share a window has to miss before the dial reacts, and then some. */
  const missing = STEP_DOWN_SHARE + 0.1
  const clean = 0

  it('steps down when too much of the window missed the budget', () => {
    expect(nextPixelRatio(2, missing, 2)).toBe(1.5)
    expect(nextPixelRatio(1, missing, 2)).toBe(0.85)
  })

  it('takes two rungs when it is nowhere near, and one when it is close', () => {
    // Eleven rungs and a two-second window: one rung at a time is the right
    // shape and the wrong speed for a machine at the top of the ladder that
    // belongs at the bottom.
    expect(nextPixelRatio(1, LEAP_SHARE + 0.1, 2)).toBe(0.75)
    expect(nextPixelRatio(1, LEAP_SHARE - 0.1, 2)).toBe(0.85)
  })

  it('stops at the bottom rung rather than rendering nothing', () => {
    const floor = PIXEL_RATIO_LADDER[PIXEL_RATIO_LADDER.length - 1] ?? 0.25
    expect(nextPixelRatio(floor, missing, 2)).toBe(floor)
    // Including when it would have leapt past it.
    expect(nextPixelRatio(floor, 1, 2)).toBe(floor)
    const above = PIXEL_RATIO_LADDER[PIXEL_RATIO_LADDER.length - 2] ?? 0.33
    expect(nextPixelRatio(above, 1, 2)).toBe(floor)
  })

  it('steps back up when the window is clean, and no further than the ceiling', () => {
    expect(nextPixelRatio(1, clean, 2)).toBe(1.25)
    expect(nextPixelRatio(1, clean, 1)).toBe(1)
  })

  it('holds still in the band between, so it does not hunt', () => {
    expect(nextPixelRatio(1, (STEP_UP_SHARE + STEP_DOWN_SHARE) / 2, 2)).toBe(1)
  })

  it('leaves a ratio that was set by hand alone', () => {
    expect(nextPixelRatio(1.13, missing, 2)).toBe(1.13)
  })

  it('leaves a display that is keeping perfect time alone', () => {
    // The measured interval on a 60 Hz display is 16.7 or 16.8 ms and the
    // budget is 1000/60 = 16.667. Without a tolerance, every 60 Hz machine
    // reads as permanently over budget and walks its own image down to the
    // bottom rung while hitting every single frame.
    const meter = createFrameMeter()
    for (let i = 0; i < 600; i += 1) meter.record(i % 2 === 0 ? 16.7 : 16.8)
    expect(meter.missShare(budget * QUALITY_TOLERANCE)).toBe(0)
    expect(nextPixelRatio(1, meter.missShare(budget * QUALITY_TOLERANCE), 1)).toBe(1)
  })

  it('does not chase a tail of stalls it has no influence over', () => {
    // The window this stands for: a loop keeping the 60 Hz cadence exactly,
    // with a handful of frames descheduled by the operating system. Fewer
    // pixels would not have helped with any of them, and a dial that reacted
    // would walk the image down chasing a number it does not control.
    const meter = createFrameMeter()
    for (let i = 0; i < 588; i += 1) meter.record(1000 / 60)
    for (let i = 0; i < 12; i += 1) meter.record(250)
    const share = meter.missShare(budget * QUALITY_TOLERANCE)
    expect(share).toBeLessThan(STEP_UP_SHARE)
    expect(nextPixelRatio(1, share, 1)).toBe(1)
  })

  it('sees a cost that vsync has hidden from every summary statistic', () => {
    // The window measured on the browser smoke test's runner, which is what
    // this function was rewritten for: a median of 16.7 ms — the refresh
    // interval, and therefore the monitor's number rather than the scene's —
    // with a quarter of the frames waiting for a second refresh. The dial read
    // the median, saw 16.7, and sat where it was through the whole run.
    const meter = createFrameMeter()
    for (let i = 0; i < 450; i += 1) meter.record(1000 / 60)
    for (let i = 0; i < 150; i += 1) meter.record(2000 / 60)
    const window = summarise(meter.intervals())
    expect(window.medianMs).toBeCloseTo(1000 / 60, 5)
    expect(window.medianMs).toBeLessThan(budget * QUALITY_TOLERANCE)
    expect(nextPixelRatio(1, meter.missShare(budget * QUALITY_TOLERANCE), 2)).toBe(0.85)
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
