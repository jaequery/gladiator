/**
 * The bang-bang servo: what it is allowed to do, and what it must not.
 *
 * The claims worth having are all about *shape*, because that is what a player
 * reads. A turret arrives instantly, a Quake 3 bot shivers around the target, and
 * a person flicks, brakes and settles. The tests below are the difference between
 * the three, stated as properties rather than as a recorded trace.
 */

import { ANGLE_UNITS_PER_DEGREE, MAX_PITCH_UNITS } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  AIM_ACCEL_TICKS,
  MAX_AIM_ACCEL,
  MAX_TURN_UNITS,
  aimPitch,
  aimYaw,
  clampPitch,
  createAim,
  holdAim,
  pitchUnitsToward,
  seedAim,
  steerAim,
  subtendedUnits,
  wrapDelta,
  wrapUnits,
  yawUnitsToward,
} from './controller.ts'
import type { AimState } from './controller.ts'

/** Drive the servo at a fixed target and record what the command carried. */
function slew(target: number, steps: number, motor = 1): { yaws: number[]; aim: AimState } {
  const aim = createAim()
  seedAim(aim, 0, 0)
  const yaws: number[] = []
  for (let i = 0; i < steps; i += 1) {
    steerAim(aim, 0, target, motor)
    yaws.push(aimYaw(aim))
  }
  return { yaws, aim }
}

/** The signed step between consecutive commands, the short way round. */
function deltas(yaws: readonly number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < yaws.length; i += 1) out.push(wrapDelta((yaws[i] ?? 0) - (yaws[i - 1] ?? 0)))
  return out
}

describe('the limits', () => {
  it('never turns faster than the rate limit, even over a half turn', () => {
    const { yaws } = slew(32768, 200)
    for (const delta of deltas(yaws)) expect(Math.abs(delta)).toBeLessThanOrEqual(MAX_TURN_UNITS + 1)
  })

  it('takes the stated wind-up to reach the rate limit rather than starting there', () => {
    // The acceleration limit is what makes the motion a wrist rather than a
    // stepper motor. Over a long turn the first sub-step is one acceleration
    // step, not a full sweep.
    const { yaws } = slew(32768, 200)
    // Seeded at zero, so the first command carries exactly one acceleration step.
    expect(yaws[0] ?? 0).toBeLessThanOrEqual(Math.ceil(MAX_AIM_ACCEL))
    const stepped = deltas(yaws).findIndex((delta) => Math.abs(delta) >= MAX_TURN_UNITS)
    expect(stepped).toBeGreaterThanOrEqual(AIM_ACCEL_TICKS - 2)
  })

  it('respects the rate limit whatever the motor error does', () => {
    // Motor error multiplies the *acceleration* and nothing else — the arm does
    // not wobble, the wrist does — so the per-sub-step cap holds at both ends of
    // the band.
    for (const motor of [0.75, 1.25]) {
      const { yaws } = slew(32768, 200, motor)
      for (const delta of deltas(yaws)) {
        expect(Math.abs(delta)).toBeLessThanOrEqual(MAX_TURN_UNITS + 1)
      }
    }
  })
})

describe('the shape', () => {
  it('flicks: a big turn spends most of its time at the rate limit', () => {
    const { yaws } = slew(32768, 200)
    const atLimit = deltas(yaws).filter((delta) => Math.abs(delta) >= MAX_TURN_UNITS - 1)
    expect(atLimit.length).toBeGreaterThan(10)
  })

  it('settles exactly, and stays there', () => {
    // The endgame clause in `nextRate`. Without it the switching curve chatters
    // either side of zero forever, which is the crosshair shiver Quake 3's bots
    // are known for.
    const { yaws, aim } = slew(8192, 120)
    expect(aimYaw(aim)).toBe(8192)
    expect(aim.error).toBe(0)
    expect(aim.rate).toBe(0)
    const tail = yaws.slice(60)
    expect(new Set(tail).size).toBe(1)
  })

  it('never overshoots, at any distance', () => {
    // The switching curve brakes *before* the target rather than at it, so a
    // time-optimal approach arrives from one side and stays there. An overshoot
    // and a hunt back across the target is exactly the Q3 wobble this controller
    // exists to avoid — and is what a continuous `v^2 / 2a` braking distance
    // produces on a discretely-stepped servo. See {@link stopDistance}.
    for (const target of [200, 1000, 8192, 20000, 32768]) {
      const { yaws } = slew(target, 300)
      for (const yaw of yaws) expect(yaw, `target ${target}`).toBeLessThanOrEqual(target)
    }
  })

  it('takes the short way round', () => {
    const { aim } = slew(wrapUnits(-4096), 120)
    expect(aimYaw(aim)).toBe(wrapUnits(-4096))
  })

  it('holds the view when there is nothing to point at', () => {
    const aim = createAim()
    seedAim(aim, 100, 4096)
    steerAim(aim, 0, 20000, 1)
    holdAim(aim)
    const yaw = aimYaw(aim)
    holdAim(aim)
    expect(aimYaw(aim)).toBe(yaw)
    expect(aim.rate).toBe(0)
  })
})

describe('the angles', () => {
  it('clamps pitch to the legal band rather than wrapping it', () => {
    const aim = createAim()
    seedAim(aim, 0, 0)
    for (let i = 0; i < 400; i += 1) steerAim(aim, 30000, 0, 1)
    expect(aimPitch(aim)).toBe(MAX_PITCH_UNITS)
    expect(clampPitch(-30000)).toBe(-MAX_PITCH_UNITS)
  })

  it('points at a target, in both axes', () => {
    // Positive pitch is downward (`usercmd.ts`), so a target below the eye is a
    // positive number and one above it is negative.
    expect(yawUnitsToward(0, 0, [100, 0, 0])).toBeCloseTo(0, 6)
    expect(yawUnitsToward(0, 0, [0, 100, 0])).toBeCloseTo(16384, 6)
    expect(pitchUnitsToward(0, 0, 50, [100, 0, 0])).toBeGreaterThan(0)
    expect(pitchUnitsToward(0, 0, 50, [100, 0, 200])).toBeLessThan(0)
  })

  it('subtends a target by its size and its range, not by a constant', () => {
    // A fixed angular tolerance would be a bot that is fussy at point-blank
    // range and reckless across the map.
    const near = subtendedUnits(60, 300)
    const far = subtendedUnits(60, 3000)
    expect(near).toBeGreaterThan(far)
    expect(far / ANGLE_UNITS_PER_DEGREE).toBeCloseTo(1.146, 2)
  })
})
