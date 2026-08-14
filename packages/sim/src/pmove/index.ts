/**
 * `pmove` — Quake's player movement, ported. `docs/physics-spec.md` §1.
 *
 * This is the file that decides whether the game feels right. Everything else
 * in `packages/sim` exists so that this can be stated once and then produce the
 * same answer on both peers, bit for bit, for the length of a match.
 *
 * ## The phase order is the mechanic
 *
 * One sub-step, in Quake 3's `PmoveSingle` order:
 *
 * ```
 * release the jump latch  ->  drop timers  ->  speed rail  ->  ground trace
 *   ->  PM_WalkMove | PM_AirMove  ->  ground trace  ->  SnapVector
 * ```
 *
 * and inside `PM_WalkMove`:
 *
 * ```
 * PM_CheckJump  ->  (jumped? PM_AirMove and return)  ->  PM_Friction  ->  ...
 * ```
 *
 * **`PM_CheckJump` running before `PM_Friction` is the entire bunny hop.** A
 * successful jump clears `walking`, so `PM_Friction` finds nothing to charge
 * for and a frame-perfect landing-then-jump costs *exactly zero* speed. Miss
 * the tick by one and friction takes 4.8%. Swap those two calls and the game
 * still runs, still looks right, and quietly has no movement ceiling — which is
 * why the ordering is asserted in `pmove.test.ts` by measurement rather than by
 * reading the code.
 *
 * ## Two things a reader will want to check are on purpose
 *
 * - **The jump overrides `velocity[2]`** rather than adding to it. QuakeWorld's
 *   additive form lets a player stack a jump onto rising velocity — off a ramp,
 *   out of an explosion — and stack it again. Quake 3 assigns, and so does
 *   this.
 * - **There is a speed clamp and Quake has none.** 3000 qu/s, from
 *   `slidemove.ts` §2.6, and it is a collision and netcode safety rail rather
 *   than physics: velocity is an *input* from splash damage and from a client's
 *   reconciliation, and one absurd value should not be able to put a body
 *   outside the world. Nothing in play approaches it — a good rocket jump peaks
 *   around 1000 — so if it ever fires, something upstream is wrong and someone
 *   needs to hear about it. See {@link onSpeedClamp}.
 */

import type { Vec3 } from '../axis.ts'
import type { CollisionWorld } from '../collide.ts'
import { angleVectors, lengthVec3, normalizeVec3, scaleVec3, vec3 } from '../math.ts'
import type { MutVec3 } from '../math.ts'
import {
  MAX_MOVE_SPEED,
  OVERCLIP,
  clampMoveSpeed,
  clipVelocity,
  createMoveBody,
  groundTrace,
  stepSlideMove,
} from '../slidemove.ts'
import type { MoveBody } from '../slidemove.ts'
import { TICK_DT } from '../tick.ts'
import { BUTTON_JUMP } from '../usercmd.ts'
import type { UserCmd } from '../usercmd.ts'
import { PM_ACCELERATE, PM_AIR_ACCELERATE, accelerate, airAccelerationFor } from './accelerate.ts'
import { cmdScale } from './cmdscale.ts'
import { friction } from './friction.ts'
import { snapVelocity } from './snap.ts'

export { cmdScale } from './cmdscale.ts'
export { PM_FRICTION, PM_STOPSPEED, friction } from './friction.ts'
export {
  AIR_CONTROL,
  AIR_STOP_ACCELERATE,
  PM_ACCELERATE,
  PM_AIR_ACCELERATE,
  accelerate,
  airAccelerationFor,
} from './accelerate.ts'
export { snapVelocity } from './snap.ts'

/**
 * Downward acceleration, in qu/s². Quake 3's `g_gravity`.
 *
 * The gravity a player *feels* is 750, not 800 — integer velocity snapping eats
 * the 0.4 every tick. `snap.ts` has the derivation; it is why the sub-step
 * length is a feel constant rather than a performance knob.
 */
export const GRAVITY = 800

/** Ground speed, in qu/s. Quake 3's `g_speed`, and `PM_CmdScale`'s `ps->speed`. */
export const RUN_SPEED = 320

/**
 * The vertical velocity a jump *sets*, in qu/s. Quake 3's `JUMP_VELOCITY`.
 *
 * Assigned, never added — see the note at the top of this file. Against the
 * effective gravity of 750 it puts the apex at 48.6 units.
 */
export const JUMP_VELOCITY = 270

/**
 * A player the movement code can move.
 *
 * Everything except `jumpHeld` is `MoveBody` from the collision layer, which is
 * also what `slideMove` and `stepSlideMove` take — so there is one shape, and
 * the movement code cannot end up with a private idea of where the ground is.
 */
export type PmoveBody = MoveBody & {
  /**
   * Jump has been held since it last fired. Quake 3's `PMF_JUMP_HELD`.
   *
   * The latch is why holding space does not auto-hop: a jump costs a *press*,
   * and the press has to land on the tick you touch down. That is the timing
   * window bunny hopping is a skill because of, and it is the one piece of
   * movement state that has to survive between sub-steps — `walking`,
   * `groundPlane` and `groundNormal` are all recomputed by the ground trace.
   */
  jumpHeld: boolean
}

/** A player-shaped body at rest, in mid-air, with jump unlatched. */
export function createPmoveBody(mins: Vec3, maxs: Vec3): PmoveBody {
  return { ...createMoveBody(mins, maxs), jumpHeld: false }
}

/* --------------------------------------------------------------------------
 * The speed rail's one seam to the outside world
 * ----------------------------------------------------------------------- */

/**
 * Called when the §2.6 speed clamp fires, with the speed it clamped *from*.
 *
 * `packages/sim` has no `console` — no `DOM` lib and no ambient `@types`, by
 * construction — so "log when it fires" has to be a seam the host fills in.
 * The client and the server set one at start-up; a replay or a test can set one
 * to assert it fired.
 *
 * Purely observational: it cannot reach the simulation state and it is not
 * consulted for anything, so two peers with different observers still produce
 * the same world. Pass `null` to remove it.
 */
export function onSpeedClamp(observer: ((speed: number) => void) | null): void {
  speedClampObserver = observer
}

let speedClampObserver: ((speed: number) => void) | null = null

/* --------------------------------------------------------------------------
 * PmoveSingle
 * ----------------------------------------------------------------------- */

/**
 * Advance one player by one sub-step. Mutates `body` in place.
 *
 * `dt` is seconds, and is a parameter only so a test can state a rate; the
 * simulation always passes `TICK_DT`, because the step length is a feel
 * constant (`docs/physics-spec.md` §0.1).
 */
export function pmove(
  world: CollisionWorld,
  body: PmoveBody,
  cmd: UserCmd,
  dt: number = TICK_DT,
): void {
  // Releasing jump unlatches it. Quake 3 does this at the top of `PmoveSingle`
  // rather than in `PM_CheckJump`, so a tick spent airborne with the key up
  // still re-arms the next hop.
  if ((cmd.buttons & BUTTON_JUMP) === 0) body.jumpHeld = false

  if (body.knockbackTicks > 0) body.knockbackTicks -= 1

  // The safety rail. Before the ground trace, because a body arriving at
  // 40,000 qu/s from a bad reconciliation must not be asked to sweep that far.
  const speed = lengthVec3(body.velocity)
  if (speed > MAX_MOVE_SPEED) {
    clampMoveSpeed(body.velocity)
    if (speedClampObserver !== null) speedClampObserver(speed)
  }

  groundTrace(world, body)

  if (body.walking) walkMove(world, body, cmd, dt)
  else airMove(world, body, cmd, dt)

  // Traced again after the move, so what the rest of the tick reads — the
  // renderer's footstep, the next tick's friction — is where the body ended up
  // rather than where it set off from.
  groundTrace(world, body)

  snapVelocity(body.velocity)
}

/* --------------------------------------------------------------------------
 * PM_CheckJump
 * ----------------------------------------------------------------------- */

/**
 * Take off, if the player asked and the latch allows it. Returns whether it
 * jumped.
 *
 * Clearing `groundPlane` and `walking` here is not bookkeeping — it is what
 * makes the rest of the tick treat an already-airborne player correctly, and
 * it is what `PM_Friction` reads a few lines later when it decides to charge
 * nothing.
 */
function checkJump(body: PmoveBody, cmd: UserCmd): boolean {
  if ((cmd.buttons & BUTTON_JUMP) === 0) return false
  if (body.jumpHeld) return false

  body.jumpHeld = true
  body.groundPlane = false
  body.walking = false
  body.velocity[2] = JUMP_VELOCITY
  return true
}

/* --------------------------------------------------------------------------
 * PM_WalkMove
 * ----------------------------------------------------------------------- */

function walkMove(world: CollisionWorld, body: PmoveBody, cmd: UserCmd, dt: number): void {
  // The ordering the whole movement rests on. See the header.
  if (checkJump(body, cmd)) {
    airMove(world, body, cmd, dt)
    return
  }

  friction(body, dt)

  const scale = cmdScale(cmd.forwardMove, cmd.sideMove, RUN_SPEED)
  wishDirection(body, cmd, true)
  const wishspeed = normalizeVec3(wishdir, wishvel) * scale

  // A player still being knocked back accelerates as though airborne, so the
  // ground cannot cancel an explosion the instant they touch it.
  const accel = body.knockbackTicks > 0 ? PM_AIR_ACCELERATE : PM_ACCELERATE
  accelerate(body.velocity, wishdir, wishspeed, accel, dt)

  if (body.knockbackTicks > 0) body.velocity[2] -= GRAVITY * dt

  // Turn the velocity to lie along the ground, then put the speed back. Without
  // the restore, running up a ramp would cost exactly the fraction of the
  // velocity the slope removed, and every incline in the map would be a brake.
  const kept = lengthVec3(body.velocity)
  clipVelocity(body.velocity, body.velocity, body.groundNormal, OVERCLIP)
  normalizeVec3(body.velocity, body.velocity)
  scaleVec3(body.velocity, body.velocity, kept)

  // Standing still. Quake returns here rather than sweeping a zero-length move,
  // and so must this: `slideMove` seeds a clip plane from the normalised
  // velocity, and normalising a zero vector would seed the zero plane.
  if (body.velocity[0] === 0 && body.velocity[1] === 0) return

  stepSlideMove(world, body, dt, 0)
}

/* --------------------------------------------------------------------------
 * PM_AirMove
 * ----------------------------------------------------------------------- */

function airMove(world: CollisionWorld, body: PmoveBody, cmd: UserCmd, dt: number): void {
  // In the air this only ever performs the `speed < 1` snap to rest: ground
  // friction is gated on `walking`. Quake calls it here anyway and so do we,
  // because the gate belongs in one place.
  friction(body, dt)

  const scale = cmdScale(cmd.forwardMove, cmd.sideMove, RUN_SPEED)
  wishDirection(body, cmd, false)
  const wishspeed = normalizeVec3(wishdir, wishvel) * scale

  accelerate(body.velocity, wishdir, wishspeed, airAccelerationFor(body.velocity, wishdir), dt)

  // Airborne but resting against a slope too steep to walk on: slide down it
  // rather than sweeping into it every tick.
  if (body.groundPlane) {
    clipVelocity(body.velocity, body.velocity, body.groundNormal, OVERCLIP)
  }

  stepSlideMove(world, body, dt, GRAVITY)
}

/* --------------------------------------------------------------------------
 * The wish vector
 * ----------------------------------------------------------------------- */

/**
 * Write the un-normalised wish velocity into {@link wishvel}.
 *
 * The movement basis comes from **yaw alone**. Quake builds it from the full
 * view angles and then flattens it, which is the same horizontal direction by
 * the time it has been normalised — with the difference that looking straight
 * up leaves Quake normalising a near-zero vector. Taking yaw directly cannot
 * degenerate, and it makes "looking at the floor must not slow you down" a
 * property of the code rather than of a clamp elsewhere.
 *
 * `onGround` projects the basis onto the ground plane before normalising, which
 * is what lets a player run up a slope at full speed. In the air there is no
 * plane to project onto and the wish vector stays flat.
 */
function wishDirection(body: PmoveBody, cmd: UserCmd, onGround: boolean): void {
  angleVectors(0, cmd.yaw, 0, forward, right, null)

  if (onGround) {
    clipVelocity(forward, forward, body.groundNormal, OVERCLIP)
    clipVelocity(right, right, body.groundNormal, OVERCLIP)
    normalizeVec3(forward, forward)
    normalizeVec3(right, right)

    wishvel[0] = forward[0] * cmd.forwardMove + right[0] * cmd.sideMove
    wishvel[1] = forward[1] * cmd.forwardMove + right[1] * cmd.sideMove
    // Kept rather than zeroed: on a slope the wish velocity has to point up the
    // slope, or a player accelerating uphill is asking to walk into it.
    wishvel[2] = forward[2] * cmd.forwardMove + right[2] * cmd.sideMove
    return
  }

  wishvel[0] = forward[0] * cmd.forwardMove + right[0] * cmd.sideMove
  wishvel[1] = forward[1] * cmd.forwardMove + right[1] * cmd.sideMove
  wishvel[2] = 0
}

/**
 * Scratch. Module scope so a sub-step allocates nothing, and safe for the same
 * reason `slidemove.ts`'s is: the simulation is single-threaded and synchronous
 * by construction, with `await` a lint error inside this package. Every one of
 * these is fully written before it is read, and none survives the call that
 * wrote it — `walkMove` delegating to `airMove` hands them over and returns.
 */
const forward: MutVec3 = vec3()
const right: MutVec3 = vec3()
const wishvel: MutVec3 = vec3()
const wishdir: MutVec3 = vec3()
