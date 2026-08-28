/**
 * What a hit costs, and the four answers to "what does your own rocket cost
 * *you*". `docs/physics-spec.md` §7.2.
 *
 * Three rules meet in this file, and they are separable on purpose.
 *
 * **Armour absorbs 66% of any damage, rounded up, until it runs out.** Quake
 * 3's `CheckArmor`, and it applies to every hit from every source — it is not a
 * self-damage rule. With 100 armour and 100 health, a rocket in the chest costs
 * 66 armour and 34 health, so it takes exactly two of them to kill you. That is
 * the arithmetic the whole duel is played inside.
 *
 * **Self-damage has four modes** — Rocket Arena's own history supplies three,
 * and GLAD-7Z7MMC asked for the fourth — because the choice changes the skill
 * ceiling rather than the numbers:
 *
 * | mode | what a full-power rocket jump costs |
 * | ---- | ----------------------------------- |
 * | {@link SelfDamage.Full} | 33 armour and 17 health |
 * | {@link SelfDamage.ArmorOnly} | 33 armour, no health |
 * | {@link SelfDamage.None} | nothing |
 * | {@link SelfDamage.HealthOnly} (default) | 50 health, no armour |
 *
 * **A raised shield takes 90% off an incoming hit** ({@link BLOCK_DAMAGE_SCALE},
 * GLAD-ZPE5LN). It lands here, and not at the top of `damage.ts`, for the same
 * reason the modes below do: this file is what a hit *costs*, and the block is
 * a discount on the bill rather than a change to the hit. It applies before the
 * armour is consulted, so a blocked rocket in the chest costs 10 points in
 * total whether they come off armour, health, or both.
 *
 * **Knockback is identical in all four modes, and blocking does not change it
 * either.** It is not decided here at all: `damage.ts` derives the push from
 * the *full* figure before this function is consulted, which is Quake's own
 * ordering and the reason a rocket jump is worth what it costs. A rocket at
 * your feet is 500 qu/s in every mode, and switching mode changes the price of
 * a jump without changing the jump. A player behind a raised shield is thrown
 * exactly as far as one caught in the open — the guard is not cover, and it
 * does not win back the map position the shove took.
 *
 * ## Why `health_only` is the default
 *
 * Because your armour should only ever be spent on what the *other* player did
 * to you. `armor_only` and `full` both let a rocket you fired yourself eat into
 * the bar that decides how many of their rockets you survive, so a jump taken
 * for position is silently also a concession in the next exchange, paid at a
 * moment nobody was looking at the armour bar. `health_only` moves the whole
 * bill onto health: the armour is not consulted at all for your own splash, and
 * the halved figure comes straight off the health.
 *
 * It is the most expensive of the four in the moment — a full-power jump is 50
 * health, so one is survivable and the second one kills — and that is the
 * trade. Mobility is no longer nearly free with an armour bar to hide it in; it
 * is the single most visible number in the game, and the price is paid where a
 * player can see it. Rocket Arena 3's `none` deletes the trade entirely,
 * `armor_only` charges for it in the wrong currency, and `full` charges in
 * both.
 *
 * Note that the two `*_only` modes are mirror images and neither is a hole:
 * `armor_only` becomes free at the bottom of the armour bar, and `health_only`
 * never does — health is the one bar you cannot spend to nothing and keep
 * playing.
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
  /**
   * Halved, and the armour is never consulted — the whole of it off the health.
   * The mirror of {@link SelfDamage.ArmorOnly}, and the default.
   *
   * Listed last and numbered 3 because these values are on the wire and in the
   * state hash: the byte a mode encodes to is fixed forever, so a new one takes
   * the next free number rather than the place it reads best in.
   */
  HealthOnly: 3,
} as const

export type SelfDamageMode = (typeof SelfDamage)[keyof typeof SelfDamage]

/** The mode a match runs under unless it says otherwise. See the header. */
export const DEFAULT_SELF_DAMAGE: SelfDamageMode = SelfDamage.HealthOnly

/** Whether `value` is one of the four. The door for anything off the wire. */
export function isSelfDamageMode(value: number): value is SelfDamageMode {
  return (
    value === SelfDamage.Full ||
    value === SelfDamage.ArmorOnly ||
    value === SelfDamage.None ||
    value === SelfDamage.HealthOnly
  )
}

/**
 * The fraction of splash damage you take from your own rocket. **Half**.
 *
 * Quake 3's `if ( targ == attacker ) damage *= 0.5`, and it applies before the
 * armour is consulted, which is why a full-power rocket jump takes 33 off your
 * armour and not 66 in the modes that consult it at all. It is applied to the
 * *health* figure only, after the knockback has already been derived from the
 * full 100 (`damage.ts`) — rocket jumping lives in the gap between those two
 * statements.
 *
 * {@link SelfDamage.None} skips it entirely rather than scaling it to zero,
 * because zero damage and "no damage rule at all" want to read differently at
 * the call site.
 */
export const SELF_DAMAGE_SCALE = 0.5

/**
 * The fraction of a hit you pay for with the guard up. **A tenth** — the 90%
 * reduction GLAD-ZPE5LN asked for, stated as what you pay rather than as what
 * you save, because paying is what the arithmetic below does.
 *
 * A multiplication, and not rounded to whole points afterwards. A blocked
 * 100-point rocket costs 10 and a blocked 72-point splash costs 7.2, and the
 * fraction is left alone for the same reason {@link SELF_DAMAGE_SCALE}'s halves
 * are: health has never been an integer in this game, and rounding the discount
 * would make it 90%-ish in exactly the hits a player is most likely to be
 * counting.
 *
 * ## Why your own splash is exempt
 *
 * The scale is applied only to a hit somebody *else* dealt you. A rocket at
 * your own feet is not blockable, and letting it be would not be a shield — it
 * would be a rocket jump at a tenth of the price, with the launch unchanged,
 * because the push has already been taken off the full figure by the time this
 * function is called. That is a movement exploit wearing a defensive rule, and
 * it would quietly undo the whole of the `health_only` argument in the header:
 * the point of the default mode is that mobility is paid for where a player can
 * see it.
 *
 * There is nothing to lose by the exemption. Blocking requires the shield in
 * your hands, and the shield cannot fire, so the only way to arrive at your own
 * splash with the guard up is to shoot the floor, switch, and raise — three
 * commands to buy back a jump the game already charges an honest price for.
 */
export const BLOCK_DAMAGE_SCALE = 0.1

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
 * The one place all four modes and the block are stated, as a pure function of
 * numbers, so that the rules can be read and tested without a world around
 * them. `damage.ts` applies the result and does the knockback, which happens
 * *before* this is called and is deliberately a function of neither.
 *
 * `selfInflicted` and `blocking` rather than a pair of entity ids and an entity,
 * because "did this player damage themselves" and "was their guard up" are the
 * only things the rules turn on, and passing the questions rather than the
 * world is what keeps this file free of it.
 */
export function resolveDamage(
  mode: SelfDamageMode,
  selfInflicted: boolean,
  points: number,
  armor: number,
  blocking = false,
): DamageSplit {
  if (points <= 0) return NOTHING
  if (selfInflicted && mode === SelfDamage.None) return NOTHING

  let take = selfInflicted ? points * SELF_DAMAGE_SCALE : points

  // The guard, and only against what the other player did to you — see
  // {@link BLOCK_DAMAGE_SCALE}. Before the armour rather than after it, so that
  // a blocked hit costs a tenth *in total* rather than a tenth of whatever the
  // armour left, which would make the discount depend on how much armour you
  // happened to be standing on.
  if (blocking && !selfInflicted) take *= BLOCK_DAMAGE_SCALE

  if (take < MIN_DAMAGE) take = MIN_DAMAGE

  // The whole of `health_only`, and the reason it returns before `armorAbsorbed`
  // rather than zeroing its result afterwards: under this mode the armour is not
  // *consulted*, so there is no share for it to have absorbed and no state in
  // which a hit both spared the armour and was made smaller by it. What the
  // halving left goes through to the health. See the header.
  if (selfInflicted && mode === SelfDamage.HealthOnly) return { armor: 0, health: take }

  const saved = armorAbsorbed(take, armor)
  take -= saved

  // The whole of `armor_only`: the armour still pays its 66%, and whatever the
  // armour could not cover is thrown away instead of coming off your health.
  // A player with no armour left therefore jumps for free — see the header.
  if (selfInflicted && mode === SelfDamage.ArmorOnly) take = 0

  return { armor: saved, health: take }
}
