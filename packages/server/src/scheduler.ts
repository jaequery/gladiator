/**
 * The tick scheduler: the thing that decides when the world moves.
 *
 * A `Room` holds no timer (`room.ts`), and `loop.ts` is the seam that says so.
 * This is the module on the other side of that seam on the server: one timer
 * for the whole process, waking about sixty times a second, folding the
 * wall-clock that actually elapsed into a whole number of exact 8.000 ms
 * sub-steps, and telling every room how many to run.
 *
 * ## Drift correction: aim at the next boundary, do not sleep an interval
 *
 * `setInterval(f, 16)` does not fire every 16 ms. It fires *no sooner* than
 * 16 ms after the last one was dispatched, so every millisecond of lateness is
 * added to the next period and kept forever. Twenty milliseconds of accumulated
 * slip per second is a server whose tick counter runs 2% slow, which is a
 * client's clock estimate walking away from it all match.
 *
 * So the deadlines are absolute — frame *n* is aimed at `start + n × frameMs` —
 * and the sleep is `deadline − now`. A wakeup that was 3 ms late sleeps 13 ms
 * and the next boundary lands where it always would have. The lateness is
 * measured rather than assumed, because it is the number that decides whether
 * the machine class is fit to serve players at all: see {@link WAKEUP_BUDGET_MS}.
 *
 * ## Never spiral
 *
 * Two separate things could turn a hitch into a hang, and both are refused.
 *
 * The first is simulating the hitch. The delta is *measured* and then clamped
 * by `clampHostDelta` to `MAX_HOST_FRAME_MS`, so a 3-second stall buys 250 ms
 * of simulation — 31 sub-steps, once — and the rest is thrown away and counted.
 * Throwing simulated time away is policy and the kernel deliberately refuses to
 * do it (`kernel.ts`); this is the layer that owns the decision, and the layer
 * whose room can tell the peers about it through the tick number in the next
 * ping.
 *
 * The second is chasing the missed boundaries. After a 250 ms stall the aim
 * point is fifteen frames in the past, and marching `deadline += frameMs`
 * fifteen times produces fifteen back-to-back wakeups, each measuring ~0 ms of
 * elapsed time and therefore running no sub-steps at all — pure CPU burnt at the
 * worst possible moment. When the aim point has fallen a whole frame behind,
 * this **re-aims** at `now + frameMs` and counts a resync. Drift correction is
 * for milliseconds; a quarter of a second is not drift, it is an event.
 *
 * ## The frame rate, and why 16 rather than 16.667
 *
 * `HOST_FRAME_MS` is 16, which is 62.5 Hz. Two reasons, and the second is the
 * one that matters. Node's timers have millisecond granularity, so 16.667 is a
 * number this scheduler cannot ask for and would only round. And 16 is exactly
 * two ticks: a frame that arrives on time runs exactly two sub-steps and carries
 * a remainder of exactly zero, forever, because both numbers are powers of two
 * and the arithmetic is exact in IEEE 754. The accumulator exists for the frames
 * that *are* late, which is the point of measuring how often that is.
 */
import { MAX_HOST_FRAME_MS, TICK_INTERVAL_MS, clampHostDelta } from '@gladiator/sim'

import type { Clock } from './clock.ts'
import { createSampleLog } from './jitter.ts'
import type { Cancel } from './loop.ts'

/**
 * Milliseconds between host frames. See the header for why it is 16 and not
 * 16.667.
 */
export const HOST_FRAME_MS = 16

/**
 * The budget for p99 wakeup lateness, in milliseconds.
 *
 * One tick. The reasoning is the whole of why this number is written down
 * rather than assumed: a wakeup that is late by less than a tick still lands in
 * the same 8 ms bucket the world was going to be advanced through, so the
 * *simulation* does not notice — the accumulator hands the missing milliseconds
 * to the next frame and the tick count over any second is unchanged. Past one
 * tick, one wakeup in a hundred is a whole sub-step behind where it believed it
 * was, and the snapshots that frame produces are a tick stale for everyone in
 * every room on the machine.
 *
 * It is a p99 rather than a maximum because a maximum on a shared vCPU measures
 * the worst steal event in the sample window and nothing else, and a budget you
 * blow on one 40 ms scheduling hiccough an hour is a budget nobody can act on.
 *
 * Measured on the machine class that actually serves players — `fly.toml` says
 * `shared-cpu-1x` — by `measure-jitter.ts`, logged at boot, and served live from
 * `/healthz`. `docs/deploy.md` records the numbers and what to do when they are
 * over.
 */
export const WAKEUP_BUDGET_MS = TICK_INTERVAL_MS

/**
 * A one-shot timer, injected.
 *
 * Separate from `loop.ts`'s interval-based {@link Scheduler} because drift
 * correction needs a *different delay every time*: the whole trick is that the
 * sleep is computed from how late the last wakeup was, and an interval cannot
 * express that.
 */
export type Timer = {
  after(delayMs: number, fire: () => void): Cancel
}

/**
 * The real one.
 *
 * `unref` where it exists, for the same reason `loop.ts` does it: a server that
 * will not exit because a tick is pending is a deploy that hangs. Typed through
 * `ReturnType<typeof setTimeout>` rather than `NodeJS.Timeout`, because this
 * module is also reachable from the client's listen server, which typechecks
 * with no `@types/node` at all.
 */
export function systemTimer(): Timer {
  return {
    after(delayMs: number, fire: () => void): Cancel {
      const handle = setTimeout(fire, delayMs)
      const timer = handle as unknown as { unref?: () => void }
      timer.unref?.()
      return () => clearTimeout(handle)
    },
  }
}

export type ManualTimer = Timer & {
  /** Fire the pending callback, if there is one. */
  fire(): void
  /** The delay the scheduler last asked for, or `null` if nothing is pending. */
  readonly delayMs: number | null
  readonly pending: boolean
}

/**
 * A timer that only fires when a test says so.
 *
 * Holds exactly one callback, which is all a drift-corrected loop ever has
 * outstanding, and remembers the delay it was asked for — which is the thing
 * worth asserting about a scheduler that aims at boundaries.
 */
export function manualTimer(): ManualTimer {
  let pending: (() => void) | null = null
  let delayMs: number | null = null

  return {
    after(next: number, fire: () => void): Cancel {
      pending = fire
      delayMs = next
      return () => {
        pending = null
        delayMs = null
      }
    },

    fire() {
      const run = pending
      pending = null
      delayMs = null
      run?.()
    },

    get delayMs() {
      return delayMs
    },

    get pending() {
      return pending !== null
    },
  }
}

/* --------------------------------------------------------------------------
 * The accumulator
 * ----------------------------------------------------------------------- */

export type FrameSteps = {
  /** Sub-steps this frame is worth. Exactly `floor((remainder + dt) / 8)`. */
  readonly steps: number
  /** Carried into the next frame. Always in `[0, TICK_INTERVAL_MS)`. */
  readonly remainderMs: number
  /** The elapsed time actually folded in, after the clamp. */
  readonly dtMs: number
  /** Simulated time the clamp threw away. Zero in the steady state. */
  readonly droppedMs: number
}

/**
 * Fold `elapsedMs` of wall-clock into `remainderMs` and say how many sub-steps
 * that buys. Pure; the clock is read by the caller, once.
 *
 * The exactness is load-bearing and it is why `TICK_INTERVAL_MS` is a power of
 * two: `total / 8`, `floor(total / 8)` and `steps * 8` are all exact in IEEE
 * 754, so the carried remainder is the *true* remainder however many frames go
 * by. This is the same arithmetic `advanceHost` does inside a kernel; it is
 * spelt out here as a value because one scheduler drives every room on the
 * machine and they all have to be handed the same number.
 */
export function stepsFor(
  remainderMs: number,
  elapsedMs: number,
  maxFrameMs: number = MAX_HOST_FRAME_MS,
): FrameSteps {
  const raw = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0
  const dtMs = raw > maxFrameMs ? maxFrameMs : raw
  const total = remainderMs + dtMs
  const steps = Math.floor(total / TICK_INTERVAL_MS)
  return {
    steps,
    remainderMs: total - steps * TICK_INTERVAL_MS,
    dtMs,
    droppedMs: raw - dtMs,
  }
}

/* --------------------------------------------------------------------------
 * The scheduler
 * ----------------------------------------------------------------------- */

/** What one host frame turned out to be worth. */
export type HostFrame = {
  /** The clock reading this frame was measured at. */
  readonly nowMs: number
  /** Sub-steps to run. May be zero on a frame that woke early. */
  readonly steps: number
  /** Wall-clock folded in, after the clamp. */
  readonly dtMs: number
  /** Simulated time this frame threw away. */
  readonly droppedMs: number
  /** How far past its aim point this wakeup arrived. Never negative. */
  readonly latenessMs: number
}

export type SchedulerStats = {
  readonly frameMs: number
  readonly frames: number
  /** Sub-steps handed out over the life of the scheduler. */
  readonly steps: number
  readonly meanLatenessMs: number
  readonly p50LatenessMs: number
  readonly p99LatenessMs: number
  readonly maxLatenessMs: number
  /** Simulated time thrown away by the {@link MAX_HOST_FRAME_MS} clamp. */
  readonly droppedMs: number
  /** Times the aim point had fallen a whole frame behind and was re-aimed. */
  readonly resyncs: number
  readonly budgetMs: number
  /** Whether {@link SchedulerStats.p99LatenessMs} is inside the budget. */
  readonly withinBudget: boolean
}

export type TickScheduler = {
  start(): void
  stop(): void
  readonly running: boolean
  /**
   * Run one frame now, as though the timer had fired.
   *
   * The seam a test drives, and the reason a scheduler test costs no
   * wall-clock. It does not touch the timer: {@link TickScheduler.start} owns
   * that, and a manual frame in the middle of a running scheduler would be two
   * opinions about where the next boundary is.
   */
  frame(): HostFrame
  stats(): SchedulerStats
  /** One line, for the boot log and the shutdown log. */
  describe(): string
}

export type SchedulerOptions = {
  /** Read once per frame. `clock.ts` explains why it is a value. */
  readonly clock: Clock
  /** Injected so a test can run a thousand frames without waiting for them. */
  readonly timer?: Timer
  readonly frameMs?: number
  /** The clamp. Defaults to the kernel's `MAX_HOST_FRAME_MS`. */
  readonly maxFrameMs?: number
  readonly budgetMs?: number
  /**
   * What a frame does. Called once per frame with the sub-steps it is worth,
   * including zero — a room may want to know that time passed and nothing
   * happened.
   */
  readonly onFrame: (frame: HostFrame) => void
}

export function createTickScheduler(options: SchedulerOptions): TickScheduler {
  const clock = options.clock
  const timer = options.timer ?? systemTimer()
  const frameMs = options.frameMs ?? HOST_FRAME_MS
  const maxFrameMs = options.maxFrameMs ?? MAX_HOST_FRAME_MS
  const budgetMs = options.budgetMs ?? WAKEUP_BUDGET_MS

  const lateness = createSampleLog()
  let cancel: Cancel | null = null
  let started = false
  let remainderMs = 0
  let lastFrameMs = 0
  let deadlineMs = 0
  let frames = 0
  let steps = 0
  let droppedMs = 0
  let resyncs = 0

  const runFrame = (): HostFrame => {
    const nowMs = clock.nowMs()
    // Only lateness is recorded. A wakeup that beat its deadline is a timer
    // being generous, and folding a negative into the mean would flatter the
    // very number the budget is about.
    const late = nowMs - deadlineMs
    lateness.add(late > 0 ? late : 0)

    // `clampHostDelta` first, then the accumulator: the kernel's contract is
    // that a caller clamps before it folds, and running the raw delta through
    // both would apply the ceiling twice with two different opinions of it.
    //
    // A scheduler that was never started has no `lastFrameMs` to measure
    // against, and measuring against zero would make its first frame "however
    // long this process has been up" — 250 ms after the clamp, every time. So
    // an unstarted scheduler's first frame is worth exactly one frame. Once
    // `start` has stamped the clock, the delta is real from the first wakeup,
    // which is what lets a test drive `frame()` by hand and get the sub-steps
    // its own clock says it asked for.
    const elapsedMs = started || frames > 0 ? nowMs - lastFrameMs : frameMs
    const fold = stepsFor(remainderMs, clampHostDelta(elapsedMs), maxFrameMs)
    const rawMs = elapsedMs > 0 ? elapsedMs : 0
    const thrownMs = rawMs - fold.dtMs

    remainderMs = fold.remainderMs
    lastFrameMs = nowMs
    frames += 1
    steps += fold.steps
    droppedMs += thrownMs

    const frame: HostFrame = {
      nowMs,
      steps: fold.steps,
      dtMs: fold.dtMs,
      droppedMs: thrownMs,
      latenessMs: late > 0 ? late : 0,
    }
    options.onFrame(frame)
    return frame
  }

  /** Aim at the next boundary and sleep until it, or re-aim if it has gone. */
  const arm = (): void => {
    deadlineMs += frameMs
    const afterMs = clock.nowMs()
    if (deadlineMs <= afterMs) {
      // A whole frame behind. Marching the deadline forward one frame at a time
      // would produce a burst of wakeups measuring no elapsed time — see the
      // header. Re-aim, and say so in the stats rather than in silence.
      resyncs += 1
      deadlineMs = afterMs + frameMs
    }
    const delayMs = deadlineMs - afterMs
    cancel = timer.after(delayMs > 0 ? delayMs : 0, wake)
  }

  const wake = (): void => {
    runFrame()
    if (cancel !== null) arm()
  }

  const takeStats = (): SchedulerStats => {
    const p99 = lateness.quantile(99)
    return {
      frameMs,
      frames,
      steps,
      meanLatenessMs: lateness.mean,
      p50LatenessMs: lateness.quantile(50),
      p99LatenessMs: p99,
      maxLatenessMs: lateness.max,
      droppedMs,
      resyncs,
      budgetMs,
      // A scheduler that has not run is not "within budget" by luck; it has
      // nothing to say, and `frames` next to it is how a reader tells which.
      withinBudget: p99 <= budgetMs,
    }
  }

  return {
    start() {
      if (cancel !== null) return
      const nowMs = clock.nowMs()
      started = true
      lastFrameMs = nowMs
      deadlineMs = nowMs
      // `arm` sets `cancel`, but the guard above reads it, so it is claimed
      // first: a `start` racing its own first wakeup must not arm twice.
      cancel = () => undefined
      arm()
    },

    stop() {
      const stopping = cancel
      cancel = null
      stopping?.()
    },

    get running() {
      return cancel !== null
    },

    frame: runFrame,

    stats: takeStats,

    describe() {
      const stats = takeStats()
      const round = (value: number) => value.toFixed(3)
      return (
        `tick scheduler: ${stats.frames} frames at ${stats.frameMs} ms, ${stats.steps} sub-steps, ` +
        `wakeup lateness p50 ${round(stats.p50LatenessMs)} ms, p99 ${round(stats.p99LatenessMs)} ms ` +
        `(budget ${stats.budgetMs} ms — ${stats.withinBudget ? 'within' : 'OVER'}), ` +
        `max ${round(stats.maxLatenessMs)} ms, ${stats.resyncs} resyncs, ` +
        `${round(stats.droppedMs)} ms of simulated time dropped`
      )
    },
  }
}
