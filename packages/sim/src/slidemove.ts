/**
 * `SlideMove`, `StepSlideMove` and the ground trace. Quake 3's
 * `bg_slidemove.c`, and `docs/physics-spec.md` §2.3-§2.5.
 *
 * This is the layer between "where would the body like to go" and "where does
 * the world let it go". It never decides *what* the velocity should be — that
 * is `pmove`'s job (`pmove/`) — only how a velocity survives contact.
 *
 * Three behaviours in here look like bugs and are not. Each is load-bearing for
 * something a Quake player can feel, and each is called out where it happens:
 *
 * - {@link OVERCLIP} removes 100.1% of the velocity into a surface, not 100%.
 * - A move that folds back on itself slides along the **crease** between two
 *   planes rather than picking one of them.
 * - Entering a third plane stops the body **dead**, rather than iterating.
 */

import type { Vec3 } from './axis.ts'
import type { CollisionWorld } from './collide.ts'
import {
  addScaledVec3,
  copyVec3,
  crossVec3,
  dotVec3,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  setVec3,
  vec3,
} from './math.ts'
import type { MutVec3 } from './math.ts'
import { createTrace, traceBox } from './trace.ts'

/**
 * How much of the velocity into a surface is removed. Quake 3's `OVERCLIP`.
 *
 * A hundred point one percent, and the extra tenth of a percent is the whole
 * point. Removing exactly the normal component leaves the body travelling
 * *along* the plane, which means resting on the plane, which means the next
 * tick's trace starts on the boundary — and a body that keeps re-contacting a
 * surface it is already touching accumulates hits until it grinds to a stop.
 * Reflecting a whisker past parallel pushes it off the surface instead.
 *
 * The two consequences a player feels:
 *
 * - **Landing bounces.** Arriving at 500 qu/s downward leaves +0.5 qu/s
 *   upward. It is imperceptible, and it is what keeps you from sticking.
 * - **Ramps are lossless.** Hitting a 45-degree ramp at 700 qu/s horizontal
 *   comes off it at (349.6, 350.4) — the speed is *rotated*, not spent. That
 *   is the ramp jump, and it is why this constant is not a tunable.
 */
export const OVERCLIP = 1.001

/** How many trace-and-clip iterations one move gets. Quake 3's `numbumps`. */
export const MAX_BUMPS = 4

/**
 * How many surfaces one move may be clipped against before it gives up and
 * stops. Quake 3's `MAX_CLIP_PLANES`.
 *
 * Five, and two of them are spoken for before the first trace: the ground
 * plane (so a move never turns down into the floor) and the original direction
 * of travel (so a move never reverses into the velocity it started with).
 */
export const MAX_CLIP_PLANES = 5

/** How high a body steps up without jumping, in Quake units. Quake 3's `STEPSIZE`. */
export const STEP_SIZE = 18

/**
 * The smallest `normal[2]` that counts as floor rather than as wall.
 *
 * Quake 3's `MIN_WALK_NORMAL`. 0.7 is a hair under `cos(45deg)`, so a
 * 45-degree ramp is walkable and anything steeper is not — which is why the
 * ramp that gives you a ramp jump is also one you can stand on.
 */
export const MIN_WALK_NORMAL = 0.7

/** How far down the ground trace looks, in Quake units. Quake 3's `-0.25`. */
export const GROUND_TRACE_DEPTH = 0.25

/**
 * The speed above which the trace stops being asked to be sane, in qu/s.
 *
 * Not a physics constant — a safety clamp, and the number is chosen from the
 * geometry rather than from the feel. At 3000 qu/s a body covers 24 units in
 * one 8 ms tick, which is still less than the 30-unit width of a player, so a
 * sweep spans at most two broadphase cells per axis and the four-bump budget
 * has enough room to resolve a corner. Nothing in normal play approaches it:
 * a good rocket jump peaks around 1000.
 *
 * It exists because velocity is an *input* from elsewhere — splash damage,
 * a knockback, a malicious client's reconciliation — and one absurd value
 * should not be able to put a body outside the world.
 */
export const MAX_MOVE_SPEED = 3000

/**
 * A body the collision layer can move: the player, and later the rocket.
 *
 * `origin` is the feet (`bbox.ts` §0.2) and everything is in the Quake frame.
 * `slideMove` and `stepSlideMove` mutate `origin` and `velocity` in place, in
 * keeping with the rest of the kernel — see the note in `AGENTS.md`.
 */
export type MoveBody = {
  origin: MutVec3
  velocity: MutVec3
  /** The box being swept, relative to `origin`. */
  mins: Vec3
  maxs: Vec3
  /**
   * Ticks of knockback left. Quake 3's `ps->pm_time`.
   *
   * While it is positive, `slideMove` restores the velocity it started with
   * once the move is done, discarding every clip along the way. That is what
   * makes a rocket jump feel like a rocket jump: you keep the speed the
   * explosion gave you even while you are scraping along a wall, instead of
   * having it filed off by the geometry you are sliding past.
   */
  knockbackTicks: number
  /** The last ground trace found a plane below. Quake 3's `pml.groundPlane`. */
  groundPlane: boolean
  /** That plane is shallow enough to walk on. Quake 3's `pml.walking`. */
  walking: boolean
  /** Normal of the plane below, or all zeroes. Meaningful when `groundPlane`. */
  groundNormal: MutVec3
}

/** A body at rest, in mid-air, with the standing player box. */
export function createMoveBody(mins: Vec3, maxs: Vec3): MoveBody {
  return {
    origin: vec3(),
    velocity: vec3(),
    mins,
    maxs,
    knockbackTicks: 0,
    groundPlane: false,
    walking: false,
    groundNormal: vec3(),
  }
}

/* --------------------------------------------------------------------------
 * PM_ClipVelocity
 * ----------------------------------------------------------------------- */

/**
 * Remove the component of `v` heading into `normal`, times `overbounce`.
 *
 * Quake 3's `PM_ClipVelocity`. `out` may alias `v`.
 *
 * The asymmetry — multiply when heading into the plane, *divide* when heading
 * out of it — is Quake's and is deliberate. A velocity already leaving the
 * surface is nudged very slightly towards it rather than away, which damps the
 * one case where the reflection would otherwise compound over successive ticks.
 */
export function clipVelocity(
  out: MutVec3,
  v: Vec3,
  normal: Vec3,
  overbounce: number,
): MutVec3 {
  let backoff = dotVec3(v, normal)
  if (backoff < 0) backoff *= overbounce
  else backoff /= overbounce

  out[0] = v[0] - normal[0] * backoff
  out[1] = v[1] - normal[1] * backoff
  out[2] = v[2] - normal[2] * backoff
  return out
}

/* --------------------------------------------------------------------------
 * The clip-plane set
 * ----------------------------------------------------------------------- */

/** The plane normals one move may be clipped against. Exactly {@link MAX_CLIP_PLANES}. */
export type ClipPlanes = [MutVec3, MutVec3, MutVec3, MutVec3, MutVec3]

/** A fresh, zeroed clip-plane set. */
export function createClipPlanes(): ClipPlanes {
  return [vec3(), vec3(), vec3(), vec3(), vec3()]
}

/**
 * `planes[index]`, spelled so the typechecker can see it is always there.
 *
 * `noUncheckedIndexedAccess` is on repo-wide, and it is right to be: everywhere
 * else in the sim an index might be out of range. Here it never is — the set is
 * exactly {@link MAX_CLIP_PLANES} long and every loop below is bounded by
 * `numPlanes`, which the caller never lets exceed it. Writing the five cases
 * out keeps the guarantee in the type system rather than in a comment, and
 * costs a predictable branch on a path that runs a few times per tick.
 */
function planeAt(planes: ClipPlanes, index: number): MutVec3 {
  if (index === 0) return planes[0]
  if (index === 1) return planes[1]
  if (index === 2) return planes[2]
  if (index === 3) return planes[3]
  return planes[4]
}

/**
 * How far into a plane a velocity must point before it counts as entering it.
 *
 * Quake 3's bare `0.1`, in qu/s. Sliding along a wall produces a velocity whose
 * dot product with that wall's normal is zero to within rounding, and without a
 * threshold every such tick would re-clip against a surface it is already
 * parallel to.
 */
const ENTERING_PLANE = 0.1

/**
 * Bend `velocity` until it no longer runs into any of the planes it has hit.
 * Returns `true` if the body was stopped dead, in which case both velocities
 * are zero.
 *
 * This is the interesting half of `PM_SlideMove`, split out because it is the
 * part with the two behaviours worth testing directly rather than through a
 * geometry fixture.
 *
 * The shape is three nested loops, and each level exists for a reason:
 *
 * 1. **One plane.** Clip the velocity to the first plane it is running into.
 *    A wall; you slide along it. This is the common case and it stops here.
 * 2. **Two planes.** If that slide runs into a *second* plane, clip to both.
 *    If the doubly-clipped velocity now points back into the first plane, the
 *    two clips are fighting: alternating between them is the classic corner
 *    jitter. The fix is to stop treating them as two surfaces and start
 *    treating them as one edge — the **crease**, `normalize(cross(pi, pj))` —
 *    and project the original velocity onto it. A body sliding into the corner
 *    of two walls travels along the seam.
 * 3. **Three planes.** If the crease itself runs into a third plane, there is
 *    no direction left. Stop dead. Not "clip again", not "zero the horizontal
 *    component" — zero, exactly, which is why the acceptance test can assert
 *    `=== 0` rather than a tolerance. Anything else jitters in the corner of a
 *    room forever.
 *
 * `endVelocity` is the without-gravity twin `slideMove` carries; it is bent by
 * exactly the same clips so that the gravity half-step does not accumulate a
 * velocity the geometry never allowed.
 */
export function slideVelocityAlongPlanes(
  velocity: MutVec3,
  endVelocity: MutVec3,
  planes: ClipPlanes,
  numPlanes: number,
): boolean {
  for (let i = 0; i < numPlanes; i += 1) {
    const planeI = planeAt(planes, i)
    if (dotVec3(velocity, planeI) >= ENTERING_PLANE) continue

    clipVelocity(clipped, velocity, planeI, OVERCLIP)
    clipVelocity(endClipped, endVelocity, planeI, OVERCLIP)

    for (let j = 0; j < numPlanes; j += 1) {
      if (j === i) continue
      const planeJ = planeAt(planes, j)
      if (dotVec3(clipped, planeJ) >= ENTERING_PLANE) continue

      clipVelocity(clipped, clipped, planeJ, OVERCLIP)
      clipVelocity(endClipped, endClipped, planeJ, OVERCLIP)

      // Still leaving the first plane: the two clips agree, nothing to fix.
      if (dotVec3(clipped, planeI) >= 0) continue

      // They disagree. Slide along the edge the two planes share instead.
      crossVec3(crease, planeI, planeJ)
      normalizeVec3(crease, crease)
      scaleVec3(clipped, crease, dotVec3(crease, velocity))
      scaleVec3(endClipped, crease, dotVec3(crease, endVelocity))

      for (let k = 0; k < numPlanes; k += 1) {
        if (k === i || k === j) continue
        if (dotVec3(clipped, planeAt(planes, k)) >= ENTERING_PLANE) continue
        setVec3(velocity, 0, 0, 0)
        setVec3(endVelocity, 0, 0, 0)
        return true
      }
    }

    copyVec3(velocity, clipped)
    copyVec3(endVelocity, endClipped)
    break
  }

  return false
}

const clipped = vec3()
const endClipped = vec3()
const crease = vec3()

/* --------------------------------------------------------------------------
 * PM_SlideMove
 * ----------------------------------------------------------------------- */

/**
 * Move the body by `dt` seconds, sliding along whatever it hits.
 *
 * Returns `true` if it touched anything — which is what `stepSlideMove` uses to
 * decide whether trying the move again from a step-height up is worth the four
 * extra traces.
 *
 * `gravity` is in qu/s^2, and zero means none. When it is on, the move is
 * integrated with the velocity at the *midpoint* of the tick and the endpoint
 * velocity is carried separately — Quake's trick for making a jump arc
 * independent of the tick rate, and the reason `endVelocity` is threaded
 * through every clip below.
 */
export function slideMove(
  world: CollisionWorld,
  body: MoveBody,
  dt: number,
  gravity: number,
): boolean {
  const { origin, velocity } = body

  copyVec3(primalVelocity, velocity)
  copyVec3(endVelocity, velocity)

  if (gravity !== 0) {
    endVelocity[2] = velocity[2] - gravity * dt
    velocity[2] = (velocity[2] + endVelocity[2]) * 0.5
    primalVelocity[2] = endVelocity[2]
    // Gravity was just added to a body standing on a slope; take it back out
    // along the slope, or it spends the tick pressing into the floor.
    if (body.groundPlane) clipVelocity(velocity, velocity, body.groundNormal, OVERCLIP)
  }

  let timeLeft = dt

  // Two planes are seeded before anything is traced. Never turn down into the
  // ground you are standing on, and never turn back against the direction you
  // set off in — without the second, a body wedged between two surfaces can be
  // clipped into reversing, which reads as being spat out of a wall.
  let numPlanes = 0
  if (body.groundPlane) {
    copyVec3(planes[0], body.groundNormal)
    numPlanes = 1
  }
  normalizeVec3(planeAt(planes, numPlanes), velocity)
  numPlanes += 1

  let bumps = 0
  for (; bumps < MAX_BUMPS; bumps += 1) {
    addScaledVec3(moveEnd, origin, velocity, timeLeft)
    traceBox(moveTrace, world, origin, moveEnd, body.mins, body.maxs)

    if (moveTrace.allsolid) {
      // Buried in geometry. Keep the horizontal velocity so the body can be
      // walked out of it, but stop building up a fall.
      velocity[2] = 0
      return true
    }

    if (moveTrace.fraction > 0) copyVec3(origin, moveTrace.endpos)
    if (moveTrace.fraction === 1) break

    timeLeft -= timeLeft * moveTrace.fraction

    if (numPlanes >= MAX_CLIP_PLANES) {
      // More surfaces than a convex corner can have. Something is wrong with
      // the geometry; stopping is the one response that cannot make it worse.
      setVec3(velocity, 0, 0, 0)
      return true
    }

    // Hitting a plane already in the set means the epsilon left the body a
    // whisker inside it. Nudge out along the normal rather than adding a
    // duplicate plane, which would burn a clip-plane slot for nothing.
    let repeated = false
    for (let i = 0; i < numPlanes; i += 1) {
      if (dotVec3(moveTrace.planeNormal, planeAt(planes, i)) > 0.99) {
        velocity[0] += moveTrace.planeNormal[0]
        velocity[1] += moveTrace.planeNormal[1]
        velocity[2] += moveTrace.planeNormal[2]
        repeated = true
        break
      }
    }
    if (repeated) continue

    copyVec3(planeAt(planes, numPlanes), moveTrace.planeNormal)
    numPlanes += 1

    if (slideVelocityAlongPlanes(velocity, endVelocity, planes, numPlanes)) {
      // Stopped dead in a corner. Returning here is deliberate: neither the
      // gravity restore nor the knockback restore below may resurrect the
      // velocity the corner just took away.
      return true
    }
  }

  if (gravity !== 0) copyVec3(velocity, endVelocity)

  // The knockback restore. See {@link MoveBody.knockbackTicks} — every clip
  // this move performed is thrown away, on purpose.
  if (body.knockbackTicks > 0) copyVec3(velocity, primalVelocity)

  return bumps !== 0
}

const primalVelocity = vec3()
const endVelocity = vec3()
const moveEnd = vec3()
const moveTrace = createTrace()
const planes = createClipPlanes()

/* --------------------------------------------------------------------------
 * PM_StepSlideMove
 * ----------------------------------------------------------------------- */

/**
 * {@link slideMove}, and if it hit something, try it again from a step up.
 *
 * This is why stairs work without a ramp under them, and why a 16-unit lip does
 * not stop a sprint. The move is attempted normally; if it was obstructed, the
 * body is lifted by {@link STEP_SIZE}, the move is retried from there, and then
 * it is pushed back down by however far it was lifted. Landing on top of the
 * obstruction is what "climbing a step" is.
 *
 * **You never step up while rising.** A body with upward velocity that is not
 * standing on a walkable surface is jumping, and letting a jump grab a 18-unit
 * free ride at the apex is how you get a player mantling onto ledges they
 * should have had to rocket-jump to.
 */
export function stepSlideMove(
  world: CollisionWorld,
  body: MoveBody,
  dt: number,
  gravity: number,
): void {
  copyVec3(stepStartOrigin, body.origin)
  copyVec3(stepStartVelocity, body.velocity)

  // Went exactly where it wanted to on the first try; there is no step to take.
  if (!slideMove(world, body, dt, gravity)) return

  copyVec3(stepProbe, stepStartOrigin)
  stepProbe[2] -= STEP_SIZE
  traceBox(stepTrace, world, stepStartOrigin, stepProbe, body.mins, body.maxs)

  if (
    body.velocity[2] > 0 &&
    (stepTrace.fraction === 1 || stepTrace.planeNormal[2] < MIN_WALK_NORMAL)
  ) {
    return
  }

  copyVec3(stepProbe, stepStartOrigin)
  stepProbe[2] += STEP_SIZE
  traceBox(stepTrace, world, stepStartOrigin, stepProbe, body.mins, body.maxs)
  if (stepTrace.allsolid) return

  // However far up it actually got — a low ceiling gives less than STEP_SIZE,
  // and the push-down at the end has to match, or the body gains height.
  const stepped = stepTrace.endpos[2] - stepStartOrigin[2]
  copyVec3(body.origin, stepTrace.endpos)
  copyVec3(body.velocity, stepStartVelocity)

  slideMove(world, body, dt, gravity)

  copyVec3(stepProbe, body.origin)
  stepProbe[2] -= stepped
  traceBox(stepTrace, world, body.origin, stepProbe, body.mins, body.maxs)
  if (!stepTrace.allsolid) copyVec3(body.origin, stepTrace.endpos)
  if (stepTrace.fraction < 1) {
    clipVelocity(body.velocity, body.velocity, stepTrace.planeNormal, OVERCLIP)
  }
}

const stepStartOrigin = vec3()
const stepStartVelocity = vec3()
const stepProbe = vec3()
const stepTrace = createTrace()

/* --------------------------------------------------------------------------
 * PM_GroundTrace
 * ----------------------------------------------------------------------- */

/**
 * Decide whether the body is standing on something, and on what.
 *
 * A quarter-unit downward sweep of the body's own box. Quarter of a unit
 * because the trace epsilon leaves a body resting an eighth of a unit clear of
 * the floor, so anything shorter would report a player standing still as
 * airborne every other tick.
 *
 * Sets `groundPlane`, `walking` and `groundNormal`, and nothing else — it does
 * not move the body and does not touch its velocity.
 *
 * The kick-off rule is the subtle part. A body that is *moving upward* and
 * moving away from the surface at more than 10 qu/s is not standing on it, even
 * though the trace still finds it an eighth of a unit below. Without that rule
 * the tick a jump starts on still counts as grounded, friction is applied to a
 * player who has already left the floor, and every jump comes out shorter than
 * the one before it in a way no constant will fix.
 */
export function groundTrace(world: CollisionWorld, body: MoveBody): void {
  setVec3(groundProbe, body.origin[0], body.origin[1], body.origin[2] - GROUND_TRACE_DEPTH)
  traceBox(groundResult, world, body.origin, groundProbe, body.mins, body.maxs)

  if (groundResult.allsolid && !correctAllSolid(world, body)) {
    body.groundPlane = false
    body.walking = false
    setVec3(body.groundNormal, 0, 0, 0)
    return
  }

  if (groundResult.fraction === 1) {
    body.groundPlane = false
    body.walking = false
    setVec3(body.groundNormal, 0, 0, 0)
    return
  }

  if (
    body.velocity[2] > 0 &&
    dotVec3(body.velocity, groundResult.planeNormal) > KICK_OFF_SPEED
  ) {
    body.groundPlane = false
    body.walking = false
    setVec3(body.groundNormal, 0, 0, 0)
    return
  }

  copyVec3(body.groundNormal, groundResult.planeNormal)
  body.groundPlane = true
  body.walking = groundResult.planeNormal[2] >= MIN_WALK_NORMAL
}

/**
 * How fast a body must be leaving a surface to stop counting as on it, qu/s.
 * Quake 3's bare `10`.
 */
const KICK_OFF_SPEED = 10

/**
 * Last resort for a body that has ended up inside geometry: nudge it a unit at
 * a time until it is not, and redo the ground trace from there.
 *
 * Returns whether it found somewhere free. Quake 3 has this function and — in a
 * quirk of the released source — never actually moves the body with it, only
 * re-traces from where it already was. Gladiator does move it, because the only
 * reason to have the function at all is that being stuck is unrecoverable and
 * a fuzz gate that says "never penetrating by more than 0.03 units" has to mean
 * it.
 *
 * A one-unit nudge cannot push a body through anything it was not already
 * inside, and it is only reachable from a state that should not occur.
 */
function correctAllSolid(world: CollisionWorld, body: MoveBody): boolean {
  for (let x = -1; x <= 1; x += 1) {
    for (let y = -1; y <= 1; y += 1) {
      for (let z = -1; z <= 1; z += 1) {
        setVec3(
          nudge,
          body.origin[0] + x,
          body.origin[1] + y,
          body.origin[2] + z,
        )
        traceBox(groundResult, world, nudge, nudge, body.mins, body.maxs)
        if (groundResult.allsolid) continue

        copyVec3(body.origin, nudge)
        setVec3(groundProbe, nudge[0], nudge[1], nudge[2] - GROUND_TRACE_DEPTH)
        traceBox(groundResult, world, body.origin, groundProbe, body.mins, body.maxs)
        return true
      }
    }
  }
  return false
}

const groundProbe = vec3()
const groundResult = createTrace()
const nudge = vec3()

/* --------------------------------------------------------------------------
 * The speed clamp
 * ----------------------------------------------------------------------- */

/**
 * Clamp `velocity` to {@link MAX_MOVE_SPEED} in place. Returns the speed after
 * clamping.
 *
 * Scales the whole vector rather than each axis, so the direction of travel is
 * preserved. Clamping per axis — which is what Quake 1's `sv_maxvelocity` did —
 * turns a fast diagonal into a differently-aimed fast diagonal.
 */
export function clampMoveSpeed(velocity: MutVec3): number {
  const speed = lengthVec3(velocity)
  if (speed <= MAX_MOVE_SPEED) return speed
  scaleVec3(velocity, velocity, MAX_MOVE_SPEED / speed)
  return MAX_MOVE_SPEED
}
