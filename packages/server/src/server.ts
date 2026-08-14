/**
 * The HTTP and WebSocket server.
 *
 * Split from `index.ts` so the tests can start a real one on an ephemeral port
 * and talk to it over a real socket. Everything this ticket claims about the
 * deployed system — that the shared simulation agrees, that a version mismatch
 * is readable, that a disallowed origin is refused — is asserted against *this*,
 * not against a mock.
 *
 * The tick scheduler, room registry and connection lifecycle are GLAD-FHKBN8
 * and GLAD-DVDV6P. Here a session is created on connect and forgotten on close.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { randomUUID } from 'node:crypto'
import { Socket } from 'node:net'
import type { Duplex } from 'node:stream'

import { PROTOCOL_VERSION, type ServerMessage } from '@gladiator/sim'
import { WebSocketServer, type WebSocket } from 'ws'

import type { ServerConfig } from './config.ts'
import { createJitterProbe, type JitterProbe } from './jitter.ts'
import { createOriginPolicy } from './origin.ts'
import { SERVER_MAP, SERVER_MAP_HASH } from './map.ts'
import { applyFrame, createSession, type ServerIdentity, type SessionState } from './session.ts'

/** How often to ping an idle socket, to notice a peer that has gone away. */
const HEARTBEAT_MS = 20_000

export type GladiatorServer = {
  readonly http: Server
  readonly wss: WebSocketServer
  /** The port actually bound, which is not `config.port` when that is 0. */
  readonly port: number
  readonly sessions: number
  close(): Promise<void>
}

type Connection = {
  session: SessionState
  alive: boolean
}

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return
  socket.send(JSON.stringify(message))
}

export type StartOptions = {
  readonly config: ServerConfig
  /** Injected so tests can run without a live timer. */
  readonly jitter?: JitterProbe
  readonly log?: (line: string) => void
}

export function startServer(options: StartOptions): Promise<GladiatorServer> {
  const { config } = options
  const log = options.log ?? ((line: string) => console.log(line))
  const jitter = options.jitter ?? createJitterProbe()
  const isOriginAllowed = createOriginPolicy(config)
  // Which commit and which world. Both are fixed for the life of the process:
  // the map is bundled, so a server cannot start holding one map and finish
  // holding another.
  const identity: ServerIdentity = { build: config.build, mapHash: SERVER_MAP_HASH }
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
    const connection: Connection = { session: createSession(randomUUID()), alive: true }
    connections.set(socket, connection)

    socket.on('pong', () => {
      connection.alive = true
    })

    socket.on('message', (data: unknown, isBinary: boolean) => {
      if (isBinary) {
        send(socket, { t: 'fault', code: 'binary', detail: 'this protocol is JSON text' })
        socket.close(4002, 'binary frame')
        return
      }
      const step = applyFrame(connection.session, String(data), identity)
      connection.session = step.session
      for (const reply of step.replies) send(socket, reply)
      if (step.close !== undefined) socket.close(step.close.code, step.close.reason)
    })

    socket.on('close', () => {
      connections.delete(socket)
    })

    socket.on('error', () => {
      connections.delete(socket)
      socket.terminate()
    })
  })

  const heartbeat = setInterval(() => {
    for (const [socket, connection] of connections) {
      if (!connection.alive) {
        socket.terminate()
        connections.delete(socket)
        continue
      }
      connection.alive = false
      socket.ping()
    }
  }, HEARTBEAT_MS)
  // The heartbeat must never be the thing keeping the process alive.
  heartbeat.unref()

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
            clearInterval(heartbeat)
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
