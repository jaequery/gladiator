/**
 * The tick scheduler, driven by a clock and a timer this file owns.
 *
 * Every claim the ticket makes about the scheduler is here as an arithmetic
 * assertion rather than as a wall-clock observation, which is the only way to
 * assert them at all: "aims at the next boundary" is a statement about the
 * *delay it asks for*, and "never spirals after a 250 ms stall" is a statement
 * about what it does with a delta nobody can produce on demand.
 *
 * The real timer is exercised in `integration.test.ts`, where a live server has
 * to ping a real socket on its own — one test, because "the timer is wired" is
 * a different question from "the arithmetic is right" and only the first needs
 * to wait for anything.
 */
import { MAX_HOST_FRAME_MS, TICK_INTERVAL_MS, advanceHost, createKernel, createGameState } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { manualClock } from './clock.ts'
import {
  HOST_FRAME_MS,
  WAKEUP_BUDGET_MS,
  createTickScheduler,
  manualTimer,
  stepsFor,
  type HostFrame,
} from './scheduler.ts'

/** A scheduler over a clock and a timer a test drives, plus what it produced. */
function driven(options: { frameMs?: number; budgetMs?: number } = {}) {
  const clock = manualClock()
  const timer = manualTimer()
  const frames: HostFrame[] = []
  const scheduler = createTickScheduler({
    clock,
    timer,
    ...(options.frameMs === undefined ? {} : { frameMs: options.frameMs }),
    ...(options.budgetMs === undefined ? {} : { budgetMs: options.budgetMs }),
    onFrame: (frame) => frames.push(frame),
  })
  return { clock, timer, frames, scheduler }
}

describe('the accumulator', () => {
  it('runs exactly floor((remainder + elapsed) / 8) sub-steps', () => {
    // The contract, spelt out. Nothing rounds, nothing is clamped short of the
    // ceiling, and the remainder carried is the true one.
    expect(stepsFor(0, 16)).toMatchObject({ steps: 2, remainderMs: 0 })
    expect(stepsFor(0, 7)).toMatchObject({ steps: 0, remainderMs: 7 })
    expect(stepsFor(7, 7)).toMatchObject({ steps: 1, remainderMs: 6 })
    expect(stepsFor(0, 16.667)).toMatchObject({ steps: 2 })
    expect(stepsFor(0, 16.667).remainderMs).toBeCloseTo(0.667, 10)
  })

  it('never drifts, however many frames go by', () => {
    // 16.667 is not representable and 8 is a power of two, which is the whole
    // reason the tick interval is 8: `total / 8`, `floor(total / 8)` and
    // `steps * 8` are exact, so the carried remainder is exact and a thousand
    // frames later the count is still the count.
    let remainderMs = 0
    let steps = 0
    const frameMs = 1000 / 60
    for (let frame = 0; frame < 3600; frame += 1) {
      const fold = stepsFor(remainderMs, frameMs)
      remainderMs = fold.remainderMs
      steps += fold.steps
    }
    // A minute at 60 Hz is 60 seconds, which is 7500 sub-steps. Not 7499.
    expect(steps).toBe(7500)
    expect(remainderMs).toBeLessThan(TICK_INTERVAL_MS)
  })

  it('throws a long stall away rather than simulating it', () => {
    const fold = stepsFor(0, 3000)
    expect(fold.dtMs).toBe(MAX_HOST_FRAME_MS)
    expect(fold.steps).toBe(Math.floor(MAX_HOST_FRAME_MS / TICK_INTERVAL_MS))
    expect(fold.droppedMs).toBe(3000 - MAX_HOST_FRAME_MS)
  })

  it('treats a clock that went backwards as no time at all', () => {
    expect(stepsFor(3, -50)).toMatchObject({ steps: 0, remainderMs: 3, dtMs: 0 })
    expect(stepsFor(3, Number.NaN)).toMatchObject({ steps: 0, remainderMs: 3 })
  })

  it('agrees with the kernel it is a copy of', () => {
    // `advanceHost` does this arithmetic inside a kernel and `stepsFor` does it
    // as a value, because one scheduler drives every room on the machine and
    // they all have to be handed the same number. Two implementations of one
    // rule is the drift this repo exists to prevent, so they are compared.
    const kernel = createKernel(createGameState(1))
    let remainderMs = 0
    for (const dtMs of [16, 7, 1, 33.3, 0.4, 16.667, 250]) {
      const fold = stepsFor(remainderMs, dtMs)
      remainderMs = fold.remainderMs
      expect(advanceHost(kernel, fold.dtMs, () => [])).toBe(fold.steps)
      expect(kernel.remainderMs).toBeCloseTo(remainderMs, 12)
    }
  })
})

describe('aiming at the next boundary', () => {
  it('sleeps a whole frame when it woke on time', () => {
    const { clock, timer, scheduler } = driven()
    scheduler.start()
    expect(timer.delayMs).toBe(HOST_FRAME_MS)

    clock.advance(HOST_FRAME_MS)
    timer.fire()
    expect(timer.delayMs).toBe(HOST_FRAME_MS)
  })

  it('sleeps less after a late wakeup, so the boundary does not move', () => {
    // The whole difference between this and `setInterval`. A wakeup 3 ms late
    // sleeps 13 ms, and frame *n* still lands at `start + n × frameMs`; an
    // interval would have kept the 3 ms forever and every second after it.
    const { clock, timer, scheduler } = driven()
    scheduler.start()

    clock.advance(HOST_FRAME_MS + 3)
    timer.fire()
    expect(timer.delayMs).toBe(HOST_FRAME_MS - 3)

    clock.advance(HOST_FRAME_MS - 3)
    timer.fire()
    expect(timer.delayMs).toBe(HOST_FRAME_MS)
  })

  it('holds the tick rate over a minute of jittery wakeups', () => {
    // The number that matters: a minute of wall-clock is 7500 sub-steps,
    // whatever the timer did in between. A scheduler that kept its lateness
    // would come out short and the server's tick counter would walk away from
    // every client's estimate of it.
    const { clock, timer, scheduler } = driven()
    scheduler.start()

    const jitter = [0, 1, 4, 0, 2, 7, 1, 0, 3, 0, 5, 1]
    while (clock.nowMs() < 60_000) {
      const late = jitter[scheduler.stats().frames % jitter.length] ?? 0
      const delayMs = timer.delayMs ?? HOST_FRAME_MS
      clock.advance(delayMs + late)
      timer.fire()
    }

    const stats = scheduler.stats()
    // Every millisecond of elapsed wall-clock is accounted for as a sub-step or
    // as the remainder carried past the end of the run.
    expect(stats.steps).toBe(Math.floor(clock.nowMs() / TICK_INTERVAL_MS))
    expect(stats.droppedMs).toBe(0)
    expect(stats.resyncs).toBe(0)
  })

  it('measures its own lateness and judges it against a written budget', () => {
    const { clock, timer, scheduler } = driven({ budgetMs: 4 })
    scheduler.start()
    for (const late of [0, 1, 2, 1, 0, 3, 1, 0, 2, 1]) {
      clock.advance((timer.delayMs ?? HOST_FRAME_MS) + late)
      timer.fire()
    }

    const stats = scheduler.stats()
    expect(stats.frames).toBe(10)
    expect(stats.maxLatenessMs).toBe(3)
    expect(stats.p99LatenessMs).toBe(3)
    expect(stats.budgetMs).toBe(4)
    expect(stats.withinBudget).toBe(true)
    expect(scheduler.describe()).toContain('within')

    // And it says so when it is over, in the line that ends up in the deploy
    // log. A budget nobody is told about is a budget nobody acts on.
    const over = driven({ budgetMs: 1 })
    over.scheduler.start()
    over.clock.advance(HOST_FRAME_MS + 40)
    over.timer.fire()
    expect(over.scheduler.stats().withinBudget).toBe(false)
    expect(over.scheduler.describe()).toContain('OVER')
  })

  it('has a budget of one tick', () => {
    // Written down here as well as in the module, because the number is the
    // claim: a wakeup late by less than a sub-step lands in the same 8 ms the
    // world was going to be advanced through anyway.
    expect(WAKEUP_BUDGET_MS).toBe(TICK_INTERVAL_MS)
  })
})

describe('never spiralling', () => {
  it('simulates 250 ms of a 3-second stall and drops the rest, once', () => {
    const { clock, timer, frames, scheduler } = driven()
    scheduler.start()

    clock.advance(3000)
    timer.fire()

    const stalled = frames[0]
    expect(stalled?.steps).toBe(Math.floor(MAX_HOST_FRAME_MS / TICK_INTERVAL_MS))
    expect(stalled?.dtMs).toBe(MAX_HOST_FRAME_MS)
    expect(stalled?.droppedMs).toBe(3000 - MAX_HOST_FRAME_MS)

    // And the next frame is an ordinary one rather than the second of a
    // catch-up burst: the aim point was re-aimed rather than marched forward.
    expect(scheduler.stats().resyncs).toBe(1)
    expect(timer.delayMs).toBe(HOST_FRAME_MS)

    clock.advance(HOST_FRAME_MS)
    timer.fire()
    expect(frames[1]?.steps).toBe(2)
    expect(frames[1]?.droppedMs).toBe(0)
  })

  it('does not run a burst of empty frames chasing the boundaries it missed', () => {
    // The spiral this refuses. Marching `deadline += frameMs` past a 250 ms
    // stall would produce fifteen wakeups measuring no elapsed time, each
    // running no sub-steps — pure CPU burnt at the worst possible moment.
    const { clock, timer, frames, scheduler } = driven()
    scheduler.start()

    clock.advance(250)
    timer.fire()
    // Fifteen frames' worth of wall-clock went by and exactly one frame ran.
    expect(frames).toHaveLength(1)
    expect(timer.delayMs).toBe(HOST_FRAME_MS)

    // Ten more ordinary frames, and every one of them is worth two sub-steps.
    for (let frame = 0; frame < 10; frame += 1) {
      clock.advance(HOST_FRAME_MS)
      timer.fire()
    }
    expect(frames.slice(1).every((frame) => frame.steps === 2)).toBe(true)
    expect(scheduler.stats().resyncs).toBe(1)
  })

  it('keeps the tick count honest when time is thrown away', () => {
    // The cost of the clamp, stated: the world is behind wall-clock by exactly
    // what was dropped, and the number is reported rather than hidden. Whoever
    // has to tell the other peer about it (the ping's tick number) can read it.
    const { clock, timer, scheduler } = driven()
    scheduler.start()
    clock.advance(1000)
    timer.fire()
    const stats = scheduler.stats()
    expect(stats.steps).toBe(Math.floor(MAX_HOST_FRAME_MS / TICK_INTERVAL_MS))
    expect(stats.droppedMs).toBe(750)
  })
})

describe('starting and stopping', () => {
  it('stops beating when it is stopped, and starts again when it is started', () => {
    const { clock, timer, frames, scheduler } = driven()
    scheduler.start()
    expect(scheduler.running).toBe(true)

    clock.advance(HOST_FRAME_MS)
    timer.fire()
    expect(frames).toHaveLength(1)

    scheduler.stop()
    expect(scheduler.running).toBe(false)
    expect(timer.pending).toBe(false)

    scheduler.start()
    clock.advance(HOST_FRAME_MS)
    timer.fire()
    expect(frames).toHaveLength(2)
  })

  it('lets a frame stop the scheduler without arming another one', () => {
    // A room that closes the server from inside a frame is a real shape — a
    // graceful shutdown lands mid-tick — and re-arming after it would leave a
    // timer holding a process that is trying to exit.
    const clock = manualClock()
    const timer = manualTimer()
    const scheduler = createTickScheduler({
      clock,
      timer,
      onFrame: () => scheduler.stop(),
    })
    scheduler.start()
    clock.advance(HOST_FRAME_MS)
    timer.fire()
    expect(timer.pending).toBe(false)
    expect(scheduler.running).toBe(false)
  })
})
