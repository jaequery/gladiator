/**
 * `pmove` — a stub.
 *
 * The real one is GLAD-0B1GDS: Quake's friction, `PM_Accelerate`'s projection
 * of acceleration onto velocity, air control, velocity snapping. That is what
 * makes strafe-jumping work, and it is deliberately not here, because this
 * ticket is the walking skeleton and tuning a constant before the platform path
 * is proven is how you spend a week debugging Vercel while holding a physics
 * bug in the other hand.
 *
 * What *is* here is the shape the real one will keep: a total, synchronous
 * function of `(state, cmd)` returning the next state, in the Quake frame,
 * using nothing but exactly-specified arithmetic. Collision is a clamp to a
 * square plane rather than a trace (GLAD-3SCN0U owns the trace); acceleration
 * is instantaneous rather than Quake's `wishspeed` projection.
 *
 * Constants are Quake 3's, in Quake units per second, so that GLAD-0B1GDS
 * inherits numbers rather than replacing invented ones.
 */
import { PLAYER_HALF_WIDTH } from './bbox.ts'
import { TICK_DT } from './tick.ts'
import { cosRad, sinRad } from './trig.ts'
import { angleUnitsToRadians, BUTTON_JUMP, type UserCmd } from './usercmd.ts'
import type { Vec3 } from './axis.ts'

/** Downward acceleration, Quake units per second squared. */
export const GRAVITY = 800

/** Ground speed. Quake 3's `g_speed`. */
export const RUN_SPEED = 320

/** Upward velocity a jump imparts. Quake 3's `JUMP_VELOCITY`. */
export const JUMP_VELOCITY = 270

/** Half-width of the square plane the skeleton runs on, in Quake units. */
export const PLANE_HALF_EXTENT = 1024

/** How far the player's centre may get from the middle of the plane. */
const MOVE_LIMIT = PLANE_HALF_EXTENT - PLAYER_HALF_WIDTH

/**
 * The whole of the skeleton's world state.
 *
 * `origin` is the player's feet, in the Quake frame: `+x` forward, `+y` left,
 * `+z` up. The renderer converts once, at its own boundary — never here.
 */
export type PlayerState = {
  readonly origin: Vec3
  readonly velocity: Vec3
  readonly onGround: boolean
}

/** Standing at the middle of the plane, at rest. */
export const SPAWN_STATE: PlayerState = {
  origin: [0, 0, 0],
  velocity: [0, 0, 0],
  onGround: true,
}

/** Clamp `value` into `[-limit, limit]`. */
function clamp(value: number, limit: number): number {
  if (value > limit) return limit
  if (value < -limit) return -limit
  return value
}

/**
 * Advance one player by one tick.
 *
 * Total and synchronous: same `(state, cmd)` in, same state out, in a browser
 * and in Node, to the last bit. That property is the entire reason this file
 * may not reach for `Math.sin`, a clock or a PRNG.
 */
export function pmove(state: PlayerState, cmd: UserCmd): PlayerState {
  const yaw = angleUnitsToRadians(cmd.yaw)
  const cosYaw = cosRad(yaw)
  const sinYaw = sinRad(yaw)

  // Quake's basis: forward is (cos, sin, 0) and +y is *left*, so strafing
  // right — a positive sideMove — is forward rotated by -90 degrees.
  let wishX = cosYaw * cmd.forwardMove + sinYaw * cmd.sideMove
  let wishY = sinYaw * cmd.forwardMove - cosYaw * cmd.sideMove
  const wishLength = Math.sqrt(wishX * wishX + wishY * wishY)
  if (wishLength > 0) {
    wishX /= wishLength
    wishY /= wishLength
  }

  const [x, y, z] = state.origin
  const [, , vz] = state.velocity

  let nextVx: number
  let nextVy: number
  let nextVz: number

  if (state.onGround) {
    // No friction and no acceleration curve: the skeleton reaches full speed
    // in one tick. GLAD-0B1GDS replaces exactly this block.
    nextVx = wishX * RUN_SPEED
    nextVy = wishY * RUN_SPEED
    nextVz = (cmd.buttons & BUTTON_JUMP) === 0 ? 0 : JUMP_VELOCITY
  } else {
    // No air control either — holding a strafe key mid-air does nothing until
    // GLAD-0B1GDS lands. Momentum is conserved; gravity is not.
    nextVx = state.velocity[0]
    nextVy = state.velocity[1]
    nextVz = vz - GRAVITY * TICK_DT
  }

  const sweptX = x + nextVx * TICK_DT
  const sweptY = y + nextVy * TICK_DT
  const nextX = clamp(sweptX, MOVE_LIMIT)
  const nextY = clamp(sweptY, MOVE_LIMIT)
  let nextZ = z + nextVz * TICK_DT

  // Running into the edge of the plane stops you, the way a wall would. A real
  // SlideMove would let you slide along it (GLAD-3SCN0U).
  if (nextX !== sweptX) nextVx = 0
  if (nextY !== sweptY) nextVy = 0

  let onGround = false
  if (nextZ <= 0) {
    nextZ = 0
    nextVz = 0
    onGround = true
  }

  return {
    origin: [nextX, nextY, nextZ],
    velocity: [nextVx, nextVy, nextVz],
    onGround,
  }
}
