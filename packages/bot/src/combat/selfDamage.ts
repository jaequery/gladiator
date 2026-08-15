/**
 * What the bot is willing to do to itself. GLAD-HK3ATM.
 *
 * **The guard is two-sided, and that is the whole design.** A bot that refuses
 * every rocket which could splash it plays visibly timid: it backs away from
 * close range, declines the shot at somebody's feet three metres away, and
 * generally behaves like it is frightened of the weapon it is holding. A healthy
 * bot should happily eat twenty points to land a hundred, because that trade
 * wins duels — it is the trade the whole format is built on
 * (`match/selfDamage.ts`).
 *
 * So there is an **allowance** rather than a veto, and it shrinks with health
 * until it is a veto at the bottom.
 *
 * ## The allowance is bounded by the harshest mode, not the configured one
 *
 * The `WorldModel` does not carry which self-damage mode the match is running
 * (`perception/worldModel.ts`), and it deliberately is not going to: adding it
 * would be adding a field for the bot's convenience rather than because a
 * channel would have told a player about it. The bound is therefore taken
 * against `SelfDamage.Full` with no armour left — half the splash off the health
 * — which is the worst any mode can do. Under the default `armor_only` the bot
 * is being conservative by exactly the amount its armour would have absorbed,
 * and that is the direction to be wrong in.
 *
 * ## The prediction is where the rocket will actually burst
 *
 * Not where the bot is pointing. A rocket aimed at somebody's feet across a room
 * is harmless; the same aim with a pillar 40 units in front of the muzzle is 100
 * points of your own splash. So the guard traces the shot
 * (`combat/rocketAim.ts`'s {@link predictImpact}) and measures from where it
 * stops — the world and the one body the bot believes in, whichever comes first.
 *
 * There is deliberately **no occlusion test** on the blast. It would be the
 * unsafe direction to be wrong in, and it is also very nearly always vacuous: the
 * impact point is the first thing along a ray from the bot's own muzzle, so
 * there is nothing between the two by construction.
 */

import { PLAYER_MAXS, PLAYER_MINS, distanceToBox, vec3 } from '@gladiator/sim'
import type { CollisionWorld, MutVec3, Vec3 } from '@gladiator/sim'

import { SHIPPED_SKILL } from '../tuning.ts'
import type { BotSkill } from '../tuning.ts'
import { splashAt } from './damage.ts'
import { predictImpact } from './rocketAim.ts'

/**
 * The splash the bot will accept from its own rocket at full health, in points.
 *
 * Twenty-five. Under `armor_only` that is 17 armour and no health — an eighth of
 * the bar, for a shot that can take a third of the opponent's. Under `full` with
 * no armour it is 12 health. Both are prices worth paying, which is the point:
 * this number is what stops the bot from being the sort of opponent you can
 * safely walk straight at.
 */
export const SELF_SPLASH_ALLOWANCE = SHIPPED_SKILL.selfSplashAllowance

/**
 * How much health the bot refuses to shoot itself below, in points.
 *
 * A floor rather than a fraction, because the failure this prevents is discrete:
 * killing yourself with your own rocket hands the round over. Ten is enough to
 * survive a splash the bot did not see coming on the same sub-step.
 */
export const SELF_SPLASH_RESERVE = 10

/**
 * How many points of its own splash the bot will accept right now.
 *
 * The allowance, capped by what it can survive under the harshest self-damage
 * mode. `armor` is deliberately not a parameter: assuming there is none is the
 * conservative reading and it keeps this a function of the one number that
 * decides whether a shot can kill you.
 */
export function acceptableSelfSplash(health: number, skill: BotSkill = SHIPPED_SKILL): number {
  // Under `SelfDamage.Full` with no armour, splash costs half its points in
  // health, so this is the largest splash that leaves the reserve standing.
  const survivable = (health - SELF_SPLASH_RESERVE) * 2
  if (survivable <= 0) return 0
  return survivable < skill.selfSplashAllowance ? survivable : skill.selfSplashAllowance
}

/* Scratch. Single-threaded and synchronous; see `perception/sight.ts`. */
const impact: MutVec3 = vec3()

/**
 * How much splash a rocket fired from `muzzle` along `dir` would deal the bot
 * standing at `origin`, in points.
 *
 * Zero when the rocket will not burst inside its own splash radius of the bot,
 * which is the overwhelmingly common case and costs one trace to establish.
 */
export function predictSelfSplash(
  world: CollisionWorld,
  origin: Vec3,
  muzzle: Vec3,
  dir: Vec3,
  enemy: Vec3 | null,
): number {
  if (!predictImpact(impact, world, muzzle, dir, enemy)) return 0
  return splashAt(distanceToBox(impact, origin, PLAYER_MINS, PLAYER_MAXS))
}

/**
 * May the bot pull the trigger on a rocket that would deal it `splash` points?
 *
 * `rocketJump` is the exemption, and it is a parameter rather than a flag on a
 * state somewhere so that the two answers are visible at the call site. A
 * deliberate rocket jump is a rocket the bot *wants* to be thrown by, and
 * refusing it because it costs health would make the manoeuvre impossible rather
 * than expensive. Nothing asks for one today — the nav graph has no `rocketjump`
 * link kind (`nav/schema.ts`) and v1 does not route to positions that need one —
 * so every caller in the game passes `false`, and the day one does not, this is
 * where it says so.
 */
export function selfDamageAllows(
  splash: number,
  health: number,
  rocketJump: boolean,
  skill: BotSkill = SHIPPED_SKILL,
): boolean {
  if (rocketJump) return true
  return splash <= acceptableSelfSplash(health, skill)
}
