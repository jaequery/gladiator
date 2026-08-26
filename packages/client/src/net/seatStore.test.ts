/**
 * The seat token's storage, one decision at a time.
 *
 * Every test here is about a *credential*, so they are written as claims about
 * what the store will and will not hand back rather than about round-tripping a
 * string: a seat store that returns the right token is table stakes, and a seat
 * store that returns it to the wrong room is a way to take somebody else's
 * place in a duel.
 */
import { describe, expect, it } from 'vitest'

import { SEAT_KEY, type SeatStorage, createSeatStore } from './seatStore.ts'

/** `sessionStorage`'s shape over a plain object. */
function fakeStorage(seed: Record<string, string> = {}): SeatStorage & { data: typeof seed } {
  const data = { ...seed }
  return {
    data,
    getItem: (key) => data[key] ?? null,
    setItem: (key, value) => {
      data[key] = value
    },
    removeItem: (key) => {
      delete data[key]
    },
  }
}

/** A storage whose every method throws, which is site data blocked by policy. */
const hostile: SeatStorage = {
  getItem() {
    throw new Error('blocked')
  },
  setItem() {
    throw new Error('blocked')
  },
  removeItem() {
    throw new Error('blocked')
  },
}

describe('the seat a reload comes back to', () => {
  it('hands the token back for the room it was minted for', () => {
    const store = createSeatStore(fakeStorage())
    store.remember('ABC123', 'a-bearer-token')
    expect(store.recall('ABC123')).toBe('a-bearer-token')
  })

  it('refuses to hand it to any other room', () => {
    // The whole reason the room is stored beside the token. A code in the
    // address bar is whatever the last link said, and a token proves a seat in
    // one room and nothing at all about another.
    const store = createSeatStore(fakeStorage())
    store.remember('ABC123', 'a-bearer-token')
    expect(store.recall('ZZZ999')).toBeNull()
  })

  it('has nothing to say before a seat has been given out', () => {
    expect(createSeatStore(fakeStorage()).recall('ABC123')).toBeNull()
  })

  it('forgets on request, so a refused seat is not offered again', () => {
    const storage = fakeStorage()
    const store = createSeatStore(storage)
    store.remember('ABC123', 'a-bearer-token')
    store.forget()
    expect(store.recall('ABC123')).toBeNull()
    expect(storage.data[SEAT_KEY]).toBeUndefined()
  })

  it('keeps only the newest seat, because a tab sits in one at a time', () => {
    const store = createSeatStore(fakeStorage())
    store.remember('ABC123', 'first')
    store.remember('DEF456', 'second')
    expect(store.recall('ABC123')).toBeNull()
    expect(store.recall('DEF456')).toBe('second')
  })
})

describe('a store that cannot be read', () => {
  it('dials without a token rather than taking the page down', () => {
    // Private browsing, blocked site data, a policy. All that is lost is
    // surviving a reload, which is exactly the behaviour that predates this
    // file — and a match is not worth a white screen.
    for (const storage of [null, hostile]) {
      const store = createSeatStore(storage)
      expect(() => store.remember('ABC123', 'a-bearer-token')).not.toThrow()
      expect(store.recall('ABC123')).toBeNull()
      expect(() => store.forget()).not.toThrow()
    }
  })

  it('ignores anything in the slot that is not a seat', () => {
    // Another build's shape, a half-written value, or somebody's console. None
    // of them is a token, and guessing at one would put junk on the wire.
    for (const junk of ['', 'null', '{', '[]', '{"room":"ABC123"}', '{"token":"t"}', '7']) {
      const store = createSeatStore(fakeStorage({ [SEAT_KEY]: junk }))
      expect(store.recall('ABC123'), junk).toBeNull()
    }
  })
})
