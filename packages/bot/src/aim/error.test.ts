/**
 * The three error sources, one claim each.
 *
 * The tracking one is the only one with a shape worth asserting: a reaction
 * modelled as a blend has to cost *nothing* on a straight-line runner and a full
 * reaction time on somebody who cuts. That pair is the whole reason it is a blend
 * rather than a delay, and either half alone would pass for the wrong model.
 */

import { RUN_SPEED, TICK_INTERVAL_MS, seedRng } from '@gladiator/sim'
import type { MutVec3, RngHolder, Vec3 } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  AIM_ERROR_FRACTION,
  MAX_AIM_ERROR,
  MOTOR_ERROR,
  NOMINAL_REACTION_TICKS,
  REACTION_MIN_MS,
  REACTION_SPREAD_MS,
  ageNoise,
  createNoise,
  createTrack,
  displaceAim,
  errorRadius,
  reactionTicks,
  rollNoise,
  trackTarget,
} from './error.ts'

function rng(seed: number): RngHolder {
  return { rng: seedRng(seed) }
}

/** How far the track is from a point. */
function distance(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0]
  const dy = a[1] - b[1]
  const dz = a[2] - b[2]
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

describe('the reaction draw', () => {
  it('is inside the band, in whole sub-steps, with the floor rounded up', () => {
    const stream = rng(1)
    const floor = Math.ceil(REACTION_MIN_MS / TICK_INTERVAL_MS)
    const ceiling = Math.ceil((REACTION_MIN_MS + REACTION_SPREAD_MS) / TICK_INTERVAL_MS)
    for (let i = 0; i < 2000; i += 1) {
      const ticks = reactionTicks(stream)
      expect(Number.isInteger(ticks)).toBe(true)
      expect(ticks).toBeGreaterThanOrEqual(floor)
      expect(ticks).toBeLessThanOrEqual(ceiling)
    }
  })

  it('has a nominal value in the middle of the band, for before the first draw', () => {
    expect(NOMINAL_REACTION_TICKS * TICK_INTERVAL_MS).toBeGreaterThan(REACTION_MIN_MS)
    expect(NOMINAL_REACTION_TICKS * TICK_INTERVAL_MS).toBeLessThan(
      REACTION_MIN_MS + REACTION_SPREAD_MS,
    )
  })
})

describe('the track', () => {
  const blend = 1 / NOMINAL_REACTION_TICKS

  it('costs nothing on a target running in a straight line', () => {
    // The dead reckoning already puts the belief where they are, so a runner is
    // tracked with no lag at all. That is what tracking somebody crossing a
    // corridor feels like, and a hard reaction delay cannot produce it.
    const track = createTrack()
    const velocity: Vec3 = [0, RUN_SPEED, 0]
    let y = 0
    trackTarget(track, [0, y, 0], velocity, blend)
    for (let i = 0; i < 200; i += 1) {
      y += RUN_SPEED / 125
      trackTarget(track, [0, y, 0], velocity, blend)
    }
    expect(distance(track.origin, [0, y, 0])).toBeLessThan(0.001)
  })

  it('falls a reaction behind a target that changes direction, then catches up', () => {
    const track = createTrack()
    let y = 0
    let velocity: Vec3 = [0, RUN_SPEED, 0]
    trackTarget(track, [0, y, 0], velocity, blend)
    for (let i = 0; i < 100; i += 1) {
      y += RUN_SPEED / 125
      trackTarget(track, [0, y, 0], velocity, blend)
    }

    // They cut back the other way. The track keeps going the way they were.
    velocity = [0, -RUN_SPEED, 0]
    const errors: number[] = []
    for (let i = 0; i < 200; i += 1) {
      y -= RUN_SPEED / 125
      trackTarget(track, [0, y, 0], velocity, blend)
      errors.push(distance(track.origin, [0, y, 0]))
    }

    const worst = Math.max(...errors)
    // Wrong by more than a body width, which on a rail is a miss.
    expect(worst).toBeGreaterThan(30)
    // And decayed away by the end, rather than being a permanent offset.
    expect(errors[errors.length - 1] ?? 0).toBeLessThan(worst / 10)
  })

  it('adopts a first belief outright rather than blending in from nowhere', () => {
    const track = createTrack()
    trackTarget(track, [900, -300, 12], [1, 2, 3], blend)
    expect([...track.origin]).toEqual([900, -300, 12])
    expect(track.live).toBe(true)
  })
})

describe('the aim error', () => {
  it('is nothing at all when the aim point is what the bot can see', () => {
    // A rail at a visible body is a rail at a visible body. This is the whole
    // reason the model needs no per-weapon accuracy table.
    expect(errorRadius([100, 0, 24], [100, 0, 24])).toBe(0)
  })

  it('is small for a splash at the feet and large for a lead', () => {
    const feet = errorRadius([600, 0, 0], [600, 0, 24])
    const led = errorRadius([600, 200, 24], [600, 0, 24])
    expect(feet).toBeCloseTo(24 * AIM_ERROR_FRACTION, 6)
    expect(led).toBeCloseTo(200 * AIM_ERROR_FRACTION, 6)
    expect(led).toBeGreaterThan(feet * 5)
  })

  it('is capped, so a lead across the map is not an error the size of the arena', () => {
    expect(errorRadius([3000, 0, 24], [0, 0, 24])).toBe(MAX_AIM_ERROR)
  })

  it('displaces the aim point by at most that radius', () => {
    const noise = createNoise()
    const stream = rng(5)
    const out: MutVec3 = [0, 0, 0]
    for (let i = 0; i < 500; i += 1) {
      rollNoise(noise, stream, 26)
      const aim: Vec3 = [600, 200, 24]
      const reference: Vec3 = [600, 0, 24]
      displaceAim(out, aim, reference, noise)
      expect(distance(out, aim)).toBeLessThanOrEqual(errorRadius(aim, reference) + 1e-9)
    }
  })
})

describe('the motor error', () => {
  it('stays inside its band and averages out to no error at all', () => {
    const noise = createNoise()
    const stream = rng(9)
    let total = 0
    const count = 4000
    for (let i = 0; i < count; i += 1) {
      rollNoise(noise, stream, 26)
      expect(noise.motor).toBeGreaterThanOrEqual(1 - MOTOR_ERROR)
      expect(noise.motor).toBeLessThanOrEqual(1 + MOTOR_ERROR)
      total += noise.motor
    }
    expect(total / count).toBeCloseTo(1, 1)
  })

  it('is re-rolled once a period rather than every sub-step', () => {
    // Held constant through a flick it would make one merely fast or slow; the
    // wobble comes from it changing *during* one.
    const noise = createNoise()
    const stream = rng(11)
    rollNoise(noise, stream, 10)
    const first = noise.motor
    for (let i = 0; i < 9; i += 1) {
      ageNoise(noise, stream, 10)
      expect(noise.motor).toBe(first)
    }
    ageNoise(noise, stream, 10)
    expect(noise.motor).not.toBe(first)
  })
})
