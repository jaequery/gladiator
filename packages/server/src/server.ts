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
  PROTOCOL_VERSION,
  createDemoRecorder,
  type MatchRules,
} from '@gladiator/sim'
import { WebSocketServer, type WebSocket } from 'ws'

import { systemClock, type Clock } from './clock.ts'
import type { ServerConfig } from './config.ts'
import { writeDemoFile } from './demoFile.ts'
import { createJitterProbe, type JitterProbe } from './jitter.ts'
import { createLogger, type Log } from './log.ts'
import { startHostLoop, systemScheduler, type Scheduler } from './loop.ts'
import { createOriginPolicy } from './origin.ts'
import { SERVER_MAP, SERVER_MAP_HASH, SERVER_PLAN } from './map.ts'
import { wsTransport } from './net/wsTransport.ts'
import { createRoom, type Room } from './room.ts'
import { normalizeRoomCode } from './roomCode.ts'
import { createRoomRegistry, seedForRoom, type RoomRegistry } from './rooms.ts'
import { createTickScheduler, type Timer, type TickScheduler } from './scheduler.ts'
import { CLOSE_NO_SUCH_ROOM } from './session.ts'

/** How often to ping an idle socket, to notice a peer that has gone away. */
const HEARTBEAT_MS = 20_000

/** The query parameter a client puts a room code in. */
export const ROOM_QUERY_PARAM = 'room'

export type GladiatorServer = {
  readonly http: Server
  readonly wss: WebSocketServer
  /** The port actually bound, which is not `config.port` when that is 0. */
  readonly port: number
  readonly sessions: number
  /** The rooms this machine is holding. */
  readonly rooms: RoomRegistry
  readonly scheduler: TickScheduler
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
  if (url === undefined) return null
  const query = new URL(url, 'http://gladiator.invalid').searchParams.get(ROOM_QUERY_PARAM)
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
  const startedAtMs = Date.now()

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
    create: (code: string): Room =>
      createRoom({
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
        ...(options.rules === undefined ? {} : { rules: options.rules }),
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
                ...(options.rules === undefined ? {} : { rules: options.rules }),
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

  const http = createServer((request, response) => {
    if (request.url === '/healthz') {
      const body = JSON.stringify({
        ok: true,
        build: config.build,
        protocol: PROTOCOL_VERSION,
        // Served so that "is the client on the right arena" is answerable with
        // curl, without opening a socket and reading a welcome frame.
        map: { name: SERVER_MAP.source.name, hash: SERVER_MAP_HASH },
        uptimeSeconds: Math.round((Date.now() - startedAtMs) / 1000),
        sessions: connections.size,
        rooms: rooms.stats(),
        // Served, not just logged. The p99 on the machine that is actually
        // running is the only one worth quoting, it changes under load, and
        // `scheduler.withinBudget` is the deploy's own verdict on whether this
        // machine class can hold a tick rate. `docs/deploy.md`.
        scheduler: ticks.stats(),
        jitter: jitter.snapshot(),
        // Whether this machine is recording matches, so "did the demo capture
        // I turned on actually take" is answerable with curl rather than by
        // waiting for a room to close. `docs/deploy.md`.
        recording: config.demoDir !== null,
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
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

  const rejectUpgrade = (socket: Duplex, status: number, reason: string) => {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
  }

  http.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
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
      opened.room.join(wsTransport(socket))
      return
    }

    const found = rooms.get(asked)
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

    found.room.join(wsTransport(socket))
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
        get sessions() {
          return connections.size
        },
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
