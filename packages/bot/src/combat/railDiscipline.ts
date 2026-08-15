/**
 * When a rail is worth taking. GLAD-HK3ATM.
 *
 * A railgun shot costs 1500 ms of refire (`weapons.ts`), which is most of an
 * exchange: a duel is decided in two or three hits, so a wasted rail is a third
 * of a round handed over. That makes each shot a **resource**, and the rule for
 * spending it is one line — *the aim has to have settled first*.
 *
 * **A bot that only takes settled rails reads as disciplined; one that only
 * takes snap rails reads as lucky.** That asymmetry is the entire reason this
 * file exists rather than the trigger simply firing whenever the crosshair
 * happens to be over somebody. Both bots land roughly the same fraction of their
 * shots. Only one of them looks like it meant to.
 *
 * ## Settled is two numbers, not one
 *
 * The angular error says the crosshair is on them. The angular *rate* says it is
 * going to still be on them when the shot leaves — a crosshair sweeping across a
 * target at speed is on it for one sub-step, and firing then is a coin toss
 * dressed up as a decision.
 *
 * The rate half also produces a range behaviour nobody had to write down. A
 * target strafing at run speed subtends an angular rate inversely proportional
 * to its distance: at 1000 units that is about 27 units per sub-step and the aim
 * is settled, at 400 units it is 67 and it is not. So the bot rails across the
 * arena and switches to rockets in a close-quarters fight, which is what a
 * person does, out of one threshold rather than a range table.
 */

import type { AimState } from '../aim/controller.ts'

/**
 * How far off the aim may be and still count as settled, in angle units.
 *
 * Sixty is a third of a degree — 17 units of lateral error at the far end of the
 * bot's sight range (`perception/worldModel.ts`'s `SIGHT_RANGE`, 3000) and under
 * six at a thousand. The player box is 30 wide, so this is a threshold that
 * means "on the body" everywhere the bot can see a body.
 */
export const RAIL_SETTLE_UNITS = 60

/**
 * How fast the view may still be moving, in angle units per sub-step.
 *
 * Ninety is half a degree a sub-step, which is 62 degrees a second. Above it the
 * crosshair is sweeping rather than tracking — see the header for why that is
 * the half of "settled" that does the interesting work.
 */
export const RAIL_SETTLE_RATE = 90

/**
 * Has the aim settled enough to spend a rail on?
 *
 * Both halves, and the constants are the configured threshold the acceptance
 * check names. Nothing else gates a rail: whether the target is worth railing at
 * all is `combat/weaponSelect.ts`'s question, and whether the trigger may be
 * pulled at all is the reaction and the refire timer.
 */
export function railSettled(aim: AimState): boolean {
  return aim.error <= RAIL_SETTLE_UNITS && aim.rate <= RAIL_SETTLE_RATE
}
