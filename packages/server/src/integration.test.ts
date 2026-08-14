/**
 * The ticket's acceptance criteria, against a real server on a real socket.
 *
 * Everything here starts `startServer` on an ephemeral port and talks to it
 * with the same `ws` a browser's `WebSocket` speaks to. The point is that the
 * claims being made are about a *deployed* system, and a mock cannot be wrong
 * about TLS, framing, close codes or an origin header.
 */
import { randomUUID } from 'node:crypto'

import {
  PROTOCOL_VERSION,
  SPAWN_STATE,
  TICK_RATE,
  type PlayerState,
  type ServerMessage,
  type UserCmd,
  describeVersionMismatch,
  encodeCmd,
  hashPlayerState,
  parseServerMessage,
  pmove,
} from '@gladiator/sim'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { readConfig } from './config.ts'
import { startServer, type GladiatorServer } from './server.ts'
import { CLOSE_VERSION_MISMATCH } from './session.ts'

const ALLOWED_ORIGIN = 'http://localhost:5173'

let running: GladiatorServer | null = null

afterEach(async () => {
  await running?.close()
  running = null
})

async function start(): Promise<GladiatorServer> {
  running = await startServer({
    // Port 0: the OS picks a free one, so the suite never collides with a
    // developer's own `pnpm dev`.
    config: { ...readConfig({ PORT: '0' }), allowedOrigins: [ALLOWED_ORIGIN] },
    log: () => undefined,
  })
  return running
}

/** `null` means "send no Origin header at all", which is its own test case. */
function connect(port: number, origin: string | null = ALLOWED_ORIGIN): WebSocket {
  return new WebSocket(`ws://127.0.0.1:${port}`, {
    ...(origin === null ? {} : { headers: { Origin: origin } }),
  })
}

/** A movement script: turning, strafing and jumping, so the state keeps moving. */
function scriptedCommand(tick: number): UserCmd {
  return {
    forwardMove: tick % 240 < 200 ? 1 : -1,
    sideMove: tick % 130 < 65 ? 1 : -1,
    // A slow continuous turn, so every quadrant of the trig gets exercised.
    yaw: (tick * 37) % 65536,
    pitch: 0,
    buttons: tick % 90 === 0 ? 1 : 0,
  }
}

describe('http surface', () => {
  it('answers /healthz with the build, the protocol and the measured jitter', async () => {
    const server = await start()
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`)
    expect(response.status).toBe(200)

    const body = (await response.json()) as Record<string, unknown>
    expect(body['ok']).toBe(true)
    expect(body['protocol']).toBe(PROTOCOL_VERSION)
    expect(body['build']).toBe('dev')
    // Fly's health check reads this endpoint; the jitter number riding along
    // means the p99 on the machine actually serving players is one curl away.
    expect(body['jitter']).toMatchObject({ intervalMs: 8 })
  })

  it('answers / so a deploy can be smoke-tested with curl', async () => {
    const server = await start()
    const response = await fetch(`http://127.0.0.1:${server.port}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('gladiator server')
  })

  it('404s anything else', async () => {
    const server = await start()
    expect((await fetch(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404)
  })
})

describe('origin policy at upgrade', () => {
  it('refuses an upgrade from an origin that is not allowed', async () => {
    const server = await start()
    const socket = connect(server.port, 'https://evil.example')
    const error = await new Promise<Error>((resolve) => {
      socket.on('error', resolve)
    })
    // A WebSocket upgrade triggers no preflight and is not subject to CORS, so
    // this 403 is the only thing standing between the server and any page on
    // the internet.
    expect(error.message).toContain('403')
  })

  it('refuses an upgrade with no Origin header at all', async () => {
    const server = await start()
    const socket = connect(server.port, null)
    const error = await new Promise<Error>((resolve) => {
      socket.on('error', resolve)
    })
    expect(error.message).toContain('403')
  })
})

describe('protocol version mismatch', () => {
  it('sends a message naming the build before closing', async () => {
    const server = await start()
    const socket = connect(server.port)
    await new Promise((resolve) => socket.once('open', resolve))

    const frames: ServerMessage[] = []
    socket.on('message', (data) => {
      const parsed = parseServerMessage(String(data))
      if (parsed !== null) frames.push(parsed)
    })

    socket.send(
      JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION + 1, build: 'a-stale-client' }),
    )
    const code = await new Promise<number>((resolve) => socket.once('close', resolve))

    expect(code).toBe(CLOSE_VERSION_MISMATCH)
    const mismatch = frames.find((frame) => frame.t === 'version_mismatch')
    expect(mismatch).toBeDefined()
    if (mismatch?.t !== 'version_mismatch') throw new Error('unreachable')

    // What the player actually reads. Not a silent close.
    const text = describeVersionMismatch(mismatch)
    expect(text).toContain('server is on build dev')
    expect(text).toContain('reload')
  })
})

describe('cross-environment hash agreement', () => {
  it(
    'agrees on every hash over 60 seconds of movement',
    { timeout: 60_000 },
    async () => {
      const server = await start()
      const socket = connect(server.port)
      await new Promise((resolve) => socket.once('open', resolve))

      const TICKS = TICK_RATE * 60 // 7500 — a minute of simulated play
      const ourHashes = new Map<number, number>()
      const compared: Array<{ tick: number; ours: number; theirs: number }> = []
      let welcomed = false

      const done = new Promise<void>((resolve, reject) => {
        socket.on('message', (data) => {
          const parsed = parseServerMessage(String(data))
          if (parsed === null) {
            reject(new Error(`unparseable frame: ${String(data)}`))
            return
          }
          if (parsed.t === 'welcome') {
            welcomed = true
            return
          }
          if (parsed.t !== 'hash') {
            reject(new Error(`unexpected frame: ${parsed.t}`))
            return
          }
          const ours = ourHashes.get(parsed.tick)
          if (ours === undefined) {
            reject(new Error(`server hashed tick ${parsed.tick}, which we never simulated`))
            return
          }
          compared.push({ tick: parsed.tick, ours, theirs: parsed.hash })
          if (parsed.tick >= TICKS) resolve()
        })
        socket.on('close', () => reject(new Error('socket closed before the run finished')))
      })

      socket.send(JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, build: 'test' }))

      // Simulate locally exactly as the browser does, and send the commands on
      // in frame-sized batches — the same shape of traffic a 60 Hz client makes.
      let state: PlayerState = SPAWN_STATE
      let tick = 0
      while (tick < TICKS) {
        const batch = []
        const batchStart = tick + 1
        const size = Math.min(TICKS - tick, tick % 2 === 0 ? 2 : 3)
        for (let i = 0; i < size; i += 1) {
          tick += 1
          const cmd = scriptedCommand(tick)
          state = pmove(state, cmd)
          ourHashes.set(tick, hashPlayerState(tick, state))
          batch.push(encodeCmd(cmd))
        }
        socket.send(JSON.stringify({ t: 'cmds', startTick: batchStart, cmds: batch }))
      }

      await done
      socket.close()

      expect(welcomed).toBe(true)
      expect(compared.length).toBeGreaterThan(2000)

      const disagreements = compared.filter((entry) => entry.ours !== entry.theirs)
      // Reported with the tick rather than as a bare count: a desync is only
      // debuggable if you know when it started.
      expect(disagreements.slice(0, 5)).toEqual([])
      expect(disagreements).toHaveLength(0)

      // And the run actually went somewhere, rather than agreeing about a
      // player who never moved.
      expect(Math.abs(state.origin[0]) + Math.abs(state.origin[1])).toBeGreaterThan(100)
    },
  )

  it('gives two independent sessions the same hash for the same input', async () => {
    // Two players, one deterministic world each. If these ever differ, the
    // server is carrying state between sessions that it should not.
    const server = await start()
    const hashes = await Promise.all(
      [randomUUID(), randomUUID()].map(
        async () =>
          new Promise<number>((resolve, reject) => {
            const socket = connect(server.port)
            socket.on('error', reject)
            socket.on('message', (data) => {
              const parsed = parseServerMessage(String(data))
              if (parsed?.t === 'hash') {
                resolve(parsed.hash)
                socket.close()
              }
            })
            socket.once('open', () => {
              socket.send(
                JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, build: 'test' }),
              )
              socket.send(
                JSON.stringify({
                  t: 'cmds',
                  startTick: 1,
                  cmds: Array.from({ length: 20 }, (_, i) => encodeCmd(scriptedCommand(i + 1))),
                }),
              )
            })
          }),
      ),
    )
    expect(hashes[0]).toBe(hashes[1])
  })
})
