/**
 * Which of the two, over the three rules that decide it.
 *
 * Each rule gets a scenario that only it can answer, plus the default, which is
 * most of a duel and is the one worth being sure about.
 */

import { Weapon, boxBrush, createCollisionWorld } from '@gladiator/sim'
import type { CollisionWorld } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { createWorldModel } from '../perception/worldModel.ts'
import type { WorldModel } from '../perception/worldModel.ts'
import { AIRBORNE_DROP, RAIL_MIN_RANGE, airborneAt, selectWeapon } from './weaponSelect.ts'

/** A floor and nothing else. */
function floorWorld(): CollisionWorld {
  return createCollisionWorld([boxBrush([-4000, -4000, -64], [4000, 4000, 0])])
}

/** The bot at the origin, and the opponent wherever the scenario puts them. */
function seeing(x: number, z = 0): WorldModel {
  const model = createWorldModel(0)
  model.tick = 100
  model.self.alive = true
  model.enemy.source = 'sight'
  model.enemy.visible = true
  model.enemy.confidence = 1
  model.enemy.origin[0] = x
  model.enemy.origin[2] = z
  return model
}

describe('weapon selection', () => {
  it('rockets a target it can see at duelling range', () => {
    expect(selectWeapon(seeing(RAIL_MIN_RANGE - 200), floorWorld())).toBe(Weapon.RocketLauncher)
  })

  it('rails one across the arena, where a rocket would take a second to arrive', () => {
    expect(selectWeapon(seeing(RAIL_MIN_RANGE + 200), floorWorld())).toBe(Weapon.Railgun)
  })

  it('rails an airborne one at any range, because they cannot dodge', () => {
    // Air acceleration is a tenth of the ground figure (`pmove/accelerate.ts`),
    // so somebody in the air is on a parabola rather than making decisions.
    expect(selectWeapon(seeing(400, 300), floorWorld())).toBe(Weapon.Railgun)
  })

  it('rockets a target it cannot see, whatever the range', () => {
    // A railgun is a line drawn instantly to a point, and pointing one at a
    // remembered position is firing at a guess with the weapon least able to
    // survive being wrong.
    const remembered = seeing(RAIL_MIN_RANGE + 800)
    remembered.enemy.visible = false
    expect(selectWeapon(remembered, floorWorld())).toBe(Weapon.RocketLauncher)
  })

  it('rockets when there is no contact at all', () => {
    expect(selectWeapon(createWorldModel(0), floorWorld())).toBe(Weapon.RocketLauncher)
  })

  it('answers the range question when it has no geometry to answer the other one', () => {
    // A bot handed no level data cannot tell whether somebody is standing on
    // anything. `bot.ts` explains when that happens.
    expect(selectWeapon(seeing(400, 300), null)).toBe(Weapon.RocketLauncher)
    expect(selectWeapon(seeing(RAIL_MIN_RANGE + 200), null)).toBe(Weapon.Railgun)
  })
})

describe('the airborne probe', () => {
  it('is a step, not a guess', () => {
    const world = floorWorld()
    expect(airborneAt(world, [0, 0, 0])).toBe(false)
    expect(airborneAt(world, [0, 0, AIRBORNE_DROP - 2])).toBe(false)
    expect(airborneAt(world, [0, 0, AIRBORNE_DROP + 8])).toBe(true)
  })

  it('is a point trace, so a narrow slot does not read as floor', () => {
    // The reason `movement/ledge.ts` gives: the 30-unit player box bridges a gap
    // it is merely straddling.
    const slot = createCollisionWorld([
      boxBrush([-400, -400, -64], [-8, 400, 0]),
      boxBrush([8, -400, -64], [400, 400, 0]),
    ])
    expect(airborneAt(slot, [0, 0, 0])).toBe(true)
    expect(airborneAt(slot, [200, 0, 0])).toBe(false)
  })
})
