/**
 * The aim controller: a bang-bang angular servo with an acceleration limit.
 * GLAD-HK3ATM.
 *
 * The view is a second-order system — an angle and an angular *rate* — driven at
 * the acceleration limit in whichever direction the switching curve says. That
 * one choice produces the shape a human aim has and nothing else does: a hard
 * flick that runs out to the turn rate, a brake that starts before the target,
 * and a settle that arrives without a bounce. It is time-optimal, which is also
 * what a person trying to win a duel is attempting to be.
 *
 * ## Explicitly not Quake 3's integrator
 *
 * `BotChangeViewAngles` runs
 *
 * ```c
 * speed = diff * (0.5 + 0.5 * bs->cur_ps.ps.speed / 400);
 * ...
 * bs->viewangles[i] += speed;
 * ```
 *
 * with a `speed += (speed - desired)` correction whose sign is wrong: it adds
 * the error to the rate instead of subtracting it, so the rate diverges from
 * what was asked for and is then clamped. That is the origin of the
 * characteristic Q3 bot wobble — a crosshair that shivers around a target it
 * has already reached — and it is a bug rather than a design, which is why it is
 * not transcribed here the way this repo transcribes Quake's *physics*.
 *
 * ## The three limits, and which one binds when
 *
 * | Limit | Value | What it is |
 * | ----- | ----- | ---------- |
 * | acceleration | {@link MAX_AIM_ACCEL} | how fast the wrist can start and stop |
 * | rate | {@link MAX_TURN_UNITS} | how fast the arm can sweep |
 * | quantisation | one angle unit | what a `UserCmd` can carry (`usercmd.ts`) |
 *
 * A short flick never reaches the rate limit and is governed entirely by the
 * acceleration; a 180 spends most of its time at the rate limit. Both fall out
 * of the same two lines rather than being special cases.
 *
 * ## The state is the bot's, not the body's
 *
 * {@link AimState} carries the view as a **float** and integrates it. Reading
 * the angles back off the body every sub-step — which is what the walking
 * skeleton's `aimView` did — throws away the fraction of a unit the rate is
 * carrying, and a rate under one unit per sub-step would round to nothing and
 * the view would never move at all. So the controller owns the angle, emits a
 * rounded copy, and is re-seeded from the body only when something outside it
 * has moved the view: a spawn, which assigns the spawn yaw (`match/spawn.ts`).
 */

import {
  ANGLE_UNITS,
  ANGLE_UNITS_PER_DEGREE,
  MAX_PITCH_UNITS,
  RADIANS_PER_ANGLE_UNIT,
  TICK_RATE,
} from '@gladiator/sim'
import type { Vec3 } from '@gladiator/sim'

/* --------------------------------------------------------------------------
 * The limits
 * ----------------------------------------------------------------------- */

/**
 * How fast the bot may turn, in degrees per second.
 *
 * A human flick is faster than this over a short arc and slower over a long
 * one; 540 is roughly a competent player's sustained turn, and it is here as a
 * *rate limit* rather than as an accuracy model. Nerfing where the bot ends up
 * pointing is the design mistake the whole fairness argument rests against
 * (`perception/worldModel.ts`); limiting how fast it gets there is a physical
 * constraint a player has too.
 */
export const TURN_RATE_DEGREES = 540

/** The same rate as whole angle units per sub-step. Integers all the way down. */
export const MAX_TURN_UNITS = Math.round((TURN_RATE_DEGREES * ANGLE_UNITS_PER_DEGREE) / TICK_RATE)

/**
 * How many sub-steps it takes to reach {@link MAX_TURN_UNITS} from a standstill.
 * **10**, which is 80 ms.
 *
 * The acceleration limit is stated this way round because this is the number
 * that has a feel attached to it: 80 ms to wind up to a full sweep is a wrist
 * rather than a stepper motor. As an acceleration it is about 6,800 degrees per
 * second squared, which is a figure with no intuition behind it at all.
 *
 * What it buys, concretely: a 90-degree flick spends 21.6 degrees accelerating,
 * 21.6 braking and the rest at the rate limit, and takes about 250 ms end to
 * end. A 5-degree correction never leaves the acceleration phase and takes
 * about 50 ms. Neither is a number that had to be written down.
 */
export const AIM_ACCEL_TICKS = 10

/**
 * The acceleration limit, in angle units per sub-step squared.
 *
 * Derived from the two above rather than typed, so that changing the turn rate
 * changes the wind-up in proportion instead of quietly making the controller
 * either a stepper motor or a pendulum.
 */
export const MAX_AIM_ACCEL = MAX_TURN_UNITS / AIM_ACCEL_TICKS

/* --------------------------------------------------------------------------
 * Angles
 * ----------------------------------------------------------------------- */

/**
 * Radians to angle units.
 *
 * Derived from the sim's constant rather than restated, because two names for
 * one number is the drift `AGENTS.md` spends a section on — and this one would
 * be a bot that aims a fraction of a degree off and nothing that says why.
 */
const ANGLE_UNITS_PER_RADIAN = 1 / RADIANS_PER_ANGLE_UNIT

/** Wrap angle units into `[0, ANGLE_UNITS)`, as a `UserCmd` requires. */
export function wrapUnits(units: number): number {
  const wrapped = units % ANGLE_UNITS
  return wrapped < 0 ? wrapped + ANGLE_UNITS : wrapped
}

/** The shortest signed way round, in angle units: `(-32768, 32768]`. */
export function wrapDelta(delta: number): number {
  let d = delta % ANGLE_UNITS
  if (d > ANGLE_UNITS / 2) d -= ANGLE_UNITS
  if (d <= -ANGLE_UNITS / 2) d += ANGLE_UNITS
  return d
}

/** Pitch is clamped and never wrapped — `usercmd.ts` explains why the band is 89. */
export function clampPitch(units: number): number {
  if (units > MAX_PITCH_UNITS) return MAX_PITCH_UNITS
  if (units < -MAX_PITCH_UNITS) return -MAX_PITCH_UNITS
  return units
}

/**
 * The yaw, in angle units, that points from `(ex, ey)` at `target`.
 *
 * `Math.atan2` is a lint error inside `packages/sim` because its last bit is
 * implementation-defined and the simulation has to be bit-identical in two
 * runtimes. The bot is not on that side of the line: it produces `UserCmd`s,
 * whose fields are integers, and the *server* simulates them. That is the
 * reason this package exists separately, and it is written down in `AGENTS.md`.
 */
export function yawUnitsToward(ex: number, ey: number, target: Vec3): number {
  return wrapUnits(Math.atan2(target[1] - ey, target[0] - ex) * ANGLE_UNITS_PER_RADIAN)
}

/** The pitch that points from an eye at `target`. Positive is *downward*. */
export function pitchUnitsToward(ex: number, ey: number, ez: number, target: Vec3): number {
  const dx = target[0] - ex
  const dy = target[1] - ey
  const dz = target[2] - ez
  const flat = Math.sqrt(dx * dx + dy * dy)
  return clampPitch(Math.atan2(-dz, flat) * ANGLE_UNITS_PER_RADIAN)
}

/**
 * The half-angle, in angle units, that a target of radius `radius` subtends at
 * `distance`.
 *
 * What "close enough to pull the trigger" means, in the only unit the controller
 * has. A tolerance stated as a constant angle would be a bot that is fussy at
 * point-blank range and reckless across the map, which is exactly backwards.
 */
export function subtendedUnits(radius: number, distance: number): number {
  if (distance <= 0) return ANGLE_UNITS / 4
  return Math.atan2(radius, distance) * ANGLE_UNITS_PER_RADIAN
}

/* --------------------------------------------------------------------------
 * The controller
 * ----------------------------------------------------------------------- */

/** Where the view is pointing, and how fast it is moving. Angle units. */
export type AimState = {
  /** The commanded yaw. A float — see the header. */
  yaw: number
  /** The commanded pitch. Positive is downward. */
  pitch: number
  /** Yaw rate, in angle units per sub-step. */
  yawRate: number
  /** Pitch rate, in angle units per sub-step. */
  pitchRate: number
  /**
   * Whether {@link yaw} and {@link pitch} mean anything yet.
   *
   * `false` before the first sub-step and after anything outside the controller
   * has moved the view — a spawn, which assigns the spawn yaw and expects the
   * client to adopt it (`AGENTS.md`, "The spawn system").
   */
  live: boolean
  /**
   * How far the view is from where it was last asked to point, in angle units,
   * **after** this sub-step's step.
   *
   * The number the trigger is gated on (`combat/railDiscipline.ts`). It is the
   * yaw and pitch errors in quadrature, which slightly over-weights yaw at a
   * steep pitch and is exact at the pitches a duel is fought at.
   */
  error: number
  /** The magnitude of the angular rate, in angle units per sub-step. */
  rate: number
}

export function createAim(): AimState {
  return { yaw: 0, pitch: 0, yawRate: 0, pitchRate: 0, live: false, error: 0, rate: 0 }
}

/** Adopt a view the controller did not choose, and stop dead. */
export function seedAim(aim: AimState, pitch: number, yaw: number): void {
  aim.yaw = wrapUnits(yaw)
  aim.pitch = clampPitch(pitch)
  aim.yawRate = 0
  aim.pitchRate = 0
  aim.error = 0
  aim.rate = 0
  aim.live = true
}

/**
 * One sub-step of the servo, towards `targetPitch` and `targetYaw`.
 *
 * `motor` multiplies the acceleration and nothing else (`aim/error.ts`): the
 * rate limit is a property of the arm and does not wobble, while how hard the
 * wrist actually pushes does. A motor error that is constant through a flick
 * produces a flick that is merely fast or slow; the wobble comes from it
 * changing *during* one, which is why it is re-rolled on the reaction period
 * rather than every sub-step.
 */
export function steerAim(
  aim: AimState,
  targetPitch: number,
  targetYaw: number,
  motor: number,
): void {
  const accel = MAX_AIM_ACCEL * motor
  const pitch = clampPitch(targetPitch)

  aim.yawRate = nextRate(wrapDelta(targetYaw - aim.yaw), aim.yawRate, accel)
  aim.pitchRate = nextRate(pitch - aim.pitch, aim.pitchRate, accel)

  aim.yaw = wrapUnits(aim.yaw + aim.yawRate)
  aim.pitch = clampPitch(aim.pitch + aim.pitchRate)

  const yawError = wrapDelta(targetYaw - aim.yaw)
  const pitchError = pitch - aim.pitch
  aim.error = Math.sqrt(yawError * yawError + pitchError * pitchError)
  aim.rate = Math.sqrt(aim.yawRate * aim.yawRate + aim.pitchRate * aim.pitchRate)
}

/** Hold the view where it is: brake to a stop and stay there. */
export function holdAim(aim: AimState): void {
  aim.yawRate = 0
  aim.pitchRate = 0
  aim.error = 0
  aim.rate = 0
}

/**
 * How much angle is covered braking to a stop from `speed`, in angle units.
 *
 * **Not `v^2 / 2a`.** The continuous formula is the wrong instrument for a
 * controller that steps 125 times a second, and the difference is not academic:
 * the sub-step order here is *decelerate, then move*, so the distance is the sum
 * of the rates after each brake — `a(n-1) + a(n-2) + ... + a` for `n = v / a`,
 * which is `a n (n - 1) / 2`. That is exactly `v^2 / 2a - v / 2`, half a
 * sub-step's travel less than the continuous answer, and the expression below is
 * the closed form of it.
 *
 * Using the continuous value made the servo overshoot by a fifth of its travel
 * and then hunt back and forth across the target for a dozen sub-steps —
 * indistinguishable, on screen, from the Q3 wobble this controller exists to
 * avoid, and arrived at from the opposite direction.
 */
function stopDistance(speed: number, accel: number): number {
  const distance = (speed * speed) / (2 * accel) - speed / 2
  return distance > 0 ? distance : 0
}

/**
 * The rate for the next sub-step, from the switching curve.
 *
 * The controller is one question asked every sub-step: **if I push now, can I
 * still stop in time?** Pushing costs the step it takes this sub-step plus
 * {@link stopDistance} afterwards, so the rule is
 *
 * ```
 * push if   push + stopDistance(push) <= error
 * else coast if   rate + stopDistance(rate) <= error
 * else brake
 * ```
 *
 * which is time-optimal for a double integrator and is why the motion has a
 * flick in it rather than an exponential approach. The middle case is what stops
 * the endgame from being a stutter: without a coast the servo alternates a push
 * and a brake for the last few sub-steps, which is a visible shiver at exactly
 * the moment the crosshair is supposed to be still.
 *
 * Everything is worked out in the *toward* frame — `v` is speed towards the
 * target, so a negative one is a view moving the wrong way, which happens after
 * a target crosses in front of the bot. There the only sensible answer is to
 * keep pushing, and there is nothing to plan until the sign changes.
 *
 * The last clause is the arrival. An error under one acceleration step cannot be
 * resolved by pushing *or* braking, so without it the curve chatters either side
 * of zero forever. Landing exactly is a step of at most one acceleration unit —
 * a fortieth of a degree — so it is a discontinuity nothing can see.
 */
function nextRate(error: number, rate: number, accel: number, limit = MAX_TURN_UNITS): number {
  const toward = error >= 0 ? 1 : -1
  const gap = error >= 0 ? error : -error
  const speed = rate * toward

  const pushed = speed + accel > limit ? limit : speed + accel

  let next: number
  if (pushed <= 0) next = pushed
  else if (pushed + stopDistance(pushed, accel) <= gap) next = pushed
  else if (speed > 0 && speed + stopDistance(speed, accel) <= gap) next = speed
  else next = speed - accel

  if (next > limit) next = limit
  if (next < -limit) next = -limit

  let out = next * toward
  if (gap <= accel && (out < 0 ? -out : out) <= accel) out = error
  return out
}

/** The yaw a `UserCmd` carries: whole angle units, wrapped. */
export function aimYaw(aim: AimState): number {
  return wrapUnits(Math.round(aim.yaw))
}

/** The pitch a `UserCmd` carries: whole angle units, clamped. */
export function aimPitch(aim: AimState): number {
  return clampPitch(Math.round(aim.pitch))
}
