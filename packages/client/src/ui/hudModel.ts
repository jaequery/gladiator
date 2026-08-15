/**
 * Everything the HUD is allowed to know, copied out of `GameState` once a
 * frame.
 *
 * This is `render/animState.ts`'s `playerNetState` for the readout instead of
 * the model, and it exists for the same two reasons. The `readonly` stops the
 * HUD writing to simulation state at compile time, and the *copy* stops it
 * reading a value `tick()` has since changed underneath it — the kernel mutates
 * entities in place and keeps the same objects (`AGENTS.md`), so a held
 * reference would quietly become a reference to the present.
 *
 * It is also the whole of the HUD's contract with the simulation. Every other
 * module under `ui/` takes a {@link HudModel} and nothing else, which is what
 * makes "the HUD is pure presentation" a property a test can check rather than
 * a rule a reviewer has to enforce — `ui/purity.test.ts` proves that this is
 * the only file down here that so much as names `GameState`.
 *
 * ## It is a projection, not a cache
 *
 * `hudModel` is a total function of `(state, slot)` with no memory, no
 * smoothing and no interpolation, called fresh every frame. That is what makes
 * "the HUD reflects the state within one frame of a change" true by
 * construction rather than by a subscription that might have missed an edge.
 * The one thing that genuinely needs history — hit and damage feedback, which
 * are made of *edges* — is a fold over these models in `feedback.ts`, exactly
 * the way `audio/cues.ts` folds over netstates.
 */
import {
  DUEL_SLOTS,
  EntityFlag,
  type EntityState,
  type GameState,
  MatchPhase,
  NEVER_FIRED,
  NO_DEADLINE,
  NO_WINNER,
  SPAWN_ARMOR,
  SPAWN_HEALTH,
  TICK_INTERVAL_MS,
  type Vec3,
  Weapon,
  findPlayer,
  weaponDef,
} from '@gladiator/sim'

/* --------------------------------------------------------------------------
 * The shape
 * ----------------------------------------------------------------------- */

/** How much of a pool is left, as a fraction, for a bar. */
export type HudPlayer = {
  /** `false` when nothing in the world holds this slot — a duel with one peer. */
  readonly present: boolean
  readonly alive: boolean
  readonly health: number
  readonly armor: number
  /** `health / SPAWN_HEALTH`, clamped. What a bar is scaled by. */
  readonly healthFraction: number
  readonly armorFraction: number
  /** The weapon in their hands. `Weapon.None` for a body holding nothing. */
  readonly weapon: Weapon
  /** Its display name, from the weapon table. Never parsed. */
  readonly weaponName: string
  /** Milliseconds until this player may fire again. Zero when they may now. */
  readonly cooldownMs: number
  /**
   * How much of the current refire interval is left, 1 at the muzzle flash and
   * 0 the instant the weapon is ready again. What the ring is drawn from.
   */
  readonly cooldownFraction: number
  /** Quake units per second, Quake frame. The damage indicator's input. */
  readonly velocity: Vec3
  /** Yaw in angle units — what "in front of me" means for that indicator. */
  readonly yawUnits: number
}

/** The score, the clock, and where the match is in its life. */
export type HudMatch = {
  readonly phase: MatchPhase
  /** 1-based; zero in warmup. */
  readonly round: number
  /** Rounds won, indexed by slot — `[yours, theirs]` is `scoreFor` below. */
  readonly wins: readonly [number, number]
  readonly roundsToWin: number
  /**
   * Milliseconds until this phase ends, or `null` for a phase that ends when
   * something happens rather than when a clock runs out.
   *
   * One field for both the round timer and the intermission countdown, because
   * `MatchState.phaseEndTick` is one field for both — see the comment on it.
   */
  readonly remainingMs: number | null
  /** Who won the last decided round, or `NO_WINNER` for a draw. */
  readonly lastRoundWinner: number
  /** Who won the match, or `NO_WINNER` while it is still being played. */
  readonly winner: number
}

export type HudModel = {
  /** The simulation's clock. Feedback decays against it, never against a timer. */
  readonly tick: number
  /** The slot this client is playing. */
  readonly slot: number
  readonly self: HudPlayer
  readonly opponent: HudPlayer
  readonly match: HudMatch
}

/* --------------------------------------------------------------------------
 * Projecting one player
 * ----------------------------------------------------------------------- */

/** A slot nothing in the world holds. Everything reads as zero and absent. */
export const ABSENT_PLAYER: HudPlayer = {
  present: false,
  alive: false,
  health: 0,
  armor: 0,
  healthFraction: 0,
  armorFraction: 0,
  weapon: Weapon.None,
  weaponName: '—',
  cooldownMs: 0,
  cooldownFraction: 0,
  velocity: [0, 0, 0],
  yawUnits: 0,
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return value < 0 ? 0 : value > 1 ? 1 : value
}

/**
 * How long until this player may fire again, and how far through the wait they
 * are.
 *
 * The interesting half is the *denominator*. The refire timer is shared by both
 * weapons (`sim/weapons.ts`), so dividing by the held weapon's interval would
 * be wrong for the one case that matters — firing the rail and then switching
 * to the launcher would draw a ring more than full. `nextFireTick -
 * lastFireTick` is exactly the interval of the weapon that actually fired, so
 * the ring empties at the rate the player is really waiting at without the HUD
 * having to remember which weapon that was.
 */
export function cooldownOf(entity: EntityState, tick: number): {
  readonly ms: number
  readonly fraction: number
} {
  const remaining = entity.nextFireTick - tick
  if (remaining <= 0) return { ms: 0, fraction: 0 }

  const total =
    entity.lastFireTick === NEVER_FIRED ? 0 : entity.nextFireTick - entity.lastFireTick
  return {
    ms: remaining * TICK_INTERVAL_MS,
    // A positive wait with no shot behind it can only come from a state we did
    // not see the start of — a mid-round join, a rewind. Draw it full rather
    // than dividing by zero and drawing nothing.
    fraction: total > 0 ? clamp01(remaining / total) : 1,
  }
}

/** The readable slice of one player. The HUD's only door into an entity. */
export function hudPlayer(entity: EntityState | null, tick: number): HudPlayer {
  if (entity === null) return ABSENT_PLAYER

  const cooldown = cooldownOf(entity, tick)
  return {
    present: true,
    alive: (entity.flags & EntityFlag.Dead) === 0 && entity.health > 0,
    health: entity.health,
    armor: entity.armor,
    healthFraction: clamp01(entity.health / SPAWN_HEALTH),
    armorFraction: clamp01(entity.armor / SPAWN_ARMOR),
    weapon: entity.weapon,
    weaponName: entity.weapon === Weapon.None ? '—' : weaponDef(entity.weapon).name,
    cooldownMs: cooldown.ms,
    cooldownFraction: cooldown.fraction,
    velocity: [entity.velocity[0], entity.velocity[1], entity.velocity[2]],
    yawUnits: entity.angles[1],
  }
}

/* --------------------------------------------------------------------------
 * Projecting the match
 * ----------------------------------------------------------------------- */

/** The other duellist's slot. Two slots, so this is the one that is not yours. */
export function opponentSlot(slot: number): number {
  return slot === DUEL_SLOTS[1] ? DUEL_SLOTS[0] : DUEL_SLOTS[1]
}

/** The whole readout, projected out of the world. Pure; no memory. */
export function hudModel(state: GameState, slot: number): HudModel {
  const match = state.match
  const other = opponentSlot(slot)

  return {
    tick: state.tick,
    slot,
    self: hudPlayer(findPlayer(state, slot), state.tick),
    opponent: hudPlayer(findPlayer(state, other), state.tick),
    match: {
      phase: match.phase,
      round: match.round,
      wins: [match.wins[0], match.wins[1]],
      roundsToWin: match.rules.roundsToWin,
      remainingMs:
        match.phaseEndTick === NO_DEADLINE
          ? null
          : Math.max(0, match.phaseEndTick - state.tick) * TICK_INTERVAL_MS,
      lastRoundWinner: match.lastRoundWinner,
      winner: match.winner,
    },
  }
}

/* --------------------------------------------------------------------------
 * Reading it
 *
 * Everything below turns the model into something a person reads. Pure, and
 * here rather than in the view, so the wording and the thresholds are testable
 * without a browser.
 * ----------------------------------------------------------------------- */

/**
 * Health below which the readout changes colour.
 *
 * Two thresholds rather than one, because they answer different questions. 50
 * is "the next direct hit kills you if your armour is gone"; 25 is "any splash
 * at all does". Both are read peripherally, so they are a *colour* change and a
 * pulse rather than a number somebody has to look at.
 */
export const HEALTH_LOW = 50
export const HEALTH_CRITICAL = 25

export type HealthTier = 'ok' | 'low' | 'critical' | 'dead'

export function healthTier(player: HudPlayer): HealthTier {
  if (!player.present || !player.alive) return 'dead'
  if (player.health <= HEALTH_CRITICAL) return 'critical'
  if (player.health <= HEALTH_LOW) return 'low'
  return 'ok'
}

/** `m:ss`, rounded up so a clock reading `0:00` means the phase is over. */
export function formatClock(remainingMs: number | null): string {
  if (remainingMs === null) return '—'
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/** Rounds won by a slot. */
export function scoreFor(match: HudMatch, slot: number): number {
  return slot === DUEL_SLOTS[1] ? match.wins[1] : match.wins[0]
}

/**
 * The line above the score: what is happening right now, in three words.
 *
 * Written from the *viewer's* slot, because "you won" and "they won" are the
 * only two readings of a round result anybody wants mid-duel, and working that
 * out from a slot number is not something a player should be doing.
 */
export function matchHeadline(model: HudModel): string {
  const { match, slot } = model
  const them = opponentSlot(slot)

  if (match.phase === MatchPhase.Warmup) return 'warm-up'
  if (match.phase === MatchPhase.Live) return `round ${match.round}`
  if (match.phase === MatchPhase.Intermission) {
    if (match.lastRoundWinner === NO_WINNER) return 'round drawn'
    return match.lastRoundWinner === slot ? 'round won' : 'round lost'
  }
  if (match.winner === NO_WINNER) return 'match drawn'
  return match.winner === slot ? 'match won' : match.winner === them ? 'match lost' : 'match over'
}

/**
 * The banner shown across the middle, or `null` for "get on with the duel".
 *
 * Only ever present when nobody can act on it anyway — an intermission or a
 * finished match — because a message over the crosshair during a live round is
 * a message in front of the thing the player is aiming at.
 */
export function matchAnnouncement(model: HudModel): string | null {
  const { match } = model
  if (match.phase === MatchPhase.Intermission || match.phase === MatchPhase.Over) {
    return matchHeadline(model)
  }
  return null
}
