/**
 * The band table: ten numbers that decide whether the bot is tuned. GLAD-6BIYFQ.
 *
 * `tools/bot-arena.ts` answers "does the movement work" — a pass/fail over
 * things that should never happen. This answers a different kind of question, and
 * the difference is why it is a second file: **every row here is a distribution
 * with a floor *and* a ceiling.** A bot that never misses a rail fails as hard as
 * one that never lands one, and a bot that dodges every rocket fails hardest of
 * all, because from the other end of the arena that is indistinguishable from a
 * bot that was told.
 *
 * ## Everything is measured from the world
 *
 * The same rule the soak harness works under, and it matters more here. Asking
 * the bot how many rails it landed would be asking the aim controller to grade
 * itself; asking it how many rockets it dodged would be asking the dodge
 * planner whether it thinks the dodge worked. So:
 *
 * - **Shots** are counted off `EntityState.lastFireTick`, which the simulation
 *   writes when a shot actually leaves — not off the trigger bit, which is a
 *   request that the refire timer may refuse.
 * - **Hits** come through `onDamage` (`packages/sim/src/damage.ts`), which is
 *   the tick telling the harness what landed and what delivered it. A rail, a
 *   direct rocket and a rocket at somebody's feet all take exactly 100 points,
 *   so a harness watching a health bar cannot tell the three apart, and two of
 *   them are separate rows of the table.
 * - **Line of sight** is a ray traced against the map, not the bot's
 *   `WorldModel`. A perception leak would be invisible to a check that asked the
 *   perception layer.
 *
 * The one thing read off the bot is {@link BotDecision.action}, for the
 * dithering row, and for the same reason `bot-arena.ts` reads `MoveState.hop`:
 * "what it decided to do" only exists as a claim, so there is nowhere else to
 * get it.
 *
 * ## The three samples, and why the ladder is two of them
 *
 * A run plays three sets of matches:
 *
 * | Sample | Seats | What it is for |
 * | ------ | ----- | -------------- |
 * | mirror | shipped vs shipped | every per-shot row, and spawn/side fairness |
 * | vs 0.45 | shipped vs novice | the difficulty axis is real, and points up |
 * | vs 0.80 | shipped vs expert | the difficulty axis is real, and points up |
 *
 * The ticket is honest about the first one's win rate: **two identical bots on a
 * symmetric map win half each by symmetry**, and a bot that stands still passes
 * it. It is kept as a *spawn and side fairness* check under that name — if the
 * two seats are not equally good places to start, this is what says so — and the
 * rows that mean something about skill are the two asymmetric ones.
 *
 * The ladder swaps seats every other match, so that a side advantage the mirror
 * row failed to notice cannot be read as the skill axis working.
 */

import {
  DAMAGE_ORIGIN_HEIGHT,
  DEFAULT_MATCH_RULES,
  EntityKind,
  MatchPhase,
  NO_WINNER,
  PLAYER_VIEW_HEIGHT,
  TICK_DT,
  TICK_RATE,
  Weapon,
  buildSpawnPlan,
  createTrace,
  findPlayer,
  onDamage,
  traceRay,
  vec3,
} from '@gladiator/sim'
import type {
  CollisionWorld,
  DamageEvent,
  EntityState,
  GameState,
  LoadedMap,
  MutVec3,
  SpawnPlan,
} from '@gladiator/sim'
import { DODGE_DANGER, SHIPPED_SKILL, SPLASH_DAMAGE, deriveSkill } from '@gladiator/bot'
import type { BotAction, BotSkill, LoadedNav } from '@gladiator/bot'

import { SLOTS, actBotArena, advanceBotArena, createBotArena } from './bot-arena.ts'

/* --------------------------------------------------------------------------
 * The two skills the ladder is made of
 * ----------------------------------------------------------------------- */

/** The novice rung. The shipped bot should beat it most of the time. */
export const LADDER_NOVICE = 0.45

/** The expert rung. It should beat the shipped bot most of the time. */
export const LADDER_EXPERT = 0.8

/* --------------------------------------------------------------------------
 * What "meaningfully dodged" and "had line of sight" mean
 * ----------------------------------------------------------------------- */

/**
 * How much of a rocket's full splash has to land for it to count as *not*
 * dodged, in points.
 *
 * Half. A duellist who takes 30 off a rocket that was going to take 100 has
 * dodged it in every sense that matters — they are still standing, and the
 * exchange went their way. A threshold at "took nothing at all" would measure
 * teleportation rather than movement.
 */
export const DODGE_SURVIVED_DAMAGE = SPLASH_DAMAGE * 0.5

/**
 * How far ahead a rocket's line is followed when deciding it was ever a threat,
 * in seconds.
 *
 * Two seconds is 1800 units of rocket, which is the whole arena. This is
 * deliberately *not* `DODGE_HORIZON_SECONDS`: that is how far ahead the bot
 * bothers to worry, and this is how far ahead the harness is willing to call a
 * rocket "aimed at you". Using the bot's own horizon would make the denominator
 * a function of the thing being measured.
 */
export const THREAT_HORIZON_SECONDS = 2

/**
 * How often line of sight is sampled, in sub-steps. **5**, which is 25 Hz.
 *
 * A trace per seat per sub-step is four million traces over a five-hundred-match
 * sample, for a question whose answer is measured in whole seconds. Twenty-five
 * samples a second resolves a one-second window to 4%.
 */
export const LOS_SAMPLE_TICKS = 5

/**
 * How far back the line-of-sight window reaches, in sub-steps. 2.5 s.
 *
 * Wider than the second the acceptance check asks about, and the reason is the
 * rocket launcher. A rail kills on the sub-step it is fired, so a window ending
 * at the frag is a window ending at the shot; a rocket is up to a second in the
 * air, and the last thing a dying player does is get behind something. Measuring
 * only the second before the *impact* would therefore report a perfectly fair
 * rocket kill as a perception leak, because the second before impact is the
 * second the victim spent hiding.
 *
 * Two and a half seconds covers a rocket's flight plus the second of sight the
 * check asks for, and still has no room in it for a bot that killed somebody it
 * never saw — such a bot has no clear samples in any window.
 */
export const LOS_WINDOW_TICKS = Math.round(TICK_RATE * 2.5)

/** The window as whole samples. */
export const LOS_WINDOW_SAMPLES = Math.floor(LOS_WINDOW_TICKS / LOS_SAMPLE_TICKS)

/** How many of those samples have to be clear: one second's worth. */
export const LOS_REQUIRED_SAMPLES = Math.ceil(TICK_RATE / LOS_SAMPLE_TICKS)

/* --------------------------------------------------------------------------
 * The tallies
 * ----------------------------------------------------------------------- */

/** Everything counted about one seat over a whole sample. */
export type SlotTally = {
  /** Sub-steps this seat was alive and in a live round. */
  aliveTicks: number
  /** Rails that actually left the muzzle. */
  rails: number
  /** Of those, the ones that hit. */
  railHits: number
  /** Rails fired at a target further away than `RAIL_MIN_RANGE`. */
  railsFar: number
  railHitsFar: number
  /** Rockets that actually left the muzzle. */
  rockets: number
  /** Of those, the ones that hit the opponent in the chest. */
  rocketDirects: number
  /**
   * Of those, the ones that burst near enough to splash the opponent.
   *
   * **Not** disjoint from {@link SlotTally.rocketDirects}: a rocket that hits
   * somebody in the chest burst at distance zero from their box, so it landed
   * inside the splash radius by construction. Quake declines to charge it the
   * splash *as well* — `radiusDamage`'s `ignoreId`, which is why a rocket in the
   * chest is 100 points and not 200 — and that is a damage-bookkeeping rule
   * rather than a statement about where the rocket went.
   *
   * Counting the two as disjoint would make the band table's two rocket rows
   * mutually exclusive, and their bands then demand that 58% to 82% of every
   * rocket fired lands on a duellist who is actively dodging it. Nothing does
   * that, and a bot that did would end a round in four seconds rather than the
   * nine to sixteen the row above asks for. So the splash row is
   * `directs + splashes`: **the rocket was aimed well enough to hurt**, and the
   * direct row is the share of those that were aimed well enough to hit.
   */
  rocketSplashes: number
  /** Points of health and armour this seat's rockets took off the opponent. */
  rocketDamage: number
  /** Changes of {@link BotAction} while alive. */
  actionSwitches: number
  /** Kills of the *other* player. A rocket-jump death is nobody's frag. */
  frags: number
  /** Frags this seat had a second of line of sight before. */
  fragsWithSight: number
  /** Enemy rockets that were on a line to hurt this seat when they were fired. */
  threats: number
  /** Of those, the ones that then failed to land half a splash on it. */
  dodged: number
  /** Rounds this seat won. */
  roundWins: number
  /** Matches this seat won. */
  matchWins: number
}

function createSlotTally(): SlotTally {
  return {
    aliveTicks: 0,
    rails: 0,
    railHits: 0,
    railsFar: 0,
    railHitsFar: 0,
    rockets: 0,
    rocketDirects: 0,
    rocketSplashes: 0,
    rocketDamage: 0,
    actionSwitches: 0,
    frags: 0,
    fragsWithSight: 0,
    threats: 0,
    dodged: 0,
    roundWins: 0,
    matchWins: 0,
  }
}

/** One sample: some number of matches between two given skills. */
export type SampleTally = {
  matches: number
  /** Matches that hit the tick cap without reaching a winner. */
  unfinished: number
  rounds: number
  /** Rounds decided by somebody dying, and the sub-steps each of them took. */
  killedRounds: number
  killTicks: number
  /** Rockets whose explosion could not be attributed to one launch. Should be nil. */
  ambiguous: number
  readonly slots: [SlotTally, SlotTally]
  /**
   * Which skill sat in each seat, per match, as a share. `1` means seat 0 always
   * held the first skill. Diagnostics for the seat swap.
   */
  swapped: number
}

export function createSampleTally(): SampleTally {
  return {
    matches: 0,
    unfinished: 0,
    rounds: 0,
    killedRounds: 0,
    killTicks: 0,
    ambiguous: 0,
    slots: [createSlotTally(), createSlotTally()],
    swapped: 0,
  }
}

/* --------------------------------------------------------------------------
 * One match
 * ----------------------------------------------------------------------- */

/** A rocket in the air, and what the harness needs to judge it by. */
type Rocket = {
  /** The projectile's entity id. */
  readonly id: number
  readonly owner: number
  /** The seat it was fired at — the other one. */
  readonly target: number
  /** Whether it was on a line to hurt {@link target} when it left the muzzle. */
  readonly threatening: boolean
}

/** One seat's running state inside a match. */
type SeatWatch = {
  action: BotAction
  /** The trailing line-of-sight window, oldest first. */
  readonly sight: boolean[]
  sightAt: number
  sightClear: number
}

function createSeatWatch(): SeatWatch {
  return {
    action: 'dead',
    sight: new Array<boolean>(LOS_WINDOW_SAMPLES).fill(false),
    sightAt: 0,
    sightClear: 0,
  }
}

/* Scratch. Single-threaded and synchronous, like the sim's own. */
const eye: MutVec3 = vec3()
const mark: MutVec3 = vec3()
const sightTrace = createTrace()

/** Is there clean air between `from`'s eye and `to`'s middle? */
function hasSight(world: CollisionWorld, from: EntityState, to: EntityState): boolean {
  eye[0] = from.origin[0]
  eye[1] = from.origin[1]
  eye[2] = from.origin[2] + PLAYER_VIEW_HEIGHT
  mark[0] = to.origin[0]
  mark[1] = to.origin[1]
  mark[2] = to.origin[2] + DAMAGE_ORIGIN_HEIGHT
  return traceRay(sightTrace, world, eye, mark).fraction === 1
}

/**
 * Was `rocket` going to hurt `target` if `target` carried on doing what it was
 * doing?
 *
 * This is the counterfactual the whole dodge row rests on, and getting it wrong
 * is the easiest way to make the number mean nothing. The first version compared
 * the rocket's line against where the target *was*, and that quietly threw away
 * every led shot: a rocket aimed 200 units ahead of a runner passes nowhere near
 * their current position, so it scored as "never a threat" and the rockets left
 * in the denominator were mostly the ones the shooter had already misjudged.
 *
 * So both bodies move. The closest approach of two constant-velocity points —
 * the rocket at its muzzle velocity, the target at whatever it was travelling at
 * when the trigger went down — against {@link DODGE_DANGER}, which is the same
 * splash-radius-plus-a-margin test `combat/dodge.ts` applies, run against the
 * truth instead of against a `WorldModel`.
 *
 * Then a ray from the muzzle to the rocket's own position at that moment,
 * because a rocket that was going to hit a pillar first was never a threat and a
 * target that "dodged" it did nothing. Without that trace the denominator fills
 * up with the shooter's misses and the dodge rate reads far too high.
 *
 * A straight line is of course not what a duellist does for the next second.
 * That is the point: **the rocket counted as dodged is exactly the one that
 * would have landed had the target not changed anything**, which is what a dodge
 * is.
 */
function threatens(world: CollisionWorld, rocket: EntityState, target: EntityState): boolean {
  // Relative to the target, which is the frame the closest approach is simplest
  // in and the frame the target's own movement belongs in.
  const vx = rocket.velocity[0] - target.velocity[0]
  const vy = rocket.velocity[1] - target.velocity[1]
  const vz = rocket.velocity[2] - target.velocity[2]
  const speedSquared = vx * vx + vy * vy + vz * vz
  if (speedSquared === 0) return false

  const rx = target.origin[0] - rocket.origin[0]
  const ry = target.origin[1] - rocket.origin[1]
  const rz = target.origin[2] + DAMAGE_ORIGIN_HEIGHT - rocket.origin[2]

  const at = (rx * vx + ry * vy + rz * vz) / speedSquared
  if (at <= 0 || at >= THREAT_HORIZON_SECONDS) return false

  const mx = rx - vx * at
  const my = ry - vy * at
  const mz = rz - vz * at
  if (mx * mx + my * my + mz * mz >= DODGE_DANGER * DODGE_DANGER) return false

  eye[0] = rocket.origin[0]
  eye[1] = rocket.origin[1]
  eye[2] = rocket.origin[2]
  mark[0] = rocket.origin[0] + rocket.velocity[0] * at
  mark[1] = rocket.origin[1] + rocket.velocity[1] * at
  mark[2] = rocket.origin[2] + rocket.velocity[2] * at
  return traceRay(sightTrace, world, eye, mark).fraction === 1
}

/** The other seat. A duel has two. */
function other(slot: number): number {
  return slot === 0 ? 1 : 0
}

export type BandMatchOptions = {
  readonly map: LoadedMap
  readonly nav: LoadedNav
  readonly plan: SpawnPlan
  readonly seed: number
  /** The skill in each seat. */
  readonly skills: readonly [BotSkill, BotSkill]
  /** The most sub-steps this match may take before it is abandoned. */
  readonly maxTicks: number
}

/**
 * Play one match to its end and fold what happened into `tally`.
 *
 * The loop is `act`, then observe the decision, then `advance`, then attribute —
 * and the split is the same phase trap `bot-arena.ts` documents. A decision is
 * about the world *before* the sub-step; a hit is about the world after it.
 */
export function playBandMatch(tally: SampleTally, options: BandMatchOptions): void {
  const arena = createBotArena({
    map: options.map,
    nav: options.nav,
    plan: options.plan,
    seed: options.seed,
    skills: options.skills,
  })
  const state: GameState = arena.state
  const world = options.map.world

  const watches: SeatWatch[] = SLOTS.map(() => createSeatWatch())
  const rockets = new Map<number, Rocket>()

  // Damage that landed on the tick just simulated, drained after every advance.
  const landed: DamageEvent[] = []
  onDamage((event) => landed.push(event))

  let wasLive = false
  let roundStart = state.tick
  let killed = false
  let ticks = 0

  try {
    while (state.match.phase !== MatchPhase.Over && ticks < options.maxTicks) {
      ticks += 1

      actBotArena(arena)

      const live = state.match.phase === MatchPhase.Live
      for (const slot of SLOTS) {
        const bot = arena.bots[slot]
        const watch = watches[slot]
        const body = findPlayer(state, slot)
        if (bot === null || bot === undefined || watch === undefined || body === null) continue

        const action = bot.brain.decision.action
        if (live && action !== 'dead') {
          const seat = tally.slots[slot]
          if (seat !== undefined) seat.aliveTicks += 1
          if (watch.action !== 'dead' && action !== watch.action && seat !== undefined) {
            seat.actionSwitches += 1
          }
        }
        watch.action = action

        // Line of sight, sampled rather than traced every sub-step. The phase is
        // the world's tick number, so both seats sample together and a replay
        // reproduces the window.
        if (state.tick % LOS_SAMPLE_TICKS === 0) {
          const foe = findPlayer(state, other(slot))
          const clear = live && foe !== null && hasSight(world, body, foe)
          const was = watch.sight[watch.sightAt] ?? false
          if (was) watch.sightClear -= 1
          if (clear) watch.sightClear += 1
          watch.sight[watch.sightAt] = clear
          watch.sightAt = (watch.sightAt + 1) % LOS_WINDOW_SAMPLES
        }
      }

      landed.length = 0
      advanceBotArena(arena)

      /* ---- shots that actually left the muzzle ---- */
      for (const slot of SLOTS) {
        const body = findPlayer(state, slot)
        const seat = tally.slots[slot]
        if (body === null || seat === undefined) continue
        if (body.lastFireTick !== state.tick) continue

        const foe = findPlayer(state, other(slot))
        if (body.weapon === Weapon.Railgun) {
          seat.rails += 1
          // Both bodies are where the fire phase saw them: the movement phase
          // ran before it, and nothing after it moves an origin (`kernel.ts`).
          const far = foe !== null && rangeSquared(body, foe) > RAIL_FAR * RAIL_FAR
          if (far) seat.railsFar += 1
          const hit = landed.some((e) => e.cause === 'rail' && e.attackerId === body.id)
          if (hit) {
            seat.railHits += 1
            if (far) seat.railHitsFar += 1
          }
        } else {
          seat.rockets += 1
        }
      }

      /* ---- rockets appearing and disappearing ---- */
      for (const entity of state.entities) {
        if (entity.kind !== EntityKind.Projectile) continue
        if (rockets.has(entity.id)) continue
        const owner = ownerSlot(state, entity.ownerId)
        if (owner < 0) continue
        const target = findPlayer(state, other(owner))
        rockets.set(entity.id, {
          id: entity.id,
          owner,
          target: other(owner),
          threatening: target !== null && threatens(world, entity, target),
        })
      }

      const exploded: Rocket[] = []
      for (const [id, rocket] of rockets) {
        if (findProjectile(state, id) === null) exploded.push(rocket)
      }
      for (const rocket of exploded) rockets.delete(rocket.id)

      for (const rocket of exploded) {
        if (!rocket.threatening) continue

        const owner = findPlayer(state, rocket.owner)
        const victim = tally.slots[rocket.target]
        if (owner === null || victim === undefined) continue

        // Two of the same shooter's rockets bursting on one sub-step cannot be
        // told apart from out here — one health bar went down and there are two
        // candidates — so they are counted and excluded rather than guessed at.
        if (exploded.filter((one) => one.owner === rocket.owner).length > 1) {
          tally.ambiguous += 1
          continue
        }

        let took = 0
        for (const event of landed) {
          if (event.attackerId !== owner.id) continue
          if (event.attackerId === event.targetId) continue
          if (event.cause === 'rail') continue
          took += event.absorbed
        }
        victim.threats += 1
        if (took < DODGE_SURVIVED_DAMAGE) victim.dodged += 1
      }

      /* ---- rockets landing ---- */
      for (const event of landed) {
        const shooter = ownerSlot(state, event.attackerId)
        const seat = shooter < 0 ? undefined : tally.slots[shooter]
        if (seat === undefined) continue
        if (event.attackerId === event.targetId) continue
        if (event.cause === 'direct') seat.rocketDirects += 1
        if (event.cause === 'splash') seat.rocketSplashes += 1
        if (event.cause !== 'rail') seat.rocketDamage += event.absorbed

        if (event.fatal) {
          seat.frags += 1
          const watch = watches[shooter]
          if (watch !== undefined && watch.sightClear >= LOS_REQUIRED_SAMPLES) {
            seat.fragsWithSight += 1
          }
        }
      }

      /* ---- rounds ---- */
      if (landed.some((event) => event.fatal)) killed = true

      const nowLive = state.match.phase === MatchPhase.Live
      if (nowLive && !wasLive) {
        roundStart = state.tick
        killed = false
        // A fresh window, so a kill early in round three is not credited with
        // the sight line somebody had at the end of round two.
        for (const watch of watches) {
          watch.sight.fill(false)
          watch.sightAt = 0
          watch.sightClear = 0
        }
      }
      if (!nowLive && wasLive) {
        tally.rounds += 1
        if (killed) {
          tally.killedRounds += 1
          tally.killTicks += state.tick - roundStart
        }
      }
      wasLive = nowLive
    }
  } finally {
    onDamage(null)
  }

  tally.matches += 1
  if (state.match.phase !== MatchPhase.Over) {
    tally.unfinished += 1
    return
  }

  for (const slot of SLOTS) {
    const seat = tally.slots[slot]
    if (seat !== undefined) seat.roundWins += state.match.wins[slot] ?? 0
  }
  const winner = state.match.winner
  if (winner !== NO_WINNER) {
    const seat = tally.slots[winner]
    if (seat !== undefined) seat.matchWins += 1
  }
}

/** `RAIL_MIN_RANGE`, restated where the table says "beyond 900 u". */
const RAIL_FAR = 900

function rangeSquared(a: EntityState, b: EntityState): number {
  const dx = b.origin[0] - a.origin[0]
  const dy = b.origin[1] - a.origin[1]
  const dz = b.origin[2] - a.origin[2]
  return dx * dx + dy * dy + dz * dz
}

/** The player slot that owns `id`, or -1. */
function ownerSlot(state: GameState, id: number): number {
  for (const entity of state.entities) {
    if (entity.id === id) return entity.kind === EntityKind.Player ? entity.slot : -1
  }
  return -1
}

function findProjectile(state: GameState, id: number): EntityState | null {
  for (const entity of state.entities) {
    if (entity.id === id) return entity
  }
  return null
}

/* --------------------------------------------------------------------------
 * A whole sample
 * ----------------------------------------------------------------------- */

export type BandSampleOptions = {
  readonly map: LoadedMap
  readonly nav: LoadedNav
  /** How many matches. */
  readonly matches: number
  /**
   * The index of the first match, for a run split across processes.
   *
   * The seat swap is `index % 2`, so a chunk that started counting from zero
   * would play the swap the wrong way round and the un-swapping in
   * {@link foldSample} would put the wrong bot in `slots[0]`. Handing each chunk
   * its offset is what makes a pooled run and a single-process run the same run.
   */
  readonly from?: number
  /** The first seed. Every match after it is this plus a fixed stride. */
  readonly seed: number
  /**
   * The two skills. The first is the bot under test; it starts in seat 0 and
   * swaps every other match.
   */
  readonly skills: readonly [BotSkill, BotSkill]
  /** Built once and shared; see `bot-arena.ts`. */
  readonly plan?: SpawnPlan
  readonly onMatch?: (index: number, tally: SampleTally) => void
}

/**
 * The seed the committed sample is played from.
 *
 * One number, written down, so that "the band table passes" is a claim somebody
 * else can reproduce rather than a claim about whichever matches happened to be
 * played. Changing it is changing the evidence, and is a thing to do
 * deliberately and say out loud.
 */
export const BAND_SEED = 20260816

/**
 * The stride between one match's seed and the next.
 *
 * Prime, and larger than the number of draws a match takes, so two matches in a
 * sample cannot be handed overlapping stretches of the same stream — the bot's
 * seed is `seed * 31 + slot` (`bot-arena.ts`) and the world's is `seed`.
 */
export const SEED_STRIDE = 1009

/**
 * The tick cap on one match. Ten seconds a round beyond the round limit itself.
 *
 * A match that reaches it is counted as unfinished rather than scored, because a
 * half-played match's win rate is a statement about the cap.
 */
export function maxMatchTicks(): number {
  const rules = DEFAULT_MATCH_RULES
  return rules.maxRounds * (rules.roundTimeLimitTicks + rules.intermissionTicks) + TICK_RATE * 10
}

/** Play `matches` of them, swapping seats every other one, and fold them together. */
export function sampleBands(options: BandSampleOptions): SampleTally {
  const tally = createSampleTally()
  const plan = options.plan ?? buildSpawnPlan(options.map.source, options.map.world)
  const maxTicks = maxMatchTicks()
  const [first, second] = options.skills

  const from = options.from ?? 0
  for (let index = from; index < from + options.matches; index += 1) {
    // Odd matches swap the seats. Without it a side advantage would be read as
    // the skill axis working, which is precisely the claim being made.
    const match = index
    const swap = match % 2 === 1
    const inner = createSampleTally()
    playBandMatch(inner, {
      map: options.map,
      nav: options.nav,
      plan,
      seed: options.seed + match * SEED_STRIDE,
      skills: swap ? [second, first] : [first, second],
      maxTicks,
    })
    if (swap) tally.swapped += 1
    foldSample(tally, inner, swap)
    options.onMatch?.(match, tally)
  }

  return tally
}

/** Add one sample into another, seat for seat. For a run split across processes. */
export function addSample(into: SampleTally, from: SampleTally): void {
  foldSample(into, from, false)
}

/**
 * Add `from` into `into`, un-swapping the seats if this match was played the
 * other way round.
 *
 * So `slots[0]` of a finished sample is always *the first skill*, whichever seat
 * it happened to sit in. That is what makes the ladder rows readable as "the
 * shipped bot won this share" rather than as "seat zero won this share".
 */
function foldSample(into: SampleTally, from: SampleTally, swap: boolean): void {
  into.matches += from.matches
  into.unfinished += from.unfinished
  into.rounds += from.rounds
  into.killedRounds += from.killedRounds
  into.killTicks += from.killTicks
  into.ambiguous += from.ambiguous
  into.swapped += from.swapped

  for (const slot of SLOTS) {
    const target = into.slots[swap ? other(slot) : slot]
    const source = from.slots[slot]
    if (target === undefined || source === undefined) continue
    for (const key of Object.keys(source) as (keyof SlotTally)[]) {
      target[key] += source[key]
    }
  }
}

/* --------------------------------------------------------------------------
 * The table itself
 * ----------------------------------------------------------------------- */

/** One row: what was measured, what it has to be, and whether it is. */
export type BandRow = {
  readonly name: string
  /** The measured value, or `null` for a row with no sample behind it. */
  readonly value: number | null
  readonly low: number
  readonly high: number
  /** How to print it: a share of one, or a number of seconds, or a rate. */
  readonly unit: 'percent' | 'seconds' | 'rate'
  readonly pass: boolean
  /** The denominator, so a row that passed on four shots can be seen to have. */
  readonly sample: number
}

function ratio(top: number, bottom: number): number | null {
  return bottom === 0 ? null : top / bottom
}

function row(
  name: string,
  value: number | null,
  low: number,
  high: number,
  unit: BandRow['unit'],
  sample: number,
): BandRow {
  return { name, value, low, high, unit, pass: value !== null && value >= low && value <= high, sample }
}

/** Both seats of a sample added together — the per-shot rows are about the bot, not the seat. */
function bothSeats(tally: SampleTally): SlotTally {
  const total = createSlotTally()
  for (const seat of tally.slots) {
    for (const key of Object.keys(total) as (keyof SlotTally)[]) total[key] += seat[key]
  }
  return total
}

/** The share of decided matches the first skill won. */
export function winRate(tally: SampleTally): number | null {
  const [a, b] = tally.slots
  return ratio(a.matchWins, a.matchWins + b.matchWins)
}

/** The share of decided rounds the first skill won. */
export function roundWinRate(tally: SampleTally): number | null {
  const [a, b] = tally.slots
  return ratio(a.roundWins, a.roundWins + b.roundWins)
}

export type BandSamples = {
  readonly mirror: SampleTally
  readonly novice: SampleTally
  readonly expert: SampleTally
}

/**
 * The band table, as the ticket states it.
 *
 * Every row is a floor and a ceiling. The two that are not obviously two-sided
 * still are: a dodge rate of 100% is a bot that cannot be shot, and an action
 * that never changes is a bot that has stopped thinking.
 */
export function bandTable(samples: BandSamples): BandRow[] {
  const mirror = bothSeats(samples.mirror)
  const seconds = samples.mirror.killedRounds === 0
    ? null
    : samples.mirror.killTicks / samples.mirror.killedRounds / TICK_RATE
  const aliveSeconds = mirror.aliveTicks * TICK_DT

  return [
    row('spawn and side fairness (seat 0 wins)', winRate(samples.mirror), 0.46, 0.54, 'percent', samples.mirror.matches),
    row('vs skill 0.45', winRate(samples.novice), 0.68, 0.82, 'percent', samples.novice.matches),
    row('vs skill 0.80', winRate(samples.expert), 0.18, 0.32, 'percent', samples.expert.matches),
    row('mean time to kill', seconds, 9, 16, 'seconds', samples.mirror.killedRounds),
    row('railgun accuracy, all ranges', ratio(mirror.railHits, mirror.rails), 0.36, 0.48, 'percent', mirror.rails),
    row('railgun accuracy beyond 900 u', ratio(mirror.railHitsFar, mirror.railsFar), 0.28, 0.4, 'percent', mirror.railsFar),
    row('rocket direct-hit rate', ratio(mirror.rocketDirects, mirror.rockets), 0.14, 0.24, 'percent', mirror.rockets),
    row(
      'rocket splash-damage rate',
      ratio(mirror.rocketDirects + mirror.rocketSplashes, mirror.rockets),
      0.44,
      0.58,
      'percent',
      mirror.rockets,
    ),
    row('L3 action switches per second', aliveSeconds === 0 ? null : mirror.actionSwitches / aliveSeconds, 0.6, 2.2, 'rate', mirror.actionSwitches),
    row('rockets meaningfully dodged', ratio(mirror.dodged, mirror.threats), 0.55, 0.75, 'percent', mirror.threats),
  ]
}

/**
 * The fourth acceptance check, which is not a band-table row: the share of frags
 * the killer had a second of line of sight before.
 *
 * A floor rather than a band. It is looking for a *perception leak* — a bot that
 * kills somebody it was never in a position to have seen — and there is no such
 * thing as too many fair kills.
 */
export const SIGHT_BEFORE_FRAG_FLOOR = 0.85

export function sightBeforeFrag(tally: SampleTally): number | null {
  const both = bothSeats(tally)
  return ratio(both.fragsWithSight, both.frags)
}

/* --------------------------------------------------------------------------
 * Running it
 * ----------------------------------------------------------------------- */

export type BandRunOptions = {
  readonly map: LoadedMap
  readonly nav: LoadedNav
  /** Matches in the mirror sample — the one every per-shot row comes from. */
  readonly matches: number
  /** Matches in each ladder sample. Defaults to {@link BandRunOptions.matches}. */
  readonly ladderMatches?: number
  /** The committed seed. See `bot-bands.test.ts` for why it is committed. */
  readonly seed: number
  /** The skill under test. The shipped one, unless a sweep is asking. */
  readonly skill?: BotSkill
  readonly onProgress?: (label: string, index: number, of: number) => void
}

/** Play all three samples. */
export function runBands(options: BandRunOptions): BandSamples {
  const plan = buildSpawnPlan(options.map.source, options.map.world)
  const skill = options.skill ?? SHIPPED_SKILL
  const ladder = options.ladderMatches ?? options.matches

  const sample = (label: string, matches: number, against: BotSkill, seed: number): SampleTally =>
    sampleBands({
      map: options.map,
      nav: options.nav,
      plan,
      matches,
      seed,
      skills: [skill, against],
      onMatch: (index) => options.onProgress?.(label, index + 1, matches),
    })

  return {
    // Three disjoint stretches of seed space, so the mirror sample and the two
    // ladder samples are not three views of the same matches.
    mirror: sample('mirror', options.matches, skill, options.seed),
    novice: sample('vs 0.45', ladder, deriveSkill(LADDER_NOVICE), options.seed + 500_000),
    expert: sample('vs 0.80', ladder, deriveSkill(LADDER_EXPERT), options.seed + 1_000_000),
  }
}

/** How far a row is outside its band, as a share of the band's width. Zero when it passes. */
export function rowError(row: BandRow): number {
  if (row.value === null) return 1
  const width = row.high - row.low
  if (row.value < row.low) return (row.low - row.value) / width
  if (row.value > row.high) return (row.value - row.high) / width
  return 0
}

/**
 * How wrong a whole table is, as one number a sweep can descend.
 *
 * The sum of the per-row errors, each in units of its own band's width so that a
 * row measured in seconds and a row measured in percent are worth the same. The
 * side-fairness row is left out: it is 50% by symmetry, so a sweep that could
 * move it would be a sweep exploiting the sample rather than the bot.
 */
export function tableError(rows: readonly BandRow[]): number {
  let total = 0
  for (const row of rows) {
    if (row.name.startsWith('spawn and side')) continue
    total += rowError(row)
  }
  return total
}

function formatValue(row: BandRow): string {
  if (row.value === null) return '-'
  if (row.unit === 'percent') return `${(row.value * 100).toFixed(1)}%`
  if (row.unit === 'seconds') return `${row.value.toFixed(1)} s`
  return row.value.toFixed(2)
}

function formatBand(row: BandRow): string {
  if (row.unit === 'percent') return `${(row.low * 100).toFixed(0)}-${(row.high * 100).toFixed(0)}%`
  if (row.unit === 'seconds') return `${row.low}-${row.high} s`
  return `${row.low}-${row.high}`
}

/** The table, one row per line, for the CLI and for a failing test's output. */
export function formatBands(rows: readonly BandRow[]): string {
  const width = Math.max(...rows.map((row) => row.name.length))
  return rows
    .map(
      (row) =>
        `${row.pass ? 'pass' : 'FAIL'}  ${row.name.padEnd(width)}  ${formatValue(row).padStart(7)}  want ${formatBand(row).padStart(9)}  n=${row.sample}`,
    )
    .join('\n')
}

/** A one-line-per-row summary of a sample, for a run that wants to say what happened. */
export function formatSample(label: string, tally: SampleTally): string {
  const both = bothSeats(tally)
  const rate = winRate(tally)
  const rounds = roundWinRate(tally)
  return [
    `${label}: ${tally.matches} matches (${tally.unfinished} unfinished), ${tally.rounds} rounds`,
    `        matches ${rate === null ? '-' : (rate * 100).toFixed(1)}%, rounds ${rounds === null ? '-' : (rounds * 100).toFixed(1)}% to the first skill`,
    `        ${both.rails} rails / ${both.railHits} hits, ${both.rockets} rockets / ${both.rocketDirects} direct / ${both.rocketSplashes} splash / ${both.rockets === 0 ? '-' : (both.rocketDamage / both.rockets).toFixed(1)} mean damage`,
    `        ${both.threats} threatening rockets, ${both.dodged} dodged, ${tally.ambiguous} ambiguous`,
    `        ${both.frags} frags, ${both.fragsWithSight} with a second of sight first`,
  ].join('\n')
}
