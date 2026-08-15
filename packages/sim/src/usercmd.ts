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

/**
 * How far a movement axis may go: -1 back or left, +1 forward or right.
 *
 * Quake's `forwardmove` is a signed byte and its clients send +/-127; this one
 * is a *direction* and the speed it means is `cmdscale.ts`'s business. So the
 * legal range is three values, and a client sending 127 is either an old
 * protocol or a client hoping the number is a multiplier.
 */
export const MAX_MOVE = 1

/** Button bits. Crouch arrives with its ticket. */
export const BUTTON_JUMP = 1

/**
 * Hold to fire. Both weapons are fully automatic, as Quake's are: the refire
 * interval is the only thing between shots, so there is no press-to-fire latch
 * and holding the button empties nothing.
 */
export const BUTTON_ATTACK = 2

/**
 * Every button bit that means something.
 *
 * `sanitizeUserCmd` masks with this, so a bit nobody has defined never reaches
 * the simulation. Two reasons, and the second is the one that made it a
 * constant: an undefined bit is a value the state hash carries and two peers can
 * disagree about, and a bit that is *later* defined would arrive already set
 * from clients that were sending noise. Adding a button means adding it here,
 * which is one edit rather than a hunt.
 */
export const BUTTON_MASK = BUTTON_JUMP | BUTTON_ATTACK

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
 * Wrap an arbitrary value into `[0, ANGLE_UNITS)`, mapping anything that is not
 * an integer to 0.
 *
 * A yaw *wraps* rather than clamping, and that is the difference between the two
 * halves of this file: a pitch of 200 degrees is a value with no meaning, and a
 * yaw of 400 degrees is 40. Clamping it would turn "the client's spin counter
 * overflowed" into "the player is suddenly facing due north", which is a
 * teleport of the view rather than a rejected number.
 *
 * `%` is exact for every integer a `UserCmd` can carry, because the divisor is a
 * power of two and the dividend is below 2^53.
 */
function wrapAngle(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return 0
  const wrapped = value % ANGLE_UNITS
  return wrapped < 0 ? wrapped + ANGLE_UNITS : wrapped
}

/**
 * Force an arbitrary value into a legal `UserCmd`.
 *
 * The server must never hand the simulation a number it did not choose: a
 * `NaN` yaw arriving from a hostile client would poison the state hash and every
 * position downstream of it, and the sim has no way to reject anything — a tick
 * is a total function. So the clamp happens here, once, at the only door.
 *
 * It lives in the simulation package rather than in the server's `validate.ts`
 * on purpose. Every constant a legal value is defined against — {@link MAX_MOVE},
 * {@link MAX_PITCH_UNITS}, {@link ANGLE_UNITS}, {@link BUTTON_MASK}, the two
 * weapons — is in here, and a clamp on the other side of the package boundary
 * would be a second opinion about all of them to keep in step. Every route into
 * the simulation goes through it: `decodeCmd` on the wire, the bot's command
 * generator, and the client's own input.
 *
 * Six fields and six rules, all of them total:
 *
 * | Field | Rule |
 * | ----- | ---- |
 * | `forwardMove`, `sideMove` | clamped to +/-{@link MAX_MOVE} |
 * | `yaw` | **wrapped** into `[0, ANGLE_UNITS)` — see {@link wrapAngle} |
 * | `pitch` | clamped to +/-{@link MAX_PITCH_UNITS}, which is +/-89 degrees |
 * | `buttons` | masked to {@link BUTTON_MASK} |
 * | `weapon` | one of the two, or the launcher |
 *
 * Anything that is not an integer — a float, a `NaN`, an `Infinity`, a string, a
 * missing field — is zero. GLAD-V7M6PQ.
 */
export function sanitizeUserCmd(value: unknown): UserCmd {
  const raw = (value ?? {}) as Partial<Record<keyof UserCmd, unknown>>
  // Anything that is not one of the two weapons becomes the launcher — the one
  // a player spawns holding. `Weapon.None` is a legal *entity* state (a corpse,
  // a rocket) and is not something a command may ask for: a player with empty
  // hands is not a thing this game has.
  const weapon = raw.weapon
  const held =
    typeof weapon === 'number' && (weapon === Weapon.RocketLauncher || weapon === Weapon.Railgun)
      ? weapon
      : Weapon.RocketLauncher

  // Masked rather than clamped: a clamp keeps every bit below a ceiling, and a
  // bit nobody has defined is exactly what should not survive the door — it
  // changes the state hash and means nothing. Negatives are zeroed *before* the
  // mask, because two's complement makes `-1 & BUTTON_MASK` every button at
  // once, which is a held trigger nobody asked for.
  const bits = clampInteger(raw.buttons, 0xffff)
  const buttons = bits > 0 ? bits & BUTTON_MASK : 0

  return {
    forwardMove: clampInteger(raw.forwardMove, MAX_MOVE),
    sideMove: clampInteger(raw.sideMove, MAX_MOVE),
    yaw: wrapAngle(raw.yaw),
    pitch: clampInteger(raw.pitch, MAX_PITCH_UNITS),
    buttons,
    weapon: held,
  }
}
