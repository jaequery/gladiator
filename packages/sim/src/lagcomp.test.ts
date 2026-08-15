import { describe, expect, it } from 'vitest'

import {
  INTERP_DELAY_MS,
  INTERP_DELAY_TICKS,
  MAX_REWIND_MS,
  rewindMsFor,
  rewindTicksFor,
} from './lagcomp.ts'
import { TICK_INTERVAL_MS } from './tick.ts'

describe('how far back a shooter sees', () => {
  it('is half the round trip plus the interpolation delay', () => {
    expect(rewindMsFor(200)).toBe(180)
    expect(rewindMsFor(40)).toBe(100)
    expect(rewindMsFor(0)).toBe(INTERP_DELAY_MS)
  })

  it('rewinds by the interpolation delay before any round trip is measured', () => {
    // A client draws the opponent in the past from its very first snapshot,
    // ping or no ping. Rewinding zero here would mean rails that mysteriously
    // miss for the first second of every session.
    expect(rewindMsFor(-1)).toBe(INTERP_DELAY_MS)
    expect(rewindMsFor(Number.NaN)).toBe(INTERP_DELAY_MS)
  })

  it('never rewinds more than the cap, whatever the round trip claims to be', () => {
    // The acceptance check, stated as arithmetic: the round trip is the
    // server's own measurement and there is no client-supplied path into it,
    // but even a genuinely catastrophic link cannot buy more than the cap.
    expect(rewindMsFor(5000)).toBe(MAX_REWIND_MS)
    expect(rewindMsFor(60_000)).toBe(MAX_REWIND_MS)
    expect(rewindMsFor(440)).toBe(MAX_REWIND_MS)
    expect(rewindMsFor(439)).toBeLessThan(MAX_REWIND_MS)

    for (const rttMs of [-1000, -1, 0, 1, 39, 200, 439, 440, 5000, 60_000, 1e12]) {
      expect(rewindMsFor(rttMs)).toBeLessThanOrEqual(MAX_REWIND_MS)
      expect(rewindMsFor(rttMs)).toBeGreaterThanOrEqual(0)
    }
  })

  it('treats a round trip that is not a number as one nobody has measured', () => {
    // `Infinity` and `NaN` are upstream bugs rather than links, and the safe
    // reading of a number nobody chose is "no measurement", which is the
    // interpolation delay and nothing more.
    expect(rewindMsFor(Number.POSITIVE_INFINITY)).toBe(INTERP_DELAY_MS)
    expect(rewindMsFor(Number.NaN)).toBe(INTERP_DELAY_MS)
  })

  it('is fractional in ticks, because shots do not land on tick boundaries', () => {
    // 180 ms is 22.5 sub-steps. Rounding it would throw away half a tick of the
    // target's motion — 1.28 units at run speed — for nothing.
    expect(rewindTicksFor(200)).toBe(22.5)
    expect(rewindTicksFor(200)).not.toBe(Math.round(rewindTicksFor(200)))
    expect(rewindTicksFor(5000)).toBe(MAX_REWIND_MS / TICK_INTERVAL_MS)
  })
})

describe('the interpolation delay', () => {
  it('is a whole number of sub-steps, and one number for both peers', () => {
    expect(INTERP_DELAY_TICKS).toBe(INTERP_DELAY_MS / TICK_INTERVAL_MS)
    expect(Number.isInteger(INTERP_DELAY_TICKS)).toBe(true)
  })

  it('is comfortably inside the rewind cap', () => {
    // Otherwise a client on a perfect link would be asking for a rewind the cap
    // refuses, which would make the mechanism wrong at zero latency.
    expect(INTERP_DELAY_MS).toBeLessThan(MAX_REWIND_MS)
  })
})
