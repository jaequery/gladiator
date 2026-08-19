import {
  BUTTON_ATTACK,
  BUTTON_JUMP,
  MAX_PITCH_UNITS,
  Weapon,
  pitchUnitsFromDegrees,
  yawUnitsFromDegrees,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_SETTINGS,
  countsPer360,
  degreesPerCount,
  normalizeSettings,
} from '../ui/settings.ts'
import { DEFAULT_DEGREES_PER_COUNT, applyMouseDelta, commandFrom } from './controller.ts'

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

  it('maps the left mouse button onto attack, and 1 and 2 onto the weapons', () => {
    expect(commandFrom(new Set(['Mouse0']), LEVEL).buttons).toBe(BUTTON_ATTACK)
    expect(commandFrom(new Set(['Mouse0', 'Space']), LEVEL).buttons).toBe(
      BUTTON_ATTACK | BUTTON_JUMP,
    )
    expect(commandFrom(new Set(), LEVEL).weapon).toBe(Weapon.RocketLauncher)
    expect(commandFrom(new Set(), LEVEL, Weapon.Railgun).weapon).toBe(Weapon.Railgun)
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
    expect(cmd.pitch).toBe(pitchUnitsFromDegrees(-45))
  })

  it('clamps a pitch that has run past straight up', () => {
    expect(commandFrom(new Set(), { yawDegrees: 0, pitchDegrees: 500 }).pitch).toBe(
      -MAX_PITCH_UNITS,
    )
    expect(commandFrom(new Set(), { yawDegrees: 0, pitchDegrees: -500 }).pitch).toBe(
      MAX_PITCH_UNITS,
    )
  })

  it('wraps a yaw that has spun past a full turn', () => {
    const cmd = commandFrom(new Set(), { yawDegrees: 725, pitchDegrees: 0 })
    expect(cmd.yaw).toBeGreaterThanOrEqual(0)
    expect(cmd.yaw).toBeLessThan(65536)
  })
})

/**
 * The acceptance check for cm/360, measured rather than asserted.
 *
 * A player sets a distance and expects their hand to travel exactly that far in
 * one full turn. Nothing about that claim is obvious from the arithmetic — the
 * angle is accumulated in floating-point degrees, wrapped every event, and
 * quantised to 16-bit units at the door — so this drives the counts a turn is
 * supposed to take through the same function a mouse drives, one event at a
 * time, and measures where the view ended up.
 *
 * Two percent, because that is the tolerance the ticket names and because it is
 * roughly the smallest error a player can feel: 2% of 360 degrees is seven
 * degrees of overshoot on a full spin, which is a rail shot missed by a body
 * width at the far end of the arena.
 */
describe('cm/360 turns the view exactly once', () => {
  const TOLERANCE = 0.02

  /** Spin from due north through `counts` mouse counts, in `events` events. */
  function turn(counts: number, degreesPerCount: number, events: number): number {
    const angles = { yawDegrees: 0, pitchDegrees: 0 }
    const perEvent = counts / events
    let unwrapped = 0
    let previous = 0
    for (let i = 0; i < events; i += 1) {
      applyMouseDelta(angles, -perEvent, 0, degreesPerCount)
      // The controller wraps yaw into [0, 360) every event, so the total turn
      // has to be recovered by summing the wrapped steps rather than by reading
      // the final angle — which is exactly what a player's hand is doing.
      let step = angles.yawDegrees - previous
      if (step < -180) step += 360
      if (step > 180) step -= 360
      unwrapped += step
      previous = angles.yawDegrees
    }
    return unwrapped
  }

  for (const [cm360, dpi] of [
    [30, 800],
    [20, 400],
    [45, 1600],
    [12.7, 3200],
  ] as const) {
    it(`turns 360 degrees over ${cm360} cm at ${dpi} CPI`, () => {
      const settings = normalizeSettings({ cm360, dpi })
      const counts = countsPer360(settings)
      // Counts, not events: a mouse polling at 1000 Hz delivers a fast flick in
      // a handful of events and a slow drag in hundreds, and the same physical
      // distance has to produce the same angle either way. This is the whole
      // reason raw input matters, and the reason a player can carry a number
      // over from another game.
      //
      // Four is the fewest the measurement can resolve rather than the fewest a
      // mouse produces: each event has to turn less than half a circle for the
      // wrapped steps to be summable at all, which is a property of the ruler
      // and not of the thing being measured.
      for (const events of [4, 8, 250]) {
        const turned = turn(counts, degreesPerCount(settings), events)
        expect(Math.abs(turned - 360) / 360).toBeLessThan(TOLERANCE)
      }
    })
  }

  it('is exact enough that it is the quantiser, not the setting, that loses anything', () => {
    const settings = normalizeSettings({ cm360: 30, dpi: 800 })
    // A tenth of a degree over a full turn — far inside the 2% the check asks
    // for, and inside one 16-bit angle unit (0.0055 degrees) per event.
    expect(Math.abs(turn(countsPer360(settings), degreesPerCount(settings), 100) - 360)).toBeLessThan(
      0.1,
    )
  })

  it('agrees with the controller’s own default, so the two cannot drift', () => {
    expect(DEFAULT_DEGREES_PER_COUNT).toBeCloseTo(degreesPerCount(DEFAULT_SETTINGS), 4)
  })
})
