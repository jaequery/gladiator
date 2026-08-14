import { describe, expect, it } from 'vitest'

import {
  FRAME_BUDGET_MS,
  HITCH_FACTOR,
  MAX_HITCHES_PER_SECOND,
  createFrameMeter,
  frameVerdict,
  meterVerdict,
  percentile,
  summarise,
} from './frameStats.ts'

/**
 * The frame graph this module exists to reject, exactly as the ticket words it:
 * 144 fps average with a 30 ms hitch every two seconds.
 */
function hitchingAt144Hz(seconds: number): number[] {
  const normalMs = 1000 / 144
  const framesPerHitch = Math.round(2000 / normalMs) // one hitch every two seconds
  const intervals: number[] = []
  let elapsed = 0
  let sinceHitch = 0
  while (elapsed < seconds * 1000) {
    sinceHitch += 1
    const interval = sinceHitch >= framesPerHitch ? 30 : normalMs
    if (sinceHitch >= framesPerHitch) sinceHitch = 0
    intervals.push(interval)
    elapsed += interval
  }
  return intervals
}

/** The same run, without the hitches. */
function steadyAt144Hz(seconds: number): number[] {
  const normalMs = 1000 / 144
  return Array.from({ length: Math.round((seconds * 1000) / normalMs) }, () => normalMs)
}

describe('percentile', () => {
  const ascending = Array.from({ length: 100 }, (_, i) => i + 1)

  it('takes the nearest rank, so the answer is a frame that happened', () => {
    expect(percentile(ascending, 0.5)).toBe(50)
    expect(percentile(ascending, 0.95)).toBe(95)
    expect(percentile(ascending, 0.99)).toBe(99)
  })

  it('clamps at both ends rather than reading off the array', () => {
    expect(percentile(ascending, 0)).toBe(1)
    expect(percentile(ascending, 1)).toBe(100)
    expect(percentile([], 0.99)).toBe(0)
  })
})

describe('summarise', () => {
  it('reports the distribution, not just the middle', () => {
    const stats = summarise([10, 10, 10, 10, 90])
    expect(stats.frames).toBe(5)
    expect(stats.spanMs).toBe(130)
    expect(stats.meanMs).toBe(26)
    expect(stats.medianMs).toBe(10)
    expect(stats.worstMs).toBe(90)
  })
})

describe('the pathological frame graph', () => {
  const intervals = hitchingAt144Hz(30)

  it('averages well inside budget — which is why a mean is the wrong gate', () => {
    const stats = summarise(intervals)
    expect(stats.meanMs).toBeLessThan(FRAME_BUDGET_MS)
    // And so does p99, on its own: fifteen hitches in 4300 frames are rarer
    // than one in a hundred, so they sit *above* the 99th percentile. This is
    // the arithmetic that makes the hitch-rate half of the verdict necessary.
    expect(stats.p99Ms).toBeLessThan(FRAME_BUDGET_MS)
  })

  it('FAILS the verdict', () => {
    const verdict = frameVerdict(intervals, FRAME_BUDGET_MS)
    expect(verdict.ok).toBe(false)
    expect(verdict.hitchesPerSecond).toBeGreaterThan(MAX_HITCHES_PER_SECOND)
    expect(verdict.reason).toContain('hitches')
  })

  it('passes once the hitches are gone', () => {
    expect(frameVerdict(steadyAt144Hz(30), FRAME_BUDGET_MS).ok).toBe(true)
  })

  it('tolerates a single stall in a long run', () => {
    const intervals = steadyAt144Hz(30)
    intervals[1000] = 40
    expect(frameVerdict(intervals, FRAME_BUDGET_MS).ok).toBe(true)
  })
})

describe('frameVerdict', () => {
  it('fails a frame graph that is simply too slow', () => {
    const verdict = frameVerdict(
      Array.from({ length: 600 }, () => 25),
      FRAME_BUDGET_MS,
    )
    expect(verdict.ok).toBe(false)
    expect(verdict.reason).toContain('p99')
  })

  it('counts a hitch as more than twice the budget', () => {
    const budget = 10
    const justUnder = frameVerdict([budget * HITCH_FACTOR], budget)
    const justOver = frameVerdict([budget * HITCH_FACTOR + 0.001], budget)
    expect(justUnder.hitches).toBe(0)
    expect(justOver.hitches).toBe(1)
  })

  it('says nothing is wrong when nothing is', () => {
    expect(frameVerdict([], FRAME_BUDGET_MS).ok).toBe(true)
  })
})

describe('createFrameMeter', () => {
  it('ignores intervals that are not frames', () => {
    const meter = createFrameMeter(8)
    meter.record(0)
    meter.record(-5)
    meter.record(Number.NaN)
    expect(meter.stats().frames).toBe(0)
  })

  it('keeps a rolling window rather than growing without bound', () => {
    const meter = createFrameMeter(4)
    for (let i = 1; i <= 100; i += 1) meter.record(i)
    expect(meter.stats().frames).toBe(4)
  })

  it('forgets everything on reset', () => {
    const meter = createFrameMeter(16)
    for (const interval of [40, 40, 40]) meter.record(interval)
    expect(meterVerdict(meter, FRAME_BUDGET_MS).ok).toBe(false)
    meter.reset()
    expect(meter.stats().frames).toBe(0)
    expect(meterVerdict(meter, FRAME_BUDGET_MS).ok).toBe(true)
  })
})
