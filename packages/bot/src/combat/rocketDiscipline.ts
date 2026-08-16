/**
 * When a rocket is worth firing. GLAD-KN4QRJ.
 *
 * `combat/railDiscipline.ts` argues that a railgun shot is a **resource**,
 * because 1500 ms of refire is most of an exchange. The rocket launcher was
 * never given the same argument, and it has the same problem for the same
 * reason: **both weapons share one timer** (`EntityState.nextFireTick`,
 * `sim/weapons.ts`), so a rocket that was never going to hurt anybody does not
 * merely fail — it buys 800 ms of silence during which the better shot that
 * arrives 200 ms later cannot be taken.
 *
 * ## This is not the tolerance check, and measuring proved it
 *
 * `rocketTolerance` (`combat/fire.ts`) already refuses a rocket whose *crosshair*
 * has not arrived at the aim point. That is a different question, and on this map
 * it is almost always already satisfied: tightening it from four degrees to one
 * and a half suppressed 3.5% of rockets and moved no hit rate at all. The wasted
 * rocket is not the one aimed badly at a good point. It is the one aimed
 * perfectly at a point that was worth nothing — a target 600 units away who is
 * jinking, where the miss radius is two splash radii wide before the crosshair
 * has done anything wrong.
 *
 * An angular gate cannot see that, because the thing that ruined the shot is
 * range and evasion rather than the wrist. So the quantity to test is the one
 * `combat/damage.ts` already computes and `combat/rocketAim.ts` already uses to
 * *choose* between two aim points — and, until this file, threw away immediately
 * afterwards.
 *
 * ## Why holding fire makes the bot land more rockets *and* take longer to kill
 *
 * Those two read as opposites and are not, which is the whole reason this ticket
 * had three rows to close rather than a trade to make. Every other knob moves
 * whether a *fired* rocket lands, and each of those does trade one row against
 * the other. This one moves **which rockets are fired**, and the two rows are
 * different fractions:
 *
 * - the hit rate is `landed / fired`, and refusing a shot that was going to miss
 *   takes one off the bottom and none off the top, so the rate **rises**
 * - time-to-kill is set by damage per second, and a refused shot is damage not
 *   dealt, so a round gets **longer**
 *
 * Measured over five thousand attributed rockets, the shots this refuses at the
 * shipped floor are 17.6% of what the bot fires and 11.0% of the damage it
 * deals. Refusing them is a real cost, honestly paid: the model does not
 * discriminate well down here — a refused rocket is worth about fifteen points
 * rather than nothing — and the rows move because the two fractions move at
 * different rates, not because the discarded shots were worthless.
 *
 * ## It is a floor on the shot that was *chosen*, not on both candidates
 *
 * `planRocket` has already taken the better of the body and the surface beside it
 * under the same expectation. Asking whether that winner clears the floor is
 * therefore one comparison, and asking it of the loser as well would refuse
 * shots on the strength of the option the bot had already declined.
 */

import { SHIPPED_SKILL } from '../tuning.ts'
import type { BotSkill } from '../tuning.ts'
import type { ShotPlan } from './rocketAim.ts'

/**
 * The expected damage a rocket has to promise before it is worth 800 ms, in
 * points. The shipped bot's value; a bot at another skill carries its own
 * (`tuning.ts`).
 *
 * **On the skill axis, and it had to be — a fixed floor stretches the ladder.**
 * This was tried as a fixed number first, beside `selfSplashAllowance`, on the
 * reasoning that knowing a bad shot is a bad shot is arithmetic every difficulty
 * does. Measured, that is wrong, and wrong in a way worth writing down: an
 * expectation is *already* a function of how good the bot is, because a novice's
 * miss radius at a given range is several times an expert's. So one floor in
 * absolute points refuses most of a novice's rockets and almost none of an
 * expert's — it does not merely fail to separate the rungs, it **amplifies** the
 * difference between them. Raising a fixed floor from 35 to 50 moved the band
 * table's two ladder rows in *opposite* directions, out of opposite ends of
 * their bands, and no single value satisfied both.
 *
 * Putting it on the axis with the novice held to a lower floor and the expert to
 * a higher one makes each refuse a comparable share of its own shots, which is
 * what leaves the ladder measuring the ladder. That it also reads correctly is a
 * bonus rather than the argument: a better player holds out for a better shot.
 *
 * Points are pre-armour, which is what `combat/damage.ts` predicts and what
 * `sim/damage.ts` computes before `resolveDamage` splits it — so against a full
 * armour bar this floor is worth about a third of itself in health. The bot has
 * no armour term because it has no way to see an opponent's armour, and adding
 * one would be a channel invented for the bot's convenience.
 */
export const ROCKET_DAMAGE_FLOOR = SHIPPED_SKILL.rocketDamageFloor

/**
 * Is the planned rocket worth the refire timer it would spend?
 *
 * Read off the mode the plan settled on, because that is the shot that would
 * actually be fired. A plan with no shot in it is not worth firing by
 * definition, and says so here rather than making every caller check twice.
 */
export function rocketWorthFiring(plan: ShotPlan, skill: BotSkill = SHIPPED_SKILL): boolean {
  if (plan.mode === 'none') return false
  const expected = plan.mode === 'splash' ? plan.splashExpected : plan.directExpected
  return expected >= skill.rocketDamageFloor
}
