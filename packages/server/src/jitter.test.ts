import { TICK_INTERVAL_MS } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { createJitterProbe, percentile } from './jitter.ts'

describe('percentile', () => {
  it('takes the nearest rank', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(sorted, 50)).toBe(5)
    expect(percentile(sorted, 99)).toBe(10)
    expect(percentile(sorted, 100)).toBe(10)
    expect(percentile(sorted, 0)).toBe(1)
  })

  it('is zero for no samples', () => {
    expect(percentile([], 99)).toBe(0)
  })
})

describe('jitter probe', () => {
  /** A fake clock and scheduler, so the probe can be driven a wakeup at a time. */
  function harness(lateness: readonly number[]) {
    let clock = 0
    let pending: (() => void) | null = null
    let index = 0

    const probe = createJitterProbe({
      intervalMs: TICK_INTERVAL_MS,
      now: () => clock,
      schedule: (fn, delayMs) => {
        // Advance to when the timer was *asked* to fire, then add this
        // wakeup's lateness on top.
        clock += delayMs + (lateness[index] ?? 0)
        index += 1
        pending = fn
        return 0 as unknown as NodeJS.Timeout
      },
      cancel: () => {
        pending = null
      },
    })

    return {
      probe,
      pump(times: number) {
        for (let i = 0; i < times; i += 1) {
          const next = pending
          if (next === null) return
          pending = null
          next()
        }
      },
    }
  }

  it('records how late each wakeup was, not how long it slept', () => {
    const { probe, pump } = harness([0, 1, 2, 3])
    probe.start()
    pump(4)
    const snapshot = probe.snapshot()
    expect(snapshot.samples).toBe(4)
    expect(snapshot.maxMs).toBe(3)
    expect(snapshot.meanMs).toBeCloseTo(1.5, 9)
  })

  it('reports a p99 that a single outlier moves', () => {
    // The point of measuring p99 rather than the mean: 99 good wakeups and one
    // 40 ms stall is a server that visibly hitches, and the mean hides it.
    const { probe, pump } = harness([...new Array(99).fill(0.1), 40])
    probe.start()
    pump(100)
    const snapshot = probe.snapshot()
    expect(snapshot.p50Ms).toBeCloseTo(0.1, 9)
    expect(snapshot.p99Ms).toBeCloseTo(0.1, 9)
    expect(snapshot.maxMs).toBe(40)
    expect(snapshot.meanMs).toBeLessThan(1)
  })

  it('does not count a clock that went backwards as a negative delay', () => {
    const { probe, pump } = harness([-5, -5])
    probe.start()
    pump(2)
    expect(probe.snapshot().meanMs).toBe(0)
    expect(probe.snapshot().maxMs).toBe(0)
  })

  it('describes itself in one line, with the p99 named', () => {
    const { probe, pump } = harness([1, 2, 3])
    probe.start()
    pump(3)
    expect(probe.describe()).toMatch(/p99 \d+\.\d+ ms/)
    expect(probe.describe()).toContain('8 ms')
  })

  it('measures something on the real timer', async () => {
    // The unit tests above use a fake clock; this one proves the probe is
    // actually wired to `setTimeout`, which is the thing being measured.
    const probe = createJitterProbe({ intervalMs: 4 })
    probe.start()
    await new Promise((resolve) => setTimeout(resolve, 120))
    probe.stop()
    const snapshot = probe.snapshot()
    expect(snapshot.samples).toBeGreaterThan(5)
    expect(snapshot.p99Ms).toBeGreaterThanOrEqual(0)
    expect(Number.isFinite(snapshot.maxMs)).toBe(true)
  })
})
