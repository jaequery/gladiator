/**
 * The HTTP and WebSocket server: the Node *edge* around the host.
 *
 * Split from `index.ts` so the tests can start a real one on an ephemeral port
 * and talk to it over a real socket. Everything this ticket claims about the
 * deployed system — that the shared simulation agrees, that a version mismatch
 * is readable, that a disallowed origin is refused — is asserted against *this*,
 * not against a mock.
 *
 * What this file is *not* is the host. A connection is turned into a
 * `Transport` by `net/wsTransport.ts` and handed to a `Room` (`room.ts`), and
 * the room is the same object the browser runs behind a loopback for
 * single-player. Everything Node-specific — the HTTP server, the upgrade,
 * `ws`, the origin policy, `randomUUID` — lives on this side of that line and
 * nothing on the other side of it may reach back over.
 *
 * The tick scheduler and the room registry are GLAD-FHKBN8; the connection
 * lifecycle is GLAD-DVDV6P. Here one connection gets one single-seat room,
 * created on connect and forgotten on close.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import { PROTOCOL_VERSION } from '@gladiator/sim'
import { WebSocketServer, type WebSocket } from 'ws'

import { systemClock, type Clock } from './clock.ts'
import type { ServerConfig } from './config.ts'
import { createJitterProbe, type JitterProbe } from './jitter.ts'
import { startHostLoop, systemScheduler, type Scheduler } from './loop.ts'
import { createOriginPolicy } from './origin.ts'
import { SERVER_MAP, SERVER_MAP_HASH } from './map.ts'
import { wsTransport } from './net/wsTransport.ts'
import { createRoom, type Room } from './room.ts'

/** How often to ping an idle socket, to notice a peer that has gone away. */
const HEARTBEAT_MS = 20_000

/**
 * How often a room is given a beat, in milliseconds.
 *
 * A `Room` holds no timer of its own (`loop.ts`), so `sweep` is where its
 * housekeeping happens — and since GLAD-5995PA that includes minting clock-sync
 * pings, which are due five times a second. Twenty hertz, rather than exactly
 * the ping interval, so a beat that arrives a millisecond late does not push the
 * next ping a whole interval out and leave the cadence alternating.
 *
 * Beating a room and *ticking* it are different things, and this is only the
 * first: the 125 Hz scheduler that advances a room's world is GLAD-FHKBN8, and
 * it replaces this loop rather than joining it.
 */
const ROOM_BEAT_MS = 50

export type GladiatorServer = {
  readonly http: Server
  readonly wss: WebSocketServer
  /** The port actually bound, which is not `config.port` when that is 0. */
  readonly port: number
  readonly sessions: number
  close(): Promise<void>
}

type Connection = {
  room: Room
  alive: boolean
}

export type StartOptions = {
  readonly config: ServerConfig
  /** Injected so tests can run without a live timer. */
  readonly jitter?: JitterProbe
  /** Injected, because `Room` is not allowed to read one. `clock.ts`. */
  readonly clock?: Clock
  /** Injected, because nothing that holds a world may hold a timer. `loop.ts`. */
  readonly scheduler?: Scheduler
  readonly log?: (line: string) => void
}

export function startServer(options: StartOptions): Promise<GladiatorServer> {
  const { config } = options
  const log = options.log ?? ((line: string) => console.log(line))
  const jitter = options.jitter ?? createJitterProbe()
  const clock = options.clock ?? systemClock()
  const scheduler = options.scheduler ?? systemScheduler()
  const isOriginAllowed = createOriginPolicy(config)
  const startedAtMs = Date.now()

  const connections = new Map<WebSocket, Connection>()

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
        // Served, not just logged: the p99 on the machine that is actually
        // running is the only one worth quoting, and it changes under load.
        jitter: jitter.snapshot(),
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
      log(`upgrade refused: ${verdict.reason}`)
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

  wss.on('connection', (socket: WebSocket) => {
    // One connection, one single-seat room. Which commit and which world are
    // fixed for the life of the process: the map is bundled, so a server
    // cannot start holding one map and finish holding another. Rooms that
    // outlive a connection and seat two players are GLAD-FHKBN8.
    const room = createRoom({
      map: SERVER_MAP,
      clock,
      build: config.build,
      peerId: () => randomUUID(),
      log,
    })
    const connection: Connection = { room, alive: true }
    connections.set(socket, connection)

    // `pong` is the one socket event the room has no opinion about: it is the
    // liveness of the *pipe*, which is exactly what a transport abstracts away.
    socket.on('pong', () => {
      connection.alive = true
    })
    socket.on('close', () => {
      connections.delete(socket)
    })
    socket.on('error', () => {
      connections.delete(socket)
      socket.terminate()
    })

    room.join(wsTransport(socket))
  })

  // The timers. `Room` never holds one — see `loop.ts` — so both beats are
  // handed to it, and the same room runs in a browser tab with no timer at all.
  //
  // Two of them, because they answer different questions at very different
  // rates. This one asks "is this socket still there", which is a question
  // about the pipe and costs a WebSocket ping to ask.
  const heartbeat = startHostLoop({
    scheduler,
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

  // And this one is the room's own housekeeping: peers that have gone quiet,
  // and the clock-sync pings, which are due five times a second. A room is
  // swept at most once per beat however many peers it is holding — `sweep` is
  // idempotent, but doing it twice would mint two pings for one interval.
  const rooms = startHostLoop({
    scheduler,
    clock,
    intervalMs: ROOM_BEAT_MS,
    beat: (nowMs) => {
      const swept = new Set<Room>()
      for (const connection of connections.values()) {
        if (swept.has(connection.room)) continue
        swept.add(connection.room)
        connection.room.sweep(nowMs)
      }
    },
  })

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
        get sessions() {
          return connections.size
        },
        close: () =>
          new Promise<void>((done) => {
            heartbeat.stop()
            rooms.stop()
            jitter.stop()
            // 1001 "going away" is what a browser is told when a server is
            // shutting down cleanly, and it is what lets a client tell a deploy
            // apart from a crash.
            for (const socket of connections.keys()) socket.close(1001, 'server shutting down')
            wss.close(() => http.close(() => done()))
          }),
      })
    })
  })
}
