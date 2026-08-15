/**
 * The objective function the shot selection maximises.
 *
 * Two closed forms with a boundary between them, which is exactly the sort of
 * thing that is right in the middle of each branch and wrong at the join. The
 * asymmetry at the bottom is the one that matters: as the miss radius grows a
 * direct hit collapses quadratically and a splash decays linearly, and that gap
 * is the whole argument for splash-at-the-feet being the primary mode.
 */

import { describe, expect, it } from 'vitest'

import {
  DIRECT_DAMAGE,
  SPLASH_DAMAGE,
  SPLASH_RADIUS,
  TARGET_AREA,
  directChance,
  expectedDirect,
  expectedSplash,
  splashAt,
} from './damage.ts'

describe('the splash falloff', () => {
  it('is Quake’s linear falloff, truncated as the simulation truncates it', () => {
    expect(splashAt(0)).toBe(SPLASH_DAMAGE)
    expect(splashAt(SPLASH_RADIUS / 2)).toBe(SPLASH_DAMAGE / 2)
    expect(splashAt(SPLASH_RADIUS)).toBe(0)
    expect(splashAt(SPLASH_RADIUS + 100)).toBe(0)
    // 60 units off still deals 50, which is why splashing is worth doing at all.
    expect(splashAt(60)).toBe(50)
    // Integers, because `damage.ts` truncates before deriving the knockback.
    expect(splashAt(37.7)).toBe(Math.trunc(splashAt(37.7)))
  })
})

describe('the expected splash over a miss', () => {
  it('is the damage at the aim point when there is no miss to expect', () => {
    expect(expectedSplash(0, 0)).toBe(SPLASH_DAMAGE)
    expect(expectedSplash(60, 0)).toBe(50)
  })

  it('joins its two branches continuously at the boundary', () => {
    // The branches meet where the miss radius equals the remaining reach. A step
    // there would make the shot selection flip on a rounding difference.
    const d0 = 30
    const reach = SPLASH_RADIUS - d0
    expect(expectedSplash(d0, reach - 1e-6)).toBeCloseTo(expectedSplash(d0, reach + 1e-6), 4)
  })

  it('decays but never reaches zero, so there is always a better option', () => {
    // Two expectations that both collapsed to exactly zero would leave the shot
    // selection with nothing to compare, and it would take whichever the
    // tie-break happened to name.
    let previous = SPLASH_DAMAGE
    for (const radius of [10, 40, 80, 120, 240, 600]) {
      const value = expectedSplash(0, radius)
      expect(value).toBeLessThan(previous)
      expect(value).toBeGreaterThan(0)
      previous = value
    }
  })

  it('is nothing once the aim point is a whole radius from the body', () => {
    expect(expectedSplash(SPLASH_RADIUS, 30)).toBe(0)
    expect(expectedSplash(SPLASH_RADIUS + 50, 0)).toBe(0)
  })
})

describe('the direct-hit expectation', () => {
  it('is certain when the miss is smaller than the body', () => {
    expect(directChance(0)).toBe(1)
    expect(expectedDirect(0)).toBe(DIRECT_DAMAGE)
    // A disc that fits inside the silhouette is a hit either way.
    expect(directChance(Math.sqrt(TARGET_AREA / Math.PI) - 1)).toBe(1)
  })

  it('collapses quadratically once the miss is bigger than the body', () => {
    const near = directChance(40)
    const far = directChance(80)
    expect(near).toBeLessThan(1)
    expect(far).toBeCloseTo(near / 4, 6)
  })

  it('is beaten by the splash as soon as the bot is guessing at all', () => {
    // The comparison the shot selection is built on, at the radius where it
    // turns over. Below it a direct hit is better; above it the splash is, and
    // by an increasing margin.
    expect(expectedSplash(0, 20)).toBeLessThan(expectedDirect(20))
    expect(expectedSplash(0, 60)).toBeGreaterThan(expectedDirect(60))
    expect(expectedSplash(0, 120)).toBeGreaterThan(expectedDirect(120) * 5)
  })
})
