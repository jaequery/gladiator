import { describe, expect, it } from 'vitest'

import {
  ANGLE_UNITS,
  ANGLE_UNITS_PER_DEGREE,
  BUTTON_ATTACK,
  BUTTON_JUMP,
  BUTTON_MASK,
  MAX_MOVE,
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

  it('clamps movement past +/-127, which is the byte range Quake sends', () => {
    // A `UserCmd` axis here is a *direction* and not a speed, so 127 is not a
    // number this game has a meaning for — it is an old client, or a client
    // hoping the field is a multiplier.
    expect(sanitizeUserCmd({ forwardMove: 127, sideMove: -127 })).toMatchObject({
      forwardMove: MAX_MOVE,
      sideMove: -MAX_MOVE,
    })
  })

  it('wraps a yaw past 180 degrees rather than clamping it', () => {
    // 400 degrees is 40, and that is the whole difference between this field and
    // the one below it: a yaw has no illegal value, only an unwrapped one.
    // Clamping would turn an overflowed spin counter into a view that teleports
    // to due north, which is a thing the other player would watch happen.
    expect(sanitizeUserCmd({ yaw: Math.round(400 * ANGLE_UNITS_PER_DEGREE) }).yaw).toBe(
      Math.round(40 * ANGLE_UNITS_PER_DEGREE),
    )
    expect(sanitizeUserCmd({ yaw: -Math.round(90 * ANGLE_UNITS_PER_DEGREE) }).yaw).toBe(
      yawUnitsFromDegrees(-90),
    )
    for (const hostile of [ANGLE_UNITS, ANGLE_UNITS * 1000, -ANGLE_UNITS * 1000, 2147483647]) {
      const yaw = sanitizeUserCmd({ yaw: hostile }).yaw
      expect(yaw, String(hostile)).toBeGreaterThanOrEqual(0)
      expect(yaw, String(hostile)).toBeLessThan(ANGLE_UNITS)
    }
  })

  it('clamps a pitch past +/-89 degrees, in both directions', () => {
    const beyond = Math.round(180 * ANGLE_UNITS_PER_DEGREE)
    expect(sanitizeUserCmd({ pitch: beyond }).pitch).toBe(MAX_PITCH_UNITS)
    expect(sanitizeUserCmd({ pitch: -beyond }).pitch).toBe(-MAX_PITCH_UNITS)
  })

  it('masks a button bit nobody has defined', () => {
    // An undefined bit is a number the state hash carries and two peers can
    // quietly disagree about, and a bit that is *later* defined would arrive
    // already set from clients that had been sending noise.
    expect(sanitizeUserCmd({ buttons: 0xffff }).buttons).toBe(BUTTON_MASK)
    expect(sanitizeUserCmd({ buttons: BUTTON_JUMP | 0x40 }).buttons).toBe(BUTTON_JUMP)
    expect(sanitizeUserCmd({ buttons: BUTTON_JUMP | BUTTON_ATTACK }).buttons).toBe(BUTTON_MASK)
  })

  it('does not turn a negative button field into every button at once', () => {
    // Two's complement makes `-1 & BUTTON_MASK` a held trigger, which is a
    // rocket the player never asked for. Zeroed before the mask, not after.
    expect(sanitizeUserCmd({ buttons: -1 }).buttons).toBe(0)
    expect(sanitizeUserCmd({ buttons: -0xffff }).buttons).toBe(0)
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
