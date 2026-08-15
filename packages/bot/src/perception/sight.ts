/**
 * The sight channel: a cone, a range gate, and three rays.
 *
 * The output is a **fraction**, not a boolean, and that is the whole design.
 * Two thresholds sit on it — {@link ACQUIRE_VISIBILITY} to start tracking
 * somebody and anything above zero to keep tracking them — which is what makes
 * cover work in both directions: hard to spot a body behind a railing, easy to
 * stay on one you already have.
 *
 * Q3 computes the equivalent with `BotEntityVisible`, and then throws the
 * asymmetry away by calling it with a 360-degree FOV from the aim code. There
 * is exactly one entry point here, so there is nowhere for a second, wider
 * caller to appear.
 *
 * ## Nothing in this file allocates
 *
 * It runs three traces per opponent per sub-step, 125 times a second, so the
 * scratch is module-level — the same arrangement, and the same justification,
 * as `sim/trace.ts`: single-threaded and synchronous, with no `await` anywhere
 * on the path.
 */

import { cosRad, createTrace, dotVec3, traceRay, vec3 } from '@gladiator/sim'
import type { CollisionWorld, MutVec3, TraceResult, Vec3 } from '@gladiator/sim'

import { SIGHT_SAMPLES } from './worldModel.ts'

/** Radians per degree. Written out because the sim's angles are not radians. */
const RADIANS_PER_DEGREE = 0.017453292519943295

/**
 * The cosine of half a cone, given its full width in degrees.
 *
 * Half, because the test is against the angle between the look direction and
 * the target — which is measured from the centre line, not across the cone.
 * Getting this wrong gives a bot with a 200-degree field of view that appears
 * to work.
 */
export function coneCosine(fovDegrees: number): number {
  return cosRad(fovDegrees * 0.5 * RADIANS_PER_DEGREE)
}

/** Scratch. See the header. */
const trace: TraceResult = createTrace()
const sample: MutVec3 = vec3()
const toSample: MutVec3 = vec3()

/**
 * Whether `point` is inside the cone of half-cosine `cosHalf` about `forward`,
 * seen from `eye`.
 *
 * A point *at* the eye counts as inside: a body close enough to be standing on
 * you is not something you fail to notice, and the alternative is a division by
 * zero.
 */
export function inCone(eye: Vec3, forward: Vec3, cosHalf: number, point: Vec3): boolean {
  toSample[0] = point[0] - eye[0]
  toSample[1] = point[1] - eye[1]
  toSample[2] = point[2] - eye[2]
  const distance = Math.sqrt(
    toSample[0] * toSample[0] + toSample[1] * toSample[1] + toSample[2] * toSample[2],
  )
  if (distance === 0) return true
  return dotVec3(toSample, forward) / distance >= cosHalf
}

/**
 * Whether an unobstructed straight line runs from `eye` to `point`.
 *
 * A point trace, which is the same swept-box code with a zero-extent box
 * (`sim/trace.ts`) — so line of sight and a railgun shot agree about what a
 * wall is, by construction rather than by review.
 */
export function lineOfSight(world: CollisionWorld, eye: Vec3, point: Vec3): boolean {
  return traceRay(trace, world, eye, point).fraction === 1
}

/**
 * How much of the body standing at `origin` the bot can see, in `[0, 1]`.
 *
 * Zero if the body is beyond `range`. Otherwise each of {@link SIGHT_SAMPLES}
 * is tested against the cone *and* against the geometry, and the answer is the
 * total share of the ones that passed both.
 *
 * The cone is tested per sample rather than once against the centre, so a
 * player edging out from behind a corner at the very rim of the field of view
 * is partially visible, which is what a fraction is for.
 */
export function visibilityFraction(
  world: CollisionWorld,
  eye: Vec3,
  forward: Vec3,
  cosHalf: number,
  range: number,
  origin: Vec3,
): number {
  const dx = origin[0] - eye[0]
  const dy = origin[1] - eye[1]
  const dz = origin[2] - eye[2]
  if (dx * dx + dy * dy + dz * dz > range * range) return 0

  let seen = 0
  for (const [height, weight] of SIGHT_SAMPLES) {
    sample[0] = origin[0]
    sample[1] = origin[1]
    sample[2] = origin[2] + height
    if (!inCone(eye, forward, cosHalf, sample)) continue
    if (!lineOfSight(world, eye, sample)) continue
    seen += weight
  }

  return seen
}
