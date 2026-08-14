import { BUTTON_JUMP, MAX_PITCH_UNITS, yawUnitsFromDegrees } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { commandFrom } from './controller.ts'

const LEVEL = { yawDegrees: 0, pitchDegrees: 0 }

describe('commandFrom', () => {
  it('maps WASD onto the movement axes', () => {
    expect(commandFrom(new Set(['KeyW']), LEVEL).forwardMove).toBe(1)
    expect(commandFrom(new Set(['KeyS']), LEVEL).forwardMove).toBe(-1)
    expect(commandFrom(new Set(['KeyD']), LEVEL).sideMove).toBe(1)
    expect(commandFrom(new Set(['KeyA']), LEVEL).sideMove).toBe(-1)
  })

  it('maps space onto the jump button', () => {
    expect(commandFrom(new Set(['Space']), LEVEL).buttons).toBe(BUTTON_JUMP)
    expect(commandFrom(new Set(), LEVEL).buttons).toBe(0)
  })

  it('cancels opposing keys instead of letting one win', () => {
    const cmd = commandFrom(new Set(['KeyW', 'KeyS', 'KeyA', 'KeyD']), LEVEL)
    expect(cmd.forwardMove).toBe(0)
    expect(cmd.sideMove).toBe(0)
  })

  it('ignores keys that are not bound', () => {
    expect(commandFrom(new Set(['KeyQ', 'F5']), LEVEL)).toMatchObject({
      forwardMove: 0,
      sideMove: 0,
      buttons: 0,
    })
  })

  it('quantises the view to angle units', () => {
    const cmd = commandFrom(new Set(), { yawDegrees: 90, pitchDegrees: 45 })
    expect(cmd.yaw).toBe(yawUnitsFromDegrees(90))
    expect(Number.isInteger(cmd.pitch)).toBe(true)
  })

  it('clamps a pitch that has run past straight up', () => {
    expect(commandFrom(new Set(), { yawDegrees: 0, pitchDegrees: 500 }).pitch).toBe(MAX_PITCH_UNITS)
    expect(commandFrom(new Set(), { yawDegrees: 0, pitchDegrees: -500 }).pitch).toBe(
      -MAX_PITCH_UNITS,
    )
  })

  it('wraps a yaw that has spun past a full turn', () => {
    const cmd = commandFrom(new Set(), { yawDegrees: 725, pitchDegrees: 0 })
    expect(cmd.yaw).toBeGreaterThanOrEqual(0)
    expect(cmd.yaw).toBeLessThan(65536)
  })
})
