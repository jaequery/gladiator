/**
 * Every number the bot was *tuned* to, in one file, and the one dial that moves
 * them together. GLAD-6BIYFQ.
 *
 * ## Why a JSON blob rather than fourteen `export const`s
 *
 * Because tuning a duel bot is a parameter search, and a search needs a thing it
 * can *write*. `tools/bot-sweep.ts` runs coordinate descent over these numbers —
 * move one, play a few hundred matches, keep the move if the band table got
 * closer — and a search that had to rewrite TypeScript source to try a value
 * would either not be written or would be written badly. The blob is data; this
 * file is the argument about it.
 *
 * Everything in it still reaches the code through a named constant with a
 * comment on it (`REACTION_MIN_MS`, `RAIL_SETTLE_UNITS`, ...). Nothing reads
 * `TUNING` directly outside this module and the handful that derive from it, so
 * the JSON is a *source*, not an ambient configuration object being passed
 * around.
 *
 * ## Every tuned number is carried per bot, and that is not decoration
 *
 * {@link BotSkill} is one bot's numbers, resolved, and it rides on the bot
 * (`bot.ts`) rather than sitting in module scope. Two reasons, and the second is
 * the one that made it necessary:
 *
 * 1. Two bots in one process may be at two different skills. That is exactly
 *    what the band table's asymmetric rows are, and what the client's
 *    Easy/Medium/Hard selector uses.
 * 2. A sweep has to try a value **without restarting the process**. Module
 *    constants are read at import; a search that could only change them by
 *    editing a file and forking a new node would be a hundred times slower and
 *    would not have been run.
 *
 * ## What is in here and what is deliberately not
 *
 * In: the combat surface — how long the bot takes to notice, how wrong its aim
 * is, how still its hands are, how disciplined it is with a rail, how close it
 * likes to be, how readily it leads, how hard it tries to get out of the way.
 * Those are the numbers this ticket moved, and they are the numbers that decide
 * whether the bot is fun to lose to.
 *
 * Not in: perception ranges, field of view, memory decay, the nav graph's costs.
 * They belong to the tickets that argued them (GLAD-V7CMHR, GLAD-OB46VC), and
 * several are asserted against by `perception/fairness.test.ts` — a sweep that
 * could widen the bot's field of view would be a sweep that could tune its way
 * out of being fair.
 *
 * Also not in: the turn rate and the aim acceleration. They are the *arm* rather
 * than the skill — a novice's wrist moves as fast as an expert's — and the servo
 * they drive is a module-level machine that every bot shares
 * (`aim/controller.ts`).
 *
 * ## The skill axis, and why it is one number
 *
 * {@link TuningSource.axis} is the part of the blob that moves with `skill`, by
 * straight-line interpolation through the two rungs of the ladder — see
 * {@link SkillBand} for why it is anchored there rather than at the ends of the
 * dial, which is the one structural thing this ticket got wrong first. One dial,
 * so the axis can be *proved monotone*: a bot at 0.45 loses to the shipped one
 * and a bot at 0.80 beats it. Those measured rungs are the client's Easy and
 * Hard levels; the tuned shipped value between them is Medium. The selector is
 * therefore three names for one proven mechanism rather than three bot modes.
 *
 * The ten on the axis were chosen because each is a thing a *person* is better
 * or worse at, and none of them is knowledge.
 *
 * The last two are the ones that were added after the first measurement, and
 * they are the reason the ladder means anything. With only the hands on the axis
 * the rungs barely separated — a bot at 0.80 beat a bot at 0.45 about 55/45 —
 * because a duel at these speeds is decided by rockets, and whether a rocket
 * lands is decided far more by *when the other player started moving* and by
 * *whether the shooter shot where they were going* than by a fraction of a
 * degree of aim. Skill in this game is a decision as much as it is a wrist, and
 * an axis that only moved the wrist was an axis that did not move the game:
 *
 * | Value | Novice | Expert | What it is |
 * | ----- | ------ | ------ | ---------- |
 * | `reactionMinMs`, `reactionSpreadMs` | slow | fast | how long from seeing to acting |
 * | `aimErrorFraction` | large | small | how badly it aims at somewhere it cannot see |
 * | `motorError` | large | small | how evenly it pushes the wrist |
 * | `tremorUnits` | large | small | how still it can hold a crosshair |
 * | `railSettleUnits`, `railSettleRate` | loose | tight | how disciplined it is about spending a rail |
 * | `dodgeHorizonSeconds` | late | early | how long before a rocket arrives it starts moving |
 * | `leadStraightness` | never leads | leads readily | how confidently it shoots where somebody is going |
 * | `rocketDamageFloor` | shoots anyway | holds out | how good a rocket has to look before it is worth 800 ms |
 *
 * A weaker bot does not see less, hear less or forget faster. It sees exactly
 * what the shipped one sees and is worse with its hands, which is the only kind
 * of difficulty ladder that does not turn into a cheat at one end of it.
 */

import raw from './tuning.json' with { type: 'json' }

/**
 * One tuned value at the two rungs of the ladder.
 *
 * **Not at `skill` 0 and 1** — at {@link TuningSource.anchors}, which are the two
 * difficulties the band table names (0.45 and 0.80). That is a change worth
 * understanding, because the first version did anchor on 0 and 1 and it did not
 * work.
 *
 * The rungs span 35% of the dial. Anchoring the line on the dial's ends meant
 * that whatever the ends said, the two rungs only ever differed by 35% of it —
 * so making a novice bot genuinely bad made *both* rungs bad, and making the
 * rungs far apart demanded ends that were nonsense (a negative tremor, a
 * reaction faster than a person's). Measured, the shipped bot beat the 0.45 rung
 * 62/38 and lost to the 0.80 rung 43/57 no matter how the ends were set, and the
 * band table asks for 75/25 both ways.
 *
 * Anchoring on the rungs states the thing that is actually known — *this is what
 * a 0.45 bot is, and this is what a 0.80 bot is* — and lets the line run off
 * past them, where {@link deriveSkill} clamps whatever stops being a number that
 * means anything.
 */
export type SkillBand = {
  /** The value at `anchors.novice`. */
  readonly novice: number
  /** The value at `anchors.expert`. */
  readonly expert: number
}

/** The values that move with the skill dial. */
export type TuningAxis = {
  readonly reactionMinMs: SkillBand
  readonly reactionSpreadMs: SkillBand
  readonly aimErrorFraction: SkillBand
  readonly motorError: SkillBand
  readonly tremorUnits: SkillBand
  readonly railSettleUnits: SkillBand
  readonly railSettleRate: SkillBand
  readonly dodgeHorizonSeconds: SkillBand
  readonly leadStraightness: SkillBand
  readonly rocketDamageFloor: SkillBand
}

/**
 * The values that do not.
 *
 * Not "less important" — several are load-bearing. They are the ones where being
 * better at the game does not mean holding a different number: both players
 * think a rocket is too slow to be worth firing across the whole arena, and both
 * of them need the same three body widths of room before a sidestep is a
 * sidestep rather than a walk into a wall.
 */
export type TuningFixed = {
  /** How fast the view may sweep, in degrees per second. The arm. */
  readonly turnRateDegrees: number
  /** Sub-steps from a standstill to the full sweep. The wrist. */
  readonly aimAccelTicks: number
  /** The largest the displacement error may grow to, in Quake units. */
  readonly maxAimError: number
  /** How much of the aim error is vertical, as a share of the horizontal. */
  readonly verticalErrorShare: number
  /** How close the bot tries to get before it stops closing, in units. */
  readonly engageRange: number
  /** The range past which a rocket is too slow to be the right answer, in units. */
  readonly railMinRange: number
  /** The largest a rocket's firing tolerance may grow to, in degrees. */
  readonly rocketToleranceMaxDegrees: number
  /** The splash the bot will accept from its own rocket at full health, in points. */
  readonly selfSplashAllowance: number
  /** How much wider than a splash radius counts as a dangerous closest approach. */
  readonly dodgeDangerMargin: number
  /** How much room a dodge needs, in units. */
  readonly dodgeProbe: number
  /** The share of that probe which has to be clear for a direction to count. */
  readonly dodgeClear: number
  /** The longest lead the bot will take, in seconds. */
  readonly leadMaxSeconds: number
}

/** Which two skills the bands are stated at. See {@link SkillBand}. */
export type TuningAnchors = {
  readonly novice: number
  readonly expert: number
}

/** The shape of `tuning.json`. */
export type TuningSource = {
  /** The `skill` the shipped bot was tuned at, exposed to players as Medium. */
  readonly skill: number
  readonly anchors: TuningAnchors
  readonly axis: TuningAxis
  readonly fixed: TuningFixed
}

/** The committed configuration. `tuning.json`. */
export const TUNING: TuningSource = raw

/**
 * One bot's tuned numbers, resolved: the seven from the axis at this bot's
 * skill, and every fixed one alongside them.
 *
 * The fixed ones are copied in rather than read from module scope so that a
 * sweep can hand a bot a whole configuration in one object — see the header. A
 * reader should treat the difference as "does this move when the difficulty
 * does", not as "is this important".
 */
export type BotSkill = TuningFixed & {
  /** The dial this was derived from, in `[0, 1]`. Diagnostics and reporting. */
  readonly skill: number
  /** The floor on reacting to a target that was not there a moment ago, in ms. */
  readonly reactionMinMs: number
  /** How much slower than the floor a reaction may be, in ms. Uniform over the band. */
  readonly reactionSpreadMs: number
  /** Aim error as a fraction of the displacement from the reference point. */
  readonly aimErrorFraction: number
  /** How wrong the applied angular acceleration may be, either way, as a fraction. */
  readonly motorError: number
  /** How far a held crosshair wanders, in angle units. `aim/error.ts`. */
  readonly tremorUnits: number
  /** How far off the aim may be and still count as settled, in angle units. */
  readonly railSettleUnits: number
  /** How fast the view may still be moving, in angle units per sub-step. */
  readonly railSettleRate: number
  /** How far ahead a rocket is worried about, in seconds. */
  readonly dodgeHorizonSeconds: number
  /** How straight a target's path has to be before it is led at all, in `[0, 1]`. */
  readonly leadStraightness: number
  /** The expected damage a rocket has to promise before it is worth firing, in points. */
  readonly rocketDamageFloor: number
}

/** `skill` clamped into the band it is defined over. */
function clampSkill(skill: number): number {
  if (!Number.isFinite(skill)) return 0
  if (skill < 0) return 0
  if (skill > 1) return 1
  return skill
}

function clamp(value: number, low: number, high: number): number {
  if (value < low) return low
  if (value > high) return high
  return value
}

/**
 * The limits each tuned value is held inside, whatever the line says.
 *
 * The line is anchored on two rungs in the middle of the dial and extrapolated
 * outside them, so at `skill` 0 and `skill` 1 it asks for things that are not
 * values: a negative crosshair wobble, a reaction faster than a person has, an
 * acceleration multiplier with the sign flipped. Each limit below is a fact
 * about the game rather than a tuning choice, which is why they are here and not
 * in the blob:
 *
 * - **`reactionMinMs` floors at 140.** The simple-visual-reaction floor
 *   `aim/error.ts` argues. Nothing in this game may be faster off the mark than
 *   a person, at any difficulty, ever.
 * - **`motorError` ceilings at 0.9.** At 1 the multiplier on angular
 *   acceleration can reach zero and past it can go *negative*, which is a wrist
 *   that pushes the wrong way — not a worse player, a broken servo.
 * - **`leadStraightness` lives in `[0, 1]`.** It is compared against a ratio.
 * - The rest floor at zero or just above it, because a negative wobble, a
 *   negative error and a settle threshold of nothing are all meaningless rather
 *   than extreme.
 */
const LIMITS: Record<string, readonly [number, number]> = {
  reactionMinMs: [140, 2000],
  reactionSpreadMs: [0, 2000],
  aimErrorFraction: [0, 4],
  motorError: [0, 0.9],
  tremorUnits: [0, 16384],
  railSettleUnits: [1, 16384],
  railSettleRate: [1, 16384],
  dodgeHorizonSeconds: [0.05, 4],
  leadStraightness: [0, 1],
  rocketDamageFloor: [0, 99],
}

/**
 * One value at `skill`: the straight line through its two rungs, extrapolated
 * outside them and clamped by {@link LIMITS}.
 */
function at(band: SkillBand, name: string, t: number): number {
  const limit = LIMITS[name] ?? ([-Infinity, Infinity] as const)
  return clamp(band.novice + (band.expert - band.novice) * t, limit[0], limit[1])
}

/**
 * The tuned numbers for a bot at `skill`, where 0 is the novice end of every
 * band and 1 is the expert end.
 *
 * Linear, deliberately. A curve would be a second thing to tune and would make
 * "0.45 loses to 0.62 loses to 0.80" a claim about the curve rather than about
 * the axis; with a straight line, the monotonicity the acceptance check asserts
 * is a property of the *bands* and can be read off the table in the header.
 *
 * `source` is the blob to read the bands out of, and it is a parameter for one
 * caller: `tools/bot-sweep.ts`, which tries a candidate configuration without
 * writing it to disk first. Everything that ships passes nothing and gets
 * {@link TUNING}.
 */
export function deriveSkill(skill: number, source: TuningSource = TUNING): BotSkill {
  const s = clampSkill(skill)
  const axis = source.axis
  // Where `s` sits between the two rungs: 0 at the novice one, 1 at the expert
  // one, and outside both for a dial past either.
  const span = source.anchors.expert - source.anchors.novice
  const t = span === 0 ? 0 : (s - source.anchors.novice) / span
  return {
    ...source.fixed,
    skill: s,
    reactionMinMs: at(axis.reactionMinMs, 'reactionMinMs', t),
    reactionSpreadMs: at(axis.reactionSpreadMs, 'reactionSpreadMs', t),
    aimErrorFraction: at(axis.aimErrorFraction, 'aimErrorFraction', t),
    motorError: at(axis.motorError, 'motorError', t),
    tremorUnits: at(axis.tremorUnits, 'tremorUnits', t),
    railSettleUnits: at(axis.railSettleUnits, 'railSettleUnits', t),
    railSettleRate: at(axis.railSettleRate, 'railSettleRate', t),
    dodgeHorizonSeconds: at(axis.dodgeHorizonSeconds, 'dodgeHorizonSeconds', t),
    leadStraightness: at(axis.leadStraightness, 'leadStraightness', t),
    rocketDamageFloor: at(axis.rocketDamageFloor, 'rocketDamageFloor', t),
  }
}

/**
 * The shipped bot's numbers, and the default everywhere `skill` is a parameter.
 *
 * Every `export const` in `aim/error.ts`, `combat/railDiscipline.ts` and the
 * rest is a field of this object, so the names a reader already knows still mean
 * what they always meant — they are now *the shipped skill's* value of that name
 * rather than a literal, and a bot at another skill carries its own.
 */
export const SHIPPED_SKILL: BotSkill = deriveSkill(TUNING.skill)
