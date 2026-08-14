/**
 * How late does this machine actually wake us up?
 *
 * The simulation runs at 125 Hz, so the server has 8 ms to be woken, do a
 * tick's work and go back to sleep. Node's timers are not a real-time
 * scheduler: they are "no earlier than", and on a shared-CPU cloud instance
 * competing for a hyperthread they can be very much later than. A p99 wakeup
 * lateness above a tick means the server's idea of "now" lurches, which shows
 * up to players as the world stuttering — and it is invisible on a developer's
 * idle laptop.
 *
 * This measures it, on whatever machine it is running on, and the number is
 * logged at boot and served from `/healthz`. That is deliberately not the same
 * thing as the tick scheduler, which is GLAD-FHKBN8: this is an instrument, and
 * keeping it separate means the scheduler can be rewritten without losing the
 * baseline it was measured against.
 */
import { TICK_INTERVAL_MS } from '@gladiator/sim'

/** Samples kept for the percentiles. At 125 Hz, about a minute of history. */
const HISTORY = 8192

export type JitterSnapshot = {
  readonly intervalMs: number
  readonly samples: number
  readonly meanMs: number
  readonly p50Ms: number
  readonly p99Ms: number
  readonly maxMs: number
}

export type JitterProbe = {
  start(): void
  stop(): void
  snapshot(): JitterSnapshot
  /** One line, for the boot log. */
  describe(): string
}

/**
 * The `p`th percentile of an already-sorted array, by nearest rank.
 *
 * Nearest rank rather than interpolation: with 8192 samples the difference is
 * noise, and "the p99 is a wakeup that actually happened" is easier to reason
 * about when a number looks wrong.
 */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  const rank = Math.ceil((p / 100) * sorted.length)
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1))
  return sorted[index] ?? 0
}

export type JitterOptions = {
  readonly intervalMs?: number
  /** Overridden by the tests. */
  readonly now?: () => number
  readonly schedule?: (fn: () => void, delayMs: number) => NodeJS.Timeout
  readonly cancel?: (handle: NodeJS.Timeout) => void
}

export function createJitterProbe(options: JitterOptions = {}): JitterProbe {
  const intervalMs = options.intervalMs ?? TICK_INTERVAL_MS
  const now = options.now ?? (() => performance.now())
  const schedule = options.schedule ?? ((fn, delayMs) => setTimeout(fn, delayMs))
  const cancel = options.cancel ?? ((handle: NodeJS.Timeout) => clearTimeout(handle))

  const history = new Float64Array(HISTORY)
  let count = 0
  let total = 0
  let max = 0
  let handle: NodeJS.Timeout | null = null
  let deadline = 0

  const wake = () => {
    const lateness = now() - deadline
    // Only lateness is interesting: a timer that fires early is a clock going
    // backwards, and clamping keeps one of those from poisoning the mean.
    const sample = lateness > 0 ? lateness : 0
    history[count % HISTORY] = sample
    count += 1
    total += sample
    if (sample > max) max = sample

    // Absolute deadlines, not `setTimeout(interval)`: relative scheduling adds
    // each wakeup's lateness to the next one, so the measurement would drift
    // away from the thing it is measuring.
    deadline += intervalMs
    const delay = deadline - now()
    handle = schedule(wake, delay > 0 ? delay : 0)
  }

  const takeSnapshot = (): JitterSnapshot => {
    const kept = Math.min(count, HISTORY)
    const sorted = Array.from(history.subarray(0, kept)).sort((a, b) => a - b)
    return {
      intervalMs,
      samples: count,
      meanMs: count === 0 ? 0 : total / count,
      p50Ms: percentile(sorted, 50),
      p99Ms: percentile(sorted, 99),
      maxMs: max,
    }
  }

  return {
    start() {
      if (handle !== null) return
      deadline = now() + intervalMs
      handle = schedule(wake, intervalMs)
    },

    stop() {
      if (handle === null) return
      cancel(handle)
      handle = null
    },

    snapshot: takeSnapshot,

    describe() {
      const snapshot = takeSnapshot()
      const round = (value: number) => value.toFixed(3)
      return (
        `wakeup jitter over ${snapshot.samples} wakeups at ${snapshot.intervalMs} ms: ` +
        `p50 ${round(snapshot.p50Ms)} ms, p99 ${round(snapshot.p99Ms)} ms, ` +
        `max ${round(snapshot.maxMs)} ms, mean ${round(snapshot.meanMs)} ms`
      )
    },
  }
}
