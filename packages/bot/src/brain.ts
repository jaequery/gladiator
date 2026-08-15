/**
 * The decision layer, and the per-tick command it is turned into.
 *
 * Two clocks, and the split is the point:
 *
 * | Runs | What it does | Why at that rate |
 * | ---- | ------------ | ---------------- |
 * | 20 Hz | picks what to aim at and where to go | thinking is expensive and the answer does not change every 8 ms |
 * | 125 Hz | turns that into a `UserCmd` | a turn is a rate, and a rate sampled at 20 Hz is a staircase |
 *
 * Quake 3's bots think at 10 Hz and it shows: at this game's speeds a tenth of
 * a second is 32 units of strafe, so a 10 Hz brain is visibly a beat behind
 * whatever it is tracking. {@link BRAIN_INTERVAL_TICKS} is **6** rather than
 * 6.25 because 125 is not divisible by 20 and a fractional interval is a phase
 * that drifts against the tick counter; 20.8 Hz is the honest number.
 *
 * ## It reads `model` and nothing else
 *
 * There is no `GameState` parameter here and there is not going to be one.
 * `eslint.config.js`'s `GROUND_TRUTH_BANS` refuses the name in this file, and
 * `perception/fairness.test.ts` proves the consequence: perturb something the
 * model does not carry and this function emits the identical stream of
 * commands, bit for bit.
 *
 * ## What is deliberately still a stub
 *
 * Aiming *at* a contact, closing on it and holding fire is the smallest policy
 * that makes the fairness harness mean something — a bot that stood still would
 * pass the mutation test by doing nothing. Path following over the nav graph is
 * GLAD-TSED8V, and weapon choice, splash aiming, leading a target and dodging a
 * rocket are GLAD-HK3ATM. Both build on {@link BotDecision}: the first fills in
 * `goal`, the second `aim`, `weapon` and `buttons`.
 */

import {
  ANGLE_UNITS,
  ANGLE_UNITS_PER_DEGREE,
  MAX_PITCH_UNITS,
  PLAYER_VIEW_HEIGHT,
  RADIANS_PER_ANGLE_UNIT,
  TICK_RATE,
  Weapon,
  angleVectors,
  vec3,
} from '@gladiator/sim'
import type { MutVec3, UserCmd, Vec3 } from '@gladiator/sim'

import { DAMAGE_ASSUMED_RANGE, hasContact, isAlert } from './perception/worldModel.ts'
import type { WorldModel } from './perception/worldModel.ts'

/**
 * Sub-steps between decisions. 6 = 20.8 Hz.
 *
 * See the header for why it is not 6.25. It is a divisor of nothing in
 * particular, which is fine — what matters is that it is a whole number of
 * sub-steps, so the decision phase is a function of the tick counter and a
 * replay reproduces it.
 */
export const BRAIN_INTERVAL_TICKS = 6

/**
 * How fast the bot may turn, in degrees per second.
 *
 * A human flick is faster than this over a short arc and slower over a long
 * one; 540 is roughly a competent player's sustained turn, and it is here as a
 * *rate limit* rather than as an accuracy model. Nerfing where the bot ends up
 * pointing is the design mistake this whole ticket argues against
 * (`perception/worldModel.ts`); limiting how fast it gets there is a physical
 * constraint a player has too.
 */
export const TURN_RATE_DEGREES = 540

/** The same rate as whole angle units per sub-step. Integers all the way down. */
export const MAX_TURN_UNITS = Math.round((TURN_RATE_DEGREES * ANGLE_UNITS_PER_DEGREE) / TICK_RATE)

/**
 * How close the bot tries to get, in Quake units.
 *
 * Inside this it stops closing and holds its ground. A rocket's splash radius
 * is 120 (`weapons.ts`), so this is comfortably outside the range at which
 * advancing on somebody is the same as standing in their explosion.
 */
export const ENGAGE_RANGE = 600

/**
 * How far off a direction has to be before the bot stops asking for it, as a
 * cosine.
 *
 * `forwardMove` and `sideMove` are `-1`, `0` or `+1` (`usercmd.ts`) — there is
 * no analogue axis to be subtle with — so a direction is resolved on to at most
 * two of the four cardinals. 0.35 is a little under 70 degrees, which is what
 * makes a bearing halfway between forward and right come out as *both* rather
 * than as whichever won by a hair and flickered.
 */
export const MOVE_DEADZONE = 0.35

/** A standing intention. Two ticks in three, this is what the command is built from. */
export type BotDecision = {
  /** Whether {@link aim} means anything. `false` holds the current view angles. */
  hasAim: boolean
  /** A world point to point the crosshair at, at eye height. */
  aim: MutVec3
  /** Whether {@link goal} means anything. `false` stands still. */
  hasGoal: boolean
  /** A world point to walk towards, at foot height. */
  goal: MutVec3
  /** Button bits for the command. */
  buttons: number
  weapon: Weapon
}

/** The decision layer's state: one standing decision and when it was taken. */
export type BotBrain = {
  readonly decision: BotDecision
  /** The tick the 20 Hz layer last ran on, or -1. */
  lastDecisionTick: number
}

export function createBrain(): BotBrain {
  return {
    decision: {
      hasAim: false,
      aim: vec3(),
      hasGoal: false,
      goal: vec3(),
      buttons: 0,
      weapon: Weapon.RocketLauncher,
    },
    lastDecisionTick: -1,
  }
}

/* --------------------------------------------------------------------------
 * The 20 Hz half
 * ----------------------------------------------------------------------- */

/**
 * Pick what to aim at and where to go, from the model and nothing else.
 *
 * Three cases, in order of how much the bot knows:
 *
 * 1. **A contact.** Aim at it, and close on it if it is further away than
 *    {@link ENGAGE_RANGE}. The contact may be two seconds stale and half a
 *    room wide (`perception/memory.ts`) — this layer does not get to know the
 *    difference beyond the `confidence` and `uncertainty` it is handed, which
 *    is the whole arrangement.
 * 2. **A shove and no contact.** Look down the bearing the hit came from. There
 *    is no position in a hit, so there is nowhere to walk to.
 * 3. **Nothing.** Hold. Sweeping for a target is search behaviour and belongs
 *    with the movement that would carry it out (GLAD-TSED8V).
 */
export function decide(brain: BotBrain, model: WorldModel): void {
  const d = brain.decision
  d.hasAim = false
  d.hasGoal = false
  d.buttons = 0
  d.weapon = model.self.weapon === Weapon.None ? Weapon.RocketLauncher : model.self.weapon

  if (!model.self.alive) return

  if (hasContact(model)) {
    const enemy = model.enemy
    d.hasAim = true
    d.aim[0] = enemy.origin[0]
    d.aim[1] = enemy.origin[1]
    d.aim[2] = enemy.origin[2] + PLAYER_VIEW_HEIGHT

    const dx = enemy.origin[0] - model.self.origin[0]
    const dy = enemy.origin[1] - model.self.origin[1]
    if (dx * dx + dy * dy > ENGAGE_RANGE * ENGAGE_RANGE) {
      d.hasGoal = true
      d.goal[0] = enemy.origin[0]
      d.goal[1] = enemy.origin[1]
      d.goal[2] = enemy.origin[2]
    }
    return
  }

  if (isAlert(model) && model.damageTick >= 0) {
    d.hasAim = true
    d.aim[0] = model.self.origin[0] + model.damageBearing[0] * DAMAGE_ASSUMED_RANGE
    d.aim[1] = model.self.origin[1] + model.damageBearing[1] * DAMAGE_ASSUMED_RANGE
    d.aim[2] = model.self.origin[2] + PLAYER_VIEW_HEIGHT
  }
}

/* --------------------------------------------------------------------------
 * The 125 Hz half
 * ----------------------------------------------------------------------- */

/* Scratch. Single-threaded and synchronous; see `perception/sight.ts`. */
const forward: MutVec3 = vec3()
const right: MutVec3 = vec3()
const toGoal: MutVec3 = vec3()

/**
 * Turn the standing decision into one tick of intent.
 *
 * Everything in a `UserCmd` is an integer (`usercmd.ts`), and everything below
 * arrives at one by `Math.round` over a bounded step, so the same model
 * produces the same command on every engine — which is what makes the mutation
 * test's "bit-identical" a claim about the bot rather than about floating point.
 */
export function command(brain: BotBrain, model: WorldModel): UserCmd {
  const d = brain.decision
  const self = model.self

  let pitch = Math.round(self.angles[0])
  let yaw = wrapUnits(Math.round(self.angles[1]))

  if (d.hasAim) {
    const ex = self.origin[0]
    const ey = self.origin[1]
    const ez = self.origin[2] + PLAYER_VIEW_HEIGHT
    yaw = wrapUnits(yaw + stepToward(wrapDelta(yawUnitsToward(ex, ey, d.aim) - yaw)))
    pitch = clampPitch(pitch + stepToward(pitchUnitsToward(ex, ey, ez, d.aim) - pitch))
  }

  let forwardMove = 0
  let sideMove = 0
  if (d.hasGoal) {
    // The movement basis is yaw-only, exactly as `pmove`'s `wishDirection`
    // builds it — a bot that projected on to a pitched forward vector would
    // walk slower whenever it was looking at the floor.
    angleVectors(0, yaw, 0, forward, right, null)
    toGoal[0] = d.goal[0] - self.origin[0]
    toGoal[1] = d.goal[1] - self.origin[1]
    const length = Math.sqrt(toGoal[0] * toGoal[0] + toGoal[1] * toGoal[1])
    if (length > 0) {
      const ux = toGoal[0] / length
      const uy = toGoal[1] / length
      forwardMove = axis(ux * forward[0] + uy * forward[1])
      sideMove = axis(ux * right[0] + uy * right[1])
    }
  }

  return { forwardMove, sideMove, yaw, pitch, buttons: d.buttons, weapon: d.weapon }
}

/**
 * One tick of the bot: think if it is time to, then act.
 *
 * The decision is taken on ticks divisible by {@link BRAIN_INTERVAL_TICKS}, so
 * the phase is a property of the world's tick counter rather than of when this
 * bot happened to be created — two bots in one world think on the same ticks,
 * and a replay reproduces both.
 */
export function think(brain: BotBrain, model: WorldModel): UserCmd {
  if (brain.lastDecisionTick < 0 || model.tick - brain.lastDecisionTick >= BRAIN_INTERVAL_TICKS) {
    decide(brain, model)
    brain.lastDecisionTick = model.tick
  }
  return command(brain, model)
}

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

/** As much of `delta` as one sub-step is allowed to cover. */
function stepToward(delta: number): number {
  if (delta > MAX_TURN_UNITS) return MAX_TURN_UNITS
  if (delta < -MAX_TURN_UNITS) return -MAX_TURN_UNITS
  return Math.round(delta)
}

/** Pitch is clamped and never wrapped — `usercmd.ts` explains why the band is 89. */
function clampPitch(units: number): number {
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
  return wrapUnits(Math.round(Math.atan2(target[1] - ey, target[0] - ex) * ANGLE_UNITS_PER_RADIAN))
}

/** The pitch that points from an eye at `target`. Positive is *downward*. */
export function pitchUnitsToward(ex: number, ey: number, ez: number, target: Vec3): number {
  const dx = target[0] - ex
  const dy = target[1] - ey
  const dz = target[2] - ez
  const flat = Math.sqrt(dx * dx + dy * dy)
  return clampPitch(Math.round(Math.atan2(-dz, flat) * ANGLE_UNITS_PER_RADIAN))
}

/** A projection on to one of `-1`, `0`, `+1`. See {@link MOVE_DEADZONE}. */
function axis(projection: number): number {
  if (projection > MOVE_DEADZONE) return 1
  if (projection < -MOVE_DEADZONE) return -1
  return 0
}
