/**
 * Hit confirmation and the damage-taken indicator: the two parts of the HUD
 * that are *feel* rather than information.
 *
 * Everything else on screen answers a question the player asked. These two
 * answer one they did not: "did that land", and "where did that come from".
 * Both have to arrive on the frame the state says so, which is why neither is
 * driven by a timer, an animation or an event from the input layer — they are a
 * fold over the same {@link HudModel} the numbers are drawn from, exactly the
 * way `audio/cues.ts` folds over netstates for the same two events.
 *
 * ## It is a fold, because both are made of *edges*
 *
 * "You hit them" is their health going down; "you were hit" is your own health
 * *plus armour* going down. Neither can be read off a single frame, so the fold
 * carries the previous observation, and a player seen for the first time
 * produces nothing at all — otherwise the first frame of a round would ring
 * every bell at once.
 *
 * The clock is the **tick**, never `performance.now()`. Feedback that decays
 * against wall-clock would decay at a different rate on a machine whose frames
 * are late, and the simulation's clock is the one both peers already agree
 * about. `render/animState.ts` holds its animation windows the same way.
 *
 * ## Attribution is honest about what it does not know
 *
 * `EntityState` says nothing about *who* took a player's health, so — like
 * `audio/cues.ts` — an opponent who rocket-jumps rings the hit confirmation.
 * Damage events carrying an attacker are GLAD-5QGO11's; when they land, this
 * reads their attribution instead of inferring one, and nothing above here
 * changes.
 *
 * ## The direction comes from the shove, not from a guess
 *
 * There is no attacker position in the state either, so the arc is derived from
 * the one thing a hit always leaves behind: knockback. Damage pushes you five
 * units of speed per point, along the shot for a rail and away from the blast
 * for splash (`sim/damage.ts`), and that push is *derived before* any
 * self-damage rule applies — so it is there in all four modes. Negate the
 * change in velocity and you are pointing at whatever hit you.
 *
 * It is stored as a **world** angle and re-projected against the current yaw
 * every frame, so the arc stays pinned to the attacker while the player spins
 * to face them, which is the entire reason to draw one.
 */
import { angleUnitsToRadians } from '@gladiator/sim'

import type { HudModel, HudPlayer } from './hudModel.ts'

/**
 * How long the hit marker is on screen, in sub-steps. 45 = 360 ms.
 *
 * Long enough to register while your eye is on the opponent rather than the
 * crosshair, short enough that two rockets 800 ms apart are two separate
 * confirmations rather than one that never goes out.
 */
export const HIT_TICKS = 45

/** How long the damage indicator lasts, in sub-steps. 100 = 800 ms. */
export const DAMAGE_TICKS = 100

/**
 * How long the frag marker is on screen, in sub-steps. 125 = one second.
 *
 * Nearly three times {@link HIT_TICKS}, and the asymmetry is the point: a hit
 * marker has to clear in time for the next one, and a frag has no next one —
 * the round is over. It is still tick-clocked rather than wall-clocked, so it
 * lasts the same length of round on a machine dropping frames.
 */
export const FRAG_TICKS = 125

/**
 * Horizontal knockback below which the arc points nowhere, in qu/s.
 *
 * A hit's knockback is 5.5 units of speed per point of damage, so even a
 * glancing 12-point splash clears this comfortably. What it excludes is the
 * case with no horizontal information in it at all — a rocket straight down at
 * your own feet, whose push is almost entirely vertical — where an arc would
 * be pointing in whatever direction the noise happened to fall. The hurt flash
 * still fires; only the *direction* is withheld.
 */
export const MIN_SHOVE = 60

/** A `since` that has never happened. Every elapsed comparison against it is infinite. */
const NEVER = Number.NEGATIVE_INFINITY

export type FeedbackMemory = {
  /** `false` until the first observation, which deliberately emits nothing. */
  readonly seen: boolean
  /** The opponent's health last frame. A drop in it is a hit. */
  readonly opponentHealth: number
  /** Your own health plus armour last frame. A drop in it is damage taken. */
  readonly selfReserve: number
  /** Whether the opponent was alive last frame. Going dead is the frag edge. */
  readonly opponentAlive: boolean
  /** Your own horizontal velocity last frame, for the knockback difference. */
  readonly selfVelocity: readonly [number, number]
  readonly hitSince: number
  readonly fragSince: number
  readonly damageSince: number
  /**
   * Where the last hit came from, as a **world** yaw in radians, or `null` if
   * the shove said nothing. Re-projected against the current facing each frame.
   */
  readonly sourceWorldAngle: number | null
}

export const INITIAL_FEEDBACK: FeedbackMemory = {
  seen: false,
  opponentHealth: 0,
  opponentAlive: false,
  selfReserve: 0,
  selfVelocity: [0, 0],
  hitSince: NEVER,
  fragSince: NEVER,
  damageSince: NEVER,
  sourceWorldAngle: null,
}

/** What the view draws. Everything is 0..1 except the angle. */
export type FeedbackState = {
  /** Hit confirmation, 1 on the frame it lands and fading to 0. */
  readonly hit: number
  /**
   * Frag confirmation — you killed them — on the same 1-to-0 shape.
   *
   * A separate channel rather than a flag on {@link hit}, because the two are
   * drawn differently and overlap for exactly one frame: the killing blow
   * raises this one and, deliberately, not the hit marker.
   */
  readonly frag: number
  /** Damage taken, same shape. Drives the hurt flash. */
  readonly damage: number
  /**
   * Radians clockwise from straight ahead, or `null` for damage with no
   * direction in it. Zero is dead ahead; `+PI/2` is to the player's right.
   */
  readonly damageAngle: number | null
}

export const NO_FEEDBACK: FeedbackState = { hit: 0, frag: 0, damage: 0, damageAngle: null }

export type FeedbackResult = {
  readonly memory: FeedbackMemory
  readonly state: FeedbackState
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/** Linear fade from 1 at `since` to 0 at `since + ticks`. */
function decay(since: number, tick: number, ticks: number): number {
  return clamp01(1 - (tick - since) / ticks)
}

/** Health plus armour: the one number a hit always reduces. `match/round.ts`. */
function reserveOf(player: HudPlayer): number {
  return player.health + player.armor
}

/** Wrap to `(-PI, PI]`, so an arc never takes the long way round. */
function wrapAngle(radians: number): number {
  const turn = 2 * Math.PI
  let wrapped = radians % turn
  if (wrapped > Math.PI) wrapped -= turn
  if (wrapped <= -Math.PI) wrapped += turn
  return wrapped
}

/**
 * The world yaw of whatever produced this change in velocity, or `null`.
 *
 * The push points away from the source, so the source is at the negation of it.
 * Quake's frame: `+x` forward, `+y` left, and `atan2(y, x)` is the yaw the rest
 * of the simulation uses.
 */
export function shoveSourceAngle(
  before: readonly [number, number],
  after: readonly [number, number],
): number | null {
  const dx = after[0] - before[0]
  const dy = after[1] - before[1]
  if (Math.sqrt(dx * dx + dy * dy) < MIN_SHOVE) return null
  return Math.atan2(-dy, -dx)
}

/**
 * Fold one frame of the model into the feedback it produces.
 *
 * Pure: same models in, same feedback out, no clock read anywhere. The state it
 * returns is for *this* frame, so a hit registered here is drawn here — there
 * is no queue between the fold and the pixels.
 */
export function advanceFeedback(memory: FeedbackMemory, model: HudModel): FeedbackResult {
  const { self, opponent, tick } = model
  const velocity: readonly [number, number] = [self.velocity[0], self.velocity[1]]
  const reserve = reserveOf(self)

  if (!memory.seen) {
    // First sight. Seed and stay quiet: every rule below is an edge, and every
    // edge would fire against a memory of nothing.
    return {
      memory: {
        seen: true,
        opponentHealth: opponent.health,
        opponentAlive: opponent.alive,
        selfReserve: reserve,
        selfVelocity: velocity,
        hitSince: NEVER,
        fragSince: NEVER,
        damageSince: NEVER,
        sourceWorldAngle: null,
      },
      state: NO_FEEDBACK,
    }
  }

  // --- you hit them ---------------------------------------------------------
  // Only while they are actually in the world: a slot emptying is a player
  // leaving, and a departure is not a hit.
  //
  // The killing blow raises the frag instead of the hit marker, the same way
  // `audio/cues.ts` swaps the confirmation sound: the round-winning shot has
  // its own punctuation, and drawing both would say the same thing twice.
  const killed = opponent.present && memory.opponentAlive && !opponent.alive
  const landed = opponent.present && opponent.health < memory.opponentHealth && !killed
  const hitSince = landed ? tick : memory.hitSince
  const fragSince = killed ? tick : memory.fragSince

  // --- they hit you ---------------------------------------------------------
  // Health *plus* armour, because armour absorbs 66% of every hit and a rocket
  // that costs you nothing but armour is still a rocket that hit you. A round
  // start raises both, which is an increase and therefore not an edge.
  const hurt = self.present && reserve < memory.selfReserve
  const damageSince = hurt ? tick : memory.damageSince
  const sourceWorldAngle = hurt
    ? shoveSourceAngle(memory.selfVelocity, velocity)
    : memory.sourceWorldAngle

  const damage = decay(damageSince, tick, DAMAGE_TICKS)

  return {
    memory: {
      seen: true,
      opponentHealth: opponent.health,
      opponentAlive: opponent.alive,
      selfReserve: reserve,
      selfVelocity: velocity,
      hitSince,
      fragSince,
      damageSince,
      sourceWorldAngle,
    },
    state: {
      hit: decay(hitSince, tick, HIT_TICKS),
      frag: decay(fragSince, tick, FRAG_TICKS),
      damage,
      // Re-projected against where the player is looking *now*, so the arc
      // follows the attacker round the screen as they turn to face them. Yaw
      // in the Quake frame increases anticlockwise, and the arc is drawn
      // clockwise from the top of the screen, hence the subtraction this way
      // round.
      damageAngle:
        damage > 0 && sourceWorldAngle !== null
          ? wrapAngle(angleUnitsToRadians(self.yawUnits) - sourceWorldAngle)
          : null,
    },
  }
}

/* --------------------------------------------------------------------------
 * The stateful shell
 *
 * `advanceFeedback` is the whole rule set and is pure. This is the ten lines
 * that carry one memory forward, so `main.ts` does not have to.
 * ----------------------------------------------------------------------- */

export type FeedbackTracker = {
  /** Fold one frame and return what should be on screen for it. */
  observe(model: HudModel): FeedbackState
  /** Forget everything. A reconnection, a new match, a new map. */
  reset(): void
}

export function createFeedbackTracker(): FeedbackTracker {
  let memory = INITIAL_FEEDBACK
  return {
    observe(model) {
      const result = advanceFeedback(memory, model)
      memory = result.memory
      return result.state
    },
    reset() {
      memory = INITIAL_FEEDBACK
    },
  }
}
