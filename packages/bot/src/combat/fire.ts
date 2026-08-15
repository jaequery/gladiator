/**
 * The combat layer, and the two clocks it is split across. GLAD-HK3ATM.
 *
 * `brain.ts` describes the split this file lives inside: 20.8 Hz to decide, 125
 * Hz to act. Combat divides along the same line and for the same reason, and
 * which half a question belongs in is decided by whether its answer is a *state*
 * or a *rate*:
 *
 * | Runs | What it decides | Why there |
 * | ---- | --------------- | --------- |
 * | 20 Hz | which weapon, splash or body, how far to lead, which way to dodge | none of them change meaningfully inside 48 ms, and all four cost traces |
 * | 125 Hz | what the target is doing, where the crosshair is, whether the trigger is down | a turn is a rate, and a trigger sampled at 20 Hz would add up to 48 ms to a reaction time measured in milliseconds |
 *
 * The trigger in particular has to be down here. The acceptance check is a hard
 * floor of 140 ms and a mean inside a 40 ms band, and a decision layer running
 * every 48 ms cannot express either.
 *
 * ## Three entry points, in the order a sub-step uses them
 *
 * 1. {@link observeCombat} — before the decision. It is what makes the tracking
 *    a *rate* rather than a staircase, and it has to run first so that a
 *    decision taken on this sub-step is taken about a target the bot has already
 *    tracked to this sub-step.
 * 2. {@link planShot} and {@link planEvade} — the decision itself, at 20 Hz.
 * 3. {@link aimCombat} and {@link triggerCombat} — the hands, at 125 Hz.
 *
 * ## The reaction is a gate, and it is armed by acquisition
 *
 * `aim/error.ts` argues why the reaction is *modelled* as a tracking blend
 * rather than a freeze. That covers keeping up with somebody; it says nothing
 * about noticing them, which is a separate event with a separate cost. So a
 * contact that becomes visible after being out of sight for longer than
 * {@link SIGHT_HOLD_TICKS} arms a fresh {@link reactionTicks}, and the trigger is
 * dead until it expires. Under that window it does not re-arm: a target
 * flickering behind a railing is one the bot is already tracking, and charging a
 * fresh 200 ms for each flicker would make cover worth more than it is.
 *
 * ## Everything the bot does to itself goes through one guard
 *
 * `combat/selfDamage.ts`, consulted at the *trigger* rather than at the
 * decision, because the bot moves between the two and the geometry in front of
 * its muzzle moves with it. It predicts where the rocket will actually burst
 * rather than where the crosshair points, which is the difference between "a
 * rocket at their feet across the room" and "a rocket into the pillar I have
 * just walked behind".
 */

import {
  ANGLE_UNITS_PER_DEGREE,
  DAMAGE_ORIGIN_HEIGHT,
  MUZZLE_FORWARD,
  MatchPhase,
  PLAYER_VIEW_HEIGHT,
  Weapon,
  angleVectors,
  snapVector,
  vec3,
} from '@gladiator/sim'
import type { CollisionWorld, MutVec3, RngHolder } from '@gladiator/sim'

import {
  aimPitch,
  aimYaw,
  createAim,
  holdAim,
  pitchUnitsToward,
  seedAim,
  steerAim,
  subtendedUnits,
  yawUnitsToward,
} from '../aim/controller.ts'
import type { AimState } from '../aim/controller.ts'
import {
  NOMINAL_REACTION_TICKS,
  ageNoise,
  clearTrack,
  createNoise,
  createTrack,
  displaceAim,
  reactionTicks,
  trackTarget,
} from '../aim/error.ts'
import type { AimNoise, AimTrack } from '../aim/error.ts'
import { NEVER_TICK, SIGHT_HOLD_TICKS } from '../perception/worldModel.ts'
import type { WorldModel } from '../perception/worldModel.ts'
import { SPLASH_RADIUS } from './damage.ts'
import { nearestThreat, planDodge } from './dodge.ts'
import { railSettled } from './railDiscipline.ts'
import {
  clearPath,
  createPath,
  createPlan,
  planDirect,
  planRocket,
  samplePath,
} from './rocketAim.ts'
import type { ShotPlan, TargetPath } from './rocketAim.ts'
import { predictSelfSplash, selfDamageAllows } from './selfDamage.ts'
import { selectWeapon } from './weaponSelect.ts'

/**
 * How far off a rocket may be aimed and still be worth firing, as the radius it
 * has to be within at the target's range.
 *
 * Half a splash radius, so the tolerance is *the weapon's own forgiveness*
 * rather than a number: at 600 units it is 5.7 degrees and at 1500 it is 2.3,
 * which is the same 60 units of slack expressed as the angle it takes to give it
 * away. A fixed angular tolerance would be a bot that is fussy at point-blank
 * range and reckless across the map.
 */
export const ROCKET_TOLERANCE_RADIUS = SPLASH_RADIUS * 0.5

/**
 * The largest that tolerance may grow to, in degrees.
 *
 * The subtended angle diverges as the range goes to zero, and a bot allowed to
 * fire 30 degrees off because the target is close would spray rockets at the
 * floor beside somebody standing on top of it. Eight degrees is reached at about
 * 430 units and holds from there in.
 */
export const ROCKET_TOLERANCE_MAX_DEGREES = 8

/** The same cap in angle units. */
export const ROCKET_TOLERANCE_MAX = Math.round(
  ROCKET_TOLERANCE_MAX_DEGREES * ANGLE_UNITS_PER_DEGREE,
)

/** Everything the combat layer remembers between sub-steps. */
export type CombatState = {
  /** The bot's seeded stream, shared with the perception layer. `bot.ts`. */
  readonly rng: RngHolder
  readonly aim: AimState
  readonly track: AimTrack
  readonly noise: AimNoise
  readonly path: TargetPath
  readonly plan: ShotPlan

  /** The reaction currently in force, in sub-steps. */
  reaction: number
  /** The first sub-step the trigger may be pulled on, or {@link NEVER_TICK}. */
  readyTick: number
  /** The last sub-step sight had the opponent, or {@link NEVER_TICK}. */
  lastVisibleTick: number
  /** The id of the rocket the bot is reacting to, or `-1`. */
  threatId: number
  /** The sub-step {@link threatId} was first noticed on, or {@link NEVER_TICK}. */
  threatTick: number

  /** The round the state was last brought up to date for. */
  round: number
  /** Whether the bot was alive last sub-step. */
  alive: boolean

  /** Where the crosshair is being sent this sub-step. */
  readonly point: MutVec3
  /** Whether {@link point} means anything. */
  hasPoint: boolean
  /** How far away the thing being aimed at is, in units. */
  range: number
  /** Diagnostics: the trigger was held because a rail had not settled. */
  settling: boolean
}

export function createCombat(rng: RngHolder): CombatState {
  return {
    rng,
    aim: createAim(),
    track: createTrack(),
    noise: createNoise(),
    path: createPath(),
    plan: createPlan(),
    reaction: NOMINAL_REACTION_TICKS,
    readyTick: NEVER_TICK,
    lastVisibleTick: NEVER_TICK,
    threatId: -1,
    threatTick: NEVER_TICK,
    round: -1,
    alive: false,
    point: vec3(),
    hasPoint: false,
    range: 0,
    settling: false,
  }
}

/**
 * Forget the target and let the view be re-adopted from the body.
 *
 * A round boundary and a respawn, which are the two moments something outside
 * the controller moves the view: `spawnRound` writes the spawn yaw and expects
 * the next command to carry it (`AGENTS.md`, "The spawn system"), so a
 * controller that kept integrating from where it was would spin the bot straight
 * back to where it was looking when it died.
 */
export function resetCombat(combat: CombatState): void {
  combat.aim.live = false
  clearTrack(combat.track)
  clearPath(combat.path)
  combat.plan.mode = 'none'
  combat.readyTick = NEVER_TICK
  combat.lastVisibleTick = NEVER_TICK
  combat.threatId = -1
  combat.threatTick = NEVER_TICK
  combat.hasPoint = false
  combat.settling = false
}

/* Scratch. Single-threaded and synchronous; see `perception/sight.ts`. */
const predicted: MutVec3 = vec3()
const reference: MutVec3 = vec3()
const wanted: MutVec3 = vec3()
const forward: MutVec3 = vec3()
const muzzle: MutVec3 = vec3()

/* --------------------------------------------------------------------------
 * Before the decision
 * ----------------------------------------------------------------------- */

/**
 * Bring the target track, the error and the reaction up to this sub-step.
 *
 * Runs before `decide`, so that a decision taken on this sub-step is taken about
 * a target that has already been tracked to it — otherwise the first decision
 * after acquiring somebody would be taken against an empty track and the bot
 * would spend a sixth of a second with no shot planned.
 */
export function observeCombat(combat: CombatState, model: WorldModel): void {
  const self = model.self

  if (model.match.round !== combat.round || (self.alive && !combat.alive)) {
    resetCombat(combat)
    combat.round = model.match.round
  }
  combat.alive = self.alive

  if (!combat.aim.live) seedAim(combat.aim, self.angles[0], self.angles[1])

  // The error is aged on every sub-step the bot is alive and on no other
  // condition, so the number of draws taken cannot depend on anything the bot
  // did not perceive. `aim/error.ts` is where that argument lives.
  if (self.alive) ageNoise(combat.noise, combat.rng, combat.reaction)
  if (!self.alive) return

  armReaction(combat, model)

  const contact = model.enemy
  if (contact.source === 'none') {
    clearTrack(combat.track)
    clearPath(combat.path)
    combat.plan.mode = 'none'
    return
  }

  trackTarget(combat.track, contact.origin, contact.velocity, 1 / combat.reaction)
  samplePath(combat.path, model.tick, contact.origin)
}

/**
 * Arm a fresh reaction when the opponent turns up after being out of sight.
 *
 * The gap is measured against {@link SIGHT_HOLD_TICKS}, which is the same 200 ms
 * `perception/perceive.ts` uses to decide a contact has genuinely been lost
 * rather than briefly occluded. Two thresholds on the same event should be one
 * number.
 */
function armReaction(combat: CombatState, model: WorldModel): void {
  const contact = model.enemy
  if (!contact.visible) return

  const seen = combat.lastVisibleTick
  const gap = seen === NEVER_TICK ? Number.POSITIVE_INFINITY : model.tick - seen
  if (gap > SIGHT_HOLD_TICKS) {
    combat.reaction = reactionTicks(combat.rng)
    combat.readyTick = model.tick + combat.reaction
  }
  combat.lastVisibleTick = model.tick
}

/* --------------------------------------------------------------------------
 * The 20 Hz half
 * ----------------------------------------------------------------------- */

/**
 * Choose the weapon and the shape of the shot, and write the second into the
 * plan.
 *
 * It reads the model and the level data and nothing else — in particular it does
 * not read the aim, because whether the crosshair has arrived is a question
 * about this sub-step and this runs every sixth one.
 */
export function planShot(
  combat: CombatState,
  model: WorldModel,
  world: CollisionWorld | null,
): Weapon {
  const weapon = selectWeapon(model, world)
  const plan = combat.plan

  if (!combat.track.live) {
    plan.mode = 'none'
    return weapon
  }

  if (weapon === Weapon.Railgun) {
    planDirect(plan)
    return weapon
  }

  aimVectors(model.self.angles[0], model.self.angles[1], model)
  planRocket(plan, world, muzzle, combat.track, combat.path)
  return weapon
}

/**
 * Decide which way to get out of the way, if anything needs getting out of the
 * way of. Writes a horizontal unit vector into `out`.
 *
 * The threat is charged the same reaction the trigger is: a rocket the bot has
 * only just been able to see is one it has only just seen, and reacting to it in
 * the 8 ms after it entered the field of view would be the fast half of the
 * cheat this whole layer is arranged against. The clock is per-rocket, so a
 * second one arriving during a dodge starts its own.
 */
export function planEvade(
  out: MutVec3,
  combat: CombatState,
  model: WorldModel,
  world: CollisionWorld | null,
): boolean {
  if (world === null || !model.self.alive) return false

  const threat = nearestThreat(model)
  if (threat === null) {
    combat.threatId = -1
    combat.threatTick = NEVER_TICK
    return false
  }

  if (threat.id !== combat.threatId) {
    combat.threatId = threat.id
    combat.threatTick = model.tick
  }
  if (model.tick - combat.threatTick < combat.reaction) return false

  return planDodge(out, world, model, threat)
}

/* --------------------------------------------------------------------------
 * The 125 Hz half
 * ----------------------------------------------------------------------- */

/**
 * Point the crosshair, and step the servo one sub-step towards it.
 *
 * `fallback` is where to point when there is no shot planned — the damage
 * bearing, today (`brain.ts`) — and it is aimed at without any error applied,
 * because a bearing derived from a shove is already a guess and adding a second
 * guess on top of it would be modelling the same uncertainty twice.
 */
export function aimCombat(
  combat: CombatState,
  model: WorldModel,
  fallback: MutVec3 | null,
): void {
  if (!model.self.alive || !acceptsCommands(model.match.phase)) {
    combat.hasPoint = false
    holdAim(combat.aim)
    return
  }

  if (combat.plan.mode === 'none' || !combat.track.live) {
    aimAt(combat, model, fallback)
    return
  }

  const lead = combat.plan.lead
  predicted[0] = combat.track.origin[0] + combat.track.velocity[0] * lead
  predicted[1] = combat.track.origin[1] + combat.track.velocity[1] * lead
  predicted[2] = combat.track.origin[2] + combat.track.velocity[2] * lead

  reference[0] = combat.track.origin[0]
  reference[1] = combat.track.origin[1]
  reference[2] = combat.track.origin[2] + DAMAGE_ORIGIN_HEIGHT

  wanted[0] = predicted[0] + combat.plan.offset[0]
  wanted[1] = predicted[1] + combat.plan.offset[1]
  wanted[2] = predicted[2] + combat.plan.offset[2]
  displaceAim(wanted, wanted, reference, combat.noise)

  aimAt(combat, model, wanted)
}

/** Point the servo at `target`, or hold the view when there is nothing to point at. */
function aimAt(combat: CombatState, model: WorldModel, target: MutVec3 | null): void {
  if (target === null) {
    combat.hasPoint = false
    holdAim(combat.aim)
    return
  }

  const self = model.self
  const ex = self.origin[0]
  const ey = self.origin[1]
  const ez = self.origin[2] + PLAYER_VIEW_HEIGHT

  combat.point[0] = target[0]
  combat.point[1] = target[1]
  combat.point[2] = target[2]
  combat.hasPoint = true

  const dx = target[0] - ex
  const dy = target[1] - ey
  const dz = target[2] - ez
  combat.range = Math.sqrt(dx * dx + dy * dy + dz * dz)

  steerAim(
    combat.aim,
    pitchUnitsToward(ex, ey, ez, target),
    yawUnitsToward(ex, ey, target),
    combat.noise.motor,
  )
}

/**
 * Whether the trigger is down this sub-step.
 *
 * Seven gates, cheapest first, because six of them are false for most of a
 * match. The two that carry the design are the last two: a rail waits for the
 * aim to settle (`combat/railDiscipline.ts`) and a rocket is refused if it would
 * hurt the bot more than it is willing to be hurt (`combat/selfDamage.ts`).
 */
export function triggerCombat(
  combat: CombatState,
  model: WorldModel,
  world: CollisionWorld | null,
  weapon: Weapon,
): boolean {
  combat.settling = false

  const self = model.self
  if (!self.alive || !acceptsCommands(model.match.phase)) return false
  if (!combat.hasPoint || combat.plan.mode === 'none') return false

  // Only at what it can see. Firing at a remembered position is a thing people
  // do and a thing a bot cannot be seen to do: from the other end, a rocket
  // arriving through a doorway you are behind is indistinguishable from a bot
  // that never lost you.
  if (!model.enemy.visible) return false

  if (combat.readyTick === NEVER_TICK || model.tick < combat.readyTick) return false
  if (model.tick < self.nextFireTick) return false

  if (weapon === Weapon.Railgun) {
    if (!railSettled(combat.aim)) {
      combat.settling = true
      return false
    }
    return true
  }

  if (combat.aim.error > rocketTolerance(combat.range)) return false
  return selfSplashAllowed(combat, model, world)
}

/** How far off a rocket may be aimed at this range, in angle units. */
export function rocketTolerance(range: number): number {
  const subtended = subtendedUnits(ROCKET_TOLERANCE_RADIUS, range)
  return subtended > ROCKET_TOLERANCE_MAX ? ROCKET_TOLERANCE_MAX : subtended
}

/**
 * Would this rocket hurt the bot more than it is willing to be hurt?
 *
 * Measured down the angles the command being built *this* sub-step will carry,
 * not the ones the body arrived on: the movement phase assigns the command's
 * angles before the fire phase reads them (`kernel.ts`), so the shot goes where
 * the servo has just decided rather than where the bot was pointing last tick.
 *
 * Permissive for a bot with no level data, which cannot trace its own shot and
 * therefore has nothing to be conservative *with*. That is the perception
 * fixture's configuration and not a shipping one: every bot in a match is handed
 * the arena it is standing in (`bot.ts`).
 */
function selfSplashAllowed(
  combat: CombatState,
  model: WorldModel,
  world: CollisionWorld | null,
): boolean {
  if (world === null) return true

  aimVectors(aimPitch(combat.aim), aimYaw(combat.aim), model)
  const contact = model.enemy
  const splash = predictSelfSplash(
    world,
    model.self.origin,
    muzzle,
    forward,
    contact.source === 'none' ? null : contact.origin,
  )
  // `false` for the rocket jump, which nothing asks for in v1 — see
  // `combat/selfDamage.ts` for where the exemption lives and why it is a
  // parameter rather than a flag.
  return selfDamageAllows(splash, model.self.health, false)
}

/**
 * The aim direction and muzzle for a shot taken at `pitch`/`yaw`, left in
 * {@link forward} and {@link muzzle}.
 *
 * `weapons.ts`'s `CalcMuzzlePoint`, restated against the model's copy of the
 * body rather than against an `EntityState` — a name this package may not say
 * outside `perception/`. The snap is Quake's and is kept because the prediction
 * has to agree with the shot the simulation will actually fire.
 */
function aimVectors(pitch: number, yaw: number, model: WorldModel): void {
  const self = model.self
  angleVectors(pitch, yaw, 0, forward, null, null)
  muzzle[0] = self.origin[0] + forward[0] * MUZZLE_FORWARD
  muzzle[1] = self.origin[1] + forward[1] * MUZZLE_FORWARD
  muzzle[2] = self.origin[2] + PLAYER_VIEW_HEIGHT + forward[2] * MUZZLE_FORWARD
  snapVector(muzzle)
}

/** Whether a command sent now reaches the bot's body. `match/match.ts`'s rule. */
function acceptsCommands(phase: MatchPhase): boolean {
  return phase === MatchPhase.Warmup || phase === MatchPhase.Live
}
