/**
 * What a rocket is worth, before it is fired. GLAD-HK3ATM.
 *
 * The shot selection in `combat/rocketAim.ts` is an `argmax` over two candidate
 * aim points, and this is the objective function. Both halves of it are closed
 * forms over one number — the **miss radius**, how far from the aim point the
 * explosion is expected to land — so the comparison between "splash it at their
 * feet" and "put it in their chest" is one subtraction rather than a table of
 * cases.
 *
 * ## Why a distribution and not a point estimate
 *
 * Evaluating the damage *at* the aim point says a direct hit is always 100 and
 * a splash at the feet is always 99, so the bot would take the direct shot every
 * time and miss most of them. Evaluating it *over* the miss instead is what
 * makes the linear falloff worth something: a direct hit needs to land inside a
 * 30-unit-wide body and a splash needs to land inside a 120-unit radius, so as
 * the miss radius grows the direct expectation collapses quadratically and the
 * splash expectation decays linearly. That gap is the entire argument for
 * splash-at-the-feet being the primary mode.
 *
 * ## The miss is a uniform disc
 *
 * Not a Gaussian, for two reasons. It is bounded, so `expectedSplash` has an
 * exact closed form with no error function in it and no tail that quietly
 * assigns damage to explosions on the other side of the map. And the bot's own
 * aim error is already drawn from a bounded disc (`aim/error.ts`), so the model
 * and the thing it models are the same shape.
 *
 * Nothing in here reads the world. It is arithmetic over a radius, which is what
 * makes it something a test can enumerate rather than something a match has to
 * be played to observe.
 */

import { PLAYER_HALF_WIDTH, PLAYER_HEIGHT, Weapon, weaponDef } from '@gladiator/sim'

/** The rocket launcher's own numbers, read from the table rather than restated. */
const ROCKET = weaponDef(Weapon.RocketLauncher)

/** Damage at the centre of the explosion, in points. `weapons.ts`. */
export const SPLASH_DAMAGE = ROCKET.splashDamage

/** How far the explosion reaches, in Quake units. `weapons.ts`. */
export const SPLASH_RADIUS = ROCKET.splashRadius

/** What a rocket in the chest does, in points. `weapons.ts`. */
export const DIRECT_DAMAGE = ROCKET.damage

/**
 * The silhouette a rocket has to find for a direct hit, in square units.
 *
 * The player box seen side-on: 30 wide by 56 tall (`bbox.ts`). It is an
 * over-estimate for a shot arriving from above or below and exact for the flat
 * shot a duel is mostly made of.
 */
export const TARGET_AREA = PLAYER_HALF_WIDTH * 2 * PLAYER_HEIGHT

/**
 * Splash damage at distance `d` from the target's box, in points.
 *
 * Quake's linear falloff, truncated to an integer exactly as `damage.ts` does
 * it — so the number this predicts is the number the simulation would deal,
 * rather than a half-point above it.
 */
export function splashAt(d: number): number {
  if (d >= SPLASH_RADIUS) return 0
  if (d <= 0) return SPLASH_DAMAGE
  return Math.trunc(SPLASH_DAMAGE * (1 - d / SPLASH_RADIUS))
}

/**
 * Expected splash damage when the explosion is aimed `d0` from the target's box
 * and lands somewhere in a disc of radius `radius` about that.
 *
 * The integral of the linear falloff over a uniform disc, in closed form. With
 * `u = SPLASH_RADIUS - d0` the remaining reach and `D` the centre damage:
 *
 * ```
 * radius <= u :  D * (u - 2 * radius / 3) / SPLASH_RADIUS
 * radius >  u :  D * u^3 / (3 * SPLASH_RADIUS * radius^2)
 * ```
 *
 * Both branches are continuous at `radius === u` and neither ever reaches zero
 * for a finite radius, which matters: a bot whose expectations both collapsed to
 * exactly zero would have no reason to prefer either shot, and would then take
 * whichever the tie-break happened to name.
 */
export function expectedSplash(d0: number, radius: number): number {
  const reach = SPLASH_RADIUS - (d0 > 0 ? d0 : 0)
  if (reach <= 0) return 0
  if (radius <= 0) return splashAt(d0)

  if (radius <= reach) {
    return (SPLASH_DAMAGE * (reach - (2 * radius) / 3)) / SPLASH_RADIUS
  }
  return (SPLASH_DAMAGE * reach * reach * reach) / (3 * SPLASH_RADIUS * radius * radius)
}

/**
 * The chance a shot aimed at a body actually finds it, given a miss uniformly
 * distributed over a disc of `radius`.
 *
 * The share of the disc the silhouette covers, capped at one for a miss radius
 * small enough to be inside the body. Quadratic in the radius, which is why a
 * direct rocket at a target you are guessing about is a coin flip and then
 * rapidly worse than one.
 */
export function directChance(radius: number): number {
  if (radius <= 0) return 1
  const disc = Math.PI * radius * radius
  return disc <= TARGET_AREA ? 1 : TARGET_AREA / disc
}

/** Expected damage from a rocket aimed at the body, in points. */
export function expectedDirect(radius: number): number {
  return DIRECT_DAMAGE * directChance(radius)
}
