/**
 * Frame pacing, measured rather than felt.
 *
 * The number a frame counter reports is an average, and an average is exactly
 * the statistic that hides the thing players notice. A frame graph that runs at
 * 144 fps and drops one 30 ms frame every two seconds averages 142 fps — and
 * stutters visibly twice a second. So this module reports the distribution, and
 * the gate below is written against the distribution.
 *
 * ## Why p99 alone is not enough
 *
 * It is tempting to write the whole gate as "p99 under budget", and it does not
 * work, for a reason worth doing the arithmetic for once:
 *
 *     30 s at 144 fps            = 4320 frames
 *     one hitch every two seconds =   15 frames
 *     the top 1% of 4320         =   43 frames
 *
 * Fifteen hitches fit inside the top 43, so they sit *above* p99 and the
 * percentile reports a perfectly healthy 6.9 ms. The hitches are rarer than the
 * percentile can see.
 *
 * So the verdict has two halves, and they catch different failures:
 *
 *   - **p99 under budget** catches sustained slowness — a scene that is simply
 *     too expensive, where most frames miss.
 *   - **hitch rate under tolerance** catches the pathological case above — rare
 *     stalls that a percentile averages away. A hitch is a frame that took more
 *     than {@link HITCH_FACTOR} times the budget; the tolerance is a rate, not
 *     a count, so a single garbage-collection pause in a long run does not fail
 *     a build while a rhythm of them does.
 *
 * `frameStats.test.ts` runs the ticket's own example through it and asserts it
 * fails — and asserts that a mean-based check would have passed it.
 */

/**
 * The shipping frame budget, in milliseconds: one 60 Hz frame.
 *
 * Not 1/144: this is the *ceiling* a 99th-percentile frame has to stay under
 * for the game to feel smooth on ordinary hardware, and it is what the quality
 * controller steps the pixel ratio down to defend. A 144 Hz display simply
 * spends most of it idle.
 */
export const FRAME_BUDGET_MS = 1000 / 60

/**
 * How many times the budget a frame has to take before it counts as a hitch.
 *
 * 1.5. Strictly, *any* frame over the budget has missed a refresh — but a
 * display running at exactly its budget jitters either side of it, and counting
 * that as a hitch would fail every honest 60 Hz machine. Half again is past the
 * jitter and unambiguously a dropped frame: 25 ms against a 16.7 ms budget
 * misses one refresh at 60 Hz and three at 144 Hz.
 */
export const HITCH_FACTOR = 1.5

/**
 * Hitches per second the verdict tolerates.
 *
 * 0.2 is one every five seconds. The pathological case this module exists for
 * is one every two seconds (0.5/s) and fails; a lone stall in a 30 second run
 * is 0.033/s and does not, because failing a build for one garbage collection
 * teaches everyone to ignore the gate.
 */
export const MAX_HITCHES_PER_SECOND = 0.2

/** How many intervals to keep. 8192 at 144 fps is just under a minute. */
export const DEFAULT_CAPACITY = 8192

export type FrameStats = {
  /** Intervals recorded — one fewer than the number of frames drawn. */
  readonly frames: number
  /** Wall-clock the intervals span, in milliseconds. */
  readonly spanMs: number
  readonly meanMs: number
  readonly medianMs: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly worstMs: number
}

export type FrameVerdict = {
  readonly ok: boolean
  readonly budgetMs: number
  readonly p99Ms: number
  /** Frames slower than `budgetMs * HITCH_FACTOR`. */
  readonly hitches: number
  readonly hitchesPerSecond: number
  /** One line, already written for a human. */
  readonly reason: string
}

export type FrameMeter = {
  /** Record one frame-to-frame interval, in milliseconds. */
  record(intervalMs: number): void
  stats(): FrameStats
  /**
   * The intervals currently in the window, oldest-first-ish.
   *
   * Handed out rather than kept, because the hitch count in
   * {@link frameVerdict} is not derivable from percentiles and the meter has no
   * business knowing what a budget is.
   */
  intervals(): readonly number[]
  /** Forget everything measured so far. */
  reset(): void
}

const EMPTY_STATS: FrameStats = {
  frames: 0,
  spanMs: 0,
  meanMs: 0,
  medianMs: 0,
  p95Ms: 0,
  p99Ms: 0,
  worstMs: 0,
}

/**
 * The `q`-quantile of an ascending array, by nearest rank.
 *
 * Nearest rank rather than an interpolating definition because the value has to
 * be a frame that actually happened: "the 99th percentile frame took 31 ms" is
 * a claim about a frame, and a number interpolated between two frames is a
 * claim about neither.
 */
export function percentile(ascending: ArrayLike<number>, q: number): number {
  if (ascending.length === 0) return 0
  const rank = Math.ceil(q * ascending.length)
  const index = rank < 1 ? 0 : rank > ascending.length ? ascending.length - 1 : rank - 1
  return ascending[index] ?? 0
}

/** The summary of an already-sorted window. Allocates one object and nothing else. */
function statsFromSorted(ascending: ArrayLike<number>): FrameStats {
  if (ascending.length === 0) return EMPTY_STATS
  let total = 0
  for (let i = 0; i < ascending.length; i += 1) total += ascending[i] ?? 0
  return {
    frames: ascending.length,
    spanMs: total,
    meanMs: total / ascending.length,
    medianMs: percentile(ascending, 0.5),
    p95Ms: percentile(ascending, 0.95),
    p99Ms: percentile(ascending, 0.99),
    worstMs: ascending[ascending.length - 1] ?? 0,
  }
}

/** Summarise a set of frame intervals. Exported so tests can drive it directly. */
export function summarise(intervalsMs: readonly number[]): FrameStats {
  return statsFromSorted([...intervalsMs].sort((a, b) => a - b))
}

/**
 * Judge a set of intervals against a budget.
 *
 * Takes the intervals rather than a {@link FrameStats} because the hitch count
 * is not derivable from percentiles — see the header.
 */
export function frameVerdict(intervalsMs: readonly number[], budgetMs: number): FrameVerdict {
  const stats = summarise(intervalsMs)
  const hitchMs = budgetMs * HITCH_FACTOR
  let hitches = 0
  for (const interval of intervalsMs) if (interval > hitchMs) hitches += 1
  const seconds = stats.spanMs / 1000
  const hitchesPerSecond = seconds > 0 ? hitches / seconds : 0

  const slow = stats.p99Ms > budgetMs
  const hitching = hitchesPerSecond > MAX_HITCHES_PER_SECOND
  const reason = slow
    ? `p99 frame interval ${stats.p99Ms.toFixed(1)} ms is over the ${budgetMs.toFixed(1)} ms budget`
    : hitching
      ? `${hitches} hitches over ${hitchMs.toFixed(1)} ms in ${seconds.toFixed(1)} s — ${hitchesPerSecond.toFixed(2)}/s, over the ${MAX_HITCHES_PER_SECOND}/s tolerance`
      : `p99 ${stats.p99Ms.toFixed(1)} ms under ${budgetMs.toFixed(1)} ms, ${hitches} hitches in ${seconds.toFixed(1)} s`

  return {
    ok: !slow && !hitching,
    budgetMs,
    p99Ms: stats.p99Ms,
    hitches,
    hitchesPerSecond,
    reason,
  }
}

/**
 * A rolling window of frame intervals.
 *
 * A ring buffer, so a session that runs for an hour costs what a session that
 * runs for a minute costs. Sorting happens in {@link FrameMeter.stats}, which
 * is called by the HUD and the quality controller a few times a second — never
 * in {@link FrameMeter.record}, which is called every frame.
 */
export function createFrameMeter(capacity: number = DEFAULT_CAPACITY): FrameMeter {
  const intervals = new Float64Array(capacity)
  // Sorted into, never allocated. `stats()` is called ten times a second by the
  // HUD, and a fresh eight-thousand-element array each time is a megabyte a
  // second of garbage — which shows up as exactly the hitches this module
  // exists to report. A frame-pacing instrument that costs frames is worse than
  // no instrument.
  const sorted = new Float64Array(capacity)
  let count = 0
  let next = 0

  /** How many of the ring's slots hold a real interval. Order does not matter. */
  const size = () => (count < capacity ? count : capacity)

  return {
    record(intervalMs) {
      // A zero or negative interval is a clock that went backwards or two
      // frames in one millisecond; neither is a frame, and averaging them in
      // would flatter the result.
      if (!(intervalMs > 0)) return
      intervals[next] = intervalMs
      next = (next + 1) % capacity
      count += 1
    },

    stats() {
      const used = size()
      const window = sorted.subarray(0, used)
      window.set(intervals.subarray(0, used))
      // `TypedArray.sort` is numeric by default, so there is no comparator
      // closure to allocate either.
      window.sort()
      return statsFromSorted(window)
    },

    intervals() {
      const used = size()
      const out: number[] = new Array(used)
      for (let i = 0; i < used; i += 1) out[i] = intervals[i] ?? 0
      return out
    },

    reset() {
      count = 0
      next = 0
    },
  }
}

/** {@link frameVerdict} over a meter's current window. */
export function meterVerdict(meter: FrameMeter, budgetMs: number): FrameVerdict {
  return frameVerdict(meter.intervals(), budgetMs)
}
