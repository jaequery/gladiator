/**
 * The three answers a browser can give to `unadjustedMovement`, driven without
 * a browser.
 *
 * Each case below is a real engine's behaviour rather than an invented one, and
 * `docs/browser-support.md` records which engine is which. The point of testing
 * it this way is that the *fallback* is what a player experiences, and the
 * fallback has to be right on an engine this machine may not be able to run.
 */
import { describe, expect, it } from 'vitest'

import { createPointerLock, type LockDocument, type LockTarget } from './pointerLock.ts'

/** A `document` whose lock state and events are ours to drive. */
function fakeDocument() {
  const listeners = new Map<string, Array<() => void>>()
  let element: unknown = null
  return {
    doc: {
      get pointerLockElement() {
        return element
      },
      addEventListener(type: string, listener: () => void) {
        listeners.set(type, [...(listeners.get(type) ?? []), listener])
      },
      removeEventListener(type: string, listener: () => void) {
        listeners.set(type, (listeners.get(type) ?? []).filter((one) => one !== listener))
      },
    } satisfies LockDocument,
    lock(target: unknown) {
      element = target
      for (const listener of listeners.get('pointerlockchange') ?? []) listener()
    },
    unlock() {
      element = null
      for (const listener of listeners.get('pointerlockchange') ?? []) listener()
    },
    fail() {
      for (const listener of listeners.get('pointerlockerror') ?? []) listener()
    },
    count: (type: string) => (listeners.get(type) ?? []).length,
  }
}

/** An element that answers the way `behaviour` says a browser does. */
function fakeElement(behaviour: (options?: { unadjustedMovement?: boolean }) => unknown): LockTarget & {
  readonly calls: Array<{ unadjustedMovement?: boolean } | undefined>
} {
  const calls: Array<{ unadjustedMovement?: boolean } | undefined> = []
  return {
    calls,
    requestPointerLock(options) {
      calls.push(options)
      return behaviour(options)
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('a browser that honours unadjustedMovement — Chromium', () => {
  it('reports raw input once the promise resolves', async () => {
    const element = fakeElement(() => Promise.resolve())
    const { doc } = fakeDocument()
    const pointer = createPointerLock(element, doc)

    expect(pointer.rawInput).toBe('unknown')
    pointer.request()
    await settle()

    expect(pointer.rawInput).toBe('granted')
    expect(pointer.raw).toBe(true)
    expect(element.calls).toEqual([{ unadjustedMovement: true }])
  })
})

describe('a browser that refuses the flag', () => {
  it('takes the lock without it, and says the input is accelerated', async () => {
    const element = fakeElement((options) =>
      options?.unadjustedMovement === true
        ? Promise.reject(new DOMException('unsupported', 'NotSupportedError'))
        : Promise.resolve(),
    )
    const pointer = createPointerLock(element, fakeDocument().doc)

    pointer.request()
    await settle()

    expect(pointer.rawInput).toBe('refused')
    expect(pointer.raw).toBe(false)
    // Asked twice: once with the flag, once without. The second is the one that
    // gets the player into the game.
    expect(element.calls).toEqual([{ unadjustedMovement: true }, undefined])
  })

  it('retries plain whatever the browser called the refusal', async () => {
    // Not only `NotSupportedError`: an engine that rejects for a reason nobody
    // anticipated must still leave the player able to play.
    const element = fakeElement((options) =>
      options === undefined ? Promise.resolve() : Promise.reject(new Error('nope')),
    )
    const pointer = createPointerLock(element, fakeDocument().doc)
    pointer.request()
    await settle()
    expect(pointer.rawInput).toBe('refused')
    expect(element.calls).toHaveLength(2)
  })
})

describe('a browser still on the events-only specification — WebKit', () => {
  it('leaves the verdict unknown rather than claiming raw input', async () => {
    // `requestPointerLock` returns undefined and the options object is ignored.
    // There is no way to learn whether the flag was applied, and guessing that
    // it was is the same bug as guessing that it was not.
    const element = fakeElement(() => undefined)
    const fake = fakeDocument()
    const pointer = createPointerLock(element, fake.doc)

    pointer.request()
    fake.lock(element)
    await settle()

    expect(pointer.locked).toBe(true)
    expect(pointer.rawInput).toBe('unknown')
    expect(pointer.raw).toBe(false)
  })

  it('reports a refusal through the error event, which is its only channel', () => {
    const element = fakeElement(() => undefined)
    const fake = fakeDocument()
    const pointer = createPointerLock(element, fake.doc)
    const reasons: string[] = []
    pointer.onDenied((reason) => reasons.push(reason))

    pointer.request()
    fake.fail()

    expect(reasons).toHaveLength(1)
  })
})

describe('escape, and the lock coming back', () => {
  it('tracks the lock going away and returning without forgetting the verdict', async () => {
    const element = fakeElement(() => Promise.resolve())
    const fake = fakeDocument()
    const pointer = createPointerLock(element, fake.doc)
    const states: boolean[] = []
    pointer.onChange((locked) => states.push(locked))

    pointer.request()
    fake.lock(element)
    await settle()
    expect(pointer.rawInput).toBe('granted')

    // Escape. The browser drops the lock; the raw-input verdict is a property
    // of the *browser*, so it survives — a warning that flickered on every
    // escape would be a warning nobody reads.
    fake.unlock()
    expect(pointer.locked).toBe(false)
    expect(pointer.rawInput).toBe('granted')

    pointer.request()
    fake.lock(element)
    expect(pointer.locked).toBe(true)
    expect(states).toEqual([true, false, true])
  })

  it('says so when a request is refused, rather than failing silently', async () => {
    // Every browser refuses for a moment after the player pressed escape. The
    // only cure is another gesture, so the refusal has to reach the menu.
    const element = fakeElement(() => Promise.reject(new Error('A user gesture is required')))
    const pointer = createPointerLock(element, fakeDocument().doc)
    const reasons: string[] = []
    pointer.onDenied((reason) => reasons.push(reason))

    pointer.request()
    await settle()

    expect(reasons).toEqual(['A user gesture is required'])
  })

  it('lets go of the document when disposed', () => {
    const fake = fakeDocument()
    const pointer = createPointerLock(fakeElement(() => undefined), fake.doc)
    expect(fake.count('pointerlockchange')).toBe(1)
    pointer.dispose()
    expect(fake.count('pointerlockchange')).toBe(0)
    expect(fake.count('pointerlockerror')).toBe(0)
  })
})
