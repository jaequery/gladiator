/**
 * The six characters the whole lobby is made of.
 *
 * Two halves. The alphabet is asserted symbol by symbol, because a typo in it
 * mints codes that cannot be typed back in and nothing else would notice. And
 * the guessability arithmetic is *computed here* rather than quoted in a
 * document, so the number in `docs/deploy.md` is a number this suite can be
 * pointed at rather than a claim somebody made once.
 */
import { describe, expect, it } from 'vitest'

import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_BITS,
  ROOM_CODE_LENGTH,
  ROOM_CODE_SPACE,
  expectedGuessSeconds,
  guessProbability,
  mintRoomCode,
  normalizeRoomCode,
} from './roomCode.ts'
import { MAX_ROOMS } from './rooms.ts'

/** A deterministic uint32 source, so a draw is a value a test can name. */
function counter(from = 0): () => number {
  let at = from
  return () => {
    at += 1
    return at - 1
  }
}

describe('the alphabet', () => {
  it('is Crockford base32: 32 symbols with no I, L, O or U', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(32)
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(32)
    for (const banned of ['I', 'L', 'O', 'U']) {
      expect(ROOM_CODE_ALPHABET.includes(banned), `${banned} is ambiguous or worse`).toBe(false)
    }
    // The digits first and then the letters in order, which is what makes the
    // value of a symbol its index rather than a lookup table to get wrong.
    expect(ROOM_CODE_ALPHABET).toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ')
  })

  it('mints six symbols, all of them from the alphabet', () => {
    const code = mintRoomCode(counter(7))
    expect(code).toHaveLength(ROOM_CODE_LENGTH)
    for (const symbol of code) expect(ROOM_CODE_ALPHABET.includes(symbol)).toBe(true)
    // Uniform: 32 divides 2³², so a counter walks the alphabet in order.
    expect(code).toBe('789ABC')
  })

  it('draws uniformly across the whole alphabet', () => {
    // Every symbol reachable, and none reachable twice as often as another —
    // the property `% ROOM_CODE_RADIX` gives for free because the radix is a
    // power of two, and the property a 34-symbol alphabet would quietly lose.
    const seen = new Map<string, number>()
    for (let draw = 0; draw < 32 * 64; draw += 1) {
      const symbol = mintRoomCode(counter(draw))[0] ?? ''
      seen.set(symbol, (seen.get(symbol) ?? 0) + 1)
    }
    expect(seen.size).toBe(32)
    expect([...seen.values()].every((count) => count === 64)).toBe(true)
  })

  it('mints from the platform CSPRNG when nobody supplies one', () => {
    const code = mintRoomCode()
    expect(code).toHaveLength(ROOM_CODE_LENGTH)
    expect(normalizeRoomCode(code)).toBe(code)
  })
})

describe('reading a code back', () => {
  it('takes a code exactly as it was minted', () => {
    expect(normalizeRoomCode('H7K2Q9')).toBe('H7K2Q9')
  })

  it('folds the confusable letters the way Crockford says', () => {
    // The whole reason those four are not in the alphabet: a player reading a
    // code off a screen cannot tell them apart from the digits, so both
    // spellings have to reach the same room.
    expect(normalizeRoomCode('OIL123')).toBe('011123')
    expect(normalizeRoomCode('oil123')).toBe('011123')
  })

  it('drops the separators a chat client or a person adds', () => {
    expect(normalizeRoomCode('h7k-2q9')).toBe('H7K2Q9')
    expect(normalizeRoomCode('H7K 2Q9')).toBe('H7K2Q9')
  })

  it('refuses a U rather than folding it', () => {
    // `U` is not ambiguous with anything — it was removed so that no draw can
    // spell an obscenity — so a `U` in a code is a typo or a guess, and mapping
    // it to something would turn a wrong code into a *different room*.
    expect(normalizeRoomCode('H7KUQ9')).toBeNull()
  })

  it('refuses anything that is not a code', () => {
    for (const junk of ['', 'H7K2Q', 'H7K2Q99', 'H7K2Q!', 'ZZZZZZZZZZZZZZZZZZZZZZ', null, undefined]) {
      expect(normalizeRoomCode(junk), String(junk)).toBeNull()
    }
  })
})

describe('how guessable a code is', () => {
  it('is exactly 30 bits', () => {
    // 32⁶ = 1,073,741,824. Exact, and exactly a power of two, because the
    // alphabet is one — which is also what makes the draw unbiased.
    expect(ROOM_CODE_SPACE).toBe(1_073_741_824)
    expect(ROOM_CODE_BITS).toBe(30)
  })

  it('computes the guess rate at the concurrency this deploy admits', () => {
    // The number `docs/deploy.md` quotes, computed rather than asserted. The
    // machine holds at most `MAX_ROOMS` rooms, so that is the largest target an
    // attacker can ever be shooting at, and a guess costs a WebSocket upgrade.
    const probability = guessProbability(MAX_ROOMS)
    expect(probability).toBeCloseTo(MAX_ROOMS / 1_073_741_824, 12)

    // Ten upgrades a second is a brisk attacker against a single small machine.
    const seconds = expectedGuessSeconds(MAX_ROOMS, 10)
    const days = seconds / 86_400
    expect(days).toBeGreaterThan(5)
    expect(days).toBeLessThan(10)
  })

  it('says a guess can never land when there is nothing to land on', () => {
    expect(guessProbability(0)).toBe(0)
    expect(expectedGuessSeconds(0, 1000)).toBe(Number.POSITIVE_INFINITY)
    expect(expectedGuessSeconds(MAX_ROOMS, 0)).toBe(Number.POSITIVE_INFINITY)
  })
})
