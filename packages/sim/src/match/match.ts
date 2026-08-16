/**
 * The shape of a match: its rules, its score, and which of four phases it is
 * in. `docs/physics-spec.md` §7.1.
 *
 * The Rocket Arena format in one paragraph. A **round** is one life each: both
 * players stand up at 100 health and 100 armour, holding both weapons, and the
 * round ends when one of them dies. A **match** is a sequence of rounds, first
 * to {@link MatchRules.roundsToWin}. Nothing is picked up, nothing regenerates,
 * and nothing carries from one round to the next except the score.
 *
 * ## Why this lives in `GameState`
 *
 * Because a replay has to reproduce the whole match and not just the physics.
 * `GameState` is what `encodeExact` walks, what `hashState` digests, what
 * reconciliation clones and rewinds — so putting the round number, the score
 * and the phase clock in there is what makes "the same seed and the same inputs
 * produce the same match" true rather than nearly true. It also means two peers
 * that disagree about the *rules* — one running `armor_only`, one running
 * `none` — mismatch on the state hash at the first tick rather than on the
 * first rocket jump.
 *
 * That is why {@link MatchRules} is hashed alongside the score even though it
 * never changes during a match. A rule that is not in the hash is a rule the
 * two peers can quietly disagree about.
 *
 * ## Why there is no state machine in this file
 *
 * This is the *shape*; `round.ts` is the machine that moves it, and it needs a
 * `GameState` and a `SpawnPlan` to do so. Keeping them apart is what lets
 * `state.ts` import this without importing the world it describes.
 */

import { TICK_RATE } from '../tick.ts'
import { DEFAULT_SELF_DAMAGE } from './selfDamage.ts'
import type { SelfDamageMode } from './selfDamage.ts'

/* --------------------------------------------------------------------------
 * The phases
 * ----------------------------------------------------------------------- */

/**
 * Where a match is in its life. Numeric so it encodes in one byte.
 *
 * Four, and the boundaries are the interesting part: {@link MatchPhase.Warmup}
 * and {@link MatchPhase.Live} are the two in which a player's commands reach
 * their body (`kernel.ts`), and the other two are the ones in which the world
 * keeps simulating — gravity, friction, a body sliding to rest — while nobody
 * can steer it.
 */
export const MatchPhase = {
  /**
   * No match has been started yet. Players may run about; nothing is scored.
   *
   * This is the state a bare `createGameState` is in, which is deliberate: the
   * walking skeleton, the golden replay and every physics test are worlds with
   * no round rules in force, and they should stay that way. `startMatch` in
   * `round.ts` is the one edge out of here, and it belongs to whoever knows
   * that both players have arrived (GLAD-DVDV6P, GLAD-4G4W2T).
   */
  Warmup: 0,
  /** A round is being played. The only phase in which anyone can die. */
  Live: 1,
  /** A round has been decided; the next one's bodies appear when this ends. */
  Intermission: 2,
  /**
   * The match has a winner, or has run out of rounds.
   *
   * Terminal as far as a sub-step is concerned — `advanceMatch` does nothing in
   * here, so nothing the world does to itself gets out. The way out is the same
   * kind of thing as the way in: `resetMatch` in `round.ts`, called by whoever
   * knows there are still two players to give another match to (GLAD-8VZ12W).
   */
  Over: 3,
} as const

export type MatchPhase = (typeof MatchPhase)[keyof typeof MatchPhase]

/** A phase that ends when something happens rather than when a clock runs out. */
export const NO_DEADLINE = -1

/** `winner` and `lastRoundWinner` for "nobody" — no winner, or a drawn round. */
export const NO_WINNER = -1

/* --------------------------------------------------------------------------
 * The rules
 * ----------------------------------------------------------------------- */

/**
 * How long a round may last before it is decided on damage taken, in ticks.
 *
 * Two minutes. Long enough that it is never what ends a duel between two
 * players who are trying, short enough that two players who are not cannot hold
 * a match hostage. Written in ticks because both peers count in ticks; a limit
 * measured against a wall clock is a limit the two of them disagree about.
 */
export const ROUND_TIME_LIMIT_TICKS = 120 * TICK_RATE

/**
 * Sub-steps between a round being decided and the next round's bodies
 * appearing. Three seconds.
 *
 * Long enough to see how you died and read the score, short enough that a
 * first-to-three match is not mostly waiting. In ticks rather than
 * milliseconds, for the same reason the round limit above is: both peers count
 * in ticks, and a delay measured against a wall clock is a delay they disagree
 * about.
 *
 * It sits here rather than in `spawn.ts`, next to the spawn it delays, because
 * `state.ts` has to reach this file for `MatchState` and `spawn.ts` reaches
 * `state.ts` — putting the number the other side of that would either spell it
 * twice or make an import cycle, and spelling a number twice is the drift
 * `AGENTS.md` exists to prevent.
 */
export const RESPAWN_DELAY_TICKS = 3 * TICK_RATE

/** Rounds a player has to win to take the match. Three — a best-of-five duel. */
export const DEFAULT_ROUNDS_TO_WIN = 3

/**
 * The hard cap on how many rounds a match may run, given a target.
 *
 * A decisive match is at most `2 * roundsToWin - 1` rounds — five, for a
 * first-to-three. The cap is `3 * roundsToWin`, which leaves room for four
 * drawn rounds and then stops.
 *
 * It exists because a draw is genuinely reachable: two players who never find
 * each other reach the time limit on equal health and equal armour, and a
 * format with no cap would let them do that forever. When the cap is reached
 * the match ends on the score as it stands, which may be no winner at all
 * (`round.ts`).
 */
export function maxRoundsFor(roundsToWin: number): number {
  return roundsToWin * 3
}

export type MatchRules = {
  /** Rounds a player must win to take the match. 3 is a best-of-five. */
  readonly roundsToWin: number
  /** The hard round cap; see {@link maxRoundsFor}. */
  readonly maxRounds: number
  /** Which of the three self-damage rules is in force. `selfDamage.ts`. */
  readonly selfDamage: SelfDamageMode
  /** How long a round may run before it is decided on damage, in ticks. */
  readonly roundTimeLimitTicks: number
  /** Ticks between a round being decided and the next round's bodies appearing. */
  readonly intermissionTicks: number
}

/* --------------------------------------------------------------------------
 * The state
 * ----------------------------------------------------------------------- */

export type MatchState = {
  /**
   * The rules this match is being played under.
   *
   * Immutable and shared by reference across a clone — there is nothing in here
   * a sub-step writes, so `cloneGameState` copying the pointer is correct as
   * well as cheap. It is still encoded and hashed; see the header.
   */
  rules: MatchRules
  phase: MatchPhase
  /** The round being played, 1-based. Zero in {@link MatchPhase.Warmup}. */
  round: number
  /** Rounds won, indexed by the player slot. `DUEL_SLOTS` are 0 and 1. */
  wins: [number, number]
  /** The tick the current phase began on. */
  phaseStartTick: number
  /**
   * The tick the current phase ends on, or {@link NO_DEADLINE}.
   *
   * A round's time limit and an intermission's countdown are the same field
   * because they are the same question — "what tick does this stop on" — and a
   * HUD asking how long is left should not have to know which phase it is in
   * to find out (GLAD-BHNPOE).
   */
  phaseEndTick: number
  /** Who won the last decided round, or {@link NO_WINNER} for a draw. */
  lastRoundWinner: number
  /** Who won the match, or {@link NO_WINNER} while it is still being played. */
  winner: number
}

/** The rules a match runs under when nobody chooses. */
export const DEFAULT_MATCH_RULES: MatchRules = {
  roundsToWin: DEFAULT_ROUNDS_TO_WIN,
  maxRounds: maxRoundsFor(DEFAULT_ROUNDS_TO_WIN),
  selfDamage: DEFAULT_SELF_DAMAGE,
  roundTimeLimitTicks: ROUND_TIME_LIMIT_TICKS,
  intermissionTicks: RESPAWN_DELAY_TICKS,
}

/**
 * A match that has not started, under `rules`.
 *
 * Every `GameState` has one of these from the moment it is created, sitting in
 * {@link MatchPhase.Warmup} and doing nothing until `startMatch`. A world with
 * no rounds in it is therefore a world whose match is in warmup, rather than a
 * special case every reader of the state has to test for.
 */
export function createMatchState(rules: MatchRules = DEFAULT_MATCH_RULES): MatchState {
  return {
    rules,
    phase: MatchPhase.Warmup,
    round: 0,
    wins: [0, 0],
    phaseStartTick: 0,
    phaseEndTick: NO_DEADLINE,
    lastRoundWinner: NO_WINNER,
    winner: NO_WINNER,
  }
}

/** A deep copy. The rules are shared; everything a tick writes is copied. */
export function cloneMatchState(match: MatchState): MatchState {
  return {
    rules: match.rules,
    phase: match.phase,
    round: match.round,
    wins: [match.wins[0], match.wins[1]],
    phaseStartTick: match.phaseStartTick,
    phaseEndTick: match.phaseEndTick,
    lastRoundWinner: match.lastRoundWinner,
    winner: match.winner,
  }
}

/**
 * Rules with some of the defaults replaced, and `maxRounds` kept consistent.
 *
 * A caller that raises `roundsToWin` almost never means to leave the cap where
 * it was, so the cap follows unless it is named explicitly.
 */
export function matchRules(overrides: Partial<MatchRules> = {}): MatchRules {
  const roundsToWin = overrides.roundsToWin ?? DEFAULT_MATCH_RULES.roundsToWin
  return {
    ...DEFAULT_MATCH_RULES,
    ...overrides,
    roundsToWin,
    maxRounds: overrides.maxRounds ?? maxRoundsFor(roundsToWin),
  }
}

/** Whether a player's commands reach their body in this phase. */
export function acceptsCommands(match: MatchState): boolean {
  return match.phase === MatchPhase.Warmup || match.phase === MatchPhase.Live
}

/** Whether the match is still being played — started, and not yet decided. */
export function isMatchRunning(match: MatchState): boolean {
  return match.phase === MatchPhase.Live || match.phase === MatchPhase.Intermission
}
