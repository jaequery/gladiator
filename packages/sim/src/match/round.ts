/**
 * The round and match state machine: what a death does, when a round ends, and
 * what the next one starts from. `docs/physics-spec.md` §7.
 *
 * Rocket Arena's format, and it is four states and five edges:
 *
 * ```
 *   Warmup --startMatch--> Live --somebody died------> Intermission --clock--> Live
 *                            \    or the clock ran out      |
 *                             \                             \--score reached--> Over
 *                              \--score reached, or the round cap--------------> Over
 * ```
 *
 * Plus one edge that comes from outside the world: {@link forfeitMatch} takes
 * either playing phase straight to `Over`, because a seat that has been empty
 * for thirty seconds is a match that cannot be finished (GLAD-DVDV6P).
 *
 * {@link advanceMatch} is a kernel phase and runs at the end of every sub-step,
 * after damage has been dealt and rockets have been removed. That position is
 * the contract: a death is visible to the round rules on the tick it happened,
 * not the tick after, so two peers end the round on the same tick number.
 *
 * ## Three decisions worth naming
 *
 * **A round is over the instant a player dies — including when both do.** Two
 * rockets that land on the same sub-step kill both players and the round is a
 * draw, scored to nobody. It is rare and it is reachable, and the alternative —
 * picking a winner by entity order — would hand the round to whoever happened
 * to spawn first.
 *
 * **Rockets in the air are removed when a round ends, not detonated.** A round
 * that has been decided cannot be un-decided by an explosion that arrives
 * afterwards, and a winner who spends the intermission as a corpse is a winner
 * the renderer has to draw dead. `explodeProjectile` stays for the fuse, which
 * is a rocket ending inside a round rather than after one.
 *
 * **The clock decides a round on damage taken, not on a coin.** At the time
 * limit the player with more health *plus armour* wins, because that is the
 * figure both players actually spent the round trying to reduce. Exactly equal
 * is a draw — two players who never found each other both have 200 — which is
 * why {@link MatchRules.maxRounds} exists.
 *
 * ## What a round start resets
 *
 * All of it, through `spawnRound`: origin, facing, velocity, flags, health,
 * armour, the weapon in hand, both fire timers and the knockback window. The
 * entity itself is *reused* — same id, same slot — so a client interpolating an
 * opponent sees them move rather than seeing one model vanish and a stranger
 * appear (`spawn.ts`).
 */

import { EntityFlag, EntityKind, findPlayer, removeEntity } from '../state.ts'
import type { EntityState, GameState } from '../state.ts'
import { MatchPhase, NO_DEADLINE, NO_WINNER } from './match.ts'
import type { MatchRules } from './match.ts'
import { DUEL_SLOTS, spawnRound } from './spawn.ts'
import type { SpawnPlan } from './spawn.ts'

/* --------------------------------------------------------------------------
 * Reading a round
 * ----------------------------------------------------------------------- */

/** Is this entity a player who is still standing? */
function isAlive(entity: EntityState | null): entity is EntityState {
  return entity !== null && (entity.flags & EntityFlag.Dead) === 0
}

/**
 * What a player has left to lose: health plus armour.
 *
 * The tiebreaker at the time limit, and it is one number rather than two
 * because armour is not a lesser kind of health here — it absorbs 66% of every
 * hit (`selfDamage.ts`), so a player on 100/100 and a player on 200/0 are not
 * equally close to dying, but they have both taken nothing, which is what the
 * clock is asking about.
 */
export function damageReserve(entity: EntityState | null): number {
  if (entity === null) return 0
  return entity.health + entity.armor
}

/**
 * Who won a round that has just ended, or {@link NO_WINNER} for a draw.
 *
 * `null` means the round is not over. Separated from the machine below so that
 * "when does a round end" is a question with a testable answer rather than a
 * branch inside a mutation.
 */
export function roundOutcome(state: GameState): number | null {
  const match = state.match
  const first = findPlayer(state, DUEL_SLOTS[0])
  const second = findPlayer(state, DUEL_SLOTS[1])
  const firstAlive = isAlive(first)
  const secondAlive = isAlive(second)

  // Last man standing, and "nobody standing" is a real answer — a mutual kill
  // on one sub-step, or a telefrag that went both ways.
  if (!firstAlive && !secondAlive) return NO_WINNER
  if (!firstAlive) return DUEL_SLOTS[1]
  if (!secondAlive) return DUEL_SLOTS[0]

  if (match.phaseEndTick !== NO_DEADLINE && state.tick >= match.phaseEndTick) {
    const firstReserve = damageReserve(first)
    const secondReserve = damageReserve(second)
    if (firstReserve === secondReserve) return NO_WINNER
    return firstReserve > secondReserve ? DUEL_SLOTS[0] : DUEL_SLOTS[1]
  }

  return null
}

/* --------------------------------------------------------------------------
 * Moving a match
 * ----------------------------------------------------------------------- */

/** Enter `phase` at the current tick, ending at `endTick`. */
function enterPhase(state: GameState, phase: MatchPhase, endTick: number): void {
  const match = state.match
  match.phase = phase
  match.phaseStartTick = state.tick
  match.phaseEndTick = endTick
}

/**
 * Remove every projectile in the world.
 *
 * Backwards, because removal splices the array being walked — the same reason
 * the kernel's `expire` runs backwards, and it preserves the ascending-id order
 * the state hash depends on.
 */
function clearProjectiles(state: GameState): void {
  for (let i = state.entities.length - 1; i >= 0; i -= 1) {
    const entity = state.entities[i]
    if (entity === undefined) continue
    if (entity.kind === EntityKind.Projectile) removeEntity(state, entity.id)
  }
}

/**
 * Start round `match.round + 1`: both bodies up, the clock reset, live.
 *
 * The two draws from `state.rng` happen inside `spawnRound`, which is what
 * makes the whole match a function of the seed.
 */
function beginRound(state: GameState, plan: SpawnPlan): void {
  const match = state.match
  clearProjectiles(state)
  spawnRound(state, plan)
  match.round += 1
  enterPhase(state, MatchPhase.Live, state.tick + match.rules.roundTimeLimitTicks)
}

/**
 * Award a decided round and decide what happens next.
 *
 * A draw is scored to nobody and still consumes a round, which is the whole
 * reason the round cap can be reached at all.
 */
function endRound(state: GameState, winner: number): void {
  const match = state.match
  const rules = match.rules

  clearProjectiles(state)
  match.lastRoundWinner = winner
  if (winner === DUEL_SLOTS[0]) match.wins[0] += 1
  else if (winner === DUEL_SLOTS[1]) match.wins[1] += 1

  if (match.wins[0] >= rules.roundsToWin || match.wins[1] >= rules.roundsToWin) {
    endMatch(state)
    return
  }

  // The cap. A match that has run this long is one nobody is winning, and it
  // ends on the score as it stands rather than on the next round that might
  // also draw. See `maxRoundsFor`.
  if (match.round >= rules.maxRounds) {
    endMatch(state)
    return
  }

  enterPhase(state, MatchPhase.Intermission, state.tick + rules.intermissionTicks)
}

/**
 * End the match on the score as it stands.
 *
 * The winner is whoever has more rounds, and {@link NO_WINNER} if they are
 * level — which only happens at the round cap, because reaching `roundsToWin`
 * is by construction not a tie.
 */
function endMatch(state: GameState): void {
  const match = state.match
  match.winner =
    match.wins[0] === match.wins[1]
      ? NO_WINNER
      : match.wins[0] > match.wins[1]
        ? DUEL_SLOTS[0]
        : DUEL_SLOTS[1]
  enterPhase(state, MatchPhase.Over, NO_DEADLINE)
}

/**
 * The plan a round needs, or a thrown sentence naming what is missing.
 *
 * A match cannot start a round without knowing which points it may start on,
 * and the plan is a function of the map — level data that lives beside the
 * state, like the `CollisionWorld` (`kernel.ts`). Throwing rather than quietly
 * skipping the spawn is the point: a match that silently never started another
 * round would look like a hung server.
 */
function requirePlan(plan: SpawnPlan | null): SpawnPlan {
  if (plan === null) {
    throw new RangeError(
      'gladiator: this world is running a match but was ticked without a spawn plan, so a round has nowhere to start. Pass the plan built from the loaded map (buildSpawnPlan) to tick() or createKernel().',
    )
  }
  return plan
}

/**
 * A score to start a match from instead of nil-nil.
 *
 * The state a match carries across a machine — see {@link startMatch}. It is
 * deliberately three numbers and no more: everything else about a round is
 * regenerated by `spawnRound`, so a resumed match is a fresh world played to a
 * remembered scoreline rather than a serialised one.
 */
export type MatchScore = {
  /** Rounds won, indexed by player slot. */
  readonly wins: readonly [number, number]
  /** Rounds already decided, drawn ones included. The next one is this plus 1. */
  readonly roundsPlayed: number
}

/** Nil-nil, no rounds played: what a match starts from when nobody says. */
export const NEW_MATCH_SCORE: MatchScore = { wins: [0, 0], roundsPlayed: 0 }

/**
 * Is this a score a match could still be *being played* at, under `rules`?
 *
 * Whole non-negative wins, no more wins than rounds decided, and neither the
 * target nor the round cap already reached. A score that fails this is not a
 * match to resume — it is a match that is over, or one that was never played
 * under these rules at all, which is what a rules change between two deploys
 * looks like from the other side of a resume ticket (GLAD-G41FQ9).
 *
 * Exported so the host can *ask* rather than catch: {@link startMatch} throws
 * on a score that fails this, because by the time the world is being started a
 * bad score is a bug, and `server/resume.ts` has a legitimate reason to want
 * the question answered without one.
 */
export function isPlayableScore(score: MatchScore, rules: MatchRules): boolean {
  const [first, second] = score.wins
  if (!Number.isInteger(first) || !Number.isInteger(second)) return false
  if (!Number.isInteger(score.roundsPlayed)) return false
  if (first < 0 || second < 0) return false
  if (first + second > score.roundsPlayed) return false
  if (first >= rules.roundsToWin || second >= rules.roundsToWin) return false
  return score.roundsPlayed < rules.maxRounds
}

/**
 * Begin a match: round one, both players up, the clock running.
 *
 * The one edge out of {@link MatchPhase.Warmup}, and it is external because the
 * simulation is not the layer that knows whether both players have arrived —
 * that is the room's (GLAD-FHKBN8, GLAD-DVDV6P) and the listen server's
 * (GLAD-4G4W2T). Everything after this happens by itself, in `advanceMatch`.
 *
 * Called *between* sub-steps rather than inside one, so the first tick of round
 * one is a tick both players can act on.
 *
 * ## Starting from a score
 *
 * `score` is how a duel survives a deploy (GLAD-G41FQ9). A room is a live
 * `GameState` in one process's memory, so the machine going away destroys it;
 * what the two clients bring to the next machine is a signed scoreline, and
 * this is where it is put back. It is a *score*, never a world: the new round
 * begins from spawn points like any other, because a world is not a thing two
 * peers can be handed halfway through and agree about afterwards.
 *
 * A score that has already decided the match is refused rather than adopted —
 * it would start a match in {@link MatchPhase.Live} that `advanceMatch` ends on
 * the first sub-step, which reads to both players as a round that never
 * happened. `server/resume.ts` is what checks a ticket before it gets here.
 */
export function startMatch(
  state: GameState,
  plan: SpawnPlan,
  score: MatchScore = NEW_MATCH_SCORE,
): void {
  const match = state.match
  if (match.phase !== MatchPhase.Warmup) {
    throw new RangeError(
      `gladiator: startMatch was called on a match already in phase ${match.phase}; a match runs once and a new one needs a new match state.`,
    )
  }
  const rules = match.rules
  if (!isPlayableScore(score, rules)) {
    throw new RangeError(
      `gladiator: startMatch was handed the score ${score.wins[0]}-${score.wins[1]} after ${score.roundsPlayed} rounds, which is not a match still being played under these rules (first to ${rules.roundsToWin}, at most ${rules.maxRounds} rounds). Ask isPlayableScore first.`,
    )
  }

  match.round = score.roundsPlayed
  match.wins[0] = score.wins[0]
  match.wins[1] = score.wins[1]
  match.lastRoundWinner = NO_WINNER
  match.winner = NO_WINNER
  beginRound(state, plan)
}

/**
 * End a match nobody can finish, because a seat is not coming back.
 *
 * The other external edge, and the mirror of {@link startMatch}: the simulation
 * is not the layer that knows a socket has been gone for thirty seconds, so the
 * connection lifecycle tells it (`server/lifecycle.ts`, GLAD-DVDV6P). Returns
 * whether there was a match to end — `false` in warmup, where nobody has played
 * a round yet, and in {@link MatchPhase.Over}, where the question is already
 * settled.
 *
 * **The round in progress is awarded, and then the match is.** Awarding only the
 * round would start the next one against an empty seat and award that too, three
 * seconds later, and so on until the score ran out — a match played out in
 * intermissions, which is a worse way of saying the same thing.
 *
 * `winner` is the player still connected, or {@link NO_WINNER} when both are
 * gone and there is nobody to award anything to. It is set **directly** rather
 * than derived from the score, and that is the one place this differs from
 * {@link endMatch}: a player who quits while ahead 2–1 leaves a score that says
 * they were winning and a match their opponent won. Those two facts disagree
 * because a forfeit is exactly the situation in which they should — the score is
 * a record of the rounds that were played, and the winner is the player who was
 * still there.
 */
export function forfeitMatch(state: GameState, winner: number): boolean {
  const match = state.match
  if (match.phase !== MatchPhase.Live && match.phase !== MatchPhase.Intermission) return false

  clearProjectiles(state)

  // Only a *live* round is awarded. An intermission's round has already been
  // scored, and scoring it twice would hand the leaver's opponent a round they
  // had already been given.
  if (match.phase === MatchPhase.Live && winner !== NO_WINNER) {
    match.lastRoundWinner = winner
    if (winner === DUEL_SLOTS[0]) match.wins[0] += 1
    else if (winner === DUEL_SLOTS[1]) match.wins[1] += 1
  }

  match.winner = winner
  enterPhase(state, MatchPhase.Over, NO_DEADLINE)
  return true
}

/**
 * Advance the match by one sub-step. The kernel's last phase.
 *
 * Runs after movement, weapons, projectiles and expiry, so everything it reads
 * — who is dead, what a rocket did — is already true of this tick.
 *
 * Does nothing at all in {@link MatchPhase.Warmup} and {@link MatchPhase.Over},
 * which is what makes a world with no match in it (the golden replay, every
 * physics test, the walking skeleton) behave exactly as it did before this
 * ticket existed.
 */
export function advanceMatch(state: GameState, plan: SpawnPlan | null = null): void {
  const match = state.match

  if (match.phase === MatchPhase.Live) {
    const outcome = roundOutcome(state)
    if (outcome !== null) endRound(state, outcome)
    return
  }

  if (match.phase === MatchPhase.Intermission && state.tick >= match.phaseEndTick) {
    beginRound(state, requirePlan(plan))
  }
}
