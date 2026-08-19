/**
 * The ticket's acceptance criteria, against a real server on a real socket.
 *
 * Everything here starts `startServer` on an ephemeral port and talks to it
 * with the same `ws` a browser's `WebSocket` speaks to. The point is that the
 * claims being made are about a *deployed* system, and a mock cannot be wrong
 * about TLS, framing, close codes or an origin header.
 */
import {
  MatchPhase,
  PROTOCOL_VERSION,
  TICK_RATE,
  type GameState,
  type ServerMessage,
  type UserCmd,
  applyWireState,
  createMapState,
  describeMapMismatch,
  describeVersionMismatch,
  encodeCmd,
  findPlayer,
  hashState,
  parseServerMessage,
  tick as simTick,
} from '@gladiator/sim'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { manualClock, type ManualClock } from './clock.ts'
import { readConfig } from './config.ts'
import { SERVER_MAP, SERVER_MAP_HASH } from './map.ts'
import { ROOM_CODE_ALPHABET } from './roomCode.ts'
import { seedForRoom } from './rooms.ts'
import { manualTimer } from './scheduler.ts'
import { roomCodeOf, seatTokenOf, startServer, type GladiatorServer } from './server.ts'
import { CLOSE_MAP_MISMATCH, CLOSE_NO_SUCH_ROOM, CLOSE_VERSION_MISMATCH } from './session.ts'

const ALLOWED_ORIGIN = 'http://localhost:5173'

/**
 * The frame a real client opens with. The map hash comes from the server's own
 * module, because a test that hard-coded it would go green on the day the two
 * stopped agreeing.
 */
function helloFrame(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    build: 'test',
    mapHash: SERVER_MAP_HASH,
    ...over,
  })
}

let running: GladiatorServer | null = null

afterEach(async () => {
  await running?.close()
  running = null
})

type StartedServer = { readonly server: GladiatorServer; readonly clock: ManualClock }

/**
 * A real server, with a clock and a tick timer this file owns.
 *
 * The timer is a manual one, so the scheduler never fires by itself and a test
 * drives the world with `server.scheduler.frame()` — which is the *shipping*
 * scheduler, measuring the *shipping* accumulator against a clock this file
 * advances. A minute of duel therefore costs CI the microseconds it takes to
 * run rather than a minute. `live()` below is for the two things that can only
 * be asserted against a timer that really beats.
 */
async function start(): Promise<StartedServer> {
  const clock = manualClock()
  running = await startServer({
    // Port 0: the OS picks a free one, so the suite never collides with a
    // developer's own `pnpm dev` — or with another test file, which vitest runs
    // in a worker of its own. Set on the config rather than through
    // `readConfig({ PORT: '0' })`, which rejects a zero and hands back 8787: a
    // `PORT=0` arriving from the environment is a mistake, not a request.
    config: { ...readConfig({}), port: 0, allowedOrigins: [ALLOWED_ORIGIN] },
    clock,
    timer: manualTimer(),
    random: fixedCode(TEST_ROOM),
    log: () => undefined,
  })
  return { server: running, clock }
}

/** The same server with its real timers, for the assertions that need one. */
async function live(): Promise<GladiatorServer> {
  running = await startServer({
    config: { ...readConfig({}), port: 0, allowedOrigins: [ALLOWED_ORIGIN] },
    log: () => undefined,
  })
  return running
}

/** The code every room in this file gets, so a test can name one. */
const TEST_ROOM = 'H7K2Q9'

/** A code source that always mints `code`. `roomCode.ts`. */
function fixedCode(code: string): () => number {
  let at = 0
  return () => {
    const symbol = code[at % code.length] ?? '0'
    at += 1
    return ROOM_CODE_ALPHABET.indexOf(symbol)
  }
}

/** `null` means "send no Origin header at all", which is its own test case. */
function connect(
  port: number,
  origin: string | null = ALLOWED_ORIGIN,
  room?: string,
  token?: string,
): WebSocket {
  const query = new URLSearchParams()
  if (room !== undefined) query.set('room', room)
  // The seat key, which is what turns this from a join into a reconnect.
  // `lifecycle.ts`; the client builds the same URL in `net/client.ts`.
  if (token !== undefined) query.set('token', token)
  const search = query.size === 0 ? '' : `?${query.toString()}`
  return new WebSocket(`ws://127.0.0.1:${port}${search}`, {
    ...(origin === null ? {} : { headers: { Origin: origin } }),
  })
}

/** Spin the event loop until `check` gives an answer, or give up loudly. */
async function waitFor<T>(check: () => T | null, what: string): Promise<T> {
  for (let attempt = 0; attempt < 500_000; attempt += 1) {
    const answer = check()
    if (answer !== null) return answer
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`gave up waiting for ${what}`)
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
    weapon: 0,
  }
}

describe('the room code on the upgrade', () => {
  it('reads it off the query string, and treats an empty one as none', () => {
    // The query rather than the path, because a proxy rewrites paths and
    // forwards queries. `request.url` on a server is origin-form, which is why
    // this is a function rather than a `new URL(request.url)`.
    expect(roomCodeOf('/?room=H7K2Q9')).toBe('H7K2Q9')
    expect(roomCodeOf('/play?room=h7k-2q9&x=1')).toBe('h7k-2q9')
    expect(roomCodeOf('/')).toBeNull()
    expect(roomCodeOf('/?room=')).toBeNull()
    expect(roomCodeOf(undefined)).toBeNull()
  })

  it('does not fold the code itself', () => {
    // One place folds a code and it is `roomCode.ts`. A second opinion here
    // would be a second alphabet to keep in step.
    expect(roomCodeOf('/?room=not-a-code')).toBe('not-a-code')
  })

  it('reads a seat token off the same query string, and bounds it', () => {
    expect(seatTokenOf('/?room=H7K2Q9&token=deadbeef')).toBe('deadbeef')
    expect(seatTokenOf('/?token=')).toBeNull()
    expect(seatTokenOf('/?room=H7K2Q9')).toBeNull()
    expect(seatTokenOf(undefined)).toBeNull()
    // A token is 32 hex characters. Something far longer is not one, so it is
    // not read as one — the cheapest way to make a server do pointless work is
    // to hand it a megabyte where it expected thirty-two bytes.
    expect(seatTokenOf(`/?token=${'a'.repeat(500)}`)).toBeNull()
  })
})

describe('http surface', () => {
  it('answers /healthz with the build, the protocol and the measured jitter', async () => {
    const { server } = await start()
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
    const { server } = await start()
    const response = await fetch(`http://127.0.0.1:${server.port}/`)
    expect(response.status).toBe(200)
    expect(await response.text()).toContain('gladiator server')
  })

  it('404s anything else', async () => {
    const { server } = await start()
    expect((await fetch(`http://127.0.0.1:${server.port}/nope`)).status).toBe(404)
  })
})

describe('origin policy at upgrade', () => {
  it('refuses an upgrade from an origin that is not allowed', async () => {
    const { server } = await start()
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
    const { server } = await start()
    const socket = connect(server.port, null)
    const error = await new Promise<Error>((resolve) => {
      socket.on('error', resolve)
    })
    expect(error.message).toContain('403')
  })
})

describe('protocol version mismatch', () => {
  it('sends a message naming the build before closing', async () => {
    const { server } = await start()
    const socket = connect(server.port)
    await new Promise((resolve) => socket.once('open', resolve))

    const frames: ServerMessage[] = []
    socket.on('message', (data) => {
      const parsed = parseServerMessage(String(data))
      if (parsed !== null) frames.push(parsed)
    })

    socket.send(
      helloFrame({ protocol: PROTOCOL_VERSION + 1, build: 'a-stale-client' }),
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

describe('map mismatch', () => {
  it('refuses to play with a client holding a different arena', async () => {
    // A cached browser bundle may outlive the Fly image that served it. A
    // browser holding yesterday's map and a server holding today's would
    // simulate different worlds from identical inputs — and every symptom of
    // that points at the netcode.
    const { server } = await start()
    const socket = connect(server.port)
    await new Promise((resolve) => socket.once('open', resolve))

    const frames: ServerMessage[] = []
    socket.on('message', (data) => {
      const parsed = parseServerMessage(String(data))
      if (parsed !== null) frames.push(parsed)
    })

    socket.send(helloFrame({ mapHash: '00000000' }))
    const code = await new Promise<number>((resolve) => socket.once('close', resolve))

    expect(code).toBe(CLOSE_MAP_MISMATCH)
    const mismatch = frames.find((frame) => frame.t === 'map_mismatch')
    if (mismatch?.t !== 'map_mismatch') throw new Error('expected a map_mismatch frame')
    expect(mismatch.serverMapHash).toBe(SERVER_MAP_HASH)
    expect(mismatch.clientMapHash).toBe('00000000')
    expect(describeMapMismatch(mismatch)).toContain('reload')
  })

  it('welcomes a client on the same arena, and names it in the welcome', async () => {
    const { server } = await start()
    const socket = connect(server.port)
    await new Promise((resolve) => socket.once('open', resolve))

    const welcome = await new Promise<ServerMessage | null>((resolve) => {
      socket.once('message', (data) => resolve(parseServerMessage(String(data))))
      socket.send(helloFrame())
    })
    socket.close()

    if (welcome?.t !== 'welcome') throw new Error('expected a welcome frame')
    expect(welcome.mapHash).toBe(SERVER_MAP_HASH)
  })

  it('serves the map it is authoritative over on /healthz', async () => {
    const { server } = await start()
    const response = await fetch(`http://127.0.0.1:${server.port}/healthz`)
    const body = (await response.json()) as { map?: { name?: string; hash?: string } }
    expect(body.map?.name).toBe(SERVER_MAP.source.name)
    expect(body.map?.hash).toBe(SERVER_MAP_HASH)
  })
})

describe('cross-environment hash agreement', () => {
  it(
    'agrees on every hash over 60 seconds of movement',
    { timeout: 120_000 },
    async () => {
      const { server, clock } = await start()
      const socket = connect(server.port)
      await new Promise((resolve) => socket.once('open', resolve))

      const TICKS = TICK_RATE * 60 // 7500 — a minute of simulated play
      const ourHashes = new Map<number, number>()
      const compared: Array<{ tick: number; ours: number; theirs: number }> = []
      const snapshots: Array<{ tick: number; hash: number }> = []
      // One world the snapshots are decoded into, reused. Every field of it is
      // overwritten by `applyWireState` before anything reads one.
      const rebuilt: GameState = createMapState(SERVER_MAP.source, seedForRoom(TEST_ROOM))
      let welcomed = false
      let failure: Error | null = null

      socket.on('message', (data) => {
        const parsed = parseServerMessage(String(data))
        if (parsed === null) {
          failure = new Error(`unparseable frame: ${String(data)}`)
          return
        }
        if (parsed.t === 'welcome') {
          welcomed = true
          return
        }
        if (parsed.t === 'ping') {
          // Clock sync runs alongside the hash echo and is answered the way a
          // real client answers it. Nothing about it may touch the world —
          // which is half of what this test is asserting, since a ping that
          // advanced a tick would show up as a hash for a tick we never
          // simulated below.
          socket.send(JSON.stringify({ t: 'pong', id: parsed.id }))
          return
        }
        if (parsed.t === 'snap') {
          // The authoritative world, whole. Decoded and hashed rather than
          // counted: a snapshot that carried *nearly* the state would agree
          // with the `hash` frame beside it and disagree with the world it
          // claims to describe, and reconciliation would then build on a
          // world the server never had (GLAD-6RT64L).
          if (!applyWireState(rebuilt, parsed.state)) {
            failure = new Error('the server sent a snapshot this build cannot read')
            return
          }
          snapshots.push({ tick: rebuilt.tick, hash: hashState(rebuilt) })
          return
        }
        if (parsed.t !== 'hash') {
          failure = new Error(`unexpected frame: ${parsed.t}`)
          return
        }
        const ours = ourHashes.get(parsed.tick)
        if (ours === undefined) {
          failure = new Error(`server hashed tick ${parsed.tick}, which we never simulated`)
          return
        }
        compared.push({ tick: parsed.tick, ours, theirs: parsed.hash })
      })

      socket.send(helloFrame())
      const room = await waitFor(() => server.rooms.get(TEST_ROOM)?.room ?? null, 'the room')
      await waitFor(() => (room.peers[0]?.session.greeted === true ? true : null), 'the welcome')

      // Simulate locally exactly as the browser does, send the commands on in
      // frame-sized batches — the same shape of traffic a 60 Hz client makes —
      // and then let the *server's own scheduler* turn the wall-clock this test
      // owns into sub-steps. Every command is in the host's jitter buffer
      // before the sub-step that wants it, which is the condition a client with
      // a correct lead achieves and this one achieves by construction.
      const state: GameState = createMapState(SERVER_MAP.source, seedForRoom(TEST_ROOM))
      let tick = 0
      let offered = 0
      while (tick < TICKS) {
        const batch = []
        const batchStart = tick + 1
        const size = Math.min(TICKS - tick, tick % 2 === 0 ? 2 : 3)
        for (let i = 0; i < size; i += 1) {
          tick += 1
          const cmd = scriptedCommand(tick)
          simTick(state, [cmd], SERVER_MAP.world)
          ourHashes.set(tick, hashState(state))
          batch.push(encodeCmd(cmd))
        }
        // Wall-clock moves by exactly the simulated time in the batch, so the
        // rate limit in front of the buffer is charged the way an honest 125 Hz
        // client charges it.
        clock.advance(size * 8)
        socket.send(JSON.stringify({ t: 'cmds', startTick: batchStart, cmds: batch }))
        offered += size
        const wanted = offered
        await waitFor(
          () => (failure ?? ((room.peers[0]?.session.commands ?? 0) >= wanted ? true : null)),
          `${wanted} commands to arrive`,
        )
        if (failure !== null) throw failure
        expect(server.scheduler.frame().steps).toBe(size)
      }

      await waitFor(
        () => (failure ?? (compared.length >= TICKS / 3 ? true : null)),
        'the last hash',
      )
      if (failure !== null) throw failure
      socket.close()

      expect(welcomed).toBe(true)
      expect(compared.length).toBeGreaterThan(2000)
      expect(room.tick).toBe(TICKS)

      const disagreements = compared.filter((entry) => entry.ours !== entry.theirs)
      // Reported with the tick rather than as a bare count: a desync is only
      // debuggable if you know when it started.
      expect(disagreements.slice(0, 5)).toEqual([])
      expect(disagreements).toHaveLength(0)

      // And the snapshots describe the same world the hashes do. This is what
      // makes reconciliation possible at all: a client rebuilds its world from
      // one of these and then has to agree with the server about the hash of
      // the result. A codec that dropped one field would pass every assertion
      // above and fail every one after it (GLAD-6RT64L).
      expect(snapshots.length).toBe(compared.length)
      const wrongSnapshots = snapshots.filter((entry) => ourHashes.get(entry.tick) !== entry.hash)
      expect(wrongSnapshots.slice(0, 5)).toEqual([])

      // And the run actually went somewhere, rather than agreeing about a
      // player who never moved.
      const player = findPlayer(state, 0)
      if (player === null) throw new Error('the local world lost its player')
      expect(Math.abs(player.origin[0]) + Math.abs(player.origin[1])).toBeGreaterThan(100)
    },
  )

  it('gives two independent rooms the same hash for the same input', async () => {
    // Two players, one deterministic world each — in two rooms, because a
    // connection that names no code gets a room of its own. If these ever
    // differ, the server is carrying state between rooms that it should not.
    const { server, clock } = await start()

    const play = async (): Promise<number> => {
      const socket = connect(server.port)
      await new Promise((resolve) => socket.once('open', resolve))
      let hash: number | null = null
      socket.on('message', (data) => {
        const parsed = parseServerMessage(String(data))
        if (parsed?.t === 'hash') hash = parsed.hash
      })
      socket.send(helloFrame())
      const code = await waitFor(
        () => server.rooms.codes().find((entry) => entry !== undefined) ?? null,
        'a room',
      )
      const room = await waitFor(() => server.rooms.get(code)?.room ?? null, 'the room')
      await waitFor(() => (room.peers[0]?.session.greeted === true ? true : null), 'the welcome')

      socket.send(
        JSON.stringify({
          t: 'cmds',
          startTick: 1,
          cmds: Array.from({ length: 20 }, (_, i) => encodeCmd(scriptedCommand(i + 1))),
        }),
      )
      await waitFor(
        () => ((room.peers[0]?.session.commands ?? 0) >= 20 ? true : null),
        'the commands',
      )
      clock.advance(20 * 8)
      server.scheduler.frame()
      const answer = await waitFor(() => hash, 'the hash')
      socket.close()
      server.rooms.remove(code)
      return answer
    }

    const first = await play()
    const second = await play()
    expect(first).toBe(second)
  })
})

describe('room codes on a real socket', () => {
  it('opens a room for a connection that names none, and says which', async () => {
    const { server } = await start()
    const socket = connect(server.port)
    await new Promise((resolve) => socket.once('open', resolve))

    const welcome = await new Promise<ServerMessage | null>((resolve) => {
      socket.once('message', (data) => resolve(parseServerMessage(String(data))))
      socket.send(helloFrame())
    })
    socket.close()

    if (welcome?.t !== 'welcome') throw new Error('expected a welcome frame')
    // Six characters of Crockford base32, which is what a player is expected to
    // read out over a voice call.
    expect(welcome.room).toBe(TEST_ROOM)
    expect(server.rooms.size).toBe(1)
  })

  it('puts a second player in the room the first one made', async () => {
    const { server } = await start()
    const host = connect(server.port)
    await new Promise((resolve) => host.once('open', resolve))
    const hostWelcome = await new Promise<ServerMessage | null>((resolve) => {
      host.once('message', (data) => resolve(parseServerMessage(String(data))))
      host.send(helloFrame())
    })
    if (hostWelcome?.t !== 'welcome') throw new Error('expected a welcome frame')

    // Typed the way a person types: lower case, with the hyphen a chat client
    // helpfully inserted. `roomCode.ts` folds both.
    const typed = `${hostWelcome.room.slice(0, 3)}-${hostWelcome.room.slice(3)}`.toLowerCase()
    const guest = connect(server.port, ALLOWED_ORIGIN, typed)
    await new Promise((resolve) => guest.once('open', resolve))
    const guestWelcome = await new Promise<ServerMessage | null>((resolve) => {
      guest.once('message', (data) => resolve(parseServerMessage(String(data))))
      guest.send(helloFrame())
    })
    if (guestWelcome?.t !== 'welcome') throw new Error('expected a welcome frame')

    expect(guestWelcome.room).toBe(hostWelcome.room)
    expect(server.rooms.size).toBe(1)
    const room = server.rooms.get(hostWelcome.room)?.room
    expect(room?.peers.map((peer) => peer.slot)).toEqual([0, 1])

    host.close()
    guest.close()
  })

  it('answers an unknown room code with a fault and a close, not a hang', async () => {
    // The one failure a player cannot diagnose is a socket that opened and then
    // said nothing. A typo in a six-character code is the commonest thing that
    // can go wrong in this whole product, so it gets a sentence.
    const { server } = await start()
    const socket = connect(server.port, ALLOWED_ORIGIN, 'ZZZZZZ')

    const frames: ServerMessage[] = []
    socket.on('message', (data) => {
      const parsed = parseServerMessage(String(data))
      if (parsed !== null) frames.push(parsed)
    })
    const code = await new Promise<number>((resolve) => socket.once('close', resolve))

    expect(code).toBe(CLOSE_NO_SUCH_ROOM)
    const fault = frames.find((frame) => frame.t === 'fault')
    if (fault?.t !== 'fault') throw new Error('expected a fault frame')
    expect(fault.code).toBe('no-such-room')
    expect(fault.detail).toContain('ZZZZZZ')
    expect(server.rooms.size).toBe(0)
  })

  it('says the same thing about a code that is not a code at all', async () => {
    // Telling a guesser which of "wrong shape" and "no such room" they hit is
    // telling them their character set is right.
    const { server } = await start()
    const socket = connect(server.port, ALLOWED_ORIGIN, 'not-a-code-at-all')

    const frames: ServerMessage[] = []
    socket.on('message', (data) => {
      const parsed = parseServerMessage(String(data))
      if (parsed !== null) frames.push(parsed)
    })
    const code = await new Promise<number>((resolve) => socket.once('close', resolve))

    expect(code).toBe(CLOSE_NO_SUCH_ROOM)
    expect(frames.find((frame) => frame.t === 'fault')).toMatchObject({ code: 'no-such-room' })
  })

  it('gives a dropped player their seat back, over a second real socket', async () => {
    // The reconnect, end to end: the same URL with the seat key on it
    // (`?room=…&token=…`), through the real upgrade, the real registry and the
    // real room. Everything below the socket is unit-tested in
    // `lifecycle.test.ts`; what this proves is that the key survives the wire.
    const { server, clock } = await start()

    const host = connect(server.port)
    await new Promise((resolve) => host.once('open', resolve))
    const welcome = await new Promise<ServerMessage | null>((resolve) => {
      host.once('message', (data) => resolve(parseServerMessage(String(data))))
      host.send(helloFrame())
    })
    if (welcome?.t !== 'welcome') throw new Error('expected a welcome frame')
    expect(welcome.token).toMatch(/^[0-9a-f]{32}$/)

    const guest = connect(server.port, ALLOWED_ORIGIN, welcome.room)
    const heardLife: Array<Extract<ServerMessage, { t: 'life' }>> = []
    guest.on('message', (data) => {
      const parsed = parseServerMessage(String(data))
      if (parsed?.t === 'life') heardLife.push(parsed)
    })
    await new Promise((resolve) => guest.once('open', resolve))
    guest.send(helloFrame())
    await waitFor(() => {
      const seated = server.rooms.get(welcome.room)?.room.peers ?? []
      // Greeted, not merely connected: the match starts when both *players*
      // have arrived, and a peer mid-handshake is not one yet (`room.ts`).
      return seated.length === 2 && seated.every((peer) => peer.session.greeted) ? true : null
    }, 'both seats')

    // Start the match, put a round on the board, then pull the host's socket.
    clock.advance(16)
    server.scheduler.frame()
    const room = server.rooms.get(welcome.room)?.room
    if (room === undefined) throw new Error('the registry lost the room')
    expect(room.state.match.phase).toBe(MatchPhase.Live)
    room.state.match.wins[1] = 2

    host.close()
    await waitFor(() => (room.peers.length === 1 ? true : null), 'the host to drop')
    expect(room.seats[0]?.phase).toBe('vacant')

    // The opponent is told immediately, with a countdown rather than a silence.
    const told = await waitFor(
      () => heardLife[heardLife.length - 1] ?? null,
      'a lifecycle frame',
    )
    expect(told).toMatchObject({ t: 'life', event: 'opponent-left' })
    expect(told.graceMs).toBeGreaterThan(0)

    // Back, with the key, inside the window.
    const again = connect(server.port, ALLOWED_ORIGIN, welcome.room, welcome.token)
    await new Promise((resolve) => again.once('open', resolve))
    const second = await new Promise<ServerMessage | null>((resolve) => {
      again.once('message', (data) => resolve(parseServerMessage(String(data))))
      again.send(helloFrame())
    })
    if (second?.t !== 'welcome') throw new Error('expected a welcome frame')

    // Same seat, same key, same match — and the score is the one they left.
    expect(second.room).toBe(welcome.room)
    expect(second.token).toBe(welcome.token)
    expect(room.peers.map((peer) => peer.slot).sort()).toEqual([0, 1])
    expect(room.state.match.phase).toBe(MatchPhase.Live)
    expect(room.state.match.wins).toEqual([0, 2])
    expect(server.rooms.size).toBe(1)

    guest.close()
    again.close()
  })

  it('reports its rooms and its scheduler on /healthz', async () => {
    const { server, clock } = await start()
    const socket = connect(server.port)
    await new Promise((resolve) => socket.once('open', resolve))
    socket.send(helloFrame())
    await waitFor(() => (server.rooms.size > 0 ? true : null), 'the room')

    clock.advance(16)
    server.scheduler.frame()

    const body = (await (await fetch(`http://127.0.0.1:${server.port}/healthz`)).json()) as {
      rooms?: { rooms?: number; capacity?: number }
      scheduler?: { frames?: number; steps?: number; budgetMs?: number; withinBudget?: boolean }
    }
    expect(body.rooms?.rooms).toBe(1)
    expect(body.rooms?.capacity).toBeGreaterThan(0)
    // The deploy's own verdict on whether this machine class can hold a tick
    // rate, one curl away. `docs/deploy.md`.
    expect(body.scheduler?.frames).toBe(1)
    expect(body.scheduler?.steps).toBe(2)
    expect(body.scheduler?.budgetMs).toBe(8)
    expect(body.scheduler?.withinBudget).toBe(true)

    socket.close()
  })
})

describe('clock sync on a real socket', () => {
  it('pings a connected client and measures the trip on its own clock', async () => {
    // The one assertion nothing in-process can make: the room's beat is
    // actually wired to a timer in the deployed process, and the ping reaches a
    // browser-shaped client through the real framing. Without this, clock sync
    // could be perfect and never fire. This is one of the two places the real
    // timers are used: the tick scheduler's own wakeups are what carry the
    // sweep that mints a ping, so a scheduler that stopped beating would show
    // up here and nowhere else.
    const server = await live()

    const measured = await new Promise<number>((resolve, reject) => {
      const socket = connect(server.port)
      const seen: number[] = []
      socket.on('error', reject)
      socket.on('message', (data) => {
        const parsed = parseServerMessage(String(data))
        if (parsed?.t !== 'ping') return
        seen.push(parsed.rttMs)
        // The first ping goes out before any trip has completed and says so;
        // the second carries what the server measured off our answer to the
        // first, which is the number this ticket exists to produce.
        if (seen.length >= 2 && parsed.rttMs >= 0) {
          resolve(parsed.rttMs)
          socket.close()
          return
        }
        socket.send(JSON.stringify({ t: 'pong', id: parsed.id }))
      })
      socket.once('open', () => socket.send(helloFrame()))
    })

    expect(measured).toBeGreaterThanOrEqual(0)
    // Loopback on the same machine. Anything near a second is a beat that is
    // not beating rather than a slow network.
    expect(measured).toBeLessThan(200)
  }, 20_000)
})
