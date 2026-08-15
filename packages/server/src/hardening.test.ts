/**
 * GLAD-V7M6PQ's acceptance criteria, against a real server on a real socket.
 *
 * The claims this ticket makes are about a *deployed* endpoint that anyone can
 * open a socket to, and every one of them is about what happens when the thing
 * on the other end is not a browser. So the fuzzing here goes through `ws` — a
 * real WebSocket frame, with a real close code coming back — rather than through
 * a handler called by hand, because the failures worth catching (an oversized
 * payload the socket layer refuses, an exception escaping an event handler and
 * taking the process with it) do not exist above the socket.
 *
 * The load-bearing assertion in every fuzz case is the *second* one: that the
 * other room on the machine kept ticking. A hostile client ending its own
 * session is fine. A hostile client ending everybody's is the bug.
 */
import { createConnection, type Socket } from 'node:net'

import { PROTOCOL_VERSION, type ServerMessage, parseServerMessage } from '@gladiator/sim'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { manualClock, type ManualClock } from './clock.ts'
import { readConfig, type ServerConfig } from './config.ts'
import { SERVER_MAP_HASH } from './map.ts'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './roomCode.ts'
import { manualTimer } from './scheduler.ts'
import { startServer, type GladiatorServer } from './server.ts'
import { CLOSE_BAD_FRAME } from './session.ts'
import { CLOSE_FLOODING, FRAME_BURST, MAX_FRAME_BYTES, MAX_REFUSED_FRAMES } from './validate.ts'

const ALLOWED_ORIGIN = 'http://localhost:5173'

/** The two rooms every test in this file gets: a victim and a fuzzer's. */
const VICTIM = 'H7K2Q9'
const TARGET = 'M3RW58'

let running: GladiatorServer | null = null

afterEach(async () => {
  await running?.close()
  running = null
})

/**
 * A code source that mints `list` in order, cycling.
 *
 * `rooms.ts` draws one uint32 per symbol, so a fixed sequence of symbol indices
 * is a fixed sequence of codes — which is what lets a test name the room it is
 * about to attack.
 */
function codes(...list: readonly string[]): () => number {
  let at = 0
  return () => {
    const code = list[Math.floor(at / ROOM_CODE_LENGTH) % list.length] ?? '000000'
    const symbol = code[at % ROOM_CODE_LENGTH] ?? '0'
    at += 1
    return ROOM_CODE_ALPHABET.indexOf(symbol)
  }
}

type Started = { readonly server: GladiatorServer; readonly clock: ManualClock }

/**
 * A real server on an ephemeral port, with a clock and a tick timer this file
 * owns.
 *
 * Manual both, for the reason `integration.test.ts` gives: the scheduler under
 * test is the shipping one, and driving it by hand means a minute of duel costs
 * CI the microseconds it takes to run rather than a minute. A frozen clock is
 * also exactly the shape of a flood — every frame in one instant — so the rate
 * limits are reached without sleeping.
 */
async function start(over: Partial<ServerConfig> = {}): Promise<Started> {
  const clock = manualClock()
  running = await startServer({
    config: { ...readConfig({}), port: 0, allowedOrigins: [ALLOWED_ORIGIN], ...over },
    clock,
    timer: manualTimer(),
    random: codes(VICTIM, TARGET),
    log: () => undefined,
  })
  return { server: running, clock }
}

function connect(port: number, room?: string): WebSocket {
  const query = room === undefined ? '' : `?room=${encodeURIComponent(room)}`
  return new WebSocket(`ws://127.0.0.1:${port}${query}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  })
}

/**
 * A hand-written WebSocket upgrade, so a test can name a request target that a
 * client library would refuse to send.
 */
function rawUpgrade(port: number, target: string): Socket {
  const socket = createConnection({ host: '127.0.0.1', port })
  // A connection this test is deliberately mistreating; its errors are noise.
  socket.on('error', () => undefined)
  socket.on('connect', () => {
    socket.write(
      [
        `GET ${target} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        `Origin: ${ALLOWED_ORIGIN}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==',
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'),
    )
  })
  return socket
}

function helloFrame(): string {
  return JSON.stringify({
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    build: 'test',
    mapHash: SERVER_MAP_HASH,
  })
}

/** Spin the event loop until `check` gives an answer, or give up loudly. */
async function waitFor<T>(check: () => T | null, what: string): Promise<T> {
  for (let attempt = 0; attempt < 200_000; attempt += 1) {
    const answer = check()
    if (answer !== null) return answer
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`gave up waiting for ${what}`)
}

/** Open a socket, say hello, and wait for the welcome. */
async function seat(port: number, room?: string): Promise<{ socket: WebSocket; seen: string[] }> {
  const socket = connect(port, room)
  const seen: string[] = []
  socket.on('message', (data) => seen.push(String(data)))
  await new Promise<void>((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })
  socket.send(helloFrame())
  await waitFor(() => (seen.some((raw) => raw.includes('"welcome"')) ? true : null), 'the welcome')
  return { socket, seen }
}

type Closed = { readonly code: number; readonly reason: string }

function closure(socket: WebSocket): Promise<Closed> {
  return new Promise((resolve) => {
    socket.once('close', (code: number, reason: Buffer) =>
      resolve({ code, reason: reason.toString() }),
    )
  })
}

/**
 * Advance the victim's world and report where it got to.
 *
 * Ten host frames of the *shipping* scheduler over a clock this file moves, so
 * "the other room kept ticking" is a statement about the real loop rather than
 * about a room method called directly.
 */
function runFrames(started: Started, frames = 10): number {
  for (let i = 0; i < frames; i += 1) {
    started.clock.advance(16)
    started.server.scheduler.frame()
  }
  const victim = started.server.rooms.get(VICTIM)
  expect(victim).not.toBeNull()
  return victim?.room.tick ?? -1
}

describe('a fuzzed frame ends one connection and nothing else', () => {
  /**
   * The shape every case in this block has.
   *
   * A victim room with a peer in it and a world that is advancing; a second
   * connection in a room of its own; the second one sends `attack`. The
   * assertions are that the attacker's socket closed, that the victim's world
   * carried on, and that no room on the machine faulted.
   */
  async function fuzz(send: (socket: WebSocket) => void): Promise<{
    closed: Closed
    ticked: boolean
    faulted: number
  }> {
    const started = await start()
    const port = started.server.port

    const victim = await seat(port)
    const before = runFrames(started)
    expect(before).toBeGreaterThan(0)

    // A second connection, in a second room. A room seats two, so the attacker
    // is deliberately *not* in the victim's — the claim being tested is about
    // the machine, not about one world.
    const attacker = await seat(port, undefined)
    const ended = closure(attacker.socket)
    send(attacker.socket)
    const closed = await ended

    const after = runFrames(started)
    victim.socket.close()
    return {
      closed,
      ticked: after > before,
      faulted: started.server.rooms.stats().faulted,
    }
  }

  it('closes on random bytes', async () => {
    const noise = new Uint8Array(512)
    // A fixed pattern rather than `Math.random`: a fuzz case that cannot be
    // re-run is an anecdote. This one is every byte value, twice over.
    for (let i = 0; i < noise.length; i += 1) noise[i] = (i * 37) & 0xff
    const result = await fuzz((socket) => socket.send(noise))

    expect(result.closed.code).toBe(CLOSE_BAD_FRAME)
    expect(result.ticked).toBe(true)
    expect(result.faulted).toBe(0)
  })

  it('closes on a truncated frame', async () => {
    // JSON that stops mid-object: the commonest thing a half-written client
    // produces, and the input a parser written with `JSON.parse` and no `try`
    // dies on.
    const result = await fuzz((socket) => socket.send('{"t":"cmds","startTick":1,"cmds":[[0,0'))

    expect(result.closed.code).toBe(CLOSE_BAD_FRAME)
    expect(result.ticked).toBe(true)
    expect(result.faulted).toBe(0)
  })

  it('closes on a truncated *binary* frame', async () => {
    const result = await fuzz((socket) => socket.send(new Uint8Array([0x7b, 0x22, 0x74])))

    expect(result.closed.code).toBe(CLOSE_BAD_FRAME)
    expect(result.ticked).toBe(true)
    expect(result.faulted).toBe(0)
  })

  it('closes on an oversized payload before it is assembled', async () => {
    // `ws`'s `maxPayload` refuses this at the socket, which is why the close
    // code is 1009 rather than one of ours: the frame never becomes a message.
    // That is the point — the bytes are not buffered while we decide.
    const result = await fuzz((socket) => socket.send('x'.repeat(MAX_FRAME_BYTES * 4)))

    expect(result.closed.code).toBe(1009)
    expect(result.ticked).toBe(true)
    expect(result.faulted).toBe(0)
  })

  it('closes on a deeply nested payload', async () => {
    // The input that turns a recursive-descent parser into a stack overflow.
    // `JSON.parse` is iterative in V8 and this is a `null` either way, but the
    // assertion worth having is that whatever it does, it does it to one
    // connection.
    const nested = `${'['.repeat(2000)}${']'.repeat(2000)}`
    const result = await fuzz((socket) => socket.send(nested))

    expect(result.closed.code).toBe(CLOSE_BAD_FRAME)
    expect(result.ticked).toBe(true)
    expect(result.faulted).toBe(0)
  })

  it('closes on a frame whose numbers are all wrong', async () => {
    const result = await fuzz((socket) =>
      socket.send(JSON.stringify({ t: 'cmds', startTick: -1, cmds: 'not an array' })),
    )

    expect(result.closed.code).toBe(CLOSE_BAD_FRAME)
    expect(result.ticked).toBe(true)
    expect(result.faulted).toBe(0)
  })
})

describe('the per-connection message rate', () => {
  it('drops the overage in silence and then closes on a client that will not stop', async () => {
    const started = await start()
    const { socket, seen } = await seat(started.server.port)
    const ended = closure(socket)

    // A frozen clock is a client sending everything in one instant. The burst
    // covers the first frames; every frame after that is over budget.
    const pong = JSON.stringify({ t: 'pong', id: 1 })
    for (let i = 0; i < FRAME_BURST + MAX_REFUSED_FRAMES + 4; i += 1) socket.send(pong)

    const closed = await ended
    expect(closed.code).toBe(CLOSE_FLOODING)

    // One sentence at the end, not one per dropped frame: answering a flood
    // with a fault per frame is answering a flood with a flood.
    const faults = seen
      .map((raw) => parseServerMessage(raw))
      .filter((message: ServerMessage | null) => message?.t === 'fault')
    expect(faults).toHaveLength(1)
    expect(faults[0]).toMatchObject({ code: 'flooding' })
  })

  it('leaves an honest client at 240 frames a second entirely alone', async () => {
    const started = await start()
    const { socket } = await seat(started.server.port)

    // A second of the fastest display anyone plays on, in tenths — because the
    // clock is this test's and the server reads a frame whenever the event loop
    // gets to it, so time has to be handed over in the gaps or the whole second
    // arrives in one instant and stops being a rate at all.
    const pong = JSON.stringify({ t: 'pong', id: 1 })
    for (let round = 0; round < 10; round += 1) {
      for (let i = 0; i < 23; i += 1) socket.send(pong)
      // A sentinel at the end of each tenth: the transport delivers in order, so
      // a room that has counted this command has read every frame before it.
      socket.send(
        JSON.stringify({ t: 'cmds', startTick: round + 1, cmds: [[0, 0, 0, 0, 0, 1]] }),
      )
      started.clock.advance(100)
      await waitFor(
        () =>
          started.server.rooms.get(VICTIM)?.room.snapshot().commands === round + 1 ? true : null,
        `the sentinel behind tenth ${round}`,
      )
    }

    // 240 frames a second, for a second, and not one of them turned away.
    const room = started.server.rooms.get(VICTIM)
    expect(room?.room.snapshot().refused).toBe(0)
    expect(socket.readyState).toBe(WebSocket.OPEN)
    socket.close()
  })
})

describe('connections per client address', () => {
  it('refuses an upgrade past the burst, with a 429 rather than a handshake', async () => {
    // The limit is refused at the *upgrade*, which is the whole point: a guess
    // at a room code should cost the guesser a connection and cost us a write.
    const started = await start({ connectBurst: 3, maxConnectionsPerAddress: 100 })
    const port = started.server.port

    const open: WebSocket[] = []
    for (let i = 0; i < 3; i += 1) {
      const socket = connect(port)
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      open.push(socket)
    }

    const refused = connect(port)
    const error = await new Promise<Error>((resolve) => refused.once('error', resolve))
    expect(error.message).toContain('429')

    for (const socket of open) socket.close()
  })

  it('refuses a fourth socket from an address already holding three', async () => {
    // Separate from the rate: an attacker opening connections slowly enough to
    // stay under the budget could otherwise hold every room on the machine.
    const started = await start({ connectBurst: 1000, maxConnectionsPerAddress: 3 })
    const port = started.server.port

    const open: WebSocket[] = []
    for (let i = 0; i < 3; i += 1) {
      const socket = connect(port)
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      open.push(socket)
    }
    await waitFor(() => (started.server.sessions === 3 ? true : null), 'three live sessions')

    const refused = connect(port)
    const error = await new Promise<Error>((resolve) => refused.once('error', resolve))
    expect(error.message).toContain('429')

    for (const socket of open) socket.close()
  })

  it('reads the real address out of the proxy header, so one proxy is not one player', async () => {
    // Behind Fly's proxy every connection arrives from the proxy. Without this
    // the limiter would put the whole internet in one bucket, and the first
    // twenty players a second would rate-limit the twenty-first.
    const started = await start({ connectBurst: 1, maxConnectionsPerAddress: 100 })
    const port = started.server.port

    const from = (ip: string): WebSocket =>
      new WebSocket(`ws://127.0.0.1:${port}`, {
        headers: { Origin: ALLOWED_ORIGIN, 'Fly-Client-IP': ip },
      })

    const first = from('203.0.113.4')
    await new Promise<void>((resolve, reject) => {
      first.once('open', resolve)
      first.once('error', reject)
    })

    // The same address again is over its budget...
    const again = from('203.0.113.4')
    const error = await new Promise<Error>((resolve) => again.once('error', resolve))
    expect(error.message).toContain('429')

    // ...and a different one is not, even though both arrived down the same
    // socket from the same machine.
    const other = from('198.51.100.9')
    await new Promise<void>((resolve, reject) => {
      other.once('open', resolve)
      other.once('error', reject)
    })

    first.close()
    other.close()
  })

  it('lets an address back in once its bucket has refilled', async () => {
    const started = await start({ connectBurst: 1, maxConnectionsPerAddress: 100 })
    const port = started.server.port

    const first = connect(port)
    await new Promise<void>((resolve, reject) => {
      first.once('open', resolve)
      first.once('error', reject)
    })

    const refused = connect(port)
    await new Promise<Error>((resolve) => refused.once('error', resolve))

    // A second of wall-clock is a token at the shipping budget. The limiter is
    // a delay, not a ban: a player whose network flapped gets back in.
    started.clock.advance(2000)
    const second = connect(port)
    await new Promise<void>((resolve, reject) => {
      second.once('open', resolve)
      second.once('error', reject)
    })

    first.close()
    second.close()
  })
})

describe('a room code that is not one', () => {
  it('is echoed back with nothing in it a log line could be forged with', async () => {
    const started = await start()
    const socket = connect(started.server.port, 'AB\nDELETED THE LOGS\u001b[2J')
    const seen: string[] = []
    socket.on('message', (data) => seen.push(String(data)))
    const closed = await closure(socket)

    // 4006, not a hang: "there is no such room" is the commonest thing that can
    // go wrong in this whole product and it has to be a sentence.
    expect(closed.code).toBe(4006)
    const fault = seen.map((raw) => parseServerMessage(raw)).find((m) => m?.t === 'fault')
    expect(fault).toBeDefined()
    const detail = fault?.t === 'fault' ? fault.detail : ''
    expect(detail).not.toContain('\n')
    expect(detail).not.toContain('\u001b')
    expect(detail).toContain('AB')
  })
})

describe('a request target that is not a URL', () => {
  it('is answered, and the machine goes on simulating', async () => {
    const started = await start()
    await seat(started.server.port)
    const before = runFrames(started)
    expect(before).toBeGreaterThan(0)

    // Node's HTTP parser accepts absolute-form request targets — it has to, that
    // is what a proxy puts on the wire — so `request.url` reaching the server
    // here is the literal `http://[`, and `new URL` throws on it.
    //
    // On the wire rather than by calling the parsers, because the two outcomes
    // this is between are not "null" and "a throw", they are "a room" and "no
    // more server": every reader of the target runs inside an `upgrade` or
    // `connection` handler, where nothing catches anything, so the regression
    // shows up here as an unhandled error and in production as an exit. `ws`
    // will not put a target this shape on the wire, hence the hand-written
    // request.
    const raw = rawUpgrade(started.server.port, 'http://[')
    const answered: Buffer[] = []
    raw.on('data', (chunk: Buffer) => answered.push(chunk))
    await waitFor(
      () => (answered.length > 0 || raw.destroyed ? true : null),
      'an answer to the hand-written upgrade',
    )

    // The load-bearing assertion, as everywhere in this file: the victim's room
    // is still there and its tick is still moving.
    expect(runFrames(started)).toBeGreaterThan(before)
    raw.destroy()
  })
})
