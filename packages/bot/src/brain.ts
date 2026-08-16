/**
 * The decision layer, and the per-tick command it is turned into.
 *
 * Two clocks, and the split is the point:
 *
 * | Runs | What it does | Why at that rate |
 * | ---- | ------------ | ---------------- |
 * | 20 Hz | picks what to shoot with, where to shoot, where to go, which way to dodge | thinking is expensive and the answer does not change every 8 ms |
 * | 125 Hz | tracks the target, turns the view, pulls the trigger | a turn is a rate, and a rate sampled at 20 Hz is a staircase |
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
 * The `CollisionWorld` it *is* handed is not an exception to that. Level data is
 * on both players' screens — `movement/move.ts` makes the same argument about
 * the nav graph — and everything combat does with it is a trace against the same
 * geometry a person would be looking at.
 *
 * ## Who fills in what
 *
 * {@link BotDecision} is the seam. This file fills in `goal`, `evade` and the
 * fallback `aim`; the movement layer turns `goal` into a route and a stick
 * position (`movement/move.ts`, GLAD-TSED8V); the crosshair, the weapon and the
 * trigger are `combat/fire.ts` (GLAD-HK3ATM). Nothing reaches past it.
 *
 * The 125 Hz half of this file is assembly rather than steering: the aim decides
 * `yaw` and `pitch`, and the movement layer — which needs the yaw, because the
 * two axes are relative to it — decides `forwardMove`, `sideMove` and the jump
 * bit. That order is the only one available, and it is the same order a player's
 * hands work in.
 */

import { BUTTON_ATTACK, BUTTON_JUMP, PLAYER_VIEW_HEIGHT, Weapon, vec3 } from '@gladiator/sim'
import type { CollisionWorld, MutVec3, RngHolder, UserCmd } from '@gladiator/sim'

import { aimPitch, aimYaw } from './aim/controller.ts'
import {
  aimCombat,
  createCombat,
  observeCombat,
  planEvade,
  planShot,
  triggerCombat,
} from './combat/fire.ts'
import type { CombatState } from './combat/fire.ts'
import { moveBot } from './movement/move.ts'
import type { MoveState } from './movement/move.ts'
import { DAMAGE_ASSUMED_RANGE, hasContact, isAlert } from './perception/worldModel.ts'
import type { WorldModel } from './perception/worldModel.ts'
import { SHIPPED_SKILL } from './tuning.ts'
import type { BotSkill } from './tuning.ts'

/** Re-exported from where the servo lives, so every importer keeps one name. */
export { MAX_TURN_UNITS, TURN_RATE_DEGREES, wrapDelta, wrapUnits } from './aim/controller.ts'
export { pitchUnitsToward, yawUnitsToward } from './aim/controller.ts'

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
 * How close the bot tries to get, in Quake units.
 *
 * Inside this it stops closing and holds its ground. A rocket's splash radius
 * is 120 (`weapons.ts`), so this is comfortably outside the range at which
 * advancing on somebody is the same as standing in their explosion.
 */
export const ENGAGE_RANGE = SHIPPED_SKILL.engageRange

/**
 * What the decision layer has decided to *be doing*. One of five, and they are
 * exclusive.
 *
 * The tuning band table (GLAD-6BIYFQ) has a row for how often this changes, and
 * a row needs a thing to count. It is deliberately the top-level intention and
 * not the weapon or the shot mode: which of the two guns is in the bot's hands
 * flips whenever the opponent's feet leave the floor, and counting that would
 * measure how much the *opponent* is jumping rather than whether the bot is
 * dithering.
 *
 * Ordered by precedence, which is the order {@link decide} resolves them in: a
 * rocket in the air outranks whatever the bot was doing about the person who
 * fired it.
 */
export type BotAction =
  /** Not alive, or between rounds. Nothing is decided. */
  | 'dead'
  /** Getting out of the way of a rocket. */
  | 'dodge'
  /** A contact further away than {@link ENGAGE_RANGE}: closing on it. */
  | 'hunt'
  /** A contact inside it: holding ground and shooting. */
  | 'fight'
  /** Shot at by somebody it cannot see: looking down the bearing. */
  | 'listen'
  /** Nothing known. `movement/roam.ts` answers this one. */
  | 'roam'

/** A standing intention. Five ticks in six, this is what the command is built from. */
export type BotDecision = {
  /**
   * What the bot has decided to be doing. Diagnostics — nothing below this layer
   * branches on it, and it is written last so it cannot be read half-decided.
   */
  action: BotAction
  /**
   * Whether {@link aim} means anything.
   *
   * The *fallback* aim, and only that: when the bot has a contact, where the
   * crosshair goes is `combat/fire.ts`'s answer and this is `false`. What is
   * left is the one thing combat has no shot for — a bearing off a hit from
   * somebody the bot cannot see.
   */
  hasAim: boolean
  /** A world point to point the crosshair at, at eye height. */
  aim: MutVec3
  /** Whether {@link goal} means anything. `false` leaves the movement to roam. */
  hasGoal: boolean
  /** A world point to walk towards, at foot height. */
  goal: MutVec3
  /** Whether {@link evade} means anything. */
  hasEvade: boolean
  /**
   * A horizontal unit vector the feet should follow, overriding the route.
   *
   * A dodge is a *stick position*, not a destination — the same shape, and for
   * the same reason, as `stuck.ts`'s recovery steer: there is no node to route
   * to, only a direction to be in half a second from now. The follower keeps its
   * link while it obeys one, so the route survives the dodge.
   */
  evade: MutVec3
  /** Button bits the decision layer owns. The trigger is the tick layer's. */
  buttons: number
  weapon: Weapon
}

/** The decision layer's state: one standing decision, the combat layer, and a clock. */
export type BotBrain = {
  readonly decision: BotDecision
  /** The aim controller, the shot plan and the trigger. `combat/fire.ts`. */
  readonly combat: CombatState
  /** The tick the 20 Hz layer last ran on, or -1. */
  lastDecisionTick: number
}

export function createBrain(rng: RngHolder, skill: BotSkill = SHIPPED_SKILL): BotBrain {
  return {
    decision: {
      action: 'dead',
      hasAim: false,
      aim: vec3(),
      hasGoal: false,
      goal: vec3(),
      hasEvade: false,
      evade: vec3(),
      buttons: 0,
      weapon: Weapon.RocketLauncher,
    },
    combat: createCombat(rng, skill),
    lastDecisionTick: -1,
  }
}

/* --------------------------------------------------------------------------
 * The 20 Hz half
 * ----------------------------------------------------------------------- */

/**
 * Pick what to shoot with, where to go and what to get out of the way of, from
 * the model and the level data and nothing else.
 *
 * Three cases, in order of how much the bot knows:
 *
 * 1. **A contact.** `combat/fire.ts` plans the shot against it, and this layer
 *    closes on it if it is further away than {@link ENGAGE_RANGE}. The contact
 *    may be two seconds stale and half a room wide (`perception/memory.ts`) —
 *    this layer does not get to know the difference beyond the `confidence` and
 *    `uncertainty` it is handed, which is the whole arrangement.
 * 2. **A shove and no contact.** Look down the bearing the hit came from. There
 *    is no position in a hit, so there is nowhere to walk to and nothing to
 *    shoot at.
 * 3. **Nothing.** Hold, and say nothing about where to go. Sweeping for a target
 *    is search behaviour and it belongs with the movement that carries it out —
 *    `movement/roam.ts`, which is what answers an absent goal when there is no
 *    contact at all. The distinction is load-bearing: no goal *with* a contact is
 *    a bot holding its ground on purpose, and the movement layer leaves that
 *    alone.
 *
 * The dodge is asked in every one of the three. A rocket the bot can see is a
 * reason to move whether or not it knows where the person who fired it is —
 * which, when they fired from cover, it does not.
 */
export function decide(
  brain: BotBrain,
  model: WorldModel,
  world: CollisionWorld | null = null,
): void {
  const d = brain.decision
  d.hasAim = false
  d.hasGoal = false
  d.hasEvade = false
  d.buttons = 0
  d.weapon = model.self.weapon === Weapon.None ? Weapon.RocketLauncher : model.self.weapon

  if (!model.self.alive) {
    brain.combat.plan.mode = 'none'
    d.action = 'dead'
    return
  }

  d.weapon = planShot(brain.combat, model, world)
  d.hasEvade = planEvade(d.evade, brain.combat, model, world)

  if (hasContact(model)) {
    const enemy = model.enemy
    const dx = enemy.origin[0] - model.self.origin[0]
    const dy = enemy.origin[1] - model.self.origin[1]
    const engage = brain.combat.skill.engageRange
    if (dx * dx + dy * dy > engage * engage) {
      d.hasGoal = true
      d.goal[0] = enemy.origin[0]
      d.goal[1] = enemy.origin[1]
      d.goal[2] = enemy.origin[2]
    }
    d.action = d.hasEvade ? 'dodge' : d.hasGoal ? 'hunt' : 'fight'
    return
  }

  if (isAlert(model) && model.damageTick >= 0) {
    d.hasAim = true
    d.aim[0] = model.self.origin[0] + model.damageBearing[0] * DAMAGE_ASSUMED_RANGE
    d.aim[1] = model.self.origin[1] + model.damageBearing[1] * DAMAGE_ASSUMED_RANGE
    d.aim[2] = model.self.origin[2] + PLAYER_VIEW_HEIGHT
  }

  d.action = d.hasEvade ? 'dodge' : d.hasAim ? 'listen' : 'roam'
}

/* --------------------------------------------------------------------------
 * The 125 Hz half
 * ----------------------------------------------------------------------- */

/**
 * Assemble one sub-step's command out of a view, a trigger and a stick position.
 *
 * The order is forced and it is the same order a player's hands work in: the aim
 * decides where the view is, and *then* the feet are resolved against it,
 * because `forwardMove` and `sideMove` are relative to the yaw
 * (`movement/steer.ts`). The trigger sits between the two because it is a
 * question about the view — has the crosshair arrived — and asking it before the
 * servo has stepped would be asking about last sub-step's aim.
 *
 * `move` may be `null`, and that is the shape the walking skeleton had: no
 * routing, no ledge probes, no jump — a bot that aims, shoots and stands. It is
 * kept because the reverse — a movement layer that could not be left out — would
 * make every test of the aim depend on a nav graph.
 */
export function command(
  brain: BotBrain,
  model: WorldModel,
  move: MoveState | null,
  world: CollisionWorld | null = null,
): UserCmd {
  const d = brain.decision
  const combat = brain.combat

  aimCombat(combat, model, d.hasAim ? d.aim : null)
  const yaw = aimYaw(combat.aim)
  const pitch = aimPitch(combat.aim)

  const buttons = triggerCombat(combat, model, world, d.weapon)
    ? d.buttons | BUTTON_ATTACK
    : d.buttons

  if (move === null) {
    return { forwardMove: 0, sideMove: 0, yaw, pitch, buttons, weapon: d.weapon }
  }

  moveBot(move, model, d, yaw)
  return {
    forwardMove: move.axes.forwardMove,
    sideMove: move.axes.sideMove,
    yaw,
    pitch,
    // OR'd rather than assigned: jump is the movement layer's bit and attack is
    // the combat layer's, and a command carries both.
    buttons: move.jump ? buttons | BUTTON_JUMP : buttons,
    weapon: d.weapon,
  }
}

/**
 * One tick of the bot: track, then think if it is time to, then act.
 *
 * The decision is taken on ticks divisible by {@link BRAIN_INTERVAL_TICKS}, so
 * the phase is a property of the world's tick counter rather than of when this
 * bot happened to be created — two bots in one world think on the same ticks,
 * and a replay reproduces both.
 *
 * {@link observeCombat} runs first, every sub-step, so that a decision taken on
 * this one is taken about a target already tracked to it.
 */
export function think(
  brain: BotBrain,
  model: WorldModel,
  move: MoveState | null,
  world: CollisionWorld | null = null,
): UserCmd {
  observeCombat(brain.combat, model)
  if (brain.lastDecisionTick < 0 || model.tick - brain.lastDecisionTick >= BRAIN_INTERVAL_TICKS) {
    decide(brain, model, world)
    brain.lastDecisionTick = model.tick
  }
  return command(brain, model, move, world)
}
