/**
 * What the bot believes — and the reason every layer above this one is written
 * against it rather than against `GameState`. GLAD-V7CMHR.
 *
 * ## The invariant
 *
 * **Only `perceive.ts` touches ground truth. Everything above reads
 * `bot.worldModel`.** That is not a style rule: it is what makes "the bot is
 * not omniscient" a thing a test can assert. `perception/fairness.test.ts`
 * perturbs state that is deliberately absent from this structure and requires
 * the bot's `UserCmd` stream to come out **bit-identical** — a binary claim, and
 * one nothing in a decision layer can quietly game. `eslint.config.js`'s
 * `GROUND_TRUTH_BANS` closes the door statically: nothing in
 * `packages/bot` outside `perception/` may so much as name `GameState`,
 * `EntityState` or `state.entities`, which are the only carriers an opponent's
 * health, armour or aim could arrive on.
 *
 * ## The gap in Quake 3 this exists to close
 *
 * Q3's `BotFindEnemy` applies a distance-scaled field of view at *acquisition*
 * — and then `BotAimAtEnemy` calls `BotEntityVisible` with a **360-degree**
 * FOV. So once a Q3 bot has seen you it tracks you through walls, forever, with
 * no memory and nothing to decay. That single asymmetry is the actual source of
 * "the bot knew where I was". Here, acquisition and maintenance are two
 * thresholds on the *same* per-tick visibility fraction, and everything after
 * the last one is {@link MEMORY_TICKS} of decay.
 *
 * ## Why perceptual limits and not nerfed aim
 *
 * A bot that misses on a dice roll reads as *random*: sometimes a god,
 * sometimes a fool, and there is no counterplay because nothing the player did
 * caused it. A bot that cannot see behind itself is *legible* — break line of
 * sight, flank, bait a shot — and its limits become the game's tactical
 * surface rather than an apology for it.
 *
 * ## What is deliberately not in here
 *
 * The opponent's health, armour, ammunition, `nextFireTick` and view angles.
 * There is no ammunition in this game at all (`weapons.ts`), and the other four
 * are things a duelling human infers rather than reads. {@link EnemyContact}
 * carries a *weapon*, because you read that off a silhouette or off a shot you
 * just heard — and it is written only under those two gates.
 */

import { MatchPhase, PLAYER_VIEW_HEIGHT, RUN_SPEED, Weapon, vec3 } from '@gladiator/sim'
import type { MutVec3 } from '@gladiator/sim'

/* --------------------------------------------------------------------------
 * Sight
 * ----------------------------------------------------------------------- */

/**
 * The width of the sight cone, in degrees, measured corner to corner.
 *
 * A hundred is a little under a human's *useful* field — the band where you
 * would actually notice a player-sized thing move, rather than the ~200 degrees
 * an eye chart calls peripheral vision. It is also comfortably wider than the
 * 90-degree default FOV the game is drawn at, so the bot is not blind to
 * something a player at the same position would have on screen.
 */
export const SIGHT_FOV_DEGREES = 100

/**
 * The cone while the bot is *alert*, in degrees. See {@link ALERT_TICKS}.
 *
 * Being shot makes you look around. Widening the cone rather than granting a
 * position is the whole shape of the damage channel: it makes the attacker
 * easier to *find*, and finding is still something that has to happen.
 */
export const ALERT_FOV_DEGREES = 160

/**
 * How far the bot can see a player, in Quake units.
 *
 * Long enough to cross the arena — `maps/arena1.ts` is about 2000 units across
 * — and short enough to be a gate rather than a formality. The railgun carries
 * 8192 (`weapons.ts`), so this is deliberately *not* "as far as you can shoot":
 * a target you cannot resolve is one you should not be duelling at.
 */
export const SIGHT_RANGE = 3000

/**
 * The visibility fraction a *new* contact needs.
 *
 * The pair — a quarter to acquire, anything above zero to maintain — is the
 * whole answer to Q3's asymmetry, in the other direction: spotting somebody
 * through a railing is hard, and keeping track of them once you have is not.
 *
 * A quarter is deliberately *between* two of the weights in
 * {@link SIGHT_SAMPLES}, which is what makes both halves of the pair do work: a
 * pair of legs under a beam is 0.125 and will not start a contact, and will
 * keep one going.
 */
export const ACQUIRE_VISIBILITY = 0.25

/**
 * How long a sighting keeps its *maintenance* threshold, in sub-steps. 25 = 200 ms.
 *
 * Without it, one tick of a passing pillar demotes a target being actively
 * duelled back to re-acquisition, and the bot loses people while looking
 * straight at them. With it, a break has to last a fifth of a second — which is
 * what "they got behind cover" actually looks like.
 */
export const SIGHT_HOLD_TICKS = 25

/**
 * Where the three line-of-sight rays are aimed and what each is worth:
 * `[height above the target's feet, share of the fraction]`. `bbox.ts` — the
 * origin is on the soles and the box is 56 tall.
 *
 * Three rays, not one: a single ray at the centre of mass makes a body behind a
 * waist-high crate either fully visible or fully hidden, and a duel is played
 * around exactly that geometry. Three give a *fraction*, which is what the two
 * thresholds above are thresholds on.
 *
 * **The shares are not equal, and that is what makes the two thresholds
 * differ.** A chest is the largest and most distinctive part of a silhouette; a
 * pair of legs under a railing is a glimpse. With equal thirds, "at least a
 * quarter visible" and "at least something visible" would be the same
 * predicate and one of the two would be dead code.
 *
 * All three are exact binary fractions, so a fully visible body is exactly `1`
 * rather than `0.9999999999999999` — which matters when the number is compared
 * against a threshold and printed in a debug readout.
 */
export const SIGHT_SAMPLES: readonly (readonly [number, number])[] = [
  [4, 0.125],
  [28, 0.5],
  [PLAYER_VIEW_HEIGHT, 0.375],
]

/* --------------------------------------------------------------------------
 * Sound
 * ----------------------------------------------------------------------- */

/**
 * How far a shot carries, in Quake units.
 *
 * Most of this arena, which is the point: firing is loud, and a duel where
 * nobody could hear a rocket go off would reward camping a corner with a rail.
 */
export const FIRE_HEARING_RANGE = 1800

/** How far footsteps carry, in Quake units. A quarter of a shot's reach. */
export const FOOTSTEP_HEARING_RANGE = 700

/**
 * The horizontal speed above which feet make noise, in qu/s.
 *
 * This is the stealth option, and it is a real one: below this the bot hears
 * nothing at all, so approaching slowly is a decision with a cost (you are slow)
 * and a payoff (you are silent). Quake spells the same idea as a walk button;
 * `UserCmd` has no crouch or walk bit yet (`usercmd.ts`), so the threshold is on
 * the speed itself, and the day a walk button arrives this becomes the speed it
 * caps you at.
 */
export const FOOTSTEP_SPEED = 140

/** Sub-steps between footfalls. 40 = 320 ms, which is a run cadence. */
export const FOOTSTEP_INTERVAL_TICKS = 40

/**
 * How wrong a heard bearing may be, in degrees, either way.
 *
 * The number that stops hearing from being a wallhack. A sound gives you a
 * *direction to look*, never a position to shoot at — 22 degrees at 1400 units
 * is over 500 units of lateral error, so a bot that snapped to the sound and
 * fired would miss by more than a splash radius. `fairness.test.ts` asserts
 * exactly that.
 */
export const SOUND_BEARING_ERROR_DEGREES = 22

/** How wrong a heard distance may be, as a fraction, either way. */
export const SOUND_DISTANCE_ERROR = 0.25

/**
 * The uncertainty radius a sound contact carries, as a fraction of the true
 * distance.
 *
 * The two errors above, in quadrature: the bearing error is `sin(22 deg)` of the
 * distance sideways, the range error is a quarter of it along the line, and
 * `sqrt(0.3746^2 + 0.25^2)` is the radius that contains both. Written out
 * rather than computed so that the number in a debugger is the number in this
 * comment.
 */
export const SOUND_UNCERTAINTY_FRACTION = 0.45

/**
 * How much a bot believes its ears, in `[0, 1]`.
 *
 * Half of a sighting. High enough to turn and look, low enough that a decision
 * layer comparing "I can see them" against "I heard something" never prefers the
 * second.
 */
export const SOUND_CONFIDENCE = 0.5

/* --------------------------------------------------------------------------
 * Damage
 * ----------------------------------------------------------------------- */

/**
 * How much a bot believes a shove, in `[0, 1]`.
 *
 * Below {@link SOUND_CONFIDENCE}: a hit tells you a *bearing* and nothing about
 * range, so as a position it is the weakest thing in here. It is in the model
 * at all because the bearing is worth acting on.
 */
export const DAMAGE_CONFIDENCE = 0.4

/**
 * How far along the bearing a damage contact is placed, in Quake units, when
 * there is no memory to borrow a distance from.
 *
 * Half the hearing range: near enough to be worth walking towards, far enough
 * not to make the bot charge into a wall. The contact's `uncertainty` is set to
 * the same number, which is this channel saying, in the only unit the model
 * has, that it does not know the range at all.
 */
export const DAMAGE_ASSUMED_RANGE = 512

/**
 * Horizontal knockback below which a hit points nowhere, in qu/s.
 *
 * The same constant, for the same reason, as `client/ui/feedback.ts`'s
 * `MIN_SHOVE`: a rocket at your own feet pushes almost straight up, and the
 * horizontal remainder is noise rather than a bearing. The alertness window
 * still opens; only the *direction* is withheld.
 */
export const MIN_SHOVE = 60

/**
 * How long being hit widens the cone for, in sub-steps. 150 = 1.2 s.
 *
 * Long enough to sweep {@link ALERT_FOV_DEGREES} at the bot's turn rate, short
 * enough that it is a reaction and not a permanent upgrade.
 */
export const ALERT_TICKS = 150

/* --------------------------------------------------------------------------
 * Memory
 * ----------------------------------------------------------------------- */

/**
 * How long a contact survives with nothing to refresh it, in sub-steps.
 * 275 = 2.2 s.
 *
 * The number that makes breaking line of sight *work*. Two seconds is about how
 * long a player stays where you last saw them before the guess is worthless: at
 * {@link RUN_SPEED} they have covered 700 units by then, which on this arena is
 * anywhere at all. Confidence falls linearly to exactly zero at this age, and a
 * contact at zero confidence is {@link ContactSource} `'none'` — not a stale
 * position with a small number attached to it.
 */
export const MEMORY_TICKS = 275

/**
 * How fast a remembered position blurs, in Quake units per second.
 *
 * Run speed, because that is the fastest a target can be somewhere the dead
 * reckoning did not put them. It is an honest bound rather than a tuned one:
 * after `t` seconds the truth is inside `uncertainty` of the belief, unless the
 * target rocket-jumped.
 */
export const UNCERTAINTY_GROWTH = RUN_SPEED

/* --------------------------------------------------------------------------
 * The model
 * ----------------------------------------------------------------------- */

/** A tick number for something that has never happened. */
export const NEVER_TICK = -1

/**
 * Which channel the belief came from.
 *
 * `'none'` is a real state and the important one: it is what the model says
 * after {@link MEMORY_TICKS} of nothing, and it is why a decision layer can ask
 * "do I know where they are" without inventing a confidence threshold of its
 * own.
 *
 * There is deliberately no `'memory'` member. Memory is not a fifth channel —
 * it is what happens to the other three when nothing refreshes them, and it
 * keeps the provenance rather than replacing it, because "a sighting two
 * seconds old" and "a noise two seconds old" are worth different amounts.
 * {@link EnemyContact.fresh} is the flag that separates the two, and
 * {@link isRemembered} is the name for it.
 */
export type ContactSource = 'none' | 'sight' | 'sound' | 'damage'

/**
 * What a channel's belief is worth the instant it is written, in `[0, 1]`.
 *
 * The base that {@link MEMORY_TICKS} of decay eats into, and the priority
 * ordering between the channels: a live sighting is never displaced by a noise,
 * and a noise is never displaced by a shove. One function, so the two uses
 * cannot drift apart.
 */
export function confidenceOf(source: ContactSource): number {
  if (source === 'sight') return 1
  if (source === 'sound') return SOUND_CONFIDENCE
  if (source === 'damage') return DAMAGE_CONFIDENCE
  return 0
}

/**
 * What the bot believes about its opponent.
 *
 * Every field in here is something a human in the same seat would have. There
 * is no health, no armour, no ammunition and no view angle, and that absence is
 * load-bearing — see the header, and `fairness.test.ts`, which asserts the
 * absence rather than trusting it.
 */
export type EnemyContact = {
  source: ContactSource
  /** Where the bot believes the opponent's feet are. Meaningless when `'none'`. */
  origin: MutVec3
  /**
   * The velocity the belief is being dead-reckoned along, in qu/s.
   *
   * Zero for every channel but sight: a sound gives a point and a shove gives a
   * bearing, and neither says anything about which way somebody is travelling.
   */
  velocity: MutVec3
  /** Radius, in Quake units, the truth is expected to lie within. */
  uncertainty: number
  /** `[0, 1]`. Zero exactly when `source` is `'none'`. */
  confidence: number
  /** Whether a channel confirmed this belief on the current tick. */
  fresh: boolean
  /** This tick's sight fraction, in `[0, 1]`. Zero when nothing was seen. */
  visibility: number
  /** Whether the opponent is on screen *now*. */
  visible: boolean
  /** The last tick sight wrote this contact, or {@link NEVER_TICK}. */
  lastSeenTick: number
  /** The last tick any channel wrote it, or {@link NEVER_TICK}. */
  lastContactTick: number
  /**
   * The weapon the bot believes is in their hands, or `Weapon.None` for "no
   * idea".
   *
   * Written under exactly two gates, which are the two a player has: it is
   * visible on the model, or it just went off. Everything else leaves the last
   * belief standing, which is also what a player does.
   */
  weapon: Weapon
  /** The tick {@link weapon} was last confirmed, or {@link NEVER_TICK}. */
  weaponTick: number
}

/**
 * What the bot knows about *itself*, which is everything.
 *
 * Its own body is not a perception problem — a player has a health bar, a
 * velocity they can feel and a crosshair they are pointing. This is a copy
 * rather than a reference into the world so that nothing above the perception
 * layer holds an `EntityState` at all.
 */
export type SelfModel = {
  slot: number
  entityId: number
  alive: boolean
  origin: MutVec3
  velocity: MutVec3
  /** `[pitch, yaw, roll]` in angle units — the bot's own aim. */
  angles: MutVec3
  health: number
  armor: number
  weapon: Weapon
  onGround: boolean
  knockbackTicks: number
  /** The first tick this bot may fire on again. Its own weapon timer. */
  nextFireTick: number
}

/**
 * A rocket the bot can see, or one of its own.
 *
 * Perception rather than combat, because a rocket is something you *spot* — and
 * if rocket dodging (GLAD-HK3ATM) had to reach into `state.entities` for the
 * list, the boundary this file exists for would have a hole in it the size of
 * the thing the bot reacts to most.
 */
export type ThreatContact = {
  /** The projectile's entity id, so a dodge can track one across ticks. */
  id: number
  origin: MutVec3
  velocity: MutVec3
  /** Whether the bot fired it. Its own rockets are known without being seen. */
  own: boolean
}

/** How many rockets the bot tracks at once. Two players, one launcher each. */
export const MAX_THREATS = 8

/**
 * The scoreboard. Public information — it is on the HUD, for both players.
 */
export type MatchModel = {
  phase: MatchPhase
  round: number
  /** Rounds this bot has won. */
  mine: number
  /** Rounds the opponent has won. */
  theirs: number
}

/** Everything the bot is allowed to know, and the only thing it is handed. */
export type WorldModel = {
  /** The tick this model was last brought up to date on. */
  tick: number
  self: SelfModel
  enemy: EnemyContact
  /** Visible rockets, nearest first. Reused in place; never reallocated. */
  threats: ThreatContact[]
  match: MatchModel
  /** While `tick` is below this, the sight cone is {@link ALERT_FOV_DEGREES}. */
  alertUntilTick: number
  /**
   * A horizontal unit vector pointing at whatever last hit the bot, or all
   * zeroes.
   *
   * Derived from the knockback and nothing else, exactly as the player's own
   * damage indicator is (`client/ui/feedback.ts`) — the state carries no
   * attacker, so this is the honest amount of information a hit leaves behind.
   */
  damageBearing: MutVec3
  /** The tick {@link damageBearing} was written, or {@link NEVER_TICK}. */
  damageTick: number
}

/** A contact that knows nothing. */
export function createContact(): EnemyContact {
  return {
    source: 'none',
    origin: vec3(),
    velocity: vec3(),
    uncertainty: 0,
    confidence: 0,
    fresh: false,
    visibility: 0,
    visible: false,
    lastSeenTick: NEVER_TICK,
    lastContactTick: NEVER_TICK,
    weapon: Weapon.None,
    weaponTick: NEVER_TICK,
  }
}

/** Forget everything about the opponent. A round boundary; a respawn. */
export function clearContact(contact: EnemyContact): void {
  contact.source = 'none'
  contact.origin[0] = 0
  contact.origin[1] = 0
  contact.origin[2] = 0
  contact.velocity[0] = 0
  contact.velocity[1] = 0
  contact.velocity[2] = 0
  contact.uncertainty = 0
  contact.confidence = 0
  contact.fresh = false
  contact.visibility = 0
  contact.visible = false
  contact.lastSeenTick = NEVER_TICK
  contact.lastContactTick = NEVER_TICK
  contact.weapon = Weapon.None
  contact.weaponTick = NEVER_TICK
}

/** A model that has perceived nothing yet. */
export function createWorldModel(slot: number): WorldModel {
  return {
    tick: NEVER_TICK,
    self: {
      slot,
      entityId: 0,
      alive: false,
      origin: vec3(),
      velocity: vec3(),
      angles: vec3(),
      health: 0,
      armor: 0,
      weapon: Weapon.None,
      onGround: false,
      knockbackTicks: 0,
      nextFireTick: 0,
    },
    enemy: createContact(),
    threats: [],
    match: { phase: MatchPhase.Warmup, round: 0, mine: 0, theirs: 0 },
    alertUntilTick: NEVER_TICK,
    damageBearing: vec3(),
    damageTick: NEVER_TICK,
  }
}

/**
 * Whether the bot believes it knows where the opponent is.
 *
 * One predicate, so that "is there a contact" is spelled the same way in every
 * decision layer. `source !== 'none'` and `confidence > 0` are the same
 * condition by construction — `memory.ts`'s `ageContact` clears one exactly
 * when it zeroes the other — and this is the name for it.
 */
export function hasContact(model: WorldModel): boolean {
  return model.enemy.source !== 'none'
}

/**
 * Whether the belief is being remembered rather than perceived — a contact that
 * exists and that nothing confirmed this tick.
 */
export function isRemembered(model: WorldModel): boolean {
  return model.enemy.source !== 'none' && !model.enemy.fresh
}

/** Whether the bot is inside the widened-cone window opened by a hit. */
export function isAlert(model: WorldModel): boolean {
  return model.tick < model.alertUntilTick
}

/** The full width of the sight cone right now, in degrees. */
export function fovDegrees(model: WorldModel): number {
  return isAlert(model) ? ALERT_FOV_DEGREES : SIGHT_FOV_DEGREES
}
