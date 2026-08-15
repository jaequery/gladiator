/**
 * Turning a direction into two axes, and back again. GLAD-TSED8V.
 *
 * This is the narrowest part of the whole movement layer and the reason the rest
 * of it is a controller rather than an assignment. A `UserCmd` carries
 * `forwardMove` and `sideMove` as `-1`, `0` or `+1` (`usercmd.ts`) — there is no
 * analogue stick to be subtle with — so **the bot can ask for exactly nine
 * things**: eight directions relative to its own yaw, and standing still. Every
 * "walk towards that point" in this package ends up here, resolved on to one of
 * the eight.
 *
 * ## The yaw is not the bot's to choose
 *
 * The view belongs to the aim controller (`brain.ts` today, GLAD-HK3ATM after).
 * So the eight directions are eight directions *of the view*, and the view is
 * usually pointing at whatever the bot is fighting rather than at where it is
 * going. That is the same constraint a human has — you strafe past somebody
 * while looking at them — and it is why {@link steerAxes} takes the yaw as an
 * argument rather than deriving one.
 *
 * ## What the deadzone costs, exactly
 *
 * A unit direction always resolves to something: the larger of its two projections
 * is at least `cos(45deg)` = 0.707, which is over {@link MOVE_DEADZONE}, so the axes
 * are never both zero for a direction the bot asked for.
 *
 * The second axis engages at `asin(0.35)` = 20.5 degrees off a cardinal, so a
 * bearing just past that resolves to the diagonal 45 degrees away — **24.5 degrees
 * of error**, the worst there is, at a cost of `1 - cos(24.5deg)` = 9.0% of the
 * speed towards the target. (A deadzone of `sin(22.5deg)` = 0.383 would make this
 * exactly nearest-of-eight and the worst case 22.5 degrees. It is 0.35 because that
 * is the number the decision layer already had, and 2 degrees of quantisation is not
 * worth a constant changing under a passing test.)
 *
 * That error is why every controller in `travel/` re-steers every sub-step instead of
 * committing to a heading: the zig-zag closes on the target even though no single
 * sub-step points straight at it.
 */

import { angleVectors, vec3 } from '@gladiator/sim'
import type { MutVec3 } from '@gladiator/sim'

/**
 * How far off a direction has to be before the bot stops asking for it, as a
 * cosine.
 *
 * 0.35 is a little under 70 degrees, which is what makes a bearing halfway
 * between forward and right come out as *both* rather than as whichever won by a
 * hair and flickered between them on consecutive ticks. A flicker is not a
 * cosmetic problem here: `PM_Accelerate` reads the wish direction every sub-step,
 * so an axis that alternates is a wish vector that alternates, and the two
 * accelerations partly cancel.
 */
export const MOVE_DEADZONE = 0.35

/** One tick's worth of stick position. Mutated in place; never reallocated. */
export type Axes = {
  /** -1 back, 0, +1 forward. */
  forwardMove: number
  /** -1 left, 0, +1 right. */
  sideMove: number
}

/** Axes asking for nothing. */
export function createAxes(): Axes {
  return { forwardMove: 0, sideMove: 0 }
}

/* Scratch. Single-threaded and synchronous; see `perception/sight.ts`. */
const forward: MutVec3 = vec3()
const right: MutVec3 = vec3()

/** A projection on to one of `-1`, `0`, `+1`. See {@link MOVE_DEADZONE}. */
function axis(projection: number): number {
  if (projection > MOVE_DEADZONE) return 1
  if (projection < -MOVE_DEADZONE) return -1
  return 0
}

/**
 * Resolve the horizontal direction `(dirX, dirY)` on to the axes a player
 * looking along `yaw` would press. Writes into `out` and returns it.
 *
 * The basis is **yaw only**, exactly as `pmove`'s `wishDirection` builds it. A
 * bot that projected on to a pitched forward vector would ask for less speed
 * whenever it was looking at the floor, and looking at the floor is what aiming
 * a rocket at somebody's feet *is*.
 *
 * A zero-length direction asks for nothing, which is how "stand still" is
 * spelled.
 */
export function steerAxes(yaw: number, dirX: number, dirY: number, out: Axes): Axes {
  const length = Math.sqrt(dirX * dirX + dirY * dirY)
  if (length === 0) {
    out.forwardMove = 0
    out.sideMove = 0
    return out
  }

  angleVectors(0, yaw, 0, forward, right, null)
  const ux = dirX / length
  const uy = dirY / length
  out.forwardMove = axis(ux * forward[0] + uy * forward[1])
  out.sideMove = axis(ux * right[0] + uy * right[1])
  return out
}

/**
 * The world direction a given stick position actually asks for, as a horizontal
 * unit vector. Writes into `out` and returns it.
 *
 * The inverse of {@link steerAxes}, and it exists because of the 24.5 degrees
 * that function is allowed to lose: the ledge guard (`movement/ledge.ts`) has to
 * probe the ground under where the bot will *go*, not under where it wishes it
 * were going, and those are not the same ray. Deriving it here rather than in
 * the guard keeps the quantisation and its inverse in one file, so they cannot
 * fall out of step.
 *
 * This is `pmove`'s airborne `wishDirection` — normalised, flat, yaw-only — and
 * that is deliberate rather than a coincidence: it is the same vector the
 * simulation is about to build out of the same two numbers.
 */
export function axisDirection(
  yaw: number,
  forwardMove: number,
  sideMove: number,
  out: MutVec3,
): MutVec3 {
  angleVectors(0, yaw, 0, forward, right, null)
  const x = forward[0] * forwardMove + right[0] * sideMove
  const y = forward[1] * forwardMove + right[1] * sideMove
  const length = Math.sqrt(x * x + y * y)
  out[0] = length === 0 ? 0 : x / length
  out[1] = length === 0 ? 0 : y / length
  out[2] = 0
  return out
}

/**
 * Half a right angle, as a rotation of a horizontal vector. `side` is `+1` for
 * counter-clockwise — towards `+y`, which is the bot's *left*, because `+y` is
 * left in the Quake frame (`docs/physics-spec.md` §0.3).
 *
 * Written out as `(x -+ y) / sqrt(2)` rather than as a call to a general rotation
 * with a constant angle in it, because 45 degrees is the only angle anything here
 * rotates by (`movement/circleJump.ts`) and `Math.SQRT1_2` is exactly the cosine
 * and the sine of it.
 */
export function rotate45(x: number, y: number, side: number, out: MutVec3): MutVec3 {
  const s = Math.SQRT1_2
  if (side >= 0) {
    out[0] = (x - y) * s
    out[1] = (x + y) * s
  } else {
    out[0] = (x + y) * s
    out[1] = (y - x) * s
  }
  out[2] = 0
  return out
}
