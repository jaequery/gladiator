import { describe, expect, it } from 'vitest'

import {
  ANGLE_UNITS,
  MAX_PITCH_UNITS,
  angleUnitsToRadians,
  pitchUnitsFromDegrees,
  sanitizeUserCmd,
  yawUnitsFromDegrees,
} from './usercmd.ts'
import { Weapon } from './weapon.ts'

describe('angle quantisation', () => {
  it('wraps yaw into [0, ANGLE_UNITS)', () => {
    expect(yawUnitsFromDegrees(0)).toBe(0)
    expect(yawUnitsFromDegrees(90)).toBe(ANGLE_UNITS / 4)
    expect(yawUnitsFromDegrees(360)).toBe(0)
    expect(yawUnitsFromDegrees(-90)).toBe((ANGLE_UNITS * 3) / 4)
    expect(yawUnitsFromDegrees(-3600.5)).toBeGreaterThanOrEqual(0)
    expect(yawUnitsFromDegrees(3600.5)).toBeLessThan(ANGLE_UNITS)
  })

  it('clamps pitch to the legal band', () => {
    expect(pitchUnitsFromDegrees(0)).toBe(0)
    expect(pitchUnitsFromDegrees(90)).toBe(MAX_PITCH_UNITS)
    expect(pitchUnitsFromDegrees(-90)).toBe(-MAX_PITCH_UNITS)
    expect(pitchUnitsFromDegrees(1000)).toBe(MAX_PITCH_UNITS)
  })

  it('converts a quarter turn to a quarter of tau, exactly', () => {
    expect(angleUnitsToRadians(ANGLE_UNITS / 4)).toBe(6.283185307179586 / 4)
  })
})

describe('sanitizeUserCmd', () => {
  it('passes a legal command through unchanged', () => {
    const legal = {
      forwardMove: 1,
      sideMove: -1,
      yaw: 12345,
      pitch: -400,
      buttons: 1,
      weapon: Weapon.Railgun,
    }
    expect(sanitizeUserCmd(legal)).toEqual(legal)
  })

  it('turns NaN into zero rather than into a desync', () => {
    const clean = sanitizeUserCmd({
      forwardMove: Number.NaN,
      sideMove: Number.POSITIVE_INFINITY,
      yaw: Number.NaN,
      pitch: Number.NaN,
      buttons: Number.NaN,
    })
    for (const value of Object.values(clean)) {
      expect(Number.isInteger(value)).toBe(true)
    }
    expect(clean.yaw).toBe(0)
  })

  it('rejects fractional axes, which is how a float sneaks in', () => {
    expect(sanitizeUserCmd({ forwardMove: 0.5, yaw: 1.5 })).toMatchObject({
      forwardMove: 0,
      yaw: 0,
    })
  })

  it('clamps an out-of-range axis instead of trusting it', () => {
    expect(sanitizeUserCmd({ forwardMove: 1000, sideMove: -1000 })).toMatchObject({
      forwardMove: 1,
      sideMove: -1,
    })
  })

  it('survives junk', () => {
    for (const junk of [null, undefined, 'hello', 42, [], { t: 'nope' }]) {
      const clean = sanitizeUserCmd(junk)
      expect(clean).toEqual({
        forwardMove: 0,
        sideMove: 0,
        yaw: 0,
        pitch: 0,
        buttons: 0,
        weapon: Weapon.RocketLauncher,
      })
    }
  })
})
