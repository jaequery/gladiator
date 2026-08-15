/**
 * Leaving politely: what happens between SIGTERM and `process.exit`.
 *
 * Fly sends SIGTERM, waits `kill_timeout` (30 s in `fly.toml`), and then sends
 * SIGKILL. Everything this module does has to fit inside that window, and the
 * default behaviour — die on the spot — is worse than it sounds: every open
 * WebSocket closes as a 1006, which is the code for "the wire broke". A client
 * cannot tell that from a lost network, so it either hammers a machine that is
 * gone or gives up on a duel that could have continued.
 *
 * ## The order, and why it is this order
 *
 * 1. **Stop being ready.** `/healthz` answers 503 and the upgrade handler
 *    refuses new sockets with a `Retry-After`. Fly's proxy stops sending new
 *    players here within a health-check interval; the sockets already open are
 *    untouched, which is the asymmetry `health.ts` is built around.
 * 2. **Tell every peer where their match went**, one {@link ServerDrain} frame
 *    each, carrying the room code, when to come back, and that peer's signed
 *    resume ticket (`resume.ts`). This is the frame the whole ticket turns on:
 *    a room is a live world in *this* process's memory, so there is nothing on
 *    the next machine to reconnect to unless the score travels with the player.
 * 3. **Wait {@link DRAIN_NOTICE_MS}**, so those frames are actually on the wire
 *    before the close that follows them. A close and its explanation racing
 *    each other means the explanation loses.
 * 4. **Close every room** with a 1001 "going away", then wait for the sockets
 *    to actually go — bounded by {@link DRAIN_DEADLINE_MS}, which is
 *    deliberately well inside `kill_timeout`, so the process chooses its own
 *    exit rather than being killed mid-write.
 *
 * ## What draining is *not*
 *
 * It is not "finish the match first". A best-of-five can run for minutes and
 * `kill_timeout` is thirty seconds, so waiting for a natural end is a promise
 * this cannot keep — and a deploy that waits for the last duel to finish is a
 * deploy that never ships on a busy evening. What is promised instead is that
 * nobody is cut off *silently*: every peer leaves with a close code that means
 * "come back" and a ticket that says what to come back to.
 *
 * The reconnect policy on the other side — the backoff, the grace window,
 * what the player sees while it happens — is GLAD-DVDV6P's
 * (`client/net/reconnect.ts`). This module owns the half a *server* can own.
 */
import { CloseReason, MatchPhase, type ServerDrain } from '@gladiator/sim'

import type { Clock } from './clock.ts'
import { NO_LOG, type Log } from './log.ts'
import type { ResumeAuthority } from './resume.ts'
import { matchScoreOf } from './resume.ts'
import type { RoomRegistry } from './rooms.ts'

/**
 * How long the whole drain may take before the process stops waiting and exits.
 *
 * Twenty seconds against `fly.toml`'s `kill_timeout = "30s"`. The ten seconds
 * of margin is not padding: SIGKILL arriving mid-drain is indistinguishable
 * from the crash this exists to avoid, so the process must always be the one
 * that decides to go.
 */
export const DRAIN_DEADLINE_MS = 20_000

/**
 * How long to let the drain frames flush before closing the sockets under them.
 *
 * Half a second. `ws` writes on the event loop, so a close issued in the same
 * turn as the frame that explains it can win the race and the client learns
 * nothing. Half a second is far more than a flush needs and is invisible next
 * to a deploy.
 */
export const DRAIN_NOTICE_MS = 500

/**
 * What a client is told to wait before its first reconnect attempt.
 *
 * Three seconds: about how long a Fly blue/green cutover takes to pass its
 * health checks and move the proxy over. A client that dials sooner finds
 * nothing listening and burns its first two backoff steps on it; one that waits
 * much longer is a player watching a blank screen for no reason.
 */
export const DRAIN_RETRY_AFTER_MS = 3_000

/** How often the drain looks to see whether the sockets have gone. */
const DRAIN_POLL_MS = 25

export type DrainReport = {
  /** The signal, or whatever else asked for this. Straight into the log. */
  readonly reason: string
  /** Rooms that were live when the drain started. */
  readonly rooms: number
  /** Peers that were told, of any kind. */
  readonly told: number
  /** Peers that were told *and* handed a usable resume ticket. */
  readonly ticketed: number
  readonly waitedMs: number
  /** True when the deadline ran out with sockets still open. */
  readonly timedOut: boolean
}

/** The part of a running server a drain needs. `server.ts` implements it. */
export type Drainable = {
  /**
   * Refuse new upgrades and answer `/healthz` with a 503. Idempotent, because
   * a second SIGTERM during a drain is a normal thing for an orchestrator to
   * do.
   */
  beginDraining(): void
  readonly draining: boolean
  readonly rooms: RoomRegistry
  /** Open sockets, including any that never reached a room. */
  readonly sessions: number
  /** Stop the timers, close what is left, and release the port. */
  close(): Promise<void>
}

export type DrainOptions = {
  readonly server: Drainable
  readonly resume: ResumeAuthority
  readonly clock: Clock
  readonly log?: Log
  readonly deadlineMs?: number
  readonly noticeMs?: number
  readonly retryAfterMs?: number
  /** Injected so a test does not spend the notice window in real time. */
  readonly sleep?: (ms: number) => Promise<void>
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    // A pending drain timer must never be the reason a process stays up: the
    // whole point of this module is that the process leaves on time.
    timer.unref?.()
  })

/**
 * Hand every peer in every room its resume ticket.
 *
 * Per peer rather than per room, because a ticket names a *seat*: the score is
 * indexed by slot, and two players who swapped sides on a reconnect would find
 * the match had swapped with them.
 *
 * A room whose match is over gets the frame and an empty ticket. There is
 * nothing to resume, and a client that reconnected into a rebuilt room would
 * be starting a new match nobody asked for.
 */
export function tellPeers(options: {
  readonly rooms: RoomRegistry
  readonly resume: ResumeAuthority
  readonly retryAfterMs: number
}): { readonly told: number; readonly ticketed: number } {
  let told = 0
  let ticketed = 0

  for (const code of options.rooms.codes()) {
    const entry = options.rooms.get(code)
    if (entry === null) continue
    const room = entry.room
    const resumable = room.state.match.phase !== MatchPhase.Over
    const score = matchScoreOf(room.state)

    for (const peer of room.peers) {
      if (!peer.open || !peer.session.greeted || peer.session.rejected) continue
      const ticket = resumable
        ? options.resume.mint({ room: entry.code, slot: peer.slot, score })
        : ''
      const frame: ServerDrain = {
        t: 'drain',
        room: entry.code,
        retryAfterMs: options.retryAfterMs,
        resume: ticket,
      }
      peer.send(frame)
      told += 1
      if (ticket !== '') ticketed += 1
    }
  }

  return { told, ticketed }
}

/**
 * Drain and close a server. Returns once the process is safe to exit.
 *
 * Safe to call twice — the second call finds the machine already draining and
 * the rooms already closed, waits for whatever is left, and returns.
 */
export async function drainServer(options: DrainOptions): Promise<DrainReport> {
  const { server, resume, clock } = options
  const log = options.log ?? NO_LOG
  const deadlineMs = options.deadlineMs ?? DRAIN_DEADLINE_MS
  const noticeMs = options.noticeMs ?? DRAIN_NOTICE_MS
  const retryAfterMs = options.retryAfterMs ?? DRAIN_RETRY_AFTER_MS
  const sleep = options.sleep ?? realSleep

  const startedMs = clock.nowMs()
  const rooms = server.rooms.size

  server.beginDraining()

  const { told, ticketed } = tellPeers({ rooms: server.rooms, resume, retryAfterMs })
  log('drain.started', {
    rooms,
    told,
    ticketed,
    canResume: resume.enabled,
    ...(resume.enabled
      ? {}
      : { detail: 'no RESUME_SECRET — this deploy cannot resume the matches it is ending' }),
  })

  if (told > 0) await sleep(noticeMs)

  // 1001 rather than 1000: "going away" is what lets a client tell a deploy
  // apart from a crash and from being kicked. `sim/transport.ts`.
  server.rooms.closeAll(CloseReason.GoingAway, 'server is deploying')

  // Then wait for the sockets themselves. A close is a handshake, and the
  // process exiting before it completes turns every one of them back into the
  // 1006 this whole module exists to avoid.
  let timedOut = false
  while (server.sessions > 0) {
    if (clock.nowMs() - startedMs >= deadlineMs) {
      timedOut = true
      break
    }
    await sleep(DRAIN_POLL_MS)
  }

  await server.close()

  const waitedMs = clock.nowMs() - startedMs
  if (timedOut) {
    log('drain.deadline', {
      level: 'warn',
      waitedMs: Math.round(waitedMs),
      openSockets: server.sessions,
      deadlineMs,
    })
  }
  return { reason: 'drain', rooms, told, ticketed, waitedMs, timedOut }
}

export type SignalHandlerOptions = {
  /** Usually `process`. Injected so a test never installs a real handler. */
  readonly process: {
    on(signal: string, handler: () => void): unknown
    exit(code: number): never
  }
  readonly signals?: readonly string[]
  /** What to do once. The second signal does not wait for it. */
  readonly drain: (signal: string) => Promise<unknown>
  readonly log?: Log
}

/**
 * Wire SIGTERM and SIGINT to one drain.
 *
 * **The second signal is not politeness, it is an override.** An operator who
 * sends SIGTERM twice, or a Ctrl-C pressed again because nothing appeared to
 * happen, means "stop now" — and a handler that queued a second graceful drain
 * behind the first would be a process that cannot be stopped by the one key
 * everybody tries.
 */
export function installSignalHandlers(options: SignalHandlerOptions): void {
  const signals = options.signals ?? ['SIGTERM', 'SIGINT']
  const log = options.log ?? NO_LOG
  let draining = false

  for (const signal of signals) {
    options.process.on(signal, () => {
      if (draining) {
        log('shutdown.forced', { level: 'warn', signal })
        // `return`, because a real `process.exit` never comes back and the code
        // below must not run if one ever does.
        return options.process.exit(1)
      }
      draining = true
      void options
        .drain(signal)
        .then(() => options.process.exit(0))
        .catch((error: unknown) => {
          log('drain.failed', {
            level: 'error',
            error: error instanceof Error ? error.message : String(error),
          })
          options.process.exit(1)
        })
    })
  }
}
