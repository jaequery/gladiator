/**
 * Where to put a rocket. GLAD-HK3ATM.
 *
 * **Splash-at-the-feet is the primary mode, not the fallback.** A direct rocket
 * on a strafing duellist is a coin flip; 100 damage at the centre with linear
 * falloff over 120 units means an explosion 60 units off still deals 50. So the
 * bot evaluates two candidate aim points every decision and takes the better
 * one, and on a moving target the better one is almost always the floor.
 *
 * That is a comparison rather than a rule, which matters: against somebody
 * standing still at point-blank range the direct shot genuinely is better, and
 * the same two lines say so without a special case.
 *
 * ## Leading
 *
 * The intercept quadratic — solve `|P + Vt - M| = St` for the smallest positive
 * `t` — with two corrections and one refusal.
 *
 * - **A lag term**, and it is *negative*. A rocket's trajectory clock starts
 *   {@link MISSILE_PRESTEP_MS} in the past (`projectile.ts`), so it is already
 *   45 units downrange on the tick it is fired, while the command carrying the
 *   shot costs one sub-step to reach the world. The net is 42 ms of head start,
 *   derived from those two constants rather than tuned.
 * - **Clamped to {@link LEAD_MAX_SECONDS}.** Past half a second, linear
 *   extrapolation of a duellist is fantasy: they have had time to touch a wall,
 *   change direction twice and jump. Leading further does not aim better, it
 *   aims at a place nobody was ever going.
 * - **Do not lead a jittering target at all.** If the net displacement over the
 *   last {@link PATH_WINDOW_TICKS} divided by the path length is under
 *   {@link LEAD_STRAIGHTNESS}, they are strafing in place rather than
 *   travelling, and their velocity says nothing about where they will be. The
 *   bot aims at where they are and lets the splash radius do the work.
 *
 * ## The miss radius is what the two candidates are compared under
 *
 * One number, two sources, and both are honest about what the bot does not know:
 *
 * - the **aim error**, proportional to how far the candidate is from the
 *   believed body centre (`aim/error.ts`) — which is large for a lead and small
 *   for a splash at the feet, and is the entire reason leading is expensive;
 * - the **evasion**, how far the target could get to that the reckoning did not
 *   predict: their speed times the flight time times how *unpredictable* they
 *   have been. A straight-line runner contributes nothing here and a jitterer
 *   contributes all of it.
 *
 * `combat/damage.ts` turns that radius into two expectations. Nothing else in
 * this file decides anything.
 */

import {
  DAMAGE_ORIGIN_HEIGHT,
  MISSILE_PRESTEP_MS,
  PLAYER_MAXS,
  PLAYER_MINS,
  ROCKET_SPEED,
  TICK_INTERVAL_MS,
  createTrace,
  distanceToBox,
  rayBoxFraction,
  traceRay,
  vec3,
} from '@gladiator/sim'
import type { CollisionWorld, MutVec3, TraceResult, Vec3 } from '@gladiator/sim'

import { errorRadius } from '../aim/error.ts'
import type { AimTrack } from '../aim/error.ts'
import { SPLASH_RADIUS, expectedDirect, expectedSplash } from './damage.ts'

/* --------------------------------------------------------------------------
 * Leading
 * ----------------------------------------------------------------------- */

/** The longest lead worth computing, in seconds. See the header. */
export const LEAD_MAX_SECONDS = 0.5

/**
 * The rocket's head start, in seconds, net of the command's own latency.
 *
 * Negative, and derived: the trajectory clock starts 50 ms in the past and the
 * command costs one 8 ms sub-step to reach the world, so a rocket arrives 42 ms
 * sooner than `distance / speed` says. Deriving it means the day either constant
 * moves, the lead moves with it.
 */
export const LEAD_LAG_SECONDS = (TICK_INTERVAL_MS - MISSILE_PRESTEP_MS) / 1000

/**
 * The straightness below which a target is jittering rather than travelling.
 *
 * Net displacement over path length, on a window of {@link PATH_WINDOW_TICKS}.
 * A player running a corridor scores close to 1; a player strafing left and
 * right in front of you covers a lot of ground and ends up where they started,
 * so they score near 0. **0.45** sits between "changing direction while going
 * somewhere" and "going nowhere on purpose".
 */
export const LEAD_STRAIGHTNESS = 0.45

/** Sub-steps between path samples. Four is 32 ms, well under any real juke. */
export const PATH_SAMPLE_TICKS = 4

/** How many samples the path keeps. 16 at 4 sub-steps each is 512 ms. */
export const PATH_SAMPLES = 16

/** The window the straightness is measured over, in sub-steps. */
export const PATH_WINDOW_TICKS = PATH_SAMPLE_TICKS * (PATH_SAMPLES - 1)

/**
 * Where the target has been, as a ring of samples.
 *
 * Positions only, and only the believed ones — this is a fold over what the
 * `WorldModel` said, not a window on to the opponent's body. A belief that was
 * remembered rather than seen is dead-reckoned by `perception/memory.ts` and
 * therefore scores as perfectly straight, which is the honest answer: the bot
 * has no evidence of a juke it did not see.
 */
export type TargetPath = {
  readonly samples: MutVec3[]
  /** How many of {@link samples} hold anything. */
  count: number
  /** Where the next sample goes. */
  head: number
  /** The sub-step the newest sample was taken on. */
  lastTick: number
}

export function createPath(): TargetPath {
  const samples: MutVec3[] = []
  for (let i = 0; i < PATH_SAMPLES; i += 1) samples.push(vec3())
  return { samples, count: 0, head: 0, lastTick: -1 }
}

/** Forget the path. A round boundary, a death, a contact that decayed away. */
export function clearPath(path: TargetPath): void {
  path.count = 0
  path.head = 0
  path.lastTick = -1
}

/** Take a sample if one is due. Call it every sub-step there is a belief. */
export function samplePath(path: TargetPath, tick: number, origin: Vec3): void {
  if (path.lastTick >= 0 && tick - path.lastTick < PATH_SAMPLE_TICKS) return

  const slot = path.samples[path.head]
  if (slot === undefined) return
  slot[0] = origin[0]
  slot[1] = origin[1]
  slot[2] = origin[2]

  path.head = (path.head + 1) % PATH_SAMPLES
  if (path.count < PATH_SAMPLES) path.count += 1
  path.lastTick = tick
}

/**
 * Net displacement over path length, in `[0, 1]`.
 *
 * **Zero when there is not enough history**, which is deliberately the
 * pessimistic end: a target the bot has only just seen is one it has no reason
 * to believe is running in a straight line, so it does not lead them. A target
 * that has not moved at all scores 1, and leading them is a no-op anyway.
 */
export function straightness(path: TargetPath): number {
  if (path.count < 2) return 0

  const oldest = path.samples[(path.head - path.count + PATH_SAMPLES) % PATH_SAMPLES]
  const newest = path.samples[(path.head - 1 + PATH_SAMPLES) % PATH_SAMPLES]
  if (oldest === undefined || newest === undefined) return 0

  let length = 0
  for (let i = 1; i < path.count; i += 1) {
    const a = path.samples[(path.head - path.count + i - 1 + PATH_SAMPLES) % PATH_SAMPLES]
    const b = path.samples[(path.head - path.count + i + PATH_SAMPLES) % PATH_SAMPLES]
    if (a === undefined || b === undefined) continue
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    const dz = b[2] - a[2]
    length += Math.sqrt(dx * dx + dy * dy + dz * dz)
  }
  if (length === 0) return 1

  const nx = newest[0] - oldest[0]
  const ny = newest[1] - oldest[1]
  const nz = newest[2] - oldest[2]
  return Math.sqrt(nx * nx + ny * ny + nz * nz) / length
}

/**
 * The time a rocket fired from `muzzle` takes to intercept a target at `origin`
 * travelling at `velocity`, in seconds, or `0` when there is no interception.
 *
 * The quadratic `(V.V - S^2) t^2 + 2 (D.V) t + D.D = 0` with `D = P - M`. The
 * leading coefficient is negative for any target slower than a rocket, so there
 * is exactly one positive root and the sign work reduces to taking it.
 */
export function interceptSeconds(muzzle: Vec3, origin: Vec3, velocity: Vec3): number {
  const dx = origin[0] - muzzle[0]
  const dy = origin[1] - muzzle[1]
  const dz = origin[2] - muzzle[2]

  const a = velocity[0] * velocity[0] + velocity[1] * velocity[1] + velocity[2] * velocity[2] -
    ROCKET_SPEED * ROCKET_SPEED
  const b = 2 * (dx * velocity[0] + dy * velocity[1] + dz * velocity[2])
  const c = dx * dx + dy * dy + dz * dz

  if (a === 0) return b === 0 ? 0 : -c / b
  const discriminant = b * b - 4 * a * c
  if (discriminant < 0) return 0

  const root = Math.sqrt(discriminant)
  const first = (-b + root) / (2 * a)
  const second = (-b - root) / (2 * a)
  if (first > 0 && second > 0) return first < second ? first : second
  if (first > 0) return first
  return second > 0 ? second : 0
}

/* --------------------------------------------------------------------------
 * The shot
 * ----------------------------------------------------------------------- */

/**
 * Which of the two candidates won, or that neither did.
 *
 * `'none'` is a real answer and it means the bot has nothing worth pointing a
 * rocket at — no belief, or a belief with no reachable surface and no body.
 */
export type ShotMode = 'none' | 'direct' | 'splash'

/** The standing decision about how to shoot, taken at the decision rate. */
export type ShotPlan = {
  mode: ShotMode
  /** Seconds of lead folded into the predicted position. */
  lead: number
  /** Expected damage from the splash candidate, in points. */
  splashExpected: number
  /** Expected damage from the direct candidate, in points. */
  directExpected: number
  /** The miss radius both were evaluated under, in Quake units. */
  missRadius: number
  /** How straight the target's recent path was, in `[0, 1]`. */
  straight: number
  /** Whether a surface was found to splash against. */
  hasSurface: boolean
  /** The surface point, when there is one, as it was at plan time. */
  readonly surface: MutVec3
  /**
   * Where to aim relative to the *predicted* target position.
   *
   * The plan is taken at the decision rate and the aim is built at the tick
   * rate, so what crosses between them is an offset rather than a point: a
   * frozen world point would staircase the view six sub-steps at a time, and
   * re-tracing for a surface every sub-step would be five traces nobody needs
   * to pay for. "Their feet" and "their chest" are both constants in the
   * target's own frame, which is exactly what an offset is.
   */
  readonly offset: MutVec3
}

export function createPlan(): ShotPlan {
  return {
    mode: 'none',
    lead: 0,
    splashExpected: 0,
    directExpected: 0,
    missRadius: 0,
    straight: 0,
    hasSurface: false,
    surface: vec3(),
    offset: vec3(),
  }
}

/**
 * The plan for a weapon that has no splash to place: aim at the middle of the
 * body, now.
 *
 * The railgun's whole plan, and the fallback for a bot with no geometry to
 * splash against. There is no lead in it: a hitscan shot arrives on the sub-step
 * it is fired, and the host rewinds the target to where the shooter saw them
 * anyway (`sim/lagcomp.ts`), so leading one would be aiming at where they will
 * be with a weapon that hits where they were.
 */
export function planDirect(plan: ShotPlan): ShotPlan {
  plan.mode = 'direct'
  plan.lead = 0
  plan.splashExpected = 0
  plan.directExpected = 0
  plan.missRadius = 0
  plan.hasSurface = false
  plan.offset[0] = 0
  plan.offset[1] = 0
  plan.offset[2] = DAMAGE_ORIGIN_HEIGHT
  return plan
}

/* Scratch. Single-threaded and synchronous; see `perception/sight.ts`. */
const predicted: MutVec3 = vec3()
const reference: MutVec3 = vec3()
const candidate: MutVec3 = vec3()
const probeFrom: MutVec3 = vec3()
const probeTo: MutVec3 = vec3()
const shotDir: MutVec3 = vec3()
const probe: TraceResult = createTrace()

/**
 * Choose between splashing and shooting at the body, from `muzzle` at the target
 * the bot is tracking.
 *
 * `world` may be `null` — a bot handed no level data (`bot.ts`) cannot probe for
 * a floor, so it has no splash candidate and shoots at bodies. That is the
 * configuration the perception fixture runs in, and it is a real one rather than
 * a test affordance: the splash point is a claim about geometry, and a bot with
 * no geometry has nothing to claim.
 */
export function planRocket(
  plan: ShotPlan,
  world: CollisionWorld | null,
  muzzle: Vec3,
  track: AimTrack,
  path: TargetPath,
): ShotPlan {
  plan.mode = 'none'
  plan.lead = 0
  plan.splashExpected = 0
  plan.directExpected = 0
  plan.missRadius = 0
  plan.hasSurface = false

  if (!track.live) return plan

  const straight = straightness(path)
  plan.straight = straight

  const speed = Math.sqrt(
    track.velocity[0] * track.velocity[0] +
      track.velocity[1] * track.velocity[1] +
      track.velocity[2] * track.velocity[2],
  )

  // The lead, and the refusal to take one on a target that is going nowhere.
  let lead = 0
  if (straight >= LEAD_STRAIGHTNESS && speed > 0) {
    lead = interceptSeconds(muzzle, track.origin, track.velocity) + LEAD_LAG_SECONDS
    if (lead < 0) lead = 0
    if (lead > LEAD_MAX_SECONDS) lead = LEAD_MAX_SECONDS
  }
  plan.lead = lead

  predicted[0] = track.origin[0] + track.velocity[0] * lead
  predicted[1] = track.origin[1] + track.velocity[1] * lead
  predicted[2] = track.origin[2] + track.velocity[2] * lead

  // What the bot can see, which is what its aim error is measured against.
  reference[0] = track.origin[0]
  reference[1] = track.origin[1]
  reference[2] = track.origin[2] + DAMAGE_ORIGIN_HEIGHT

  const dx = predicted[0] - muzzle[0]
  const dy = predicted[1] - muzzle[1]
  const dz = predicted[2] - muzzle[2]
  const range = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const flight = range / ROCKET_SPEED

  // How far the target could get to that the reckoning did not predict. Zero for
  // a straight-line runner and everything for a jitterer, which is the whole
  // difference between the two.
  const evasion = speed * flight * (1 - straight)

  /* ---- the direct candidate ---- */
  candidate[0] = predicted[0]
  candidate[1] = predicted[1]
  candidate[2] = predicted[2] + DAMAGE_ORIGIN_HEIGHT
  const directRadius = errorRadius(candidate, reference) + evasion
  plan.directExpected = expectedDirect(directRadius)

  /* ---- the splash candidate ---- */
  if (world !== null && findSurface(world, muzzle, predicted)) {
    plan.hasSurface = true
    plan.surface[0] = probe.endpos[0]
    plan.surface[1] = probe.endpos[1]
    plan.surface[2] = probe.endpos[2]
    const splashRadius = errorRadius(plan.surface, reference) + evasion
    const gap = distanceToBox(plan.surface, predicted, PLAYER_MINS, PLAYER_MAXS)
    plan.splashExpected = expectedSplash(gap, splashRadius)
    plan.missRadius = splashRadius
  }

  if (plan.hasSurface && plan.splashExpected > plan.directExpected) {
    plan.mode = 'splash'
    plan.offset[0] = plan.surface[0] - predicted[0]
    plan.offset[1] = plan.surface[1] - predicted[1]
    plan.offset[2] = plan.surface[2] - predicted[2]
    return plan
  }

  plan.mode = 'direct'
  plan.missRadius = directRadius
  plan.offset[0] = 0
  plan.offset[1] = 0
  plan.offset[2] = DAMAGE_ORIGIN_HEIGHT
  return plan
}

/**
 * Find something for the rocket to burst against near the target, leaving it in
 * {@link probe}. Returns whether there is one.
 *
 * The floor first, because that is where a duel is fought and because a floor
 * hit is the one that reaches a body standing on it at distance zero. If there
 * is none within a splash radius — the target is airborne, or over a pit — the
 * wall *behind* them will do, and finding it is the same trace continued past
 * them along the line of the shot.
 *
 * Beyond a splash radius in either direction there is nothing worth finding: an
 * explosion further away than that deals nothing by construction
 * (`combat/damage.ts`).
 */
function findSurface(world: CollisionWorld, muzzle: Vec3, target: Vec3): boolean {
  // Start a unit above the feet: exactly on the floor plane the point trace
  // reports `startsolid` and comes back with the target's own position, which
  // would read as a perfect splash against nothing.
  probeFrom[0] = target[0]
  probeFrom[1] = target[1]
  probeFrom[2] = target[2] + 1
  probeTo[0] = target[0]
  probeTo[1] = target[1]
  probeTo[2] = target[2] - SPLASH_RADIUS
  if (traceRay(probe, world, probeFrom, probeTo).fraction < 1) return true

  const dx = target[0] - muzzle[0]
  const dy = target[1] - muzzle[1]
  const dz = target[2] - muzzle[2]
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz)
  if (length === 0) return false
  shotDir[0] = dx / length
  shotDir[1] = dy / length
  shotDir[2] = dz / length

  probeFrom[0] = target[0]
  probeFrom[1] = target[1]
  probeFrom[2] = target[2] + DAMAGE_ORIGIN_HEIGHT
  probeTo[0] = probeFrom[0] + shotDir[0] * SPLASH_RADIUS
  probeTo[1] = probeFrom[1] + shotDir[1] * SPLASH_RADIUS
  probeTo[2] = probeFrom[2] + shotDir[2] * SPLASH_RADIUS
  return traceRay(probe, world, probeFrom, probeTo).fraction < 1
}

/* --------------------------------------------------------------------------
 * Where the rocket will actually go
 * ----------------------------------------------------------------------- */

/**
 * How far a rocket is followed when working out where it will burst, in units.
 *
 * Two splash radii. Past that an explosion cannot reach the player who fired it
 * (`combat/selfDamage.ts` is the only caller that cares), so following it
 * further is arithmetic with no consequence.
 */
export const IMPACT_PROBE = SPLASH_RADIUS * 2

/**
 * Where a rocket fired from `muzzle` along `dir` will detonate, written into
 * `out`. Returns whether it will detonate inside {@link IMPACT_PROBE}.
 *
 * The world, and then the one body the bot believes in — in that order and
 * taking whichever is nearer, which is what `projectile.ts` does with the real
 * entity list. `enemy` may be `null` for a bot that believes in nobody; that
 * makes the prediction *less* conservative about self-damage in exactly the case
 * where there is nothing near enough to detonate against early, which is why it
 * is allowed to be absent rather than assumed to be somewhere.
 */
export function predictImpact(
  out: MutVec3,
  world: CollisionWorld,
  muzzle: Vec3,
  dir: Vec3,
  enemy: Vec3 | null,
): boolean {
  probeTo[0] = muzzle[0] + dir[0] * IMPACT_PROBE
  probeTo[1] = muzzle[1] + dir[1] * IMPACT_PROBE
  probeTo[2] = muzzle[2] + dir[2] * IMPACT_PROBE

  traceRay(probe, world, muzzle, probeTo)
  let fraction = probe.fraction

  if (enemy !== null) {
    const body = rayBoxFraction(muzzle, probeTo, enemy, PLAYER_MINS, PLAYER_MAXS)
    if (body < fraction) fraction = body
  }

  if (fraction === 1) return false

  out[0] = muzzle[0] + (probeTo[0] - muzzle[0]) * fraction
  out[1] = muzzle[1] + (probeTo[1] - muzzle[1]) * fraction
  out[2] = muzzle[2] + (probeTo[2] - muzzle[2]) * fraction
  return true
}
