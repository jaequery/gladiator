/**
 * The beat.
 *
 * `Room` never calls `setInterval` — that is a rule with a reason rather than a
 * style preference. A host that owned its own timer could only be tested by
 * waiting for it, and could not run in a browser tab without dragging a Node
 * timer type in behind it. So the timer lives out here, behind an injected
 * {@link Scheduler}, and the room is handed a `nowMs` when the beat lands.
 *
 * That inversion is what lets an integration test run a full match — thousands
 * of ticks — in the microseconds it takes to run them, instead of the minute a
 * wall clock would charge for the same thing.
 *
 * The scheduler that will drive rooms at a steady 125 Hz, with the jitter
 * budget and the catch-up policy that go with it, is GLAD-FHKBN8. This is the
 * seam it grows out of, not a stand-in for it: what beats and how often is the
 * caller's business, and this module only owns the fact that *something* has
 * to hold the timer and it must not be the room.
 */

/** Stops a repeating callback. Idempotent. */
export type Cancel = () => void

export type Scheduler = {
  /** Run `beat` every `intervalMs` until the returned {@link Cancel} is called. */
  every(intervalMs: number, beat: () => void): Cancel
}

/**
 * The real one.
 *
 * `unref` where it exists, so a beat is never the thing keeping a Node process
 * alive — a server that will not exit because a housekeeping timer is pending
 * is a deploy that hangs. Browsers have no such notion and no such method, and
 * the optional call is how that is spelt without branching on the runtime.
 */
export function systemScheduler(): Scheduler {
  return {
    every(intervalMs: number, beat: () => void): Cancel {
      const handle = setInterval(beat, intervalMs)
      const timer = handle as unknown as { unref?: () => void }
      timer.unref?.()
      return () => clearInterval(handle)
    },
  }
}

/**
 * A scheduler that only beats when a test says so.
 *
 * `beat()` fires every registered callback once, in registration order. Paired
 * with `manualClock`, it turns "an hour of housekeeping" into a for-loop.
 */
export type ManualScheduler = Scheduler & {
  beat(): void
  readonly registered: number
}

export function manualScheduler(): ManualScheduler {
  const beats: Array<() => void> = []
  return {
    every(_intervalMs: number, beat: () => void): Cancel {
      beats.push(beat)
      return () => {
        const at = beats.indexOf(beat)
        if (at >= 0) beats.splice(at, 1)
      }
    },
    beat() {
      for (const run of [...beats]) run()
    },
    get registered() {
      return beats.length
    },
  }
}

export type HostLoopOptions = {
  readonly scheduler: Scheduler
  /** Read once per beat, and handed to {@link HostLoopOptions.beat}. */
  readonly clock: { nowMs(): number }
  readonly intervalMs: number
  /**
   * What one beat does.
   *
   * The clock is read here and passed in rather than read by the callback,
   * for the same reason the client's frame reads `performance.now()` exactly
   * once: two readings of a clock inside one beat is two opinions about when
   * the beat was.
   */
  readonly beat: (nowMs: number) => void
}

export type HostLoop = {
  stop(): void
  /** Beats run so far. Diagnostics, and how a test knows the beat is wired. */
  readonly beats: number
}

export function startHostLoop(options: HostLoopOptions): HostLoop {
  let beats = 0
  const cancel = options.scheduler.every(options.intervalMs, () => {
    beats += 1
    options.beat(options.clock.nowMs())
  })
  return {
    stop: cancel,
    get beats() {
      return beats
    },
  }
}
