/**
 * The small amount of vector maths the kernel needs, plus the one place the
 * simulation is allowed to call a transcendental.
 *
 * `axis.ts` holds the Quake -> engine change of basis and is about the
 * *renderer* boundary. This file is about the simulation's own arithmetic and
 * never leaves the Quake frame.
 */

/** A mutable 3-vector. The sim mutates in place; see `kernel.ts`. */
export type MutVec3 = [number, number, number]

/** Degrees to radians. Quake's `M_PI * 2 / 360`, which is the same double. */
export const DEG_TO_RAD = Math.PI / 180

/** A fresh zero vector. */
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
 * Wrap an angle into `[-180, 180)`.
 *
 * Yaw accumulates without bound as a player spins; left alone it eventually
 * loses mantissa bits, and two peers that lost different bits are desynced.
 * Wrapping keeps every angle in a range where the spacing between
 * representable doubles is the same for both of them.
 */
export function wrapAngle(degrees: number): number {
  const wrapped = degrees - Math.floor((degrees + 180) / 360) * 360
  // `-0` and `0` are the same angle; only one of them should reach the hash.
  return wrapped === 0 ? 0 : wrapped
}

/**
 * Quake's `AngleVectors`: view angles (degrees) to a basis, in the Quake frame.
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
 * ## The one transcendental seam
 *
 * `Math.sin` and `Math.cos` are "implementation-approximated" in ECMA-262:
 * V8 and JavaScriptCore are both free to be a fraction of an ULP off, and
 * differently. Every trig call in the simulation goes through this function so
 * that the exposure is one function wide rather than scattered.
 *
 * We are *not* pre-empting that with a lookup table. A 65536-entry Float32
 * table is 256 KB of payload to buy cross-engine bit-exactness, and this
 * project has deliberately demoted cross-engine bit-exactness to a
 * warning-level check — a browser-vs-server mismatch shows up as a
 * self-splash mispredict, and the canary for that lands with GLAD-5QGO11. If
 * the canary ever fires, the table goes in here, behind this signature, and
 * nothing else changes. That is the whole point of the seam.
 */
export function angleVectors(
  pitchDeg: number,
  yawDeg: number,
  rollDeg: number,
  forward: MutVec3 | null,
  right: MutVec3 | null,
  up: MutVec3 | null,
): void {
  const p = pitchDeg * DEG_TO_RAD
  const y = yawDeg * DEG_TO_RAD
  const r = rollDeg * DEG_TO_RAD

  const sp = Math.sin(p)
  const cp = Math.cos(p)
  const sy = Math.sin(y)
  const cy = Math.cos(y)
  const sr = Math.sin(r)
  const cr = Math.cos(r)

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
