/**
 * The nine things a bot can ask for, and the inverse that makes the ledge guard
 * possible.
 */

import { angleVectors, vec3, yawUnitsFromDegrees } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { MOVE_DEADZONE, axisDirection, createAxes, rotate45, steerAxes } from './steer.ts'

const axes = createAxes()

/** The world direction `steerAxes` resolves a bearing on to, in degrees. */
function resolvedDegrees(yawDegrees: number, bearingDegrees: number): number {
  const yaw = yawUnitsFromDegrees(yawDegrees)
  const radians = (bearingDegrees * Math.PI) / 180
  steerAxes(yaw, Math.cos(radians), Math.sin(radians), axes)
  const out = axisDirection(yaw, axes.forwardMove, axes.sideMove, vec3())
  return (Math.atan2(out[1], out[0]) * 180) / Math.PI
}

/** The shortest way round between two bearings in degrees, always non-negative. */
function between(a: number, b: number): number {
  let delta = (a - b) % 360
  if (delta > 180) delta -= 360
  if (delta <= -180) delta += 360
  return Math.abs(delta)
}

describe('resolving a direction on to two axes', () => {
  it('never asks for nothing when it was asked for something', () => {
    // The largest of a unit vector's two projections is at least cos(45deg), which
    // is over the deadzone — so "stand still" is unreachable by accident and is only
    // ever the answer to a zero-length direction.
    for (let yaw = 0; yaw < 360; yaw += 13) {
      for (let bearing = 0; bearing < 360; bearing += 7) {
        const radians = (bearing * Math.PI) / 180
        steerAxes(yawUnitsFromDegrees(yaw), Math.cos(radians), Math.sin(radians), axes)
        expect(axes.forwardMove === 0 && axes.sideMove === 0).toBe(false)
      }
    }
  })

  it('stands still for a zero-length direction, which is the only way to', () => {
    steerAxes(0, 0, 0, axes)
    expect(axes).toEqual({ forwardMove: 0, sideMove: 0 })
  })

  it('is never more than 24.5 degrees off what it was asked for', () => {
    let worst = 0
    for (let yaw = 0; yaw < 360; yaw += 11) {
      for (let bearing = 0; bearing < 360; bearing += 3) {
        worst = Math.max(worst, between(resolvedDegrees(yaw, bearing), bearing))
      }
    }
    // 24.51 degrees exactly: the second axis engages at `asin(MOVE_DEADZONE)` =
    // 20.49 degrees off a cardinal, so a bearing just past that resolves to the
    // diagonal 45 degrees away. The number is in `steer.ts`'s header as the cost of
    // quantisation, so it is asserted rather than described.
    expect(worst).toBeLessThanOrEqual(24.52)
    expect(worst).toBeGreaterThan(24)
  })

  it('asks for forward when the direction is where the view is', () => {
    for (const yaw of [0, 37, 90, 180, 271]) {
      const radians = (yaw * Math.PI) / 180
      steerAxes(yawUnitsFromDegrees(yaw), Math.cos(radians), Math.sin(radians), axes)
      expect(axes).toEqual({ forwardMove: 1, sideMove: 0 })
    }
  })

  it('asks for back when the direction is behind the view', () => {
    steerAxes(yawUnitsFromDegrees(90), 0, -1, axes)
    expect(axes).toEqual({ forwardMove: -1, sideMove: 0 })
  })

  it('asks for right when the direction is 90 degrees clockwise of the view', () => {
    // `+y` is *left* in the Quake frame, so the right-hand strafe from a view down
    // `+x` is towards `-y`. Getting this backwards is a bot that strafes the wrong
    // way, which looks like a movement bug and is a coordinate bug.
    steerAxes(yawUnitsFromDegrees(0), 0, -1, axes)
    expect(axes).toEqual({ forwardMove: 0, sideMove: 1 })
  })

  it('resolves a diagonal on to both axes rather than picking one', () => {
    steerAxes(yawUnitsFromDegrees(0), Math.SQRT1_2, -Math.SQRT1_2, axes)
    expect(axes).toEqual({ forwardMove: 1, sideMove: 1 })
  })

  it('engages the second axis exactly at asin(deadzone) off the cardinal', () => {
    const threshold = Math.asin(MOVE_DEADZONE)
    for (const [angle, sideMove] of [
      [threshold + 0.001, 1],
      [threshold - 0.001, 0],
    ] as const) {
      steerAxes(0, Math.cos(angle), -Math.sin(angle), axes)
      expect(axes.forwardMove).toBe(1)
      expect(axes.sideMove).toBe(sideMove)
    }
  })
})

describe('the inverse', () => {
  it('is the same vector `pmove` builds out of the same two numbers', () => {
    // Not "close to": the ledge guard probes the ray the body will travel along, and
    // a guard that probed a slightly different ray would be a guard that is right
    // most of the time.
    const forward = vec3()
    const right = vec3()
    for (const yawDegrees of [0, 45, 137, 300]) {
      const yaw = yawUnitsFromDegrees(yawDegrees)
      angleVectors(0, yaw, 0, forward, right, null)
      for (const [f, s] of [
        [1, 0],
        [0, 1],
        [-1, 0],
        [0, -1],
        [1, 1],
        [-1, 1],
      ] as const) {
        const x = forward[0] * f + right[0] * s
        const y = forward[1] * f + right[1] * s
        const length = Math.sqrt(x * x + y * y)
        const out = axisDirection(yaw, f, s, vec3())
        expect(out[0]).toBeCloseTo(x / length, 12)
        expect(out[1]).toBeCloseTo(y / length, 12)
        expect(out[2]).toBe(0)
      }
    }
  })

  it('is zero for the stick position that asks for nothing', () => {
    expect(Array.from(axisDirection(0, 0, 0, vec3()))).toEqual([0, 0, 0])
  })
})

describe('the 45-degree rotation', () => {
  it('turns towards +y for a positive side, which is the bot’s left', () => {
    const out = rotate45(1, 0, 1, vec3())
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(out[1]).toBeCloseTo(Math.SQRT1_2, 12)
  })

  it('turns towards -y for a negative side', () => {
    const out = rotate45(1, 0, -1, vec3())
    expect(out[0]).toBeCloseTo(Math.SQRT1_2, 12)
    expect(out[1]).toBeCloseTo(-Math.SQRT1_2, 12)
  })

  it('preserves length, so a unit wish stays a unit wish', () => {
    const out = rotate45(3, -4, 1, vec3())
    expect(Math.sqrt(out[0] * out[0] + out[1] * out[1])).toBeCloseTo(5, 12)
  })

  it('is its own inverse the other way round', () => {
    const once = rotate45(0.6, 0.8, 1, vec3())
    const back = rotate45(once[0], once[1], -1, vec3())
    expect(back[0]).toBeCloseTo(0.6, 12)
    expect(back[1]).toBeCloseTo(0.8, 12)
  })
})
