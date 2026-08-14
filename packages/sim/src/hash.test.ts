import { describe, expect, it } from 'vitest'

import { formatHash, hashFloat64, hashInit, hashPlayerState, hashUint32 } from './hash.ts'
import { SPAWN_STATE, type PlayerState } from './pmove.ts'

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

  it('covers every field of the player state', () => {
    const base = hashPlayerState(0, SPAWN_STATE)
    const variants: PlayerState[] = [
      { ...SPAWN_STATE, origin: [1, 0, 0] },
      { ...SPAWN_STATE, origin: [0, 1, 0] },
      { ...SPAWN_STATE, origin: [0, 0, 1] },
      { ...SPAWN_STATE, velocity: [1, 0, 0] },
      { ...SPAWN_STATE, velocity: [0, 1, 0] },
      { ...SPAWN_STATE, velocity: [0, 0, 1] },
      { ...SPAWN_STATE, onGround: false },
    ]
    for (const variant of variants) {
      expect(hashPlayerState(0, variant)).not.toBe(base)
    }
    expect(hashPlayerState(1, SPAWN_STATE)).not.toBe(base)
  })

  it('formats as eight hex digits', () => {
    expect(formatHash(0)).toBe('00000000')
    expect(formatHash(0xdeadbeef)).toBe('deadbeef')
    expect(formatHash(hashPlayerState(0, SPAWN_STATE))).toMatch(/^[0-9a-f]{8}$/)
  })

  it('is a known constant for the spawn state', () => {
    // A golden value. If this changes, either the state shape changed or the
    // digest did — and both are things a reviewer should be made to look at,
    // because every deployed client and server has to agree on it.
    expect(formatHash(hashPlayerState(0, SPAWN_STATE))).toBe('4d210c14')
  })
})
