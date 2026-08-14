/**
 * The world, and the canonical encoding of it.
 *
 * `GameState` is a plain object of plain numbers and arrays: no classes, no
 * `Map`, no `Set`. That is not minimalism for its own sake — the state has to
 * be walked in a fixed order by `encodeExact`, cloned cheaply by
 * reconciliation, and eventually bit-packed into a snapshot. Every one of
 * those gets harder the moment iteration order is a property of a container
 * rather than of an array index.
 */

import { writeF64, writeI32, writeU32, writeU8, writtenBytes } from './encoding.ts'
import type { ByteWriter } from './encoding.ts'
import { createWriter, resetWriter } from './encoding.ts'
import { hashBytes } from './hash.ts'
import { vec3 } from './math.ts'
import type { MutVec3 } from './math.ts'
import { seedRng } from './rng.ts'
import type { RngState } from './rng.ts'

/** What an entity is. Numeric so it encodes in one byte. */
export const EntityKind = {
  None: 0,
  Player: 1,
  /** Rockets. Server-authoritative, spawned once; GLAD-0QWRYK and GLAD-5QGO11. */
  Projectile: 2,
} as const

export type EntityKind = (typeof EntityKind)[keyof typeof EntityKind]

/** Per-entity bits. A bitfield so the whole lot encodes in one uint32. */
export const EntityFlag = {
  OnGround: 1 << 0,
  Ducked: 1 << 1,
  Dead: 1 << 2,
} as const

export type EntityFlag = (typeof EntityFlag)[keyof typeof EntityFlag]

/** `slot` for an entity that no player controls. */
export const NO_SLOT = -1

/** `expireTick` for an entity that lives until something kills it. */
export const NEVER_EXPIRES = -1

export type EntityState = {
  /** Unique for the lifetime of the match, never reused. */
  id: number
  kind: EntityKind
  /** The player slot controlling this entity, or `NO_SLOT`. */
  slot: number
  /** `EntityFlag` bits. */
  flags: number
  /** Position in Quake units, Quake frame. */
  origin: MutVec3
  /** Velocity in Quake units per second. */
  velocity: MutVec3
  /**
   * `[pitch, yaw, roll]` in **angle units** — 1/65536 of a turn, the same
   * representation `UserCmd` carries. Integers, so an angle survives the
   * network and the state hash exactly rather than approximately.
   */
  angles: MutVec3
  health: number
  /** The entity that is responsible for this one — a rocket's shooter. */
  ownerId: number
  spawnTick: number
  /** Tick at which the kernel removes this entity, or `NEVER_EXPIRES`. */
  expireTick: number
}

export type GameState = {
  /** Sub-steps simulated so far. The sim's only notion of time. */
  tick: number
  /** The PRNG stream. One uint32; see `rng.ts`. */
  rng: RngState
  /** The id the next spawn will take. Ids are never reused. */
  nextEntityId: number
  /**
   * Every entity, in ascending `id`.
   *
   * The ordering is the canonical one `encodeExact` walks, and it is
   * maintained by `spawnEntity` (ids only increase) and preserved by
   * `removeEntity` (splice, not swap-remove). A swap-remove would be faster
   * and would make the hash depend on removal history — two peers that
   * removed the same entities in a different *order* would disagree.
   */
  entities: EntityState[]
}

/** A fresh, empty world. */
export function createGameState(seed: number): GameState {
  return { tick: 0, rng: seedRng(seed), nextEntityId: 1, entities: [] }
}

/** Everything about a new entity except its identity and its birthday. */
export type EntityInit = {
  kind: EntityKind
  slot?: number
  flags?: number
  origin?: MutVec3
  velocity?: MutVec3
  angles?: MutVec3
  health?: number
  ownerId?: number
  expireTick?: number
}

/** Append an entity. Returns it; ids ascend, so the array stays canonical. */
export function spawnEntity(state: GameState, init: EntityInit): EntityState {
  const entity: EntityState = {
    id: state.nextEntityId,
    kind: init.kind,
    slot: init.slot ?? NO_SLOT,
    flags: init.flags ?? 0,
    origin: init.origin ?? vec3(),
    velocity: init.velocity ?? vec3(),
    angles: init.angles ?? vec3(),
    health: init.health ?? 0,
    ownerId: init.ownerId ?? 0,
    spawnTick: state.tick,
    expireTick: init.expireTick ?? NEVER_EXPIRES,
  }
  state.nextEntityId += 1
  state.entities.push(entity)
  return entity
}

/** Remove an entity by id. Returns whether it was there. */
export function removeEntity(state: GameState, id: number): boolean {
  const index = state.entities.findIndex((entity) => entity.id === id)
  if (index < 0) return false
  state.entities.splice(index, 1)
  return true
}

export function findEntity(state: GameState, id: number): EntityState | null {
  return state.entities.find((entity) => entity.id === id) ?? null
}

/** The player entity for a slot, or `null` if that slot is empty or dead. */
export function findPlayer(state: GameState, slot: number): EntityState | null {
  return (
    state.entities.find(
      (entity) => entity.kind === EntityKind.Player && entity.slot === slot,
    ) ?? null
  )
}

export function cloneEntity(entity: EntityState): EntityState {
  return {
    id: entity.id,
    kind: entity.kind,
    slot: entity.slot,
    flags: entity.flags,
    origin: [entity.origin[0], entity.origin[1], entity.origin[2]],
    velocity: [entity.velocity[0], entity.velocity[1], entity.velocity[2]],
    angles: [entity.angles[0], entity.angles[1], entity.angles[2]],
    health: entity.health,
    ownerId: entity.ownerId,
    spawnTick: entity.spawnTick,
    expireTick: entity.expireTick,
  }
}

/**
 * A deep copy.
 *
 * `tick()` mutates in place, so this is what a caller uses when it needs the
 * old state as well as the new one — a client keeping the pre-prediction state
 * for reconciliation, or a test comparing two runs.
 */
export function cloneGameState(state: GameState): GameState {
  return {
    tick: state.tick,
    rng: state.rng,
    nextEntityId: state.nextEntityId,
    entities: state.entities.map(cloneEntity),
  }
}

/* --------------------------------------------------------------------------
 * Canonical encoding
 * ----------------------------------------------------------------------- */

/**
 * Write a state into a writer in canonical form.
 *
 * "Canonical" means two things, and both are load-bearing:
 *
 * 1. **Fixed order.** Header fields, then every entity in ascending `id`, then
 *    every field of an entity in declaration order. Nothing is skipped when it
 *    happens to be zero, because a variable-length encoding would let two
 *    different states produce the same bytes.
 * 2. **Fixed representation.** Little-endian, explicit widths, floats written
 *    as their raw IEEE 754 bit patterns via `writeF64` — which normalises `-0`
 *    and NaN and rounds nothing. See `encoding.ts` for why each of those
 *    matters.
 *
 * Adding a field to `EntityState` means adding a line here. A field the
 * simulation reads but the encoder does not write is a field a desync can hide
 * in, so this function is worth keeping boringly exhaustive.
 */
export function encodeInto(writer: ByteWriter, state: GameState): void {
  writeU32(writer, state.tick)
  writeU32(writer, state.rng)
  writeU32(writer, state.nextEntityId)
  writeU32(writer, state.entities.length)

  for (const entity of state.entities) {
    writeU32(writer, entity.id)
    writeU8(writer, entity.kind)
    writeI32(writer, entity.slot)
    writeU32(writer, entity.flags)
    writeF64(writer, entity.origin[0])
    writeF64(writer, entity.origin[1])
    writeF64(writer, entity.origin[2])
    writeF64(writer, entity.velocity[0])
    writeF64(writer, entity.velocity[1])
    writeF64(writer, entity.velocity[2])
    writeF64(writer, entity.angles[0])
    writeF64(writer, entity.angles[1])
    writeF64(writer, entity.angles[2])
    writeF64(writer, entity.health)
    writeI32(writer, entity.ownerId)
    writeI32(writer, entity.spawnTick)
    writeI32(writer, entity.expireTick)
  }
}

/** The canonical bytes for a state. Allocates; `encodeInto` does not. */
export function encodeExact(state: GameState): Uint8Array {
  const writer = createWriter(64 + state.entities.length * 128)
  encodeInto(writer, state)
  return writtenBytes(writer).slice()
}

/**
 * A writer reused across `hashState` calls.
 *
 * Module-level mutable scratch is normally a smell, and here it is deliberate:
 * the hash is taken every tick in development builds, and allocating a fresh
 * kilobyte each time is a measurable amount of garbage for a value that is
 * consumed immediately. It is safe because the simulation is single-threaded
 * and synchronous by construction — `await` is a lint error inside this
 * package precisely so that statements like this one stay true.
 */
const hashWriter = createWriter(4096)

/** FNV-1a over the canonical encoding. An unsigned 32-bit integer. */
export function hashState(state: GameState): number {
  resetWriter(hashWriter)
  encodeInto(hashWriter, state)
  return hashBytes(writtenBytes(hashWriter))
}
