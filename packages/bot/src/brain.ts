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
 * ## Who fills in what
 *
 * {@link BotDecision} is the seam. This file fills in `aim` and `goal`; the
 * movement layer turns `goal` into a route and a stick position
 * (`movement/move.ts`, GLAD-TSED8V); weapon choice, splash aiming, leading a target
 * and dodging a rocket fill in `weapon` and `buttons` (GLAD-HK3ATM). Neither
 * reaches past it.
 *
 * The 125 Hz half of this file is now assembly rather than steering: the aim
 * decides `yaw` and `pitch`, and the movement layer — which needs the yaw, because
 * the two axes are relative to it — decides `forwardMove`, `sideMove` and the jump
 * bit. That order is the only one available, and it is the same order a player's
 * hands work in.
 */

import {
  ANGLE_UNITS,
  ANGLE_UNITS_PER_DEGREE,
  BUTTON_JUMP,
  MAX_PITCH_UNITS,
  PLAYER_VIEW_HEIGHT,
  RADIANS_PER_ANGLE_UNIT,
  TICK_RATE,
  Weapon,
  vec3,
} from '@gladiator/sim'
import type { MutVec3, UserCmd, Vec3 } from '@gladiator/sim'

import { moveBot } from './movement/move.ts'
import type { MoveState } from './movement/move.ts'
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
 * 3. **Nothing.** Hold, and say nothing about where to go. Sweeping for a target
 *    is search behaviour and it belongs with the movement that carries it out —
 *    `movement/roam.ts`, which is what answers an absent goal when there is no
 *    contact at all. The distinction is load-bearing: no goal *with* a contact is
 *    a bot holding its ground on purpose, and the movement layer leaves that
 *    alone.
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

/** Where the view is pointing this sub-step. Both in angle units. */
export type BotView = {
  yaw: number
  pitch: number
}

/**
 * Turn the standing decision into a view.
 *
 * A turn is a **rate**, which is why this is in the 125 Hz half: sampled at 20 Hz
 * it would be a staircase, and a staircase is the one artefact in a bot's motion a
 * player reads instantly. {@link MAX_TURN_UNITS} is the whole of the rate limit,
 * applied per sub-step, so the acceptance check's "no yaw delta exceeds the turn
 * rate divided by the tick rate" is a property of this one clamp.
 *
 * Everything here is an integer (`usercmd.ts`), and everything arrives at one by
 * `Math.round` over a bounded step, so the same model produces the same view on
 * every engine — which is what makes the mutation test's "bit-identical" a claim
 * about the bot rather than about floating point.
 */
export function aimView(brain: BotBrain, model: WorldModel, out: BotView): BotView {
  const d = brain.decision
  const self = model.self

  out.pitch = clampPitch(Math.round(self.angles[0]))
  out.yaw = wrapUnits(Math.round(self.angles[1]))

  if (!d.hasAim) return out

  const ex = self.origin[0]
  const ey = self.origin[1]
  const ez = self.origin[2] + PLAYER_VIEW_HEIGHT
  out.yaw = wrapUnits(out.yaw + stepToward(wrapDelta(yawUnitsToward(ex, ey, d.aim) - out.yaw)))
  out.pitch = clampPitch(out.pitch + stepToward(pitchUnitsToward(ex, ey, ez, d.aim) - out.pitch))
  return out
}

/* Scratch. Single-threaded and synchronous; see `perception/sight.ts`. */
const view: BotView = { yaw: 0, pitch: 0 }

/**
 * Assemble one sub-step's command out of a view and a stick position.
 *
 * The order is forced and it is the same order a player's hands work in: the aim
 * decides where the view is, and *then* the feet are resolved against it, because
 * `forwardMove` and `sideMove` are relative to the yaw (`movement/steer.ts`).
 *
 * `move` may be `null`, and that is the shape the walking skeleton had: no
 * routing, no ledge probes, no jump — a bot that aims and stands. It is kept
 * because the reverse — a movement layer that could not be left out — would make
 * every test of the aim depend on a nav graph.
 */
export function command(brain: BotBrain, model: WorldModel, move: MoveState | null): UserCmd {
  const d = brain.decision
  aimView(brain, model, view)

  if (move === null) {
    return {
      forwardMove: 0,
      sideMove: 0,
      yaw: view.yaw,
      pitch: view.pitch,
      buttons: d.buttons,
      weapon: d.weapon,
    }
  }

  moveBot(move, model, d, view.yaw)
  return {
    forwardMove: move.axes.forwardMove,
    sideMove: move.axes.sideMove,
    yaw: view.yaw,
    pitch: view.pitch,
    // OR'd rather than assigned: jump is the movement layer's bit and attack is
    // the combat layer's, and a command carries both.
    buttons: move.jump ? d.buttons | BUTTON_JUMP : d.buttons,
    weapon: d.weapon,
  }
}

/**
 * One tick of the bot: think if it is time to, then act.
 *
 * The decision is taken on ticks divisible by {@link BRAIN_INTERVAL_TICKS}, so
 * the phase is a property of the world's tick counter rather than of when this
 * bot happened to be created — two bots in one world think on the same ticks,
 * and a replay reproduces both.
 */
export function think(brain: BotBrain, model: WorldModel, move: MoveState | null): UserCmd {
  if (brain.lastDecisionTick < 0 || model.tick - brain.lastDecisionTick >= BRAIN_INTERVAL_TICKS) {
    decide(brain, model)
    brain.lastDecisionTick = model.tick
  }
  return command(brain, model, move)
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
