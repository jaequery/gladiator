/**
 * The two-sided self-damage guard. GLAD-HK3ATM's third acceptance check, at the
 * level of the arithmetic.
 *
 * The check has two halves and the second one is the interesting one:
 *
 * - the bot **never** fires a rocket it predicts would cost it more than the
 *   allowance, **except** when it is deliberately rocket-jumping;
 * - a healthy bot **does** accept a real price to land a splash, because one
 *   that refused every rocket which could touch it plays visibly timid.
 *
 * A bot in a real duel, shooting real rockets, is `maps/arena1.combat.test.ts`,
 * which recomputes the same prediction from the command that was actually sent
 * and requires it to be inside the allowance every time. This file is the
 * function underneath it.
 */

import { SPAWN_HEALTH, boxBrush, createCollisionWorld, vec3 } from '@gladiator/sim'
import type { CollisionWorld, Vec3 } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { SPLASH_DAMAGE, SPLASH_RADIUS } from './damage.ts'
import { IMPACT_PROBE } from './rocketAim.ts'
import {
  SELF_SPLASH_ALLOWANCE,
  SELF_SPLASH_RESERVE,
  acceptableSelfSplash,
  predictSelfSplash,
  selfDamageAllows,
} from './selfDamage.ts'

/** A wall `distance` units down `+x`, and nothing else to hit. */
function wallAt(distance: number): CollisionWorld {
  return createCollisionWorld([
    boxBrush([distance, -600, -600], [distance + 64, 600, 600]),
  ])
}

/** The bot at the origin, looking down `+x`. */
const ORIGIN: Vec3 = [0, 0, 0]
const MUZZLE: Vec3 = [14, 0, 50]
const FORWARD: Vec3 = [1, 0, 0]

describe('the allowance', () => {
  it('lets a healthy bot pay a real price for a splash', () => {
    // The constraint the ticket states in as many words: a bot that refuses all
    // self-damage plays visibly timid at close range, so twenty points has to be
    // inside what a bot at full health will accept.
    expect(acceptableSelfSplash(SPAWN_HEALTH)).toBeGreaterThanOrEqual(20)
    expect(acceptableSelfSplash(SPAWN_HEALTH)).toBe(SELF_SPLASH_ALLOWANCE)
  })

  it('shrinks with health and reaches zero before the bot can kill itself', () => {
    expect(acceptableSelfSplash(20)).toBeLessThan(SELF_SPLASH_ALLOWANCE)
    expect(acceptableSelfSplash(SELF_SPLASH_RESERVE)).toBe(0)
    expect(acceptableSelfSplash(1)).toBe(0)
    expect(acceptableSelfSplash(0)).toBe(0)
  })

  it('never allows a splash that could kill under the harshest self-damage mode', () => {
    // `SelfDamage.Full` with no armour left takes half the splash off health
    // (`match/selfDamage.ts`). Whatever the allowance says, half of it has to
    // leave the reserve standing.
    for (let health = 0; health <= SPAWN_HEALTH; health += 1) {
      const splash = acceptableSelfSplash(health)
      expect(health - splash / 2, `at ${health} health`).toBeGreaterThanOrEqual(
        splash === 0 ? 0 : SELF_SPLASH_RESERVE,
      )
    }
  })
})

describe('the guard', () => {
  it('refuses a rocket that would deal more than the allowance', () => {
    expect(selfDamageAllows(SELF_SPLASH_ALLOWANCE, SPAWN_HEALTH, false)).toBe(true)
    expect(selfDamageAllows(SELF_SPLASH_ALLOWANCE + 1, SPAWN_HEALTH, false)).toBe(false)
    expect(selfDamageAllows(SPLASH_DAMAGE, SPAWN_HEALTH, false)).toBe(false)
  })

  it('exempts a deliberate rocket jump, which is the whole point of one', () => {
    // A rocket jump is a rocket the bot *wants* to be thrown by. Refusing it
    // because it costs health would make the manoeuvre impossible rather than
    // expensive. Nothing asks for one in v1 — see `combat/selfDamage.ts`.
    expect(selfDamageAllows(SPLASH_DAMAGE, SPAWN_HEALTH, true)).toBe(true)
    expect(selfDamageAllows(SPLASH_DAMAGE, 1, true)).toBe(true)
  })
})

describe('predicting where the rocket bursts', () => {
  it('is nearly the full splash into a wall at the muzzle', () => {
    // The wall is a few units past the side of the player box rather than
    // inside it, so this is 95 rather than 100 — `damage.ts` measures splash to
    // the nearest point on the box, which is what makes a rocket at your own
    // feet a fixed 500 qu/s launch.
    const splash = predictSelfSplash(wallAt(20), ORIGIN, MUZZLE, FORWARD, null)
    expect(splash).toBeGreaterThan(SPLASH_DAMAGE * 0.9)
    expect(selfDamageAllows(splash, SPAWN_HEALTH, false)).toBe(false)
  })

  it('falls off linearly with the distance to the wall', () => {
    const near = predictSelfSplash(wallAt(60), ORIGIN, MUZZLE, FORWARD, null)
    const far = predictSelfSplash(wallAt(110), ORIGIN, MUZZLE, FORWARD, null)
    expect(near).toBeGreaterThan(far)
    expect(far).toBeGreaterThan(0)
  })

  it('is nothing at all past a splash radius', () => {
    expect(predictSelfSplash(wallAt(SPLASH_RADIUS + 40), ORIGIN, MUZZLE, FORWARD, null)).toBe(0)
  })

  it('is nothing when the rocket will not burst inside the probe at all', () => {
    // No geometry and no believed body: the rocket flies past the horizon this
    // guard cares about, which is two splash radii.
    expect(predictSelfSplash(createCollisionWorld([]), ORIGIN, MUZZLE, FORWARD, null)).toBe(0)
    expect(IMPACT_PROBE).toBe(SPLASH_RADIUS * 2)
  })

  it('counts a body the bot believes in, because a rocket detonates on one', () => {
    // Nothing in the world to hit, but somebody standing 40 units away. A rocket
    // that bursts on their chest is a rocket that bursts on yours.
    const world = createCollisionWorld([])
    const enemy = vec3(40, 0, 0)
    expect(predictSelfSplash(world, ORIGIN, MUZZLE, FORWARD, enemy)).toBeGreaterThan(0)
    expect(predictSelfSplash(world, ORIGIN, MUZZLE, FORWARD, null)).toBe(0)
  })
})
