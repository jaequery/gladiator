/**
 * The scripted stand-in.
 *
 * Worth testing despite being a development affordance, for one reason: it is
 * the only thing driving the animation machine in a real browser until real
 * snapshots arrive, so a `NaN` in here reads as a broken renderer.
 */
import { EntityFlag, EntityKind, NEVER_FIRED, type Vec3, Weapon } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { DUMMY_ID, dummyMode, dummyOpponent } from './dummyOpponent.ts'
import { AnimState, animSequence, playerNetState } from './render/animState.ts'

const CENTRE: Vec3 = [0, 0, 0]

describe('the scripted opponent', () => {
  it('is off unless the page asks for it', () => {
    expect(dummyMode('')).toBe(false)
    expect(dummyMode('?shot=1')).toBe(false)
    expect(dummyMode('?dummy=1')).toBe(true)
  })

  it('produces a finite, well-formed entity at every tick of its loop', () => {
    for (let tick = 0; tick < 2600; tick += 7) {
      const state = dummyOpponent(tick, CENTRE)
      expect(state.id).toBe(DUMMY_ID)
      expect(state.kind).toBe(EntityKind.Player)
      for (const value of [...state.origin, ...state.velocity, ...state.angles]) {
        expect(Number.isFinite(value)).toBe(true)
      }
      expect(state.weapon === Weapon.RocketLauncher || state.weapon === Weapon.Railgun).toBe(
        true,
      )
      expect(state.lastFireTick === NEVER_FIRED || state.lastFireTick <= tick).toBe(true)
    }
  })

  it('stays on its circle and never falls through the floor', () => {
    for (let tick = 0; tick < 2600; tick += 3) {
      const { origin } = dummyOpponent(tick, CENTRE)
      const radius = Math.sqrt(origin[0] * origin[0] + origin[1] * origin[1])
      expect(radius).toBeCloseTo(224, 6)
      expect(origin[2]).toBeGreaterThanOrEqual(0)
    }
  })

  it('reaches every animation state over one loop, which is why it exists', () => {
    const states = Array.from({ length: 2500 }, (_, tick) =>
      playerNetState(dummyOpponent(tick, CENTRE)),
    )
    const seen = new Set(animSequence(states).map((frame) => frame.state))

    for (const state of Object.values(AnimState)) {
      expect(seen, `never played ${state}`).toContain(state)
    }
  })

  it('lies still once it is dead', () => {
    const dead = dummyOpponent(2400, CENTRE)
    expect(dead.health).toBe(0)
    expect(dead.flags & EntityFlag.Dead).not.toBe(0)
    expect([...dead.velocity]).toEqual([0, 0, 0])
    // Frozen where it fell, rather than orbiting as a corpse.
    expect([...dummyOpponent(2401, CENTRE).origin]).toEqual([...dead.origin])
  })
})
