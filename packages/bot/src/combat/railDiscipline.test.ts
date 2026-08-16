/**
 * The rail waits for the aim. GLAD-HK3ATM's fourth acceptance check.
 *
 * Three levels, because the claim is only worth as much as the weakest one:
 *
 * 1. **The predicate**, over its two thresholds.
 * 2. **The trigger**, driven directly with an aim that has not arrived, so that
 *    "held because it had not settled" is a state a test can observe rather than
 *    a behaviour it has to infer.
 * 3. **A duel**, in `maps/arena1.combat.test.ts`, where every rail either bot
 *    fired over four minutes is re-checked against the same thresholds from the
 *    command that was sent.
 */

import { MatchPhase, Weapon } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { createAim } from '../aim/controller.ts'
import { createWorldModel } from '../perception/worldModel.ts'
import type { WorldModel } from '../perception/worldModel.ts'
import { createCombat, triggerCombat } from './fire.ts'
import type { CombatState } from './fire.ts'
import { RAIL_SETTLE_RATE, RAIL_SETTLE_UNITS, railSettled } from './railDiscipline.ts'
import { ROCKET_DAMAGE_FLOOR } from './rocketDiscipline.ts'

/** An aim with the given error and rate, and nothing else that matters. */
function aimWith(error: number, rate: number) {
  const aim = createAim()
  aim.live = true
  aim.error = error
  aim.rate = rate
  return aim
}

describe('the settle predicate', () => {
  it('needs the crosshair on them', () => {
    expect(railSettled(aimWith(0, 0))).toBe(true)
    expect(railSettled(aimWith(RAIL_SETTLE_UNITS, 0))).toBe(true)
    expect(railSettled(aimWith(RAIL_SETTLE_UNITS + 1, 0))).toBe(false)
  })

  it('needs it to have stopped moving as well', () => {
    // The half that does the interesting work: a crosshair sweeping across a
    // target is on it for one sub-step, and firing then is a coin toss dressed
    // up as a decision.
    expect(railSettled(aimWith(0, RAIL_SETTLE_RATE))).toBe(true)
    expect(railSettled(aimWith(0, RAIL_SETTLE_RATE + 1))).toBe(false)
  })
})

/* --------------------------------------------------------------------------
 * The trigger
 * ----------------------------------------------------------------------- */

/** A model in which every gate but the aim is open. */
function ready(): WorldModel {
  const model = createWorldModel(0)
  model.tick = 500
  model.match.phase = MatchPhase.Live
  model.self.alive = true
  model.self.health = 100
  model.self.nextFireTick = 0
  model.enemy.source = 'sight'
  model.enemy.visible = true
  model.enemy.confidence = 1
  model.enemy.origin[0] = 1200
  return model
}

/** A combat state whose reaction has expired and whose plan is a live shot. */
function armed(error: number, rate: number): CombatState {
  const combat = createCombat({ rng: 1 })
  combat.readyTick = 0
  combat.hasPoint = true
  combat.range = 1200
  combat.plan.mode = 'direct'
  // A shot that clears the rocket damage floor, so that the only thing these
  // cases are testing is the aim (`combat/rocketDiscipline.ts` has its own).
  combat.plan.directExpected = ROCKET_DAMAGE_FLOOR
  combat.aim.live = true
  combat.aim.error = error
  combat.aim.rate = rate
  return combat
}

describe('the trigger', () => {
  it('holds a rail whose aim has not arrived, and says that is why', () => {
    const combat = armed(RAIL_SETTLE_UNITS + 400, RAIL_SETTLE_RATE + 300)
    expect(triggerCombat(combat, ready(), null, Weapon.Railgun)).toBe(false)
    expect(combat.settling).toBe(true)
  })

  it('holds it for a crosshair that is on them but still sweeping', () => {
    const combat = armed(0, RAIL_SETTLE_RATE + 1)
    expect(triggerCombat(combat, ready(), null, Weapon.Railgun)).toBe(false)
    expect(combat.settling).toBe(true)
  })

  it('takes it the moment both halves are inside the threshold', () => {
    const combat = armed(RAIL_SETTLE_UNITS, RAIL_SETTLE_RATE)
    expect(triggerCombat(combat, ready(), null, Weapon.Railgun)).toBe(true)
    expect(combat.settling).toBe(false)
  })

  it('does not apply the settle threshold to a rocket', () => {
    // A rocket fired mid-slew still goes where the crosshair points, and 120
    // units of splash is a great deal more forgiveness than a rail's zero. The
    // rocket has its own, looser tolerance (`combat/fire.ts`), and at 1200 units
    // this error is well inside it.
    const combat = armed(RAIL_SETTLE_UNITS + 1, RAIL_SETTLE_RATE + 1)
    expect(triggerCombat(combat, ready(), null, Weapon.RocketLauncher)).toBe(true)
  })

  it('still refuses before the reaction has expired, whatever the aim is doing', () => {
    const combat = armed(0, 0)
    combat.readyTick = 600
    expect(triggerCombat(combat, ready(), null, Weapon.Railgun)).toBe(false)
  })

  it('still refuses while the refire timer is running', () => {
    const combat = armed(0, 0)
    const model = ready()
    model.self.nextFireTick = model.tick + 1
    expect(triggerCombat(combat, model, null, Weapon.Railgun)).toBe(false)
  })

  it('never fires at a contact it cannot see', () => {
    // Firing at a remembered position is a thing people do and a thing a bot
    // cannot be seen to do: from the other end it is indistinguishable from a
    // bot that never lost you.
    const combat = armed(0, 0)
    const model = ready()
    model.enemy.visible = false
    expect(triggerCombat(combat, model, null, Weapon.Railgun)).toBe(false)
    expect(triggerCombat(combat, model, null, Weapon.RocketLauncher)).toBe(false)
  })
})
