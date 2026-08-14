/**
 * The small amount of vector maths the kernel needs, and the one function that
 * turns view angles into a basis.
 *
 * `axis.ts` holds the Quake -> engine change of basis and is about the
 * *renderer* boundary. This file is about the simulation's own arithmetic and
 * never leaves the Quake frame.
 */

import { cosRad, sinRad } from './trig.ts'
import { angleUnitsToRadians } from './usercmd.ts'

/** A mutable 3-vector. The sim mutates in place; see `kernel.ts`. */
export type MutVec3 = [number, number, number]

/** A fresh vector. */
export function vec3(x = 0, y = 0, z = 0): MutVec3 {
  return [x, y, z]
}

/** `out = v`. Returns `out`. */
export function copyVec3(out: MutVec3, v: MutVec3): MutVec3 {
  out[0] = v[0]
  out[1] = v[1]
  out[2] = v[2]
  return out
}

/** `out = [x, y, z]`. Returns `out`. */
export function setVec3(out: MutVec3, x: number, y: number, z: number): MutVec3 {
  out[0] = x
  out[1] = y
  out[2] = z
  return out
}

/** `|v|`. `Math.hypot` is banned in the sim — it is implementation-approximated. */
export function lengthVec3(v: MutVec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2])
}

/** `|v|` ignoring `z`. Horizontal speed is what the movement rules are about. */
export function lengthVec2(v: MutVec3): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1])
}

/**
 * Quake's `AngleVectors`: view angles to a basis, in the Quake frame.
 *
 * Angles are in **angle units** — 1/65536 of a turn, the representation
 * `UserCmd` carries (`usercmd.ts`). Integers, so an angle survives the network
 * and the state hash exactly, rather than approximately.
 *
 * Pass `null` for any output you do not need. Outputs are written in place, so
 * a caller in the tick loop can hold three scratch vectors and allocate
 * nothing.
 *
 * Angle conventions, which are Quake's and are not the obvious ones:
 * - `pitch` is positive *downward*, hence `forward[2] = -sin(pitch)`.
 * - `yaw` is counter-clockwise from `+x`, because `+y` is left.
 * - `right` is `-y` at rest, for the same reason.
 *
 * ## One trig seam, and it is already deterministic
 *
 * Every trig call in the simulation goes through this function, and this
 * function goes through `trig.ts`, whose `sinRad`/`cosRad` are built from
 * IEEE-exact operations only. `Math.sin` and `Math.cos` are
 * "implementation-approximated" in ECMA-262 and are lint errors inside this
 * package for exactly that reason.
 *
 * So there is no lookup table here and there does not need to be one: a table
 * would be 256 KB of payload bought to purchase cross-engine bit-exactness
 * that `trig.ts` already provides from arithmetic.
 */
export function angleVectors(
  pitchUnits: number,
  yawUnits: number,
  rollUnits: number,
  forward: MutVec3 | null,
  right: MutVec3 | null,
  up: MutVec3 | null,
): void {
  const p = angleUnitsToRadians(pitchUnits)
  const y = angleUnitsToRadians(yawUnits)
  const r = angleUnitsToRadians(rollUnits)

  const sp = sinRad(p)
  const cp = cosRad(p)
  const sy = sinRad(y)
  const cy = cosRad(y)
  const sr = sinRad(r)
  const cr = cosRad(r)

  if (forward !== null) {
    forward[0] = cp * cy
    forward[1] = cp * sy
    forward[2] = -sp
  }
  if (right !== null) {
    right[0] = -sr * sp * cy + cr * sy
    right[1] = -sr * sp * sy - cr * cy
    right[2] = -sr * cp
  }
  if (up !== null) {
    up[0] = cr * sp * cy + sr * sy
    up[1] = cr * sp * sy - sr * cy
    up[2] = cr * cp
  }
}
