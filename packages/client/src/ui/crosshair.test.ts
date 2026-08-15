/**
 * The crosshair is geometry, so it is asserted rather than eyeballed.
 *
 * Two things here are worth a test rather than a look. **Symmetry**, because a
 * crosshair whose left arm is a unit longer than its right quietly pulls a
 * player's aim and nobody ever finds out why; and the **direction the cooldown
 * ring runs**, because getting it backwards draws a full ring at the one moment
 * there is nothing to say.
 */
import { Weapon } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  COOLDOWN_RING_RADIUS,
  CROSSHAIR_CENTRE,
  CROSSHAIR_SIZE,
  type CrosshairLine,
  type CrosshairSpec,
  HIT_MARKER_LINES,
  RING_CIRCUMFERENCE,
  crosshairFor,
  ringDashOffset,
} from './crosshair.ts'

const C = CROSSHAIR_CENTRE

/** The gap from the centre and the arm length a line implies. */
function armOf(line: CrosshairLine): { gap: number; length: number } {
  const [x1, y1, x2, y2] = line
  const near = Math.min(Math.hypot(x1 - C, y1 - C), Math.hypot(x2 - C, y2 - C))
  const far = Math.max(Math.hypot(x1 - C, y1 - C), Math.hypot(x2 - C, y2 - C))
  return { gap: near, length: far - near }
}

function assertSymmetric(spec: CrosshairSpec): void {
  expect(spec.lines).toHaveLength(4)
  const arms = spec.lines.map(armOf)
  for (const arm of arms) {
    expect(arm.gap).toBeCloseTo(arms[0]?.gap ?? 0, 9)
    expect(arm.length).toBeCloseTo(arms[0]?.length ?? 0, 9)
  }
  // Two along each axis, so the cross is a cross and not a chevron.
  const horizontal = spec.lines.filter(([, y1, , y2]) => y1 === C && y2 === C)
  const vertical = spec.lines.filter(([x1, , x2]) => x1 === C && x2 === C)
  expect(horizontal).toHaveLength(2)
  expect(vertical).toHaveLength(2)
  // One of each pair on each side of the centre.
  expect(horizontal.filter(([x1]) => x1 < C)).toHaveLength(1)
  expect(vertical.filter(([, y1]) => y1 < C)).toHaveLength(1)
}

describe('the two crosshairs', () => {
  it('is symmetric about the centre, for both weapons', () => {
    assertSymmetric(crosshairFor(Weapon.RocketLauncher))
    assertSymmetric(crosshairFor(Weapon.Railgun))
  })

  it('gives the launcher a placing dot and the rail a clear centre', () => {
    expect(crosshairFor(Weapon.RocketLauncher).dotRadius).toBeGreaterThan(0)
    expect(crosshairFor(Weapon.Railgun).dotRadius).toBe(0)
  })

  it('makes the rail the tighter and finer of the two', () => {
    const rocket = crosshairFor(Weapon.RocketLauncher)
    const rail = crosshairFor(Weapon.Railgun)
    const rocketArm = armOf(rocket.lines[0] ?? [0, 0, 0, 0])
    const railArm = armOf(rail.lines[0] ?? [0, 0, 0, 0])

    expect(railArm.gap).toBeLessThan(rocketArm.gap)
    expect(railArm.length).toBeGreaterThan(rocketArm.length)
    expect(rail.strokeWidth).toBeLessThan(rocket.strokeWidth)
  })

  it('is distinguishable at a glance — the two are not the same shape', () => {
    expect(crosshairFor(Weapon.Railgun).key).not.toBe(
      crosshairFor(Weapon.RocketLauncher).key,
    )
    expect(crosshairFor(Weapon.Railgun).lines).not.toEqual(
      crosshairFor(Weapon.RocketLauncher).lines,
    )
  })

  it('draws a bare dot for a body holding nothing', () => {
    const none = crosshairFor(Weapon.None)
    expect(none.lines).toHaveLength(0)
    expect(none.dotRadius).toBeGreaterThan(0)
  })

  it('returns the same object for the same weapon, so the view can skip a rebuild', () => {
    expect(crosshairFor(Weapon.Railgun)).toBe(crosshairFor(Weapon.Railgun))
  })

  it('keeps everything inside the box, ring included', () => {
    for (const weapon of [Weapon.None, Weapon.RocketLauncher, Weapon.Railgun]) {
      const spec = crosshairFor(weapon)
      for (const [x1, y1, x2, y2] of [...spec.lines, ...HIT_MARKER_LINES]) {
        for (const value of [x1, y1, x2, y2]) {
          expect(value).toBeGreaterThanOrEqual(0)
          expect(value).toBeLessThanOrEqual(CROSSHAIR_SIZE)
        }
      }
    }
    expect(C + COOLDOWN_RING_RADIUS).toBeLessThanOrEqual(CROSSHAIR_SIZE)
  })

  it('keeps the ring clear of the longest arm either weapon has', () => {
    for (const weapon of [Weapon.RocketLauncher, Weapon.Railgun]) {
      for (const line of crosshairFor(weapon).lines) {
        const arm = armOf(line)
        expect(arm.gap + arm.length).toBeLessThan(COOLDOWN_RING_RADIUS)
      }
    }
  })
})

describe('the hit marker', () => {
  it('sits in the quadrants, never on top of the arms it has to be read beside', () => {
    expect(HIT_MARKER_LINES).toHaveLength(4)
    for (const [x1, y1, x2, y2] of HIT_MARKER_LINES) {
      for (const value of [x1, y1, x2, y2]) expect(value).not.toBe(C)
    }
    // One in each quadrant.
    const quadrants = new Set(
      HIT_MARKER_LINES.map(([x1, y1]) => `${x1 < C ? 'l' : 'r'}${y1 < C ? 't' : 'b'}`),
    )
    expect(quadrants.size).toBe(4)
  })
})

describe('the cooldown ring', () => {
  it('draws nothing when there is nothing to wait for', () => {
    expect(ringDashOffset(0)).toBeCloseTo(RING_CIRCUMFERENCE, 9)
  })

  it('closes the ring the instant a shot is fired', () => {
    expect(ringDashOffset(1)).toBeCloseTo(0, 9)
  })

  it('empties monotonically as the wait runs down', () => {
    let previous = -1
    for (let step = 0; step <= 10; step += 1) {
      const offset = ringDashOffset(step / 10)
      if (previous >= 0) expect(offset).toBeLessThan(previous)
      previous = offset
    }
  })

  it('clamps rather than drawing past the end of the circle', () => {
    expect(ringDashOffset(-1)).toBeCloseTo(RING_CIRCUMFERENCE, 9)
    expect(ringDashOffset(4)).toBeCloseTo(0, 9)
  })
})
