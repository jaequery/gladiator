import { describe, expect, it, vi } from 'vitest'

import { GESTURE_EVENT, armGesture, type GestureTarget } from './gesture.ts'

/** An element, as far as `armGesture` is concerned. */
function fakeTarget() {
  const listeners = new Map<string, Array<() => void>>()
  const target: GestureTarget = {
    addEventListener(type, listener) {
      const existing = listeners.get(type) ?? []
      existing.push(listener)
      listeners.set(type, existing)
    },
    removeEventListener(type, listener) {
      listeners.set(type, (listeners.get(type) ?? []).filter((each) => each !== listener))
    },
  }
  return {
    target,
    listenerCount: (type: string) => (listeners.get(type) ?? []).length,
    /** One click, delivered the way a browser would. */
    click: () => {
      for (const listener of [...(listeners.get(GESTURE_EVENT) ?? [])]) listener()
    },
  }
}

describe('armGesture', () => {
  /**
   * The acceptance check, and the only thing this file is really about: the
   * context resumes on the *same* gesture that takes pointer lock. Two
   * listeners on two different events is how the first shot ends up silent.
   */
  it('resumes audio and requests pointer lock from one gesture', () => {
    const { target, click, listenerCount } = fakeTarget()
    const resume = vi.fn()
    const requestLock = vi.fn()

    armGesture(target, { resume, requestLock })
    expect(listenerCount(GESTURE_EVENT)).toBe(1)

    click()
    expect(resume).toHaveBeenCalledTimes(1)
    expect(requestLock).toHaveBeenCalledTimes(1)
  })

  it('listens on the click, which is the event pointer lock needs', () => {
    expect(GESTURE_EVENT).toBe('click')
  })

  it('resumes before asking for the lock', () => {
    const { target, click } = fakeTarget()
    const order: string[] = []
    armGesture(target, {
      resume: () => order.push('resume'),
      requestLock: () => order.push('lock'),
    })
    click()
    expect(order).toEqual(['resume', 'lock'])
  })

  it('still takes the lock when resuming throws', () => {
    const { target, click } = fakeTarget()
    const requestLock = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    armGesture(target, {
      resume: () => {
        throw new Error('no audio device')
      },
      requestLock,
    })
    click()

    expect(requestLock).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('still resumes when the lock is refused', () => {
    const { target, click } = fakeTarget()
    const resume = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    armGesture(target, {
      resume,
      requestLock: () => {
        throw new Error('not allowed')
      },
    })
    click()

    expect(resume).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  /**
   * Every click, not just the first: escape drops pointer lock and a
   * backgrounded tab can have its context suspended again, so both calls have
   * to be available on the click that comes after either.
   */
  it('stays armed for every later gesture', () => {
    const { target, click } = fakeTarget()
    const resume = vi.fn()
    const requestLock = vi.fn()
    armGesture(target, { resume, requestLock })

    click()
    click()
    click()
    expect(resume).toHaveBeenCalledTimes(3)
    expect(requestLock).toHaveBeenCalledTimes(3)
  })

  it('unhooks on dispose', () => {
    const { target, click, listenerCount } = fakeTarget()
    const resume = vi.fn()
    const armed = armGesture(target, { resume, requestLock: () => undefined })

    armed.dispose()
    expect(listenerCount(GESTURE_EVENT)).toBe(0)
    click()
    expect(resume).not.toHaveBeenCalled()
  })
})
