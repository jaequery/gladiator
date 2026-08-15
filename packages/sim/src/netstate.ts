/**
 * The whole world, as a flat array of numbers, and back again.
 *
 * `snapshot.ts` says what a snapshot *is* — state rather than an event, so a
 * client that misses one and receives the next has lost nothing. This is how
 * one crosses a wire, and it exists because reconciliation (GLAD-6RT64L) needs
 * something stronger than "enough of the world to draw it".
 *
 * ## Why the whole state, and not just the entities
 *
 * A reconciling client takes the authoritative state, replays its own unacked
 * commands on top, and then compares its hash against the server's for the same
 * tick. That comparison is the project's containment mechanism — the thing that
 * catches a foreign value entering gameplay, including the violations nobody
 * thought to ban (`AGENTS.md`). It only works if the client can reconstruct the
 * server's state *exactly*, and `hashState` walks more than the entity list: the
 * tick, the PRNG stream position, the next entity id, the match phase and clock,
 * and the rules.
 *
 * Leave any one of them out and the client rebuilds a world that is almost the
 * server's. The hashes then disagree on every tick, the canary is permanently
 * red, and the one instrument that would have found a real desync has been
 * turned into noise. So the encoding here is deliberately the *same* walk as
 * `encodeInto` in `state.ts`, field for field and in the same order — adding a
 * field to `EntityState` means adding a line to both, and
 * `netstate.test.ts` fails if the two ever disagree about how many numbers a
 * state is.
 *
 * ## Why numbers rather than objects
 *
 * The protocol is JSON text today (`protocol.ts` explains why), and a double
 * survives `JSON.parse(JSON.stringify(x))` bit for bit. An array of numbers is
 * the shape that stays true when the frame becomes binary: it is already the
 * canonical field order, so the binary encoder is a loop rather than a rewrite.
 *
 * ## Applying, not replacing
 *
 * {@link applyWireState} writes into an existing `GameState` and **reuses the
 * entity objects whose ids it recognises**. That is not a micro-optimisation: a
 * client reconciles several times a second, and replacing every entity object
 * each time would hand the renderer a brand-new opponent to build a rig for on
 * every snapshot. Same reasoning as `match/spawn.ts` reusing a slot's entity
 * across a round boundary.
 */

import { cloneMatchState } from './match/match.ts'
import type { MatchPhase, MatchRules } from './match/match.ts'
import type { SelfDamageMode } from './match/selfDamage.ts'
import { EntityKind } from './state.ts'
import type { EntityState, GameState } from './state.ts'
import { vec3 } from './math.ts'
import type { Weapon } from './weapon.ts'

/**
 * Numbers in front of the entity list: the header `encodeInto` writes, plus the
 * entity count.
 *
 * Sixteen header fields — tick, rng, nextEntityId, the eight of `MatchState`,
 * and the five of `MatchRules` — and then the count.
 */
export const WIRE_HEADER_FIELDS = 17

/** Numbers per entity. One per field of `EntityState`, vectors flattened. */
export const WIRE_ENTITY_FIELDS = 25

/** A state on the wire. Flat, canonical order, integers where the state has them. */
export type WireState = readonly number[]

/** How many numbers a state with `entities` entities encodes to. */
export function wireStateLength(entities: number): number {
  return WIRE_HEADER_FIELDS + entities * WIRE_ENTITY_FIELDS
}

/**
 * Pack a state for the wire.
 *
 * The walk is `state.ts`'s `encodeInto`, in the same order, so the two can be
 * read side by side. Allocates one array; called once per snapshot rather than
 * once per tick.
 */
export function encodeState(state: GameState): number[] {
  const match = state.match
  const rules = match.rules
  const wire: number[] = [
    state.tick,
    state.rng,
    state.nextEntityId,
    match.phase,
    match.round,
    match.wins[0],
    match.wins[1],
    match.phaseStartTick,
    match.phaseEndTick,
    match.lastRoundWinner,
    match.winner,
    rules.selfDamage,
    rules.roundsToWin,
    rules.maxRounds,
    rules.roundTimeLimitTicks,
    rules.intermissionTicks,
    state.entities.length,
  ]

  for (const entity of state.entities) {
    wire.push(
      entity.id,
      entity.kind,
      entity.slot,
      entity.flags,
      entity.origin[0],
      entity.origin[1],
      entity.origin[2],
      entity.velocity[0],
      entity.velocity[1],
      entity.velocity[2],
      entity.angles[0],
      entity.angles[1],
      entity.angles[2],
      entity.health,
      entity.armor,
      entity.weapon,
      entity.lastFireTick,
      entity.knockbackTicks,
      entity.ownerId,
      entity.nextFireTick,
      entity.trBase[0],
      entity.trBase[1],
      entity.trBase[2],
      entity.spawnTick,
      entity.expireTick,
    )
  }

  return wire
}

/**
 * Whether `value` is a wire state this build can read.
 *
 * The door, and the only place a value nobody chose is turned away. Every
 * number has to be finite: a `NaN` origin would poison the state hash and every
 * position downstream of it, and the simulation has no way to reject one — a
 * tick is a total function. Same argument as `sanitizeUserCmd`, pointed at the
 * other direction of traffic.
 */
export function isWireState(value: unknown): value is number[] {
  if (!Array.isArray(value)) return false
  if (value.length < WIRE_HEADER_FIELDS) return false
  const count = value[WIRE_HEADER_FIELDS - 1]
  if (!Number.isInteger(count) || count < 0) return false
  if (value.length !== wireStateLength(count as number)) return false
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return false
  }
  return true
}

/** Read a number that has to be there. Callers have checked the length. */
function at(wire: WireState, index: number): number {
  return wire[index] as number
}

/**
 * Overwrite `target` with the state in `wire`, reusing entity objects by id.
 *
 * Returns `false` and leaves `target` untouched if the wire is not a state this
 * build can read — a caller then has a client that is one deploy behind rather
 * than a world with a hole in it.
 *
 * The rules object is shared with whatever `target` already held when the two
 * agree, so a clone costs no allocation; when they differ the wire wins, which
 * is the server being authoritative about the rules it is running.
 */
export function applyWireState(target: GameState, wire: WireState): boolean {
  if (!isWireState(wire)) return false

  const count = at(wire, WIRE_HEADER_FIELDS - 1)

  // Existing entities, by id, so a snapshot reuses the object the renderer is
  // already keyed on. Built before anything is written, because the array is
  // about to be rebuilt in the wire's (canonical) order.
  const existing = new Map<number, EntityState>()
  for (const entity of target.entities) existing.set(entity.id, entity)

  target.tick = at(wire, 0)
  target.rng = at(wire, 1)
  target.nextEntityId = at(wire, 2)

  const match = target.match
  match.phase = at(wire, 3) as MatchPhase
  match.round = at(wire, 4)
  match.wins[0] = at(wire, 5)
  match.wins[1] = at(wire, 6)
  match.phaseStartTick = at(wire, 7)
  match.phaseEndTick = at(wire, 8)
  match.lastRoundWinner = at(wire, 9)
  match.winner = at(wire, 10)

  const rules: MatchRules = {
    selfDamage: at(wire, 11) as SelfDamageMode,
    roundsToWin: at(wire, 12),
    maxRounds: at(wire, 13),
    roundTimeLimitTicks: at(wire, 14),
    intermissionTicks: at(wire, 15),
  }
  match.rules = sameRules(match.rules, rules) ? match.rules : rules

  target.entities.length = 0
  for (let i = 0; i < count; i += 1) {
    const base = WIRE_HEADER_FIELDS + i * WIRE_ENTITY_FIELDS
    const id = at(wire, base)
    const entity = existing.get(id) ?? blankEntity(id)
    entity.kind = at(wire, base + 1) as EntityKind
    entity.slot = at(wire, base + 2)
    entity.flags = at(wire, base + 3)
    entity.origin[0] = at(wire, base + 4)
    entity.origin[1] = at(wire, base + 5)
    entity.origin[2] = at(wire, base + 6)
    entity.velocity[0] = at(wire, base + 7)
    entity.velocity[1] = at(wire, base + 8)
    entity.velocity[2] = at(wire, base + 9)
    entity.angles[0] = at(wire, base + 10)
    entity.angles[1] = at(wire, base + 11)
    entity.angles[2] = at(wire, base + 12)
    entity.health = at(wire, base + 13)
    entity.armor = at(wire, base + 14)
    entity.weapon = at(wire, base + 15) as Weapon
    entity.lastFireTick = at(wire, base + 16)
    entity.knockbackTicks = at(wire, base + 17)
    entity.ownerId = at(wire, base + 18)
    entity.nextFireTick = at(wire, base + 19)
    entity.trBase[0] = at(wire, base + 20)
    entity.trBase[1] = at(wire, base + 21)
    entity.trBase[2] = at(wire, base + 22)
    entity.spawnTick = at(wire, base + 23)
    entity.expireTick = at(wire, base + 24)
    target.entities.push(entity)
  }

  return true
}

/**
 * A copy of `source` with `wire` applied — for a caller that wants the
 * authoritative world without giving up the one it already has.
 */
export function decodeState(source: GameState, wire: WireState): GameState | null {
  const target: GameState = {
    tick: source.tick,
    rng: source.rng,
    match: cloneMatchState(source.match),
    nextEntityId: source.nextEntityId,
    entities: [],
  }
  return applyWireState(target, wire) ? target : null
}

/** Field-for-field equality, so an unchanged rules object is kept rather than replaced. */
function sameRules(a: MatchRules, b: MatchRules): boolean {
  return (
    a.selfDamage === b.selfDamage &&
    a.roundsToWin === b.roundsToWin &&
    a.maxRounds === b.maxRounds &&
    a.roundTimeLimitTicks === b.roundTimeLimitTicks &&
    a.intermissionTicks === b.intermissionTicks
  )
}

/** An entity with an id and nothing else. Every field is written before it is read. */
function blankEntity(id: number): EntityState {
  return {
    id,
    kind: EntityKind.None,
    slot: 0,
    flags: 0,
    origin: vec3(),
    velocity: vec3(),
    angles: vec3(),
    health: 0,
    armor: 0,
    weapon: 0 as Weapon,
    lastFireTick: 0,
    knockbackTicks: 0,
    ownerId: 0,
    nextFireTick: 0,
    trBase: vec3(),
    spawnTick: 0,
    expireTick: 0,
  }
}
