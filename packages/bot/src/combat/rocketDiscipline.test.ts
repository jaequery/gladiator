/**
 * A rocket waits for a shot worth taking. GLAD-KN4QRJ.
 *
 * The same three levels `railDiscipline.test.ts` uses, for the same reason — the
 * claim is only worth as much as its weakest one:
 *
 * 1. **The predicate**, over its threshold and over both shot modes.
 * 2. **The trigger**, driven directly with a plan that promises nothing, so that
 *    "held because the shot was not worth it" is a state a test can observe
 *    rather than a behaviour it has to infer.
 * 3. **The band table**, `tools/bot-bands.test.ts`, where the rocket rows and the
 *    time-to-kill row are measured from five hundred real matches.
 *
 * Everything here is asserted against {@link ROCKET_DAMAGE_FLOOR} rather than
 * against a literal, so a sweep that rewrites `tuning.json` moves the test with
 * the bot instead of breaking it.
 */

import { MatchPhase, Weapon } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { createWorldModel } from '../perception/worldModel.ts'
import type { WorldModel } from '../perception/worldModel.ts'
import { createCombat, triggerCombat } from './fire.ts'
import type { CombatState } from './fire.ts'
import { createPlan } from './rocketAim.ts'
import type { ShotPlan } from './rocketAim.ts'
import { ROCKET_DAMAGE_FLOOR, rocketWorthFiring } from './rocketDiscipline.ts'

/** A plan in `mode` promising `expected` points. */
function planWith(mode: ShotPlan['mode'], expected: number): ShotPlan {
  const plan = createPlan()
  plan.mode = mode
  if (mode === 'splash') plan.splashExpected = expected
  if (mode === 'direct') plan.directExpected = expected
  return plan
}

describe('the worth predicate', () => {
  it('takes a shot that promises the floor and refuses one a point under it', () => {
    expect(rocketWorthFiring(planWith('direct', ROCKET_DAMAGE_FLOOR))).toBe(true)
    expect(rocketWorthFiring(planWith('direct', ROCKET_DAMAGE_FLOOR - 1))).toBe(false)
  })

  it('reads the expectation belonging to the mode the plan settled on', () => {
    // The two candidates were already compared in `planRocket`; asking the loser
    // as well would refuse a shot on the strength of the option it declined.
    const splash = planWith('splash', ROCKET_DAMAGE_FLOOR)
    splash.directExpected = 0
    expect(rocketWorthFiring(splash)).toBe(true)

    const direct = planWith('direct', 0)
    direct.splashExpected = ROCKET_DAMAGE_FLOOR + 50
    expect(rocketWorthFiring(direct)).toBe(false)
  })

  it('never fires a plan with no shot in it', () => {
    expect(rocketWorthFiring(planWith('none', ROCKET_DAMAGE_FLOOR + 100))).toBe(false)
  })

  it('is a floor a bot at another skill carries for itself', () => {
    const plan = planWith('direct', ROCKET_DAMAGE_FLOOR)
    expect(rocketWorthFiring(plan, { rocketDamageFloor: ROCKET_DAMAGE_FLOOR * 2 } as never)).toBe(
      false,
    )
  })
})

describe('the floor is a number that means something', () => {
  it('is inside the range the expectation can take', () => {
    // Both `expectedSplash` and `expectedDirect` are bounded by the rocket's 100
    // points. A floor at or above that would refuse every rocket ever planned,
    // and a floor at zero would be the gate switched off — which is a thing a
    // sweep may legitimately arrive at, so only the top is asserted.
    expect(ROCKET_DAMAGE_FLOOR).toBeGreaterThanOrEqual(0)
    expect(ROCKET_DAMAGE_FLOOR).toBeLessThan(100)
  })
})

/* --------------------------------------------------------------------------
 * The trigger
 * ----------------------------------------------------------------------- */

/** A model in which every gate but the plan is open. */
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
  model.enemy.origin[0] = 600
  return model
}

/** A combat state whose aim has arrived and whose plan promises `expected`. */
function armed(expected: number): CombatState {
  const combat = createCombat({ rng: 1 })
  combat.readyTick = 0
  combat.hasPoint = true
  combat.range = 600
  combat.plan.mode = 'direct'
  combat.plan.directExpected = expected
  combat.aim.live = true
  combat.aim.error = 0
  combat.aim.rate = 0
  return combat
}

describe('the trigger', () => {
  it('holds a rocket whose best shot promises less than the floor', () => {
    expect(triggerCombat(armed(ROCKET_DAMAGE_FLOOR - 1), ready(), null, Weapon.RocketLauncher)).toBe(
      false,
    )
  })

  it('takes it the moment the shot is worth the refire it costs', () => {
    expect(triggerCombat(armed(ROCKET_DAMAGE_FLOOR), ready(), null, Weapon.RocketLauncher)).toBe(
      true,
    )
  })

  it('does not apply the damage floor to a rail', () => {
    // A rail is gated on the aim having settled and on nothing else: it is
    // hitscan, so there is no flight time for a target to leave and no splash
    // whose radius an expectation could be integrated over. `planDirect` zeroes
    // both expectations for exactly this reason, and a floor that read them
    // would silence the railgun completely.
    expect(triggerCombat(armed(0), ready(), null, Weapon.Railgun)).toBe(true)
  })

  it('holds the shot without dropping the aim, so the bot keeps tracking', () => {
    // The gate lives at the trigger rather than in `planRocket`, because a plan
    // of `none` also sends `aimCombat` to `holdAim`. A bot that declines a shot
    // should be looking at the target it declined to shoot.
    const combat = armed(0)
    expect(triggerCombat(combat, ready(), null, Weapon.RocketLauncher)).toBe(false)
    expect(combat.plan.mode).toBe('direct')
    expect(combat.hasPoint).toBe(true)
  })
})
