/**
 * Predicted self-splash, and the predicate that makes it safe.
 *
 * Quake 3 does not predict self-knockback at all: you press the button, the
 * server decides, and the rocket jump launches you one round trip later. At
 * 100 ms that is a visible, felt delay on the single most expressive thing in
 * the movement, and this game can do better — the client runs the identical
 * `tick()`, so it already knows exactly what its own rocket is about to do.
 *
 * It can do better *only when the rocket's flight is genuinely unobstructed*,
 * and that clause is the whole of this file.
 *
 * ## Why an unguarded prediction is dangerous
 *
 * You draw the opponent 80 ms in the past. Your rocket can therefore pass
 * through empty space on your screen and clip them on the host, which detonates
 * it *short* — somewhere your splash never reaches. You predicted a 500 qu/s
 * launch and the authoritative world gives you none of it. At 150 ms ping the
 * accumulated error reaches roughly 115 units, which is within a whisker of the
 * hard-snap threshold (one splash radius, `client/net/reconcile.ts`). The
 * failure mode is not a small rubber band: it is **the player teleporting out of
 * the air**, on the one manoeuvre they were concentrating hardest on.
 *
 * So: **predict self-splash only when the rocket's predicted path stays more
 * than {@link SELF_SPLASH_CLEARANCE} clear of every opponent's hitbox over its
 * entire flight.** Otherwise fall back to server-only for that rocket, which is
 * exactly Quake 3's behaviour and is a delay rather than a lie.
 *
 * ## How the clearance is measured
 *
 * By fattening the target's box rather than by computing a segment-to-box
 * distance. "Did this segment come within 32 units of that box" becomes "did a
 * rocket with a 32-unit hull hit it", which is {@link rayBoxFraction} — code
 * that already exists, is already the thing the real rocket is tested against,
 * and cannot fall out of step with it.
 *
 * The fattened box over-approximates at the corners: a point 32 units out along
 * a diagonal is inside the expanded box but 55 units from the real one. That
 * error is deliberately in the safe direction — it can only refuse a prediction
 * that would have been fine, never allow one that would not.
 *
 * ## The fold, not the forecast
 *
 * The predicate is offered every sub-step of the flight rather than evaluated
 * once at the muzzle, because the opponent's future positions are precisely what
 * a client does not have. It does not need them: self-splash is applied at
 * *detonation*, so by the time the answer is wanted the whole flight has already
 * happened and every segment of it has been checked against where the opponent
 * actually was at that moment. A rocket jump is one sub-step long and is decided
 * on the tick it is fired; a rocket across the map accumulates its answer over
 * the second it spends in the air.
 */

import type { Vec3 } from './axis.ts'
import { PLAYER_MAXS, PLAYER_MINS } from './bbox.ts'
import type { EntityState, GameState } from './state.ts'
import { rayBoxFraction } from './trace.ts'

/**
 * How far a rocket has to stay from an opponent for its owner to predict their
 * own splash, in Quake units. **32**.
 *
 * A little over a body width. It has to cover the difference between where the
 * client draws an opponent and where the host has them, and that difference is
 * the interpolation delay plus half a round trip of their movement: at 80 ms and
 * run speed, about 26 units. Thirty-two is that with a margin, and it is small
 * enough that the common rocket jump — nobody within a body width of you — still
 * predicts.
 */
export const SELF_SPLASH_CLEARANCE = 32

/** The player box grown by {@link SELF_SPLASH_CLEARANCE}. See the header. */
export const CLEARANCE_MINS: Vec3 = [
  PLAYER_MINS[0] - SELF_SPLASH_CLEARANCE,
  PLAYER_MINS[1] - SELF_SPLASH_CLEARANCE,
  PLAYER_MINS[2] - SELF_SPLASH_CLEARANCE,
]

/** The other half of {@link CLEARANCE_MINS}. */
export const CLEARANCE_MAXS: Vec3 = [
  PLAYER_MAXS[0] + SELF_SPLASH_CLEARANCE,
  PLAYER_MAXS[1] + SELF_SPLASH_CLEARANCE,
  PLAYER_MAXS[2] + SELF_SPLASH_CLEARANCE,
]

/**
 * Does the segment `from -> to` stay clear of a player standing at `origin`?
 *
 * `true` means "more than {@link SELF_SPLASH_CLEARANCE} away for the whole
 * segment, or near enough that the corner over-approximation says so anyway".
 * A zero-length segment is a point test, which is what a rocket that detonated
 * where it was born reduces to.
 */
export function segmentClearsPlayer(from: Vec3, to: Vec3, origin: Vec3): boolean {
  return rayBoxFraction(from, to, origin, CLEARANCE_MINS, CLEARANCE_MAXS) === 1
}

/**
 * The seam a *predicting* peer fills in to say which of its own rockets it is
 * willing to be knocked about by before the host has confirmed it.
 *
 * Absent on the authoritative host, which applies every splash it computes —
 * there is nothing for it to be uncertain about. This is the `isClient` guard,
 * and it is a seam rather than a flag so that the simulation package still has
 * no idea what a client is.
 *
 * The implementation is `client/net/rocketPredict.ts`.
 */
export type SelfSplashPolicy = {
  /**
   * One sub-step of a rocket's flight, from where it was to where it got to.
   *
   * Called for **every** rocket in the world, including the opponent's — the
   * policy decides which ones it cares about. `from` and `to` are the
   * simulation's own scratch vectors and are overwritten by the next rocket:
   * read them, do not keep them.
   */
  observe(state: GameState, rocket: EntityState, from: Vec3, to: Vec3): void
  /**
   * May this rocket's splash reach the player who fired it, on this peer?
   *
   * `false` defers exactly that share of the explosion to the next snapshot;
   * everybody else in the blast is damaged as normal, because the uncertainty is
   * about the shooter's own launch and nothing else.
   */
  allow(state: GameState, rocket: EntityState): boolean
}
