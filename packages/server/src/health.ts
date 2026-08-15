/**
 * What "healthy" means for a machine whose job is to hold live matches.
 *
 * Two questions, deliberately answered at two URLs, because a load balancer
 * that cannot tell them apart will make exactly the wrong decision at least
 * once:
 *
 * - **`/livez` — is this process alive?** Answered `200` by anything that can
 *   still run an HTTP handler. Nothing about it ever fails on purpose, because
 *   the only correct response to it failing is to kill the process, and killing
 *   a process that is holding two people's duel because it is *busy* is the
 *   failure mode this file exists to avoid.
 * - **`/healthz` — should new players be sent here?** {@link readinessOf}, and
 *   it is allowed to say no while the process is perfectly alive.
 *
 * Fly's health check hits the second one, so a `503` there takes the machine
 * out of rotation for *new* connections and leaves the WebSockets that are
 * already open exactly where they are. That asymmetry is the whole design: a
 * duel in progress must survive its machine being marked unready, because the
 * commonest reason for it to be unready is that the machine is on its way out.
 *
 * ## The three ways to be up and not ready
 *
 * | Reason | What it means | Who sets it |
 * | ------ | ------------- | ----------- |
 * | `draining` | SIGTERM arrived; this machine is finishing and leaving | `shutdown.ts` |
 * | `full` | every room slot on the machine is taken | `rooms.ts` |
 * | `stalled` | the tick scheduler has not run a frame in {@link SCHEDULER_STALL_MS} | `scheduler.ts` |
 *
 * The third is the one a liveness check can never see, and it is a real state:
 * a process whose event loop is blocked, or whose timer was never started, is
 * up, listening, accepting sockets — and simulating nobody. A player let into
 * that machine joins a room that does not tick.
 *
 * ## What is deliberately *not* a readiness failure
 *
 * **Wakeup jitter over budget.** `scheduler.withinBudget` is served in the body
 * and is what `scripts/verify-deploy.sh` reads, but it does not make the machine
 * unready: a machine that is running late is still the only machine holding
 * these matches, and taking it out of rotation would trade a stutter for an
 * outage. The budget is a *deploy* decision — a machine class to change, in
 * `NOTES.md` — not a runtime one.
 */
import { PROTOCOL_VERSION } from '@gladiator/sim'

import type { RegistryStats } from './rooms.ts'
import type { SchedulerStats } from './scheduler.ts'
import type { JitterSnapshot } from './jitter.ts'

/**
 * How long the tick scheduler may go without a frame before the machine stops
 * being ready. Two seconds.
 *
 * A frame is due every 16 ms, so this is ~125 missed frames: far past anything
 * a garbage collection, a resync, or the scheduler's own stall clamp produces,
 * and short enough that a machine which has genuinely stopped simulating is out
 * of rotation before a player finishes reading the menu.
 */
export const SCHEDULER_STALL_MS = 2_000

/** Why a machine is not ready. One string per reason, in the body and the log. */
export const NotReady = {
  Draining: 'draining',
  Full: 'full',
  Stalled: 'stalled',
} as const

export type NotReady = (typeof NotReady)[keyof typeof NotReady]

export type Readiness = {
  readonly ready: boolean
  /** Empty when ready. Ordered as listed above: the most decisive first. */
  readonly reasons: readonly NotReady[]
}

/** Everything readiness is a function of. Values, so a test needs no server. */
export type ReadinessInput = {
  readonly draining: boolean
  readonly rooms: RegistryStats
  readonly scheduler: SchedulerStats
  /** Wall-clock now, on the same clock the scheduler stamped its frame with. */
  readonly nowMs: number
  readonly stallMs?: number
}

export function readinessOf(input: ReadinessInput): Readiness {
  const reasons: NotReady[] = []
  const stallMs = input.stallMs ?? SCHEDULER_STALL_MS

  if (input.draining) reasons.push(NotReady.Draining)
  if (input.rooms.rooms >= input.rooms.capacity) reasons.push(NotReady.Full)
  // A scheduler that has never run a frame has `lastFrameMs === 0`, which is
  // not "stalled since the epoch" — it is a machine that has not started
  // ticking yet, and it is not ready either. Both land here, which is correct
  // and is why the check is written against the stamp rather than against a
  // separate "has it started" flag.
  if (input.nowMs - input.scheduler.lastFrameMs > stallMs) reasons.push(NotReady.Stalled)

  return { ready: reasons.length === 0, reasons }
}

/**
 * Bytes over the sockets, since boot.
 *
 * Here rather than in the observability ticket's structured logs (GLAD-2E6PUO)
 * because this is the *cost* question and it is answered by dividing: Fly bills
 * egress by the gigabyte, a duel is a known number of snapshots a second, and
 * `bytesOut / uptimeSeconds / sessions` on a machine with players on it is the
 * only version of that arithmetic that is not a guess. `NOTES.md` records what
 * it came out at.
 */
export type TrafficStats = {
  readonly bytesIn: number
  readonly bytesOut: number
  readonly messagesIn: number
  readonly messagesOut: number
}

export type TrafficMeter = {
  readonly stats: TrafficStats
  read(bytes: number): void
  wrote(bytes: number): void
}

export function createTrafficMeter(): TrafficMeter {
  let bytesIn = 0
  let bytesOut = 0
  let messagesIn = 0
  let messagesOut = 0

  return {
    get stats(): TrafficStats {
      return { bytesIn, bytesOut, messagesIn, messagesOut }
    },
    read(bytes) {
      bytesIn += bytes
      messagesIn += 1
    },
    wrote(bytes) {
      bytesOut += bytes
      messagesOut += 1
    },
  }
}

export type HealthInput = ReadinessInput & {
  readonly build: string
  readonly map: { readonly name: string; readonly hash: string }
  readonly startedAtMs: number
  readonly sessions: number
  readonly jitter: JitterSnapshot
  readonly traffic: TrafficStats
  /** Whether this deploy can hand out resume tickets. `resume.ts`. */
  readonly canResume: boolean
  /** Whether this machine is recording matches. `demoFile.ts`. */
  readonly recording: boolean
}

export type HealthReport = {
  /** The status code to answer with: 200 when ready, 503 when not. */
  readonly status: number
  readonly body: string
}

/**
 * The `/healthz` answer: a readiness verdict, and everything needed to argue
 * with it.
 *
 * Served as one object rather than a bare `ok` because the two audiences want
 * different halves of it and neither should have to open a socket to get the
 * other: Fly's proxy reads the status code, and a human running `curl` during a
 * deploy reads `scheduler` and `rooms`.
 */
export function healthReport(input: HealthInput): HealthReport {
  const readiness = readinessOf(input)
  const body = {
    ok: readiness.ready,
    ready: readiness.ready,
    notReady: readiness.reasons,
    draining: input.draining,
    build: input.build,
    protocol: PROTOCOL_VERSION,
    canResume: input.canResume,
    recording: input.recording,
    // Served so that "is the client on the right arena" is answerable with
    // curl, without opening a socket and reading a welcome frame.
    map: input.map,
    uptimeSeconds: Math.round((input.nowMs - input.startedAtMs) / 1000),
    sessions: input.sessions,
    rooms: input.rooms,
    // Served, not just logged. The p99 on the machine that is actually running
    // is the only one worth quoting, it changes under load, and
    // `scheduler.withinBudget` is the deploy's own verdict on whether this
    // machine class can hold a tick rate. `docs/deploy.md`.
    scheduler: input.scheduler,
    jitter: input.jitter,
    traffic: input.traffic,
  }
  return { status: readiness.ready ? 200 : 503, body: JSON.stringify(body) }
}
