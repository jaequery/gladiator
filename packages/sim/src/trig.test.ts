import { describe, expect, it } from 'vitest'

import { cosRad, sinRad } from './trig.ts'

/**
 * `Math.sin` is the *reference* here, not the authority: the point of
 * `trig.ts` is that it does not call it. These tests assert that our own
 * implementation is close enough to be indistinguishable in a game, and that
 * the identities a movement basis depends on hold exactly enough to be safe.
 *
 * This file is the one place in `packages/sim` where `Math.sin` is allowed;
 * `eslint.config.js` says so, and says why.
 */

/** Angles a view direction actually takes, plus the quadrant boundaries. */
function angleSweep(): number[] {
  const angles: number[] = []
  for (let i = 0; i < 2048; i += 1) {
    angles.push((i / 2048) * Math.PI * 2)
  }
  for (const boundary of [0, Math.PI / 4, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI, 6.283]) {
    angles.push(boundary)
  }
  return angles
}

describe('sinRad / cosRad', () => {
  it('tracks Math.sin and Math.cos across a full turn', () => {
    let worst = 0
    for (const angle of angleSweep()) {
      worst = Math.max(worst, Math.abs(sinRad(angle) - Math.sin(angle)))
      worst = Math.max(worst, Math.abs(cosRad(angle) - Math.cos(angle)))
    }
    expect(worst).toBeLessThan(1e-15)
  })

  it('keeps sin^2 + cos^2 within a few ULP of one', () => {
    let worst = 0
    for (const angle of angleSweep()) {
      const s = sinRad(angle)
      const c = cosRad(angle)
      worst = Math.max(worst, Math.abs(s * s + c * c - 1))
    }
    expect(worst).toBeLessThan(1e-15)
  })

  it('is exact at the axes, so a cardinal view direction has no drift', () => {
    expect(sinRad(0)).toBe(0)
    expect(cosRad(0)).toBe(1)
  })

  it('is a pure function of its argument', () => {
    // Trivially true here, and worth asserting: the moment `trig.ts` grows a
    // lookup table or a cache, "the same angle twice" must still agree.
    for (const angle of angleSweep()) {
      expect(sinRad(angle)).toBe(sinRad(angle))
      expect(cosRad(angle)).toBe(cosRad(angle))
    }
  })
})
