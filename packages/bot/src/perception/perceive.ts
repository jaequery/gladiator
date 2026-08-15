/**
 * The one module in `packages/bot` that touches ground truth.
 *
 * Everything above this file reads a {@link WorldModel}. That is enforced three
 * ways, weakest last:
 *
 * 1. **The mutation test.** `fairness.test.ts` perturbs state that this file
 *    deliberately does not read — the opponent's health, armour, weapon while
 *    unseen, view angles, refire timer, the world's PRNG — and requires the
 *    bot's `UserCmd` stream to come out bit-identical. A positive control moves
 *    the opponent into the cone and requires it to *differ*, so the assertion
 *    cannot pass by the bot doing nothing.
 * 2. **The lint rule.** `GROUND_TRUTH_BANS` refuses `GameState`,
 *    `EntityState` and `state.entities` anywhere in `packages/bot` outside this
 *    directory, and `scripts/guardrails.mjs` proves it fires.
 * 3. **This comment**, which is the part that stops being true first.
 *
 * ## The order the channels run in, and why it is that order
 *
 * `ageContact` first, always: it clears `fresh` and `visible`, decays the
 * standing belief and dead-reckons it, so that a channel writing afterwards is
 * the only thing that can mark the belief current. Then damage, sight, sound —
 * and each of the three writes only if its confidence is at least what is
 * already there ({@link confidenceOf}), which is what stops a noise from
 * displacing a body the bot is looking straight at.
 *
 * ## The gate comes before the draw
 *
 * The sound channel is the only one that consumes randomness, and it does so
 * strictly after its range gate and its confidence gate have passed. That is
 * not tidiness. A draw taken on a sound the bot could not hear would advance
 * the PRNG by an amount that depends on where the opponent is, and every
 * command after it would shift — a leak of exactly the kind the mutation test
 * exists to catch, arriving through the one door the test itself does not
 * look at.
 *
 * ## It must be called once per sub-step
 *
 * The damage channel is an *edge* on the bot's own health plus armour, and the
 * bearing it derives comes from the change in the bot's own velocity across
 * that edge (`client/ui/feedback.ts` derives the player's damage indicator the
 * same way, from the same shove, for the same reason: the state carries no
 * attacker). Both readings are one sub-step wide. Perception is cheap enough to
 * run at 125 Hz — three point traces — and the decision layer above it is what
 * runs at 20 Hz.
 */

import {
  EntityFlag,
  EntityKind,
  NO_SLOT,
  PLAYER_VIEW_HEIGHT,
  angleVectors,
  findPlayer,
  vec3,
} from '@gladiator/sim'
import type {
  CollisionWorld,
  EntityState,
  GameState,
  MutVec3,
  RngHolder,
} from '@gladiator/sim'

import { ageContact } from './memory.ts'
import { coneCosine, inCone, lineOfSight, visibilityFraction } from './sight.ts'
import { hearContact } from './sound.ts'
import {
  ACQUIRE_VISIBILITY,
  ALERT_TICKS,
  DAMAGE_ASSUMED_RANGE,
  FIRE_HEARING_RANGE,
  FOOTSTEP_HEARING_RANGE,
  FOOTSTEP_INTERVAL_TICKS,
  FOOTSTEP_SPEED,
  MAX_THREATS,
  MIN_SHOVE,
  NEVER_TICK,
  SIGHT_HOLD_TICKS,
  SIGHT_RANGE,
  clearContact,
  confidenceOf,
  createWorldModel,
  fovDegrees,
} from './worldModel.ts'
import type { ThreatContact, WorldModel } from './worldModel.ts'

/**
 * Everything the perception layer is allowed to look at, handed in as one
 * value.
 *
 * It is a parameter rather than something the bot holds, so that a caller above
 * this layer can forward it without ever naming what is inside it — `bot.ts`
 * mentions `Ground` and never `GameState`, which is what lets the lint rule ban
 * the name outright rather than having to reason about which uses are innocent.
 */
export type Ground = {
  readonly state: GameState
  readonly world: CollisionWorld
}

/** The perception layer's own bookkeeping, none of which is a belief. */
export type Perception = {
  readonly model: WorldModel
  /** The bot's seeded stream. Drawn from by the sound channel and nothing else. */
  readonly rng: RngHolder
  /**
   * `false` until the first observation.
   *
   * The damage channel is an edge, and the first frame of a round would
   * otherwise read the step up from nothing as a step down. `ui/feedback.ts`
   * carries the same flag for the same reason.
   */
  seen: boolean
  /** The bot's own health plus armour last tick. A drop in it is a hit. */
  reserve: number
  /** The bot's own velocity last tick, for the knockback difference. */
  previousVelocity: MutVec3
  /** Threat records, reused so that a tick in the steady state allocates nothing. */
  readonly threatPool: ThreatContact[]
}

/** A perception layer that has observed nothing. */
export function createPerception(slot: number, rng: RngHolder): Perception {
  return {
    model: createWorldModel(slot),
    rng,
    seen: false,
    reserve: 0,
    previousVelocity: vec3(),
    threatPool: [],
  }
}

/* Scratch. Single-threaded and synchronous; see `sight.ts`. */
const forward: MutVec3 = vec3()
const eye: MutVec3 = vec3()
const shove: MutVec3 = vec3()

/** Bring the model up to date for the tick `ground.state` is on. */
export function observe(perception: Perception, ground: Ground): void {
  const { state, world } = ground
  const model = perception.model
  const tick = state.tick
  const contact = model.enemy

  const self = findPlayer(state, model.self.slot)
  if (self === null) {
    // No body: between rounds in a world this bot has not been spawned into, or
    // a seat that has left. Nothing is perceived and nothing is remembered.
    model.tick = tick
    model.self.alive = false
    perception.seen = false
    clearContact(contact)
    model.threats.length = 0
    return
  }

  // A round boundary voids every belief: both players are teleported to spawn
  // points neither of them chose, so a position remembered from the last round
  // is not stale — it is about a world that no longer exists.
  if (state.match.round !== model.match.round) {
    clearContact(contact)
    model.alertUntilTick = NEVER_TICK
    model.damageTick = NEVER_TICK
    model.damageBearing[0] = 0
    model.damageBearing[1] = 0
    model.damageBearing[2] = 0
    perception.seen = false
  }

  readSelf(model, self)
  model.match.phase = state.match.phase
  model.match.round = state.match.round
  model.match.mine = state.match.wins[model.self.slot] ?? 0
  model.match.theirs = state.match.wins[model.self.slot === 0 ? 1 : 0] ?? 0
  model.tick = tick

  ageContact(contact, tick, world)

  eye[0] = self.origin[0]
  eye[1] = self.origin[1]
  eye[2] = self.origin[2] + PLAYER_VIEW_HEIGHT
  angleVectors(self.angles[0], self.angles[1], 0, forward, null, null)

  const reserve = self.health + self.armor
  if (perception.seen && reserve < perception.reserve) {
    takeDamage(perception, tick)
  }

  const opponent = findOpponent(state, model.self.slot)
  if (opponent !== null && (opponent.flags & EntityFlag.Dead) === 0) {
    const sighted = look(perception, world, opponent, tick)
    if (!sighted) listen(perception, opponent, tick, self.origin)
  }

  readThreats(perception, world, state, self)

  perception.reserve = reserve
  perception.previousVelocity[0] = self.velocity[0]
  perception.previousVelocity[1] = self.velocity[1]
  perception.previousVelocity[2] = self.velocity[2]
  perception.seen = true
}

/* --------------------------------------------------------------------------
 * Self
 * ----------------------------------------------------------------------- */

/** Copy the bot's own body out of the world. It knows all of this. */
function readSelf(model: WorldModel, self: EntityState): void {
  const s = model.self
  s.entityId = self.id
  s.alive = (self.flags & EntityFlag.Dead) === 0
  s.origin[0] = self.origin[0]
  s.origin[1] = self.origin[1]
  s.origin[2] = self.origin[2]
  s.velocity[0] = self.velocity[0]
  s.velocity[1] = self.velocity[1]
  s.velocity[2] = self.velocity[2]
  s.angles[0] = self.angles[0]
  s.angles[1] = self.angles[1]
  s.angles[2] = self.angles[2]
  s.health = self.health
  s.armor = self.armor
  s.weapon = self.weapon
  s.onGround = (self.flags & EntityFlag.OnGround) !== 0
  s.knockbackTicks = self.knockbackTicks
  s.nextFireTick = self.nextFireTick
}

/**
 * The other seat's body, or `null`.
 *
 * Found by scanning rather than by `1 - slot`, because "there are exactly two
 * seats" is `match/spawn.ts`'s rule and not this file's, and a bot that assumed
 * it would silently perceive the wrong body the first time it was not true.
 */
function findOpponent(state: GameState, slot: number): EntityState | null {
  for (const entity of state.entities) {
    if (entity.kind !== EntityKind.Player) continue
    if (entity.slot === NO_SLOT || entity.slot === slot) continue
    return entity
  }
  return null
}

/* --------------------------------------------------------------------------
 * Damage
 * ----------------------------------------------------------------------- */

/**
 * A hit landed on the bot: open the alertness window, and take a bearing off
 * the shove if there is one in it.
 *
 * A *bearing*, never a position. The state carries no attacker (`damage.ts`
 * pushes a body and does not record who pushed it), so the honest reading of a
 * hit is the direction it came from, which is what the player's own damage
 * indicator shows. The contact this injects is placed
 * {@link DAMAGE_ASSUMED_RANGE} along that line with an uncertainty of the same
 * size, which is the model saying, in the only unit it has, that it knows the
 * direction and nothing about the range.
 */
function takeDamage(perception: Perception, tick: number): void {
  const model = perception.model
  const contact = model.enemy

  model.alertUntilTick = tick + ALERT_TICKS

  shove[0] = perception.previousVelocity[0] - model.self.velocity[0]
  shove[1] = perception.previousVelocity[1] - model.self.velocity[1]
  const length = Math.sqrt(shove[0] * shove[0] + shove[1] * shove[1])
  if (length < MIN_SHOVE) return

  model.damageBearing[0] = shove[0] / length
  model.damageBearing[1] = shove[1] / length
  model.damageBearing[2] = 0
  model.damageTick = tick

  if (confidenceOf('damage') < contact.confidence) return

  // Borrow the range from a belief that already has one, if it is still worth
  // anything — being shot while you half-know where they are refines the
  // bearing rather than throwing the distance away.
  const bx = contact.origin[0] - model.self.origin[0]
  const by = contact.origin[1] - model.self.origin[1]
  const remembered = contact.source === 'none' ? 0 : Math.sqrt(bx * bx + by * by)
  const range = remembered > 0 ? remembered : DAMAGE_ASSUMED_RANGE

  contact.source = 'damage'
  contact.origin[0] = model.self.origin[0] + model.damageBearing[0] * range
  contact.origin[1] = model.self.origin[1] + model.damageBearing[1] * range
  contact.origin[2] = model.self.origin[2]
  contact.velocity[0] = 0
  contact.velocity[1] = 0
  contact.velocity[2] = 0
  contact.uncertainty = range
  contact.confidence = confidenceOf('damage')
  contact.fresh = true
  contact.lastContactTick = tick
}

/* --------------------------------------------------------------------------
 * Sight
 * ----------------------------------------------------------------------- */

/**
 * Look for the opponent. Returns whether sight has them this tick.
 *
 * The two thresholds — {@link ACQUIRE_VISIBILITY} for a new contact, anything
 * above zero to keep one — are both applied to the same fraction, which is what
 * Quake 3 does not do and is the whole reason its bots see through walls once
 * they have seen you once.
 */
function look(
  perception: Perception,
  world: CollisionWorld,
  opponent: EntityState,
  tick: number,
): boolean {
  const model = perception.model
  const contact = model.enemy

  const fraction = visibilityFraction(
    world,
    eye,
    forward,
    coneCosine(fovDegrees(model)),
    SIGHT_RANGE,
    opponent.origin,
  )
  if (fraction === 0) return false

  const holding =
    contact.lastSeenTick !== NEVER_TICK && tick - contact.lastSeenTick <= SIGHT_HOLD_TICKS
  if (!holding && fraction < ACQUIRE_VISIBILITY) return false

  contact.source = 'sight'
  contact.origin[0] = opponent.origin[0]
  contact.origin[1] = opponent.origin[1]
  contact.origin[2] = opponent.origin[2]
  contact.velocity[0] = opponent.velocity[0]
  contact.velocity[1] = opponent.velocity[1]
  contact.velocity[2] = opponent.velocity[2]
  contact.uncertainty = 0
  contact.confidence = confidenceOf('sight')
  contact.fresh = true
  contact.visible = true
  contact.visibility = fraction
  contact.lastSeenTick = tick
  contact.lastContactTick = tick
  // Read off the silhouette, which is the gate `weapon.ts` says this field
  // exists for. The other gate is a shot going off; see `listen`.
  contact.weapon = opponent.weapon
  contact.weaponTick = tick
  return true
}

/* --------------------------------------------------------------------------
 * Sound
 * ----------------------------------------------------------------------- */

/**
 * Listen for the opponent.
 *
 * A shot is loud and identifies its weapon. Footsteps are quieter, arrive on a
 * cadence rather than continuously, and stop entirely below
 * {@link FOOTSTEP_SPEED} — which is the player's stealth option, and the reason
 * it is a threshold on speed and not a constant `true`.
 *
 * Both gates are tested before `hearContact` is called, because that is where
 * the PRNG is drawn from. See the header.
 */
function listen(
  perception: Perception,
  opponent: EntityState,
  tick: number,
  listener: MutVec3,
): void {
  const contact = perception.model.enemy
  if (confidenceOf('sound') < contact.confidence) return

  const dx = opponent.origin[0] - listener[0]
  const dy = opponent.origin[1] - listener[1]
  const dz = opponent.origin[2] - listener[2]
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)

  if (opponent.lastFireTick === tick && distance <= FIRE_HEARING_RANGE) {
    hearContact(contact, perception.rng, tick, listener, opponent.origin, opponent.weapon)
    return
  }

  if (distance > FOOTSTEP_HEARING_RANGE) return
  if ((opponent.flags & EntityFlag.OnGround) === 0) return
  if (tick % FOOTSTEP_INTERVAL_TICKS !== 0) return

  const speed = Math.sqrt(
    opponent.velocity[0] * opponent.velocity[0] + opponent.velocity[1] * opponent.velocity[1],
  )
  if (speed < FOOTSTEP_SPEED) return

  hearContact(contact, perception.rng, tick, listener, opponent.origin, null)
}

/* --------------------------------------------------------------------------
 * Threats
 * ----------------------------------------------------------------------- */

/**
 * The rockets the bot can see, plus its own.
 *
 * Its own are known without being looked at — you know where you aimed. Anybody
 * else's have to pass the same cone, range and line-of-sight tests a body does,
 * except that a rocket is a point rather than a box, so there is one ray and no
 * fraction.
 *
 * This lives in the perception layer rather than in the dodge (GLAD-HK3ATM)
 * because the alternative is a decision layer reaching into `state.entities`
 * for the list — which is the boundary this whole directory exists to hold, with
 * a hole in it the size of the thing the bot reacts to most.
 */
function readThreats(
  perception: Perception,
  world: CollisionWorld,
  state: GameState,
  self: EntityState,
): void {
  const model = perception.model
  const cosHalf = coneCosine(fovDegrees(model))
  model.threats.length = 0

  for (const entity of state.entities) {
    if (entity.kind !== EntityKind.Projectile) continue
    if (model.threats.length >= MAX_THREATS) break

    const own = entity.ownerId === self.id
    if (!own) {
      const dx = entity.origin[0] - eye[0]
      const dy = entity.origin[1] - eye[1]
      const dz = entity.origin[2] - eye[2]
      if (dx * dx + dy * dy + dz * dz > SIGHT_RANGE * SIGHT_RANGE) continue
      if (!inCone(eye, forward, cosHalf, entity.origin)) continue
      if (!lineOfSight(world, eye, entity.origin)) continue
    }

    const threat = threatSlot(perception, model.threats.length)
    threat.id = entity.id
    threat.origin[0] = entity.origin[0]
    threat.origin[1] = entity.origin[1]
    threat.origin[2] = entity.origin[2]
    threat.velocity[0] = entity.velocity[0]
    threat.velocity[1] = entity.velocity[1]
    threat.velocity[2] = entity.velocity[2]
    threat.own = own
    model.threats.push(threat)
  }
}

/** The `index`th pooled threat record, minted on first use and reused after. */
function threatSlot(perception: Perception, index: number): ThreatContact {
  const existing = perception.threatPool[index]
  if (existing !== undefined) return existing
  const fresh: ThreatContact = { id: 0, origin: vec3(), velocity: vec3(), own: false }
  perception.threatPool.push(fresh)
  return fresh
}
