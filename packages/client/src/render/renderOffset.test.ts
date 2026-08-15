/**
 * The render offset, which is the only part of a correction a player is allowed
 * to see happen slowly.
 *
 * Two properties matter and both are asserted here rather than described: it
 * reaches exactly zero at the deadline it was given, and it does so at the same
 * rate whatever the frame rate is. The first is what makes "decaying over
 * 100 ms" a claim a test can check; the second is what stops a 144 Hz monitor
 * and a 60 Hz one from disagreeing about where the camera is.
 */
import { describe, expect, it } from 'vitest'

import { createRenderOffset, withRenderOffset } from './renderOffset.ts'

/** How far from zero the offset is, so a decay can be measured as one number. */
function magnitude(offset: readonly [number, number, number] | readonly number[]): number {
  const [x = 0, y = 0, z = 0] = offset
  return Math.sqrt(x * x + y * y + z * z)
}

describe('the render offset', () => {
  it('reaches exactly zero at the deadline it was given', () => {
    const offset = createRenderOffset()
    offset.push([30, 0, 0], 100)
    expect(offset.active).toBe(true)

    offset.advance(50)
    expect(offset.value[0]).toBeCloseTo(15, 6)
    offset.advance(49)
    expect(offset.value[0]).toBeCloseTo(0.3, 6)

    offset.advance(1)
    expect(offset.value).toEqual([0, 0, 0])
    expect(offset.active).toBe(false)
    expect(offset.remainingMs).toBe(0)
  })

  it('decays at the same rate whatever the frame rate is', () => {
    // The camera is a puppet of simulation state, and a smoothing filter whose
    // output depended on the display's refresh rate would make two players
    // watching the same correction see two different journeys.
    const slow = createRenderOffset()
    const fast = createRenderOffset()
    slow.push([0, 0, 24], 200)
    fast.push([0, 0, 24], 200)

    for (let ms = 0; ms < 96; ms += 16) slow.advance(16)
    for (let ms = 0; ms < 96; ms += 4) fast.advance(4)

    expect(magnitude(fast.value)).toBeCloseTo(magnitude(slow.value), 9)
    expect(magnitude(slow.value)).toBeLessThan(24)
  })

  it('adds a second correction rather than replacing it', () => {
    const offset = createRenderOffset()
    offset.push([10, 0, 0], 100)
    offset.push([0, 6, 0], 100)
    // Two things the camera owes the player. Dropping one would put back
    // exactly the step the offset exists to remove.
    expect(offset.value[0]).toBe(10)
    expect(offset.value[1]).toBe(6)
  })

  it('keeps the longer of two windows', () => {
    // A large correction mid-decay must not be hurried along by a small one
    // landing on top of it: the *speed* of the travel is what a player notices,
    // and shortening the window is what makes it fast.
    const offset = createRenderOffset()
    offset.push([100, 0, 0], 200)
    offset.advance(20)
    offset.push([1, 0, 0], 100)
    expect(offset.remainingMs).toBe(180)
  })

  it('ignores a decay window of nothing', () => {
    // What the two extreme bands ask for: below the noise floor there is
    // nothing to carry, and past a splash radius there is nothing honest to
    // carry it with.
    const offset = createRenderOffset()
    offset.push([500, 0, 0], 0)
    expect(offset.value).toEqual([0, 0, 0])
    expect(offset.active).toBe(false)
  })

  it('is dropped whole by a clear', () => {
    const offset = createRenderOffset()
    offset.push([12, -8, 3], 200)
    offset.clear()
    expect(offset.value).toEqual([0, 0, 0])
    expect(offset.remainingMs).toBe(0)
  })

  it('survives a frame of no elapsed time, and one of a negative', () => {
    const offset = createRenderOffset()
    offset.push([8, 0, 0], 100)
    offset.advance(0)
    offset.advance(-5)
    expect(offset.value[0]).toBe(8)
    expect(offset.remainingMs).toBe(100)
  })

  it('adds itself to an origin without touching either', () => {
    const origin: readonly [number, number, number] = [1, 2, 3]
    const shifted = withRenderOffset(origin, [10, 20, 30])
    expect(shifted).toEqual([11, 22, 33])
    expect(origin).toEqual([1, 2, 3])
  })
})
