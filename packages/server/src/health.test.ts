/**
 * Readiness, which is not liveness.
 *
 * The claim this file exists to hold up is the ticket's: **a health check has
 * to fail while the process is perfectly alive**, because "up" and "send me
 * players" are different questions and the three states below are ones only the
 * second can see.
 */
import { describe, expect, it } from 'vitest'

import {
  NotReady,
  SCHEDULER_STALL_MS,
  createTrafficMeter,
  healthReport,
  readinessOf,
} from './health.ts'
import type { RegistryStats } from './rooms.ts'
import type { SchedulerStats } from './scheduler.ts'

const ROOMS: RegistryStats = {
  rooms: 3,
  capacity: 200,
  peers: 6,
  created: 9,
  reaped: 6,
  missed: 1,
}

const TICKING: SchedulerStats = {
  frameMs: 16,
  frames: 60_000,
  steps: 120_000,
  meanLatenessMs: 0.2,
  p50LatenessMs: 0,
  p99LatenessMs: 1.9,
  maxLatenessMs: 12,
  droppedMs: 0,
  resyncs: 0,
  budgetMs: 8,
  withinBudget: true,
  lastFrameMs: 1_000_000,
}

const NOW = TICKING.lastFrameMs + 10

describe('readiness', () => {
  it('is yes for a machine that is ticking, has room, and is staying', () => {
    expect(readinessOf({ draining: false, rooms: ROOMS, scheduler: TICKING, nowMs: NOW })).toEqual({
      ready: true,
      reasons: [],
    })
  })

  it('is no while draining — the whole point of it not being liveness', () => {
    const verdict = readinessOf({ draining: true, rooms: ROOMS, scheduler: TICKING, nowMs: NOW })
    expect(verdict).toEqual({ ready: false, reasons: [NotReady.Draining] })
  })

  it('is no when every room slot is taken', () => {
    const full = { ...ROOMS, rooms: ROOMS.capacity }
    expect(readinessOf({ draining: false, rooms: full, scheduler: TICKING, nowMs: NOW }).reasons)
      .toEqual([NotReady.Full])
  })

  it('is no when the scheduler has stopped running frames', () => {
    // The state a liveness check can never see: up, listening, accepting
    // sockets, and simulating nobody. A player let in here joins a room that
    // does not tick.
    const stalled = readinessOf({
      draining: false,
      rooms: ROOMS,
      scheduler: TICKING,
      nowMs: TICKING.lastFrameMs + SCHEDULER_STALL_MS + 1,
    })
    expect(stalled).toEqual({ ready: false, reasons: [NotReady.Stalled] })

    // And a hitch is not a stall. Two seconds is ~125 missed frames, far past
    // anything a garbage collection or a resync produces.
    expect(
      readinessOf({
        draining: false,
        rooms: ROOMS,
        scheduler: TICKING,
        nowMs: TICKING.lastFrameMs + SCHEDULER_STALL_MS - 1,
      }).ready,
    ).toBe(true)
  })

  it('does not fail on jitter over budget', () => {
    // Deliberate: a machine running late is still the only machine holding
    // these matches, and taking it out of rotation trades a stutter for an
    // outage. The number is served, and it is a deploy decision. `NOTES.md`.
    const late = { ...TICKING, p99LatenessMs: 40, withinBudget: false }
    expect(readinessOf({ draining: false, rooms: ROOMS, scheduler: late, nowMs: NOW }).ready)
      .toBe(true)
  })

  it('reports every reason, not just the first', () => {
    const verdict = readinessOf({
      draining: true,
      rooms: { ...ROOMS, rooms: ROOMS.capacity },
      scheduler: TICKING,
      nowMs: TICKING.lastFrameMs + SCHEDULER_STALL_MS + 1,
    })
    expect(verdict.reasons).toEqual([NotReady.Draining, NotReady.Full, NotReady.Stalled])
  })
})

describe('the /healthz body', () => {
  const input = {
    draining: false,
    rooms: ROOMS,
    scheduler: TICKING,
    nowMs: NOW,
    build: 'abc1234',
    map: { name: 'ra1', hash: 'deadbeef' },
    startedAtMs: NOW - 90_000,
    sessions: 6,
    jitter: { intervalMs: 8, samples: 1000, meanMs: 0.1, p50Ms: 0, p99Ms: 2, maxMs: 9 },
    traffic: { bytesIn: 10, bytesOut: 20, messagesIn: 1, messagesOut: 2 },
    canResume: true,
    recording: false,
  }

  it('answers 200 when ready and 503 when not', () => {
    expect(healthReport(input).status).toBe(200)
    expect(healthReport({ ...input, draining: true }).status).toBe(503)
  })

  it('carries what a human running curl during a deploy needs', () => {
    const body = JSON.parse(healthReport(input).body) as Record<string, unknown>
    expect(body).toMatchObject({
      ok: true,
      ready: true,
      notReady: [],
      build: 'abc1234',
      canResume: true,
      // Both of the "is this deploy set up for the thing I turned on" answers,
      // so neither needs a socket opened to find out. `demoFile.ts`, `resume.ts`.
      recording: false,
      uptimeSeconds: 90,
      sessions: 6,
    })
    // `scripts/verify-deploy.sh` reads these two, so they are contract rather
    // than decoration.
    expect(body['scheduler']).toMatchObject({ withinBudget: true, p99LatenessMs: 1.9 })
    expect(body['rooms']).toMatchObject({ rooms: 3, capacity: 200 })
  })
})

describe('the traffic meter', () => {
  it('counts both directions, for the cost arithmetic in NOTES.md', () => {
    const meter = createTrafficMeter()
    meter.read(100)
    meter.wrote(250)
    meter.wrote(250)
    expect(meter.stats).toEqual({
      bytesIn: 100,
      bytesOut: 500,
      messagesIn: 1,
      messagesOut: 2,
    })
  })
})
