/**
 * `UserCmd` — one sub-step's worth of player intent.
 *
 * The *only* way anything gets into the simulation. A keyboard produces these;
 * so does the bot (`packages/bot`), which is what makes the bot fair — it has
 * no channel into the world that a human does not also have.
 *
 * One `UserCmd` corresponds to exactly one 8 ms sub-step, not one host frame.
 * A client running at 60 Hz produces two or three of them per frame and sends
 * them as a batch; the server consumes them one per sub-step. The buffering
 * policy for what to do when the batch arrives late, early or not at all is
 * GLAD-5995PA.
 *
 * Commands are `readonly` on purpose. They are values that travel across the
 * network and get replayed during reconciliation, possibly several times; a
 * mutated command is a command that replays differently the second time.
 */

/** Button bits. A bitfield, so a command stays one small integer on the wire. */
export const Button = {
  Attack: 1 << 0,
  Jump: 1 << 1,
  Crouch: 1 << 2,
  /** Held to move at walking speed — quieter, for GLAD-V7CMHR's hearing model. */
  Walk: 1 << 3,
  /** Railgun zoom. */
  Zoom: 1 << 4,
} as const

export type Button = (typeof Button)[keyof typeof Button]

/** The two weapons, and nothing else, ever. `0` means "no change requested". */
export const Weapon = {
  None: 0,
  RocketLauncher: 1,
  Railgun: 2,
} as const

export type Weapon = (typeof Weapon)[keyof typeof Weapon]

/**
 * The range of a movement axis: `-127..127`.
 *
 * Quake's, kept because it is exactly one signed byte and so survives the
 * eventual bit-packed command encoding without a second decision being made
 * about it.
 */
export const MOVE_AXIS_MAX = 127

export type UserCmd = {
  /** Client-assigned, strictly increasing. What the server acknowledges. */
  readonly seq: number
  /** The sub-step this command is *for*. Clock sync is GLAD-5995PA. */
  readonly tick: number
  /** Forward/back, `-127..127`. */
  readonly forwardMove: number
  /** Right/left, `-127..127`. */
  readonly rightMove: number
  /** Up/down, `-127..127`. Ladders and water, if either ever exists. */
  readonly upMove: number
  /** View pitch in degrees, positive *down* (Quake's convention). */
  readonly pitch: number
  /** View yaw in degrees, counter-clockwise from `+x`. */
  readonly yaw: number
  /** View roll in degrees. Always 0 from a human; the renderer adds its own. */
  readonly roll: number
  /** `Button` bits. */
  readonly buttons: number
  /** The `Weapon` the player wants to be holding. */
  readonly weapon: number
}

/**
 * The command a player who is not sending anything is treated as having sent.
 *
 * A missing command is *not* a skipped sub-step: the world advances whether or
 * not a packet arrived, or the two peers would be simulating different numbers
 * of ticks. Standing still is the safe default because it is the one that
 * cannot be exploited by dropping packets on purpose.
 */
export const IDLE_CMD: UserCmd = {
  seq: 0,
  tick: 0,
  forwardMove: 0,
  rightMove: 0,
  upMove: 0,
  pitch: 0,
  yaw: 0,
  roll: 0,
  buttons: 0,
  weapon: Weapon.None,
}

/** Is a button held in this command? */
export function isPressed(cmd: UserCmd, button: number): boolean {
  return (cmd.buttons & button) !== 0
}

/** Was a button pressed this sub-step but not the last one? */
export function wasJustPressed(cmd: UserCmd, previous: UserCmd, button: number): boolean {
  return (cmd.buttons & button) !== 0 && (previous.buttons & button) === 0
}

/** Clamp a movement axis into `-127..127`. Applied to anything off the wire. */
export function clampMoveAxis(value: number): number {
  if (!Number.isFinite(value)) return 0
  const truncated = Math.trunc(value)
  if (truncated > MOVE_AXIS_MAX) return MOVE_AXIS_MAX
  if (truncated < -MOVE_AXIS_MAX) return -MOVE_AXIS_MAX
  // `Math.trunc(-0.5)` is `-0`; it must not reach the state hash.
  return truncated === 0 ? 0 : truncated
}
