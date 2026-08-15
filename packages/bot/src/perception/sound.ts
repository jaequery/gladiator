/**
 * The sound channel, and the two errors that keep it from being a wallhack.
 *
 * A heard contact is **never a position**. It is a bearing wrong by up to
 * {@link SOUND_BEARING_ERROR_DEGREES} and a range wrong by up to
 * {@link SOUND_DISTANCE_ERROR}, and at 1400 units that is over 500 units of
 * lateral error — further than a rocket's splash radius, so a bot that turned
 * to the noise and fired would miss. That is the entire point, and
 * `fairness.test.ts` asserts it as a number rather than trusting the prose.
 *
 * The alternative, which is what every naive implementation does, is to hand the
 * bot the true origin of the sound and call the channel "hearing". It is a
 * wallhack with a nicer name: the bot pre-aims at where you are through a wall
 * and the player has no way to tell that from a bug.
 *
 * ## Sound goes through walls; sight does not
 *
 * There is no line-of-sight test in here, deliberately. A wall muffles a rocket
 * launcher, it does not silence one, and modelling occlusion properly would be
 * a propagation problem this game does not need to solve. The imprecision above
 * is what makes hearing through a wall *safe* to grant — you learn a direction
 * to look, which is exactly what a player in headphones gets.
 *
 * ## Two draws, and they only happen when there is something to hear
 *
 * The bot's PRNG is seeded (`bot.ts`), so a headless match replays. Both draws
 * happen strictly *after* the range gate has passed, which is not tidiness: a
 * draw taken on a sound the bot could not hear would advance the stream by an
 * amount that depends on where the opponent is, and the whole fairness argument
 * is that nothing unperceived may move the bot's output by so much as one bit.
 */

import { cosRad, rngRange, sinRad } from '@gladiator/sim'
import type { RngHolder, Vec3, Weapon } from '@gladiator/sim'

import {
  SOUND_BEARING_ERROR_DEGREES,
  SOUND_CONFIDENCE,
  SOUND_DISTANCE_ERROR,
  SOUND_UNCERTAINTY_FRACTION,
} from './worldModel.ts'
import type { EnemyContact } from './worldModel.ts'

/** Radians per degree. `sight.ts` carries the same constant for the same reason. */
const RADIANS_PER_DEGREE = 0.017453292519943295

/**
 * Write a heard contact into `contact`.
 *
 * `listener` and `source` are both **feet** positions (`bbox.ts`), so the
 * believed origin comes out in the same frame the rest of the model is in.
 *
 * The bearing error is a rotation about the vertical axis only. Rotating the
 * whole direction would tilt the belief above or below the floor, and elevation
 * is the one thing ears are genuinely good at compared with a game's geometry —
 * the error worth modelling is the one that puts a body on the wrong side of a
 * pillar.
 */
export function hearContact(
  contact: EnemyContact,
  rng: RngHolder,
  tick: number,
  listener: Vec3,
  source: Vec3,
  weapon: Weapon | null,
): void {
  const dx = source[0] - listener[0]
  const dy = source[1] - listener[1]
  const dz = source[2] - listener[2]
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

  const bearingError = rngRange(
    rng,
    -SOUND_BEARING_ERROR_DEGREES,
    SOUND_BEARING_ERROR_DEGREES,
  )
  const heard = distance * (1 + rngRange(rng, -SOUND_DISTANCE_ERROR, SOUND_DISTANCE_ERROR))

  if (distance === 0) {
    // Standing inside each other, which the telefrag rule makes momentarily
    // possible. There is no bearing to be wrong about.
    contact.origin[0] = listener[0]
    contact.origin[1] = listener[1]
    contact.origin[2] = listener[2]
  } else {
    const radians = bearingError * RADIANS_PER_DEGREE
    const c = cosRad(radians)
    const s = sinRad(radians)
    const ux = dx / distance
    const uy = dy / distance
    const uz = dz / distance
    contact.origin[0] = listener[0] + (ux * c - uy * s) * heard
    contact.origin[1] = listener[1] + (ux * s + uy * c) * heard
    contact.origin[2] = listener[2] + uz * heard
  }

  contact.source = 'sound'
  contact.velocity[0] = 0
  contact.velocity[1] = 0
  contact.velocity[2] = 0
  contact.uncertainty = heard * SOUND_UNCERTAINTY_FRACTION
  contact.confidence = SOUND_CONFIDENCE
  contact.fresh = true
  contact.lastContactTick = tick

  // A shot identifies the weapon that made it — that is the one thing a noise
  // says precisely, and it is the same information the player gets. A footstep
  // says nothing, and leaves whatever was believed before standing.
  if (weapon !== null) {
    contact.weapon = weapon
    contact.weaponTick = tick
  }
}
