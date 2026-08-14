import { describe, expect, it } from 'vitest'

import {
  MAX_PIXEL_RATIO,
  PIXEL_RATIO_LADDER,
  RECOVER_FRACTION,
  clampPixelRatio,
  hardwareScalingFor,
  ladderRung,
  nextPixelRatio,
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
