import { describe, expect, it } from 'vitest'

import { formatHash, hashFloat64, hashInit, hashUint32 } from './hash.ts'
import { vec3 } from './math.ts'
import {
  EntityFlag,
  EntityKind,
  createGameState,
  hashState,
  spawnEntity,
} from './state.ts'
import type { EntityState, GameState } from './state.ts'
import { Weapon } from './weapon.ts'

describe('state hash', () => {
  it('separates values that differ in the last bit', () => {
    const a = 1
    const b = 1 + Number.EPSILON
    expect(a).not.toBe(b)
    expect(hashFloat64(hashInit(), a)).not.toBe(hashFloat64(hashInit(), b))
  })

  it('folds -0 to +0, so two peers at rest agree', () => {
    // Reaching zero from the left and from the right must not read as a desync.
    expect(hashFloat64(hashInit(), -0)).toBe(hashFloat64(hashInit(), 0))
  })

  it('is order-sensitive, so a swapped x and y is a mismatch', () => {
    const xy = hashFloat64(hashFloat64(hashInit(), 3), 4)
    const yx = hashFloat64(hashFloat64(hashInit(), 4), 3)
    expect(xy).not.toBe(yx)
  })

  it('stays inside uint32', () => {
    let digest = hashInit()
    for (let i = 0; i < 1000; i += 1) {
      digest = hashUint32(digest, i)
      expect(digest).toBe(digest >>> 0)
      expect(Number.isInteger(digest)).toBe(true)
    }
  })

  it('covers every field of an entity', () => {
    // A field the simulation reads but `encodeInto` does not write is a field a
    // desync can hide in, so this walks the whole shape rather than the fields
    // that happen to move today.
    const base = hashState(oneStandingPlayer())

    const mutations: ((entity: EntityState) => void)[] = [
      (e) => (e.kind = EntityKind.Projectile),
      (e) => (e.slot = 1),
      (e) => (e.flags |= EntityFlag.JumpHeld),
      (e) => (e.origin[0] = 1),
      (e) => (e.origin[1] = 1),
      (e) => (e.origin[2] = 1),
      (e) => (e.velocity[0] = 1),
      (e) => (e.velocity[1] = 1),
      (e) => (e.velocity[2] = 1),
      (e) => (e.angles[0] = 1),
      (e) => (e.angles[1] = 1),
      (e) => (e.angles[2] = 1),
      (e) => (e.health = 99),
      (e) => (e.weapon = Weapon.Railgun),
      (e) => (e.lastFireTick = 0),
      (e) => (e.knockbackTicks = 1),
      (e) => (e.ownerId = 7),
      (e) => (e.spawnTick = 1),
      (e) => (e.expireTick = 1),
    ]

    for (const mutate of mutations) {
      const state = oneStandingPlayer()
      const entity = state.entities[0]
      if (entity === undefined) throw new Error('no entity to mutate')
      mutate(entity)
      expect(hashState(state)).not.toBe(base)
    }

    const later = oneStandingPlayer()
    later.tick = 1
    expect(hashState(later)).not.toBe(base)
  })

  it('formats as eight hex digits', () => {
    expect(formatHash(0)).toBe('00000000')
    expect(formatHash(0xdeadbeef)).toBe('deadbeef')
    expect(formatHash(hashState(oneStandingPlayer()))).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is a known constant for one player standing at the origin', () => {
    // A golden value. If this changes, either the state shape changed or the
    // digest did — and both are things a reviewer should be made to look at,
    // because every deployed client and server has to agree on it.
    expect(formatHash(hashState(oneStandingPlayer()))).toBe('f7719557')
  })
})

/** One player, on the ground, at the middle of the arena, at tick 0. */
function oneStandingPlayer(): GameState {
  const state = createGameState(1)
  spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    flags: EntityFlag.OnGround,
    origin: vec3(0, 0, 0),
    health: 100,
  })
  return state
}
