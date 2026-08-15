import { describe, expect, it } from 'vitest'

import { manualClock } from './clock.ts'
import { manualScheduler, startHostLoop, systemScheduler } from './loop.ts'

describe('the host loop', () => {
  it('reads the clock once per beat and hands the reading on', () => {
    const clock = manualClock(1000)
    const scheduler = manualScheduler()
    const seen: number[] = []
    const loop = startHostLoop({ scheduler, clock, intervalMs: 20, beat: (nowMs) => seen.push(nowMs) })

    scheduler.beat()
    clock.advance(20)
    scheduler.beat()

    expect(seen).toEqual([1000, 1020])
    expect(loop.beats).toBe(2)
  })

  it('stops', () => {
    const scheduler = manualScheduler()
    const loop = startHostLoop({
      scheduler,
      clock: manualClock(),
      intervalMs: 20,
      beat: () => undefined,
    })
    expect(scheduler.registered).toBe(1)
    loop.stop()
    expect(scheduler.registered).toBe(0)
    scheduler.beat()
    expect(loop.beats).toBe(0)
  })

  it('beats on a real timer, and lets the process exit while it does', async () => {
    // `unref` is the difference between a deploy that shuts down and one that
    // hangs on a housekeeping timer nobody remembers starting.
    const beats: number[] = []
    const loop = startHostLoop({
      scheduler: systemScheduler(),
      clock: manualClock(7),
      intervalMs: 1,
      beat: (nowMs) => beats.push(nowMs),
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    loop.stop()

    expect(beats.length).toBeGreaterThan(2)
    expect(new Set(beats)).toEqual(new Set([7]))
  })
})
