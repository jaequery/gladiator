/**
 * The three things that stop the bot from being a turret. GLAD-HK3ATM.
 *
 * Every one of them is an error the *bot* makes, layered on top of a
 * `WorldModel` that is already only as good as what the bot perceived. They are
 * in this order because that is the order they compound in: what it is tracking,
 * where it points at what it is tracking, and how well its hands execute.
 *
 * ## 1. Reaction is an interpolation, not a delay
 *
 * The obvious model — freeze for 200 ms, then snap to the truth — is wrong in a
 * way players read immediately: it makes the bot *perfect* the instant the timer
 * expires, and a target that keeps moving is tracked with no error at all.
 *
 * What a person actually does is keep tracking their **stale prediction** and
 * blend onto the fresh one. {@link AimTrack} is that: a held belief with a
 * velocity, dead-reckoned every sub-step and pulled towards the fresh belief by
 * `1 / reaction` of the difference. Two consequences, both correct and neither
 * written down as a rule:
 *
 * - A target travelling in a straight line is tracked with **no lag**, because
 *   the reckoning already puts the belief where they are. That is what tracking
 *   a runner feels like.
 * - A target that **changes direction** is tracked with an error that peaks
 *   immediately and decays over one reaction time. That is what being juked
 *   feels like, and it is the single largest thing separating a good duellist
 *   from a bad one.
 *
 * The reaction *period* is still a hard gate on the trigger — see
 * {@link reactionTicks} — because acquiring a target you were not looking at is
 * a different event from tracking one you were.
 *
 * ## 2. Error proportional to displacement from the reference point
 *
 * The best idea in the prior art, and it is two lines. The *reference* is the
 * believed body centre — what the bot can actually see. The *aim point* is
 * wherever it decided to shoot. The error is proportional to the distance
 * between them:
 *
 * | Shot | Displacement | Error |
 * | ---- | ------------ | ----- |
 * | rail at a visible body | 0 | none |
 * | rocket splashed at the feet | ~24 units | small |
 * | rocket led 200 units ahead | 200 units | large |
 *
 * So "aim is harder when you are guessing" needs no special case, no skill
 * table and no per-weapon accuracy: it is a property of how far from the thing
 * you can see you are pointing. It is also self-correcting — a bot that stops
 * leading because the target is jittering stops paying for the lead.
 *
 * ## 3. Motor error
 *
 * A multiplicative term on the *applied acceleration*, and on nothing else. The
 * rate limit is the arm and does not wobble; how hard the wrist pushes does. A
 * motor error held constant through a flick makes it merely fast or slow, so it
 * is re-rolled once per reaction period — about once per flick, which is what
 * turns "fast or slow" into an overshoot the bot then has to correct.
 *
 * ## Every draw is gated on the model
 *
 * The bot's PRNG is seeded and shared with the perception layer (`bot.ts`), so
 * the *number* of draws taken on a sub-step must not depend on anything the bot
 * did not perceive — `perception/perceive.ts` makes the same argument about the
 * sound channel, and `perception/fairness.test.ts` is what would catch it. So
 * the noise is aged on every sub-step the bot is alive and on no other
 * condition, and the reaction is drawn when a contact is *acquired*, which is
 * already a perceptual event.
 */

import { TICK_DT, TICK_INTERVAL_MS, cosRad, rngFloat, rngRange, sinRad, vec3 } from '@gladiator/sim'
import type { MutVec3, RngHolder, Vec3 } from '@gladiator/sim'

/* --------------------------------------------------------------------------
 * Reaction
 * ----------------------------------------------------------------------- */

/**
 * The floor on reacting to a target that was not there a moment ago, in ms.
 *
 * A simple-visual-reaction floor: about 140 ms is the fastest a person reliably
 * gets from photons to a finger, and anything under it in a game reads as the
 * bot having been told. It is a *floor* rather than a mean, so the acceptance
 * check can be a hard bound rather than a percentile.
 */
export const REACTION_MIN_MS = 140

/**
 * How much slower than the floor a reaction may be, in ms. Uniform over the
 * band, so the mean is the floor plus half of this: **210 ms**.
 *
 * Anchored on prior art rather than on human-subject data — Quake 3's
 * `reactiontime` characteristic runs from 0.5 s down to 0.1 s across its skill
 * range, and 210 ms is where a good-but-mortal player sits. Treat it as a
 * starting point to tune against the band table (GLAD-6BIYFQ), not as measured.
 */
export const REACTION_SPREAD_MS = 140

/**
 * Draw a reaction, in whole sub-steps.
 *
 * Rounded **up**, so the floor is a floor: 140 ms is 17.5 sub-steps and a bot
 * that rounded to nearest would react in 136 ms one time in two.
 */
export function reactionTicks(rng: RngHolder): number {
  const ms = REACTION_MIN_MS + rngFloat(rng) * REACTION_SPREAD_MS
  return Math.ceil(ms / TICK_INTERVAL_MS)
}

/**
 * The reaction to assume before one has been drawn, in sub-steps: the middle of
 * the band.
 *
 * It is the time constant of the tracking blend and the period the error is
 * re-rolled on, both of which are wanted on the first sub-step — before there is
 * anything to have reacted *to*, and therefore before the draw that would be
 * gated on it. Taking the draw early instead would consume the stream on a
 * schedule that depends on when a bot was constructed rather than on what it
 * perceived, which is the one thing the draws in here may not do.
 */
export const NOMINAL_REACTION_TICKS = Math.ceil(
  (REACTION_MIN_MS + REACTION_SPREAD_MS / 2) / TICK_INTERVAL_MS,
)

/* --------------------------------------------------------------------------
 * The track
 * ----------------------------------------------------------------------- */

/**
 * What the bot's hands are following, which is not quite what it believes.
 *
 * A constant-velocity model of the target, dead-reckoned every sub-step and
 * pulled towards the perceived belief by a fraction of the difference. See the
 * header for why that is the right shape for a reaction time.
 *
 * It is deliberately not traced against geometry, unlike `perception/memory.ts`'s
 * reckoning: this is where a crosshair is pointing, not where the bot thinks a
 * body is, and a crosshair is allowed to sweep across a wall.
 */
export type AimTrack = {
  origin: MutVec3
  velocity: MutVec3
  /** Whether the track holds anything. `false` is "nothing has been tracked". */
  live: boolean
}

export function createTrack(): AimTrack {
  return { origin: vec3(), velocity: vec3(), live: false }
}

/** Forget the target. A round boundary, a death, a contact that decayed away. */
export function clearTrack(track: AimTrack): void {
  track.live = false
  track.origin[0] = 0
  track.origin[1] = 0
  track.origin[2] = 0
  track.velocity[0] = 0
  track.velocity[1] = 0
  track.velocity[2] = 0
}

/**
 * One sub-step of tracking `origin` moving at `velocity`, with `blend` of the
 * difference taken up.
 *
 * A track that holds nothing adopts the belief outright rather than blending
 * from zero — there is no stale prediction to be behind, and starting one at
 * the world origin would sweep the crosshair across the map. The reaction is
 * still paid, as a gate on the trigger rather than as a lag in the hands.
 */
export function trackTarget(
  track: AimTrack,
  origin: Vec3,
  velocity: Vec3,
  blend: number,
): void {
  if (!track.live) {
    track.origin[0] = origin[0]
    track.origin[1] = origin[1]
    track.origin[2] = origin[2]
    track.velocity[0] = velocity[0]
    track.velocity[1] = velocity[1]
    track.velocity[2] = velocity[2]
    track.live = true
    return
  }

  // Dead-reckon first, then blend: the reckoning is what makes a straight-line
  // runner tracked with no lag at all, and the blend is what makes a change of
  // direction cost a reaction time.
  for (let axis = 0; axis < 3; axis += 1) {
    const reckoned = (track.origin[axis] ?? 0) + (track.velocity[axis] ?? 0) * TICK_DT
    track.origin[axis] = reckoned + ((origin[axis] ?? 0) - reckoned) * blend
    track.velocity[axis] =
      (track.velocity[axis] ?? 0) + ((velocity[axis] ?? 0) - (track.velocity[axis] ?? 0)) * blend
  }
}

/* --------------------------------------------------------------------------
 * Aim error and motor error
 * ----------------------------------------------------------------------- */

/**
 * Error as a fraction of the displacement from the reference point.
 *
 * A quarter. At a 200-unit lead that is 50 units of miss, which against a
 * 120-unit splash radius is still 58 damage — leading is *worse* than shooting
 * at a body, not futile. At a splash aimed at the feet the displacement is the
 * 24 units from the body centre to the floor, so the error is 6 units, which is
 * nothing. Both of those are the model working rather than two tuned cases.
 */
export const AIM_ERROR_FRACTION = 0.25

/**
 * The largest the error may grow to, in Quake units. **96**.
 *
 * Under one splash radius on purpose: past this the bot would be guessing so
 * badly that a rocket would be better not fired, and the shot selection
 * (`combat/rocketAim.ts`) already prefers a nearer aim point when the far one
 * is this uncertain. The cap is what stops a 3000-unit lead from producing an
 * error the size of the arena.
 */
export const MAX_AIM_ERROR = 96

/**
 * How much of the error is vertical, as a share of the horizontal.
 *
 * Under one, because a duel is fought on a floor: a player's lateral position is
 * genuinely uncertain and their height above the ground mostly is not. It is not
 * zero, because a bot whose error was exactly horizontal would splash the floor
 * at the right height every single time.
 */
export const VERTICAL_ERROR_SHARE = 0.4

/** How wrong the applied acceleration may be, either way, as a fraction. */
export const MOTOR_ERROR = 0.25

/** A full turn in radians, for the offset's bearing. */
const TAU = 6.283185307179586

/** The error the bot is currently making, re-rolled once per reaction period. */
export type AimNoise = {
  /** Sub-steps until the next re-roll. */
  ticksLeft: number
  /** A unit direction the aim point is displaced along. */
  offset: MutVec3
  /** How much of the available error radius to use, in `[0, 1)`. */
  scale: number
  /** The multiplier on applied angular acceleration. See the header. */
  motor: number
}

export function createNoise(): AimNoise {
  return { ticksLeft: 0, offset: vec3(1, 0, 0), scale: 0, motor: 1 }
}

/**
 * Draw a fresh error and a fresh motor multiplier.
 *
 * Four draws, always four, in this order — the count is what has to be
 * independent of what the bot did or did not perceive, so this function has no
 * early return in it.
 */
export function rollNoise(noise: AimNoise, rng: RngHolder, period: number): void {
  const bearing = rngRange(rng, 0, TAU)
  const rise = rngRange(rng, -VERTICAL_ERROR_SHARE, VERTICAL_ERROR_SHARE)
  const scale = rngFloat(rng)
  const motor = rngRange(rng, 1 - MOTOR_ERROR, 1 + MOTOR_ERROR)

  const flatX = cosRad(bearing)
  const flatY = sinRad(bearing)
  const length = Math.sqrt(1 + rise * rise)
  noise.offset[0] = flatX / length
  noise.offset[1] = flatY / length
  noise.offset[2] = rise / length
  noise.scale = scale
  noise.motor = motor
  noise.ticksLeft = period
}

/**
 * Count the current error down by one sub-step, re-rolling when it expires.
 *
 * Call it once per sub-step for as long as the bot is alive and on no other
 * condition — see the header on why the draw schedule may not depend on what
 * was perceived.
 */
export function ageNoise(noise: AimNoise, rng: RngHolder, period: number): void {
  noise.ticksLeft -= 1
  if (noise.ticksLeft <= 0) rollNoise(noise, rng, period)
}

/**
 * How far the aim point may be displaced, in Quake units, given how far it is
 * from the reference point.
 */
export function errorRadius(aimPoint: Vec3, reference: Vec3): number {
  const dx = aimPoint[0] - reference[0]
  const dy = aimPoint[1] - reference[1]
  const dz = aimPoint[2] - reference[2]
  const displacement = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const radius = displacement * AIM_ERROR_FRACTION
  return radius > MAX_AIM_ERROR ? MAX_AIM_ERROR : radius
}

/**
 * Write `aimPoint` displaced by the current error into `out`, and return it.
 *
 * `reference` is what the bot can see — the believed body centre — and the
 * error is proportional to how far the aim point is from it. Aiming at the
 * reference itself is therefore exact, which is the whole point: a rail at a
 * visible body is a rail at a visible body.
 */
export function displaceAim(
  out: MutVec3,
  aimPoint: Vec3,
  reference: Vec3,
  noise: AimNoise,
): MutVec3 {
  const radius = errorRadius(aimPoint, reference) * noise.scale
  out[0] = aimPoint[0] + noise.offset[0] * radius
  out[1] = aimPoint[1] + noise.offset[1] * radius
  out[2] = aimPoint[2] + noise.offset[2] * radius
  return out
}
