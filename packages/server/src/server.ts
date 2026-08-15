/**
 * The HTTP and WebSocket server: the Node *edge* around the host.
 *
 * Split from `index.ts` so the tests can start a real one on an ephemeral port
 * and talk to it over a real socket. Everything this ticket claims about the
 * deployed system — that two strangers reach one room by sharing a code, that
 * an unknown code is a sentence rather than a hang, that the world advances on
 * a measured clock — is asserted against *this*, not against a mock.
 *
 * What this file is *not* is the host. A connection is turned into a
 * `Transport` by `net/wsTransport.ts` and handed to a `Room` (`room.ts`), and
 * the room is the same object the browser runs behind a loopback for
 * single-player. Everything Node-specific — the HTTP server, the upgrade,
 * `ws`, the origin policy, `randomUUID` — lives on this side of that line and
 * nothing on the other side of it may reach back over.
 *
 * ## The three timers, and why they are three
 *
 * They answer questions at rates three orders of magnitude apart, so one loop
 * running at the fastest of them would be two thirds waste.
 *
 * - **The tick scheduler** (`scheduler.ts`), ~62.5 Hz: how far has wall-clock
 *   moved, and therefore how many 8 ms sub-steps does every room owe. This is
 *   also where each room's housekeeping beat is spent — clock-sync pings are
 *   due five times a second and the sweep is idempotent, so there is nothing to
 *   gain from a second loop for them.
 * - **The socket heartbeat**, every 20 s: is this pipe still there. A question
 *   about TCP rather than about the game, and it costs a WebSocket ping to ask.
 * - **The jitter probe** (`jitter.ts`), at the tick interval: how late does this
 *   machine wake anything up. An instrument, kept separate from the scheduler
 *   on purpose so the scheduler can be rewritten without losing the baseline it
 *   was measured against.
 *
 * ## Joining
 *
 * `wss://host/` opens a new room and the code comes back in the welcome.
 * `wss://host/?room=ABC123` joins an existing one. A code that names no room is
 * answered with a `fault` frame naming it and a 4006 close — a socket that
 * opened and then went quiet is the one failure mode a player cannot diagnose.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import {
  CloseReason,
  DEFAULT_MATCH_RULES,
  NEW_MATCH_SCORE,
  PROTOCOL_VERSION,
  createDemoRecorder,
  type MatchRules,
  type MatchScore,
} from '@gladiator/sim'
import { WebSocketServer, type WebSocket } from 'ws'

import { systemClock, type Clock } from './clock.ts'
import type { ServerConfig } from './config.ts'
import { writeDemoFile } from './demoFile.ts'
import { createTrafficMeter, healthReport, readinessOf, type Readiness } from './health.ts'
import { createJitterProbe, type JitterProbe } from './jitter.ts'
import { createLogger, type Log } from './log.ts'
import { startHostLoop, systemScheduler, type Scheduler } from './loop.ts'
import { createOriginPolicy } from './origin.ts'
import { SERVER_MAP, SERVER_MAP_HASH, SERVER_PLAN } from './map.ts'
import { wsTransport } from './net/wsTransport.ts'
import { createRoom, type Room } from './room.ts'
import { normalizeRoomCode } from './roomCode.ts'
import { createRoomRegistry, seedForRoom, type RoomRegistry } from './rooms.ts'
import { createResumeAuthority, type ResumeAuthority } from './resume.ts'
import { createTickScheduler, type Timer, type TickScheduler } from './scheduler.ts'
import { CLOSE_NO_SUCH_ROOM } from './session.ts'
import { DRAIN_RETRY_AFTER_MS } from './shutdown.ts'

/** How often to ping an idle socket, to notice a peer that has gone away. */
const HEARTBEAT_MS = 20_000

/** The query parameter a client puts a room code in. */
export const ROOM_QUERY_PARAM = 'room'

/** The query parameter a reconnecting client puts its resume ticket in. */
export const RESUME_QUERY_PARAM = 'resume'

export type GladiatorServer = {
  readonly http: Server
  readonly wss: WebSocketServer
  /** The port actually bound, which is not `config.port` when that is 0. */
  readonly port: number
  readonly sessions: number
  /** The rooms this machine is holding. */
  readonly rooms: RoomRegistry
  readonly scheduler: TickScheduler
  /** This machine's ticket authority, for the drain. `resume.ts`. */
  readonly resume: ResumeAuthority
  /**
   * Stop accepting: `/healthz` turns 503 and new upgrades are refused.
   *
   * Idempotent, and deliberately *not* the same thing as closing — the sockets
   * already open are untouched, because the reason to stop accepting is almost
   * always that this machine is leaving and the matches on it need the time.
   * `shutdown.ts` is what calls it and what does the rest.
   */
  beginDraining(): void
  readonly draining: boolean
  /** Whether new players should be sent here, and why not. `health.ts`. */
  readiness(): Readiness
  close(): Promise<void>
}

export type StartOptions = {
  readonly config: ServerConfig
  /** Injected so tests can run without a live timer. */
  readonly jitter?: JitterProbe
  /** Injected, because `Room` is not allowed to read one. `clock.ts`. */
  readonly clock?: Clock
  /** Injected, because nothing that holds a world may hold a timer. `loop.ts`. */
  readonly scheduler?: Scheduler
  /** The tick scheduler's one-shot timer. `scheduler.ts`. */
  readonly timer?: Timer
  /** Injected so a test can pin the codes it is about to type back in. */
  readonly random?: () => number
  /**
   * The match every room on this machine plays. The Rocket Arena best-of-five
   * unless something says otherwise.
   *
   * A property of the *server* rather than of a room, because v1 has one map
   * and one format and the room registry has nothing to choose between. Which
   * rules a room gets to pick — rounds to win, the self-damage mode — is a
   * settings question and belongs to GLAD-NPCTU8; this is the seam it grows
   * out of.
   */
  readonly rules?: MatchRules
  /** Where events go. One JSON object per line; `log.ts`. */
  readonly log?: Log
}

/**
 * The room code a request is asking for, or `null` for "open me a new one".
 *
 * Read off the query string rather than the path, because the path is what a
 * proxy rewrites and the query is what it forwards. The base is a throwaway:
 * `request.url` on a server is origin-form, and `URL` needs *some* origin to
 * parse against.
 */
export function roomCodeOf(url: string | undefined): string | null {
  return queryOf(url, ROOM_QUERY_PARAM)
}

/** The resume ticket a reconnecting client is presenting, or `null`. */
export function resumeTicketOf(url: string | undefined): string | null {
  return queryOf(url, RESUME_QUERY_PARAM)
}

function queryOf(url: string | undefined, name: string): string | null {
  if (url === undefined) return null
  const query = new URL(url, 'http://gladiator.invalid').searchParams.get(name)
  return query === null || query === '' ? null : query
}

export function startServer(options: StartOptions): Promise<GladiatorServer> {
  const { config } = options
  const log =
    options.log ??
    createLogger({
      write: (line) => console.log(line),
      time: () => Date.now(),
      context: { build: config.build },
    })
  const jitter = options.jitter ?? createJitterProbe()
  const clock = options.clock ?? systemClock()
  const beats = options.scheduler ?? systemScheduler()
  const isOriginAllowed = createOriginPolicy(config)
  const startedAtMs = clock.nowMs()
  const rules = options.rules ?? DEFAULT_MATCH_RULES
  const traffic = createTrafficMeter()
  const resume = createResumeAuthority({ secret: config.resumeSecret, rules })

  /**
   * Whether this machine is on its way out.
   *
   * One boolean read from three places — the health endpoint, the upgrade
   * handler and the drain itself — because "should a new player be sent here"
   * and "is this process leaving" have to be the same question or a deploy
   * will race itself.
   */
  let draining = false

  const connections = new Map<WebSocket, { alive: boolean }>()

  /**
   * Write a room's recording out, if this deploy is recording.
   *
   * Every way a room can end funnels through the registry's `onClosing`, so
   * this is one hook rather than one per ending — and it is wrapped there, so a
   * full disk costs a log line rather than the rest of the shutdown.
   */
  const keepDemo = (code: string, room: Room): void => {
    if (config.demoDir === null) return
    const demo = room.demo()
    if (demo === null || demo.frames.length === 0) return
    const path = writeDemoFile(config.demoDir, demo, Date.now())
    log('demo.written', {
      room: code,
      tick: room.tick,
      path,
      frames: demo.frames.length,
      samples: demo.trace.length,
    })
  }

  const rooms: RoomRegistry = createRoomRegistry({
    clock,
    log,
    onClosing: keepDemo,
    ...(options.random === undefined ? {} : { random: options.random }),
    create: (code: string, score: MatchScore): Room =>
      createRoom({
        score,
        map: SERVER_MAP,
        // Shared, because it is a function of the map and every room on this
        // machine plays the same one. `map.ts`.
        plan: SERVER_PLAN,
        clock,
        build: config.build,
        id: code,
        // The room's own code, hashed. Every match therefore flips its own
        // coins — which pair of spawns a round starts on, and which end each
        // player gets — rather than every room on the machine replaying the
        // same sequence. `rooms.ts`.
        seed: seedForRoom(code),
        rules,
        peerId: () => randomUUID(),
        log,
        // A recording is the command stream this room executes. Only when this
        // deploy asked for one — `config.demoDir`, `demoFile.ts`.
        ...(config.demoDir === null
          ? {}
          : {
              recorder: createDemoRecorder({
                build: config.build,
                room: code,
                map: { name: SERVER_MAP.source.name, hash: SERVER_MAP_HASH },
                seed: seedForRoom(code),
                protocol: PROTOCOL_VERSION,
                rules,
                // Carried into the header rather than left implicit: a room
                // rebuilt after a deploy starts its match at a score, and a
                // replay that started at nil-nil would diverge from its own
                // trace on the first sample. `sim/src/demo.ts`.
                ...(score === NEW_MATCH_SCORE ? {} : { score }),
              }),
            }),
      }),
  })

  // One timer for every world on the machine. It measures how much wall-clock
  // actually went past, folds that into whole 8 ms sub-steps, and hands the
  // count to every room — see `scheduler.ts` for why it aims at boundaries
  // rather than sleeping an interval, and what it does after a stall.
  const ticks = createTickScheduler({
    clock,
    ...(options.timer === undefined ? {} : { timer: options.timer }),
    onFrame: (frame) => {
      rooms.advance(frame.steps)
      rooms.sweep(frame.nowMs)
    },
  })

  const readiness = (): Readiness =>
    readinessOf({ draining, rooms: rooms.stats(), scheduler: ticks.stats(), nowMs: clock.nowMs() })

  const http = createServer((request, response) => {
    if (request.url === '/healthz') {
      const report = healthReport({
        draining,
        rooms: rooms.stats(),
        scheduler: ticks.stats(),
        nowMs: clock.nowMs(),
        build: config.build,
        map: { name: SERVER_MAP.source.name, hash: SERVER_MAP_HASH },
        startedAtMs,
        sessions: connections.size,
        jitter: jitter.snapshot(),
        traffic: traffic.stats,
        canResume: resume.enabled,
        // Whether this machine is recording matches, so "did the demo capture
        // I turned on actually take" is answerable with curl rather than by
        // waiting for a room to close. `docs/deploy.md`.
        recording: config.demoDir !== null,
      })
      response.writeHead(report.status, { 'content-type': 'application/json' })
      response.end(report.body)
      return
    }
    // Liveness, and it never fails on purpose: the only correct response to it
    // failing is to kill the process, and a machine that is merely draining or
    // full is a machine holding duels that must not be killed. `health.ts`.
    if (request.url === '/livez') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ alive: true, build: config.build, draining }))
      return
    }
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(`gladiator server, build ${config.build}, protocol ${PROTOCOL_VERSION}\n`)
      return
    }
    response.writeHead(404, { 'content-type': 'text/plain' })
    response.end('not found\n')
  })

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxPayloadBytes,
    // Compressing frames this small costs a memory allocation and a CPU burst
    // per message to save a handful of bytes. It is pure latency.
    perMessageDeflate: false,
  })

  const rejectUpgrade = (
    socket: Duplex,
    status: number,
    reason: string,
    headers: readonly string[] = [],
  ) => {
    const extra = headers.length > 0 ? `${headers.join('\r\n')}\r\n` : ''
    socket.write(`HTTP/1.1 ${status} ${reason}\r\n${extra}Connection: close\r\n\r\n`)
    socket.destroy()
  }

  http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    // Checked before the origin, because it is the more decisive of the two and
    // because a draining machine has nothing to gain from telling a stranger
    // what it thinks of their origin. `Retry-After` is in seconds by the HTTP
    // spec, and it is the same number the drain frame carries in milliseconds.
    if (draining) {
      log('upgrade refused: draining')
      rejectUpgrade(socket, 503, 'Service Unavailable', [
        `Retry-After: ${Math.ceil(DRAIN_RETRY_AFTER_MS / 1000)}`,
      ])
      return
    }

    const verdict = isOriginAllowed(request.headers.origin)
    if (!verdict.allowed) {
      // Logged, because "the preview deploy cannot connect" is otherwise a
      // silent failure that looks exactly like the server being down.
      log('upgrade.refused', { level: 'warn', reason: verdict.reason })
      rejectUpgrade(socket, 403, 'Forbidden')
      return
    }

    // Nagle's algorithm holds a small write back waiting for company. Every
    // frame this server sends is small and every one of them is urgent.
    // (`upgrade` is typed as a `Duplex`; over TCP it is always a `Socket`.)
    if (socket instanceof Socket) socket.setNoDelay(true)

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request)
    })
  })

  /**
   * Tell a socket why it is not getting a room, and close it.
   *
   * A frame and then a close code, in that order and always both. The frame is
   * what the player reads (`client/net/client.ts` prints a fault verbatim); the
   * code is what a reconnect policy will branch on (GLAD-DVDV6P). A socket that
   * simply went quiet is the one outcome nobody can diagnose, which is the whole
   * of this ticket's "not a hang".
   */
  const refuse = (socket: WebSocket, code: string, detail: string, closeCode: number): void => {
    socket.send(JSON.stringify({ t: 'fault', code, detail }))
    socket.close(closeCode, code)
  }

  wss.on('connection', (socket: WebSocket, request: IncomingMessage) => {
    connections.set(socket, { alive: true })

    // `pong` is the one socket event the room has no opinion about: it is the
    // liveness of the *pipe*, which is exactly what a transport abstracts away.
    socket.on('pong', () => {
      const connection = connections.get(socket)
      if (connection !== undefined) connection.alive = true
    })
    socket.on('close', () => {
      connections.delete(socket)
    })
    socket.on('error', () => {
      connections.delete(socket)
      socket.terminate()
    })

    const asked = roomCodeOf(request.url)
    if (asked === null) {
      const opened = rooms.create()
      if (opened === null) {
        refuse(
          socket,
          'server-full',
          'this server is holding as many matches as it can; try again in a minute',
          CloseReason.TryAgainLater,
        )
        return
      }
      opened.room.join(wsTransport(socket, traffic))
      return
    }

    // A ticket is only ever consulted for the room it names, and only ever
    // *after* the live registry has been asked. A match still running on this
    // machine is the truth about its own score; a ticket is what is left when
    // there is no match to ask. `resume.ts`.
    const ticket = resumeTicketOf(request.url)
    const claim = ticket === null ? null : resume.verify(ticket)
    if (claim !== null && !claim.ok) log(`resume refused: ${claim.reason}`)
    const resumed =
      claim !== null && claim.ok && claim.claim.room === normalizeRoomCode(asked)
        ? claim.claim
        : null

    const found =
      rooms.get(asked) ?? (resumed === null ? null : rooms.adopt(resumed.room, resumed.score))
    if (found === null) {
      // Both "that is not a code" and "that code names no room" land here, and
      // they are deliberately one sentence. Telling a guesser which of the two
      // they hit is telling them their character set is right.
      const shown = normalizeRoomCode(asked) ?? asked.slice(0, 16)
      log('join.no_such_room', { level: 'warn', room: shown })
      refuse(
        socket,
        'no-such-room',
        `there is no match with the code ${shown} — check it, or ask for a new link`,
        CLOSE_NO_SUCH_ROOM,
      )
      return
    }

    found.room.join(wsTransport(socket, traffic), resumed?.slot)
  })

  // The socket heartbeat: is this pipe still there. A question about TCP, at a
  // rate that has nothing to do with the game's, which is why it is not folded
  // into the tick scheduler's frame.
  const heartbeat = startHostLoop({
    scheduler: beats,
    clock,
    intervalMs: HEARTBEAT_MS,
    beat: () => {
      for (const [socket, connection] of connections) {
        if (!connection.alive) {
          socket.terminate()
          connections.delete(socket)
          continue
        }
        connection.alive = false
        socket.ping()
      }
    },
  })

  ticks.start()
  jitter.start()

  return new Promise((resolve, reject) => {
    http.once('error', reject)
    http.listen(config.port, () => {
      const address = http.address()
      const port = typeof address === 'object' && address !== null ? address.port : config.port
      resolve({
        http,
        wss,
        port,
        rooms,
        scheduler: ticks,
        resume,
        get sessions() {
          return connections.size
        },
        get draining() {
          return draining
        },
        beginDraining() {
          if (draining) return
          draining = true
          log('draining: /healthz is now 503 and new upgrades are refused')
        },
        readiness,
        close: () =>
          new Promise<void>((done) => {
            heartbeat.stop()
            ticks.stop()
            jitter.stop()
            // "Going away" is what a browser is told when a server is shutting
            // down cleanly, and it is what lets a client tell a deploy apart
            // from a crash. Said twice on purpose: once to every room's peers
            // through their transports, and once to any socket that never got
            // as far as a room.
            rooms.closeAll(CloseReason.GoingAway, 'server shutting down')
            for (const socket of connections.keys()) {
              socket.close(CloseReason.GoingAway, 'server shutting down')
            }
            wss.close(() => http.close(() => done()))
          }),
      })
    })
  })
}
