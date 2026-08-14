import { TICK_INTERVAL_MS, TICK_RATE } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { MAX_FRAME_MS, advance, alphaOf } from './loop.ts'

describe('fixed-timestep accumulator', () => {
  it('turns one tick of wall-clock into exactly one tick', () => {
    expect(advance(0, TICK_INTERVAL_MS)).toEqual({
      ticks: 1,
      accumulatorMs: 0,
      droppedMs: 0,
    })
  })

  it('carries the remainder rather than rounding it away', () => {
    const first = advance(0, 20)
    expect(first.ticks).toBe(2)
    expect(first.accumulatorMs).toBe(4)
    const second = advance(first.accumulatorMs, 20)
    expect(second.ticks).toBe(3)
    expect(second.accumulatorMs).toBe(0)
  })

  it('runs no ticks for a frame shorter than one', () => {
    expect(advance(0, 3).ticks).toBe(0)
    expect(advance(0, 3).accumulatorMs).toBe(3)
  })

  it('simulates exactly 125 ticks per second of wall-clock at 60 Hz', () => {
    // The check that matters: over a second of 60 Hz frames, the accumulator
    // must produce 125 ticks, not 124 and not 126.
    let accumulatorMs = 0
    let ticks = 0
    for (let frame = 0; frame < 60; frame += 1) {
      const step = advance(accumulatorMs, 1000 / 60)
      accumulatorMs = step.accumulatorMs
      ticks += step.ticks
    }
    expect(ticks).toBe(TICK_RATE)
  })

  it('does not drift over a minute of 144 Hz frames', () => {
    let accumulatorMs = 0
    let ticks = 0
    for (let frame = 0; frame < 144 * 60; frame += 1) {
      const step = advance(accumulatorMs, 1000 / 144)
      accumulatorMs = step.accumulatorMs
      ticks += step.ticks
    }
    // 60 seconds at 125 Hz. One tick either way is the float remainder, not
    // drift; anything more is a bug that compounds over a match.
    expect(Math.abs(ticks - TICK_RATE * 60)).toBeLessThanOrEqual(1)
  })

  it('clamps a stalled frame instead of spiralling', () => {
    const step = advance(0, 5000)
    expect(step.ticks).toBe(Math.floor(MAX_FRAME_MS / TICK_INTERVAL_MS))
    expect(step.droppedMs).toBe(5000 - MAX_FRAME_MS)
  })

  it('ignores a clock that goes backwards', () => {
    expect(advance(4, -100)).toEqual({ ticks: 0, accumulatorMs: 4, droppedMs: 0 })
  })

  it('reports interpolation alpha in [0, 1)', () => {
    expect(alphaOf(0)).toBe(0)
    expect(alphaOf(4)).toBe(0.5)
    expect(alphaOf(TICK_INTERVAL_MS - 0.001)).toBeLessThan(1)
  })
})
