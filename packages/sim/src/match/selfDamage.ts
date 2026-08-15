/**
 * What a hit costs, and the three answers to "what does your own rocket cost
 * *you*". `docs/physics-spec.md` §7.2.
 *
 * Two rules meet in this file, and they are separable on purpose.
 *
 * **Armour absorbs 66% of any damage, rounded up, until it runs out.** Quake
 * 3's `CheckArmor`, and it applies to every hit from every source — it is not a
 * self-damage rule. With 100 armour and 100 health, a rocket in the chest costs
 * 66 armour and 34 health, so it takes exactly two of them to kill you. That is
 * the arithmetic the whole duel is played inside.
 *
 * **Self-damage has three modes**, because Rocket Arena's own history has three
 * and the choice changes the skill ceiling rather than the numbers:
 *
 * | mode | what a full-power rocket jump costs |
 * | ---- | ----------------------------------- |
 * | {@link SelfDamage.Full} | 33 armour and 17 health |
 * | {@link SelfDamage.ArmorOnly} (default) | 33 armour, no health |
 * | {@link SelfDamage.None} | nothing |
 *
 * **Knockback is identical in all three.** It is not decided here at all:
 * `damage.ts` derives the push from the *full* figure before this function is
 * consulted, which is Quake's own ordering and the reason a rocket jump is
 * worth what it costs. A rocket at your feet is 500 qu/s in every mode, and
 * switching mode changes the price of a jump without changing the jump.
 *
 * ## Why `armor_only` is the default
 *
 * It keeps rocket-jumping a *tempo* decision. A full-power jump is free in
 * health and costs a third of your armour, so three jumps leave you on 100
 * health and 1 armour — one rocket from dead instead of two. You are never
 * killed by your own mistake, and you are still spending something real to move
 * fast, which is exactly the trade the format is about. Rocket Arena 3 went to
 * `none` and lost the trade; `full` keeps it but punishes a beginner who
 * mistimes a jump into a wall.
 *
 * Note what falls out at the bottom of the armour bar: with nothing left to
 * absorb it, a jump in `armor_only` is free again. That is not a hole, it is
 * the same trade read from the other end — a player who has spent their armour
 * on mobility dies to one rocket.
 */

/**
 * What your own splash costs you.
 *
 * Numeric and `as const` rather than an `enum`, because `erasableSyntaxOnly` is
 * on repo-wide (`AGENTS.md`) — and because these cross the wire and go into the
 * state hash, so they have to encode in one byte.
 */
export const SelfDamage = {
  /** Quake 3's rule: halved into health, armour absorbs its share of that. */
  Full: 0,
  /** Halved, then armour absorbs its share, then the health remainder is discarded. */
  ArmorOnly: 1,
  /** Rocket Arena 3's rule: no self-damage at all. The push is unchanged. */
  None: 2,
} as const

export type SelfDamageMode = (typeof SelfDamage)[keyof typeof SelfDamage]

/** The mode a match runs under unless it says otherwise. See the header. */
export const DEFAULT_SELF_DAMAGE: SelfDamageMode = SelfDamage.ArmorOnly

/** Whether `value` is one of the three. The door for anything off the wire. */
export function isSelfDamageMode(value: number): value is SelfDamageMode {
  return value === SelfDamage.Full || value === SelfDamage.ArmorOnly || value === SelfDamage.None
}

/**
 * The fraction of splash damage you take from your own rocket. **Half**.
 *
 * Quake 3's `if ( targ == attacker ) damage *= 0.5`, and it applies before the
 * armour is consulted, which is why a full-power rocket jump takes 33 off your
 * armour and not 66. It is applied to the *health* figure only, after the
 * knockback has already been derived from the full 100 (`damage.ts`) — rocket
 * jumping lives in the gap between those two statements.
 *
 * {@link SelfDamage.None} skips it entirely rather than scaling it to zero,
 * because zero damage and "no damage rule at all" want to read differently at
 * the call site.
 */
export const SELF_DAMAGE_SCALE = 0.5

/**
 * The fraction of a hit armour absorbs. Quake 3's `ARMOR_PROTECTION`, **0.66**.
 *
 * Not two-thirds. Quake wrote 0.66 and the difference is visible: `ceil(50 *
 * 0.66)` is 33 and `ceil(50 * 2/3)` is 34, which is one armour point per rocket
 * jump and, three jumps in, the difference between standing on 1 armour and
 * standing on none.
 */
export const ARMOR_PROTECTION = 0.66

/**
 * The smallest a hit can be once it has been scaled. Quake 3's
 * `if (damage < 1) damage = 1`.
 *
 * Transcribed rather than needed: splash is truncated to an integer before it
 * reaches here (`damage.ts`), so the only way to arrive under 1 is a 1-point
 * hit that the self-damage halving turns into 0.5.
 */
export const MIN_DAMAGE = 1

/** How a hit was paid for: some off the armour, the rest off the health. */
export type DamageSplit = {
  /** Points taken off `EntityState.armor`. */
  readonly armor: number
  /** Points taken off `EntityState.health`. */
  readonly health: number
}

const NOTHING: DamageSplit = { armor: 0, health: 0 }

/**
 * How much armour absorbs of a `take`-point hit. Quake 3's `CheckArmor`.
 *
 * `ceil`, not `round` or `floor`: Quake's, and it is the reason a 50-point
 * self-hit costs exactly 33 rather than 33-or-34 depending on the arithmetic.
 * Capped at the armour actually held, so the last point of armour absorbs one
 * point and the rest of the hit goes through.
 */
export function armorAbsorbed(take: number, armor: number): number {
  if (take <= 0 || armor <= 0) return 0
  const save = Math.ceil(take * ARMOR_PROTECTION)
  return save > armor ? armor : save
}

/**
 * Split `points` of incoming damage between a target's armour and its health.
 *
 * The one place all three modes are stated, as a pure function of numbers, so
 * that the rules can be read and tested without a world around them.
 * `damage.ts` applies the result and does the knockback, which happens *before*
 * this is called and is deliberately not a function of the mode.
 *
 * `selfInflicted` rather than a pair of entity ids, because "did this player
 * damage themselves" is the only thing the modes turn on, and passing the
 * question rather than the entities is what keeps this file free of the world.
 */
export function resolveDamage(
  mode: SelfDamageMode,
  selfInflicted: boolean,
  points: number,
  armor: number,
): DamageSplit {
  if (points <= 0) return NOTHING
  if (selfInflicted && mode === SelfDamage.None) return NOTHING

  let take = selfInflicted ? points * SELF_DAMAGE_SCALE : points
  if (take < MIN_DAMAGE) take = MIN_DAMAGE

  const saved = armorAbsorbed(take, armor)
  take -= saved

  // The whole of `armor_only`: the armour still pays its 66%, and whatever the
  // armour could not cover is thrown away instead of coming off your health.
  // A player with no armour left therefore jumps for free — see the header.
  if (selfInflicted && mode === SelfDamage.ArmorOnly) take = 0

  return { armor: saved, health: take }
}
