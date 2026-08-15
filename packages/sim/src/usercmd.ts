/**
 * `UserCmd` — one tick's worth of player intent, and the only way anything gets
 * into the simulation. A human's keyboard produces these; so does the bot,
 * which is what makes the bot fair.
 *
 * Every field is an **integer**. That is not tidiness: a `UserCmd` crosses the
 * network, and a float that survives a round-trip on one peer and not the other
 * is a desync with no other symptom. Angles are quantised to 1/65536 of a turn
 * — Quake's 16-bit angles — so "the angle the client sent" and "the angle the
 * server received" are the same number by construction rather than by luck.
 *
 * The full command (`msec`, impulse, the rest of the button bits) is
 * GLAD-OOELC5's; this is the walking skeleton's subset plus what it takes to
 * shoot.
 */

import { Weapon } from './weapon.ts'

/** Quantisation of a full turn. 2^16, so the conversion below is exact. */
export const ANGLE_UNITS = 65536

/** Radians per angle unit. A power-of-two divisor, so this constant is exact. */
export const RADIANS_PER_ANGLE_UNIT = 6.283185307179586 / ANGLE_UNITS

/** Angle units per degree. */
export const ANGLE_UNITS_PER_DEGREE = ANGLE_UNITS / 360

/**
 * Pitch is clamped to +/-89 degrees rather than +/-90: at exactly straight up
 * the yaw-relative movement basis is degenerate, and Quake has clamped it since
 * 1996 for the same reason.
 */
export const MAX_PITCH_UNITS = 16202

/** Button bits. Crouch arrives with its ticket. */
export const BUTTON_JUMP = 1

/**
 * Hold to fire. Both weapons are fully automatic, as Quake's are: the refire
 * interval is the only thing between shots, so there is no press-to-fire latch
 * and holding the button empties nothing.
 */
export const BUTTON_ATTACK = 2

export type UserCmd = {
  /** -1 back, 0, +1 forward. */
  readonly forwardMove: number
  /** -1 left, 0, +1 right. */
  readonly sideMove: number
  /** View yaw, in angle units, wrapped to `[0, ANGLE_UNITS)`. */
  readonly yaw: number
  /** View pitch, in angle units, clamped to +/-{@link MAX_PITCH_UNITS}. */
  readonly pitch: number
  /** Button bitfield. */
  readonly buttons: number
  /**
   * The weapon the player is holding, a {@link Weapon}.
   *
   * Carried on every command rather than sent as a switch *event*, for the
   * same reason the whole command is: a lost event leaves two peers holding
   * different weapons for the rest of the match, and a repeated field cannot
   * be lost. It is also what makes the bot's weapon selection go through
   * exactly the door a human's does.
   */
  readonly weapon: Weapon
}

/** Standing still, looking down the +x axis, holding the rocket launcher. */
export const NULL_CMD: UserCmd = {
  forwardMove: 0,
  sideMove: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  weapon: Weapon.RocketLauncher,
}

/** Wrap a signed angle in degrees into `[0, ANGLE_UNITS)` angle units. */
export function yawUnitsFromDegrees(degrees: number): number {
  const units = Math.round(degrees * ANGLE_UNITS_PER_DEGREE)
  // `%` keeps the sign of the dividend, so a negative yaw needs one more wrap.
  const wrapped = units % ANGLE_UNITS
  return wrapped < 0 ? wrapped + ANGLE_UNITS : wrapped
}

/** Clamp a signed pitch in degrees to the legal band, in angle units. */
export function pitchUnitsFromDegrees(degrees: number): number {
  const units = Math.round(degrees * ANGLE_UNITS_PER_DEGREE)
  if (units > MAX_PITCH_UNITS) return MAX_PITCH_UNITS
  if (units < -MAX_PITCH_UNITS) return -MAX_PITCH_UNITS
  return units
}

/** Angle units to radians. Exact: the divisor is a power of two. */
export function angleUnitsToRadians(units: number): number {
  return units * RADIANS_PER_ANGLE_UNIT
}

/** Clamp `value` to `[-limit, limit]`, mapping a non-integer or NaN to 0. */
function clampInteger(value: unknown, limit: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 0
  if (value > limit) return limit
  if (value < -limit) return -limit
  return value
}

/**
 * Force an arbitrary value into a legal `UserCmd`.
 *
 * The server must never hand the simulation a number it did not choose: a
 * `NaN` yaw arriving from a hostile client would poison the state hash and every
 * position downstream of it, and the sim has no way to reject anything — a tick
 * is a total function. So the clamp happens here, once, at the only door.
 *
 * This is the walking skeleton's share of GLAD-V7M6PQ, not the whole of it.
 */
export function sanitizeUserCmd(value: unknown): UserCmd {
  const raw = (value ?? {}) as Partial<Record<keyof UserCmd, unknown>>
  const yaw = clampInteger(raw.yaw, ANGLE_UNITS)
  const buttons = clampInteger(raw.buttons, 0xffff)
  // Anything that is not one of the two weapons becomes the launcher — the one
  // a player spawns holding. `Weapon.None` is a legal *entity* state (a corpse,
  // a rocket) and is not something a command may ask for: a player with empty
  // hands is not a thing this game has.
  const weapon = raw.weapon
  const held =
    typeof weapon === 'number' && (weapon === Weapon.RocketLauncher || weapon === Weapon.Railgun)
      ? weapon
      : Weapon.RocketLauncher

  return {
    forwardMove: clampInteger(raw.forwardMove, 1),
    sideMove: clampInteger(raw.sideMove, 1),
    yaw: ((yaw % ANGLE_UNITS) + ANGLE_UNITS) % ANGLE_UNITS,
    pitch: clampInteger(raw.pitch, MAX_PITCH_UNITS),
    buttons: buttons < 0 ? 0 : buttons,
    weapon: held,
  }
}
