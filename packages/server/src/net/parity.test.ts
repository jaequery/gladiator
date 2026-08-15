/**
 * The ticket's central claim, and the only assertion that can actually catch
 * the bug it exists to prevent.
 *
 * One recorded input stream, pushed through two transports: an in-process
 * loopback into a `Room` held in this process, and a real WebSocket into a
 * `Room` held by a real HTTP server on a real port. Both must produce the same
 * hash at every tick and the same hash at the end.
 *
 * ## The schedule is the same, and the delivery is not
 *
 * Since GLAD-FHKBN8 a room advances on a clock rather than on whatever batch it
 * was handed, so "the same stream" has to mean the same stream *and* the same
 * tick schedule — otherwise the two runs would be simulating different amounts
 * of time and the comparison would be about the scheduler rather than about the
 * host. Both runs therefore drive the same virtual clock and call `advance` with
 * the same numbers, and the tick scheduler is handed a `manualTimer` so it never
 * fires on its own.
 *
 * What is *not* held equal is the delivery. The loopback answers in microseconds
 * and the socket answers over TCP through the kernel; the two runs interleave
 * their frames completely differently, and one of them goes through `ws`, a real
 * `Buffer`, and a JSON round trip on a real file descriptor. Identical hashes
 * therefore still say what they always said: the host does not depend on *when*
 * anything arrived.
 *
 * The weaker version of this — "single-player and multiplayer share an entry
 * point" — is satisfied by a loopback that hands the receiver the sender's own
 * object, which is exactly the failure mode the pattern has. Comparing *state
 * hashes* is what makes the assertion bite: a shared mutable reference produces
 * a world that agrees with itself and disagrees with the one that went through
 * a socket.
 *
 * It also pins something quieter and just as valuable. The loopback answers in
 * microseconds and the socket answers in milliseconds; the two runs interleave
 * their frames completely differently. Identical hashes therefore say the host
 * does not depend on *when* anything arrived — which is the property every
 * later ticket in this goal is going to lean on.
 */
import {
  PROTOCOL_VERSION,
  TICK_RATE,
  createMapState,
  hashState,
  parseServerMessage,
  tick as simTick,
  type ServerMessage,
} from '@gladiator/sim'
import { WebSocket } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

import { manualClock } from '../clock.ts'
import { readConfig } from '../config.ts'
import {
  batchFrame,
  recordStream,
  scriptedCommand,
  type RecordedStream,
} from '../fixtures/recordedStream.ts'
import { SERVER_MAP, SERVER_MAP_HASH, SERVER_PLAN } from '../map.ts'
import { createRoom, type Room } from '../room.ts'
import { seedForRoom } from '../rooms.ts'
import { manualTimer } from '../scheduler.ts'
import { startServer, type GladiatorServer } from '../server.ts'
import { createLoopbackPair, settleLoopback } from './loopbackTransport.ts'

const ALLOWED_ORIGIN = 'http://localhost:5173'

/** A minute of play at 125 Hz, minus a little, so the run is long enough to drift. */
const TICKS = TICK_RATE * 57

/** The code both runs' rooms answer to, so the welcomes are comparable. */
const PARITY_ROOM = 'H7K2Q9'

const HELLO = JSON.stringify({
  t: 'hello',
  protocol: PROTOCOL_VERSION,
  build: 'parity',
  mapHash: SERVER_MAP_HASH,
})

let running: GladiatorServer | null = null

afterEach(async () => {
  await running?.close()
  running = null
})

/** The hash at every tick, simulated right here with no transport in the way. */
function referenceTrace(ticks: number): number[] {
  const state = createMapState(SERVER_MAP.source, seedForRoom(PARITY_ROOM))
  const trace: number[] = []
  for (let tick = 1; tick <= ticks; tick += 1) {
    simTick(state, [scriptedCommand(tick)], SERVER_MAP.world)
    trace.push(hashState(state))
  }
  return trace
}

function hashesFrom(frames: readonly ServerMessage[]): Array<{ tick: number; hash: number }> {
  return frames.flatMap((frame) =>
    frame.t === 'hash' ? [{ tick: frame.tick, hash: frame.hash >>> 0 }] : [],
  )
}

/**
 * The one drive, shared by both runs.
 *
 * Wall-clock advances by exactly the simulated time in the batch about to be
 * sent, so the rate limit in front of the buffer is charged the way an honest
 * 125 Hz client would charge it; then the batch is delivered, and only then is
 * the room advanced by exactly that many sub-steps. Every command is therefore
 * in the buffer before the sub-step that wants it, which is the condition under
 * which the host executes the recorded stream and nothing else.
 */
async function play(
  stream: RecordedStream,
  clock: ReturnType<typeof manualClock>,
  room: Room,
  send: (frame: string) => void,
  /** Resolve once the host has been offered `total` commands. */
  admitted: (total: number) => Promise<void>,
): Promise<void> {
  let offered = 0
  for (const batch of stream.batches) {
    clock.advance(batch.cmds.length * 8)
    send(batchFrame(batch))
    offered += batch.cmds.length
    await admitted(offered)
    room.advance(batch.cmds.length)
  }
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

/** A code source that always mints {@link PARITY_ROOM}. `roomCode.ts`. */
function fixedCode(code: string): () => number {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  let at = 0
  return () => {
    const symbol = code[at % code.length] ?? '0'
    at += 1
    return alphabet.indexOf(symbol)
  }
}

/**
 * The stream, over an in-process loopback into a room in this process.
 *
 * The clock is a manual one and the room holds no timer, which is the point:
 * this whole run happens in the microseconds it takes to run 7125 ticks rather
 * than in the minute a wall clock would charge for the same thing.
 */
async function overLoopback(stream: RecordedStream): Promise<ServerMessage[]> {
  const pair = createLoopbackPair()
  const clock = manualClock()
  const room: Room = createRoom({
    map: SERVER_MAP,
    plan: SERVER_PLAN,
    // The same build string the socket-side server reads out of its config, so
    // the two welcomes are comparable field for field.
    build: readConfig({}).build,
    clock,
    id: PARITY_ROOM,
    // The same seed the registry gives a room of this code, so the two runs
    // are two runs of *one* match rather than of two that happen to share a
    // command stream. `rooms.ts`.
    seed: seedForRoom(PARITY_ROOM),
    peerId: (index) => `loopback-${index}`,
  })
  room.join(pair.server)

  const frames: ServerMessage[] = []
  pair.client.setHandlers({
    onMessage: (message) => {
      if (typeof message !== 'string') throw new Error('the host answered in binary')
      const parsed = parseServerMessage(message)
      if (parsed === null) throw new Error(`unparseable frame: ${message}`)
      frames.push(parsed)
    },
  })

  pair.client.send(HELLO)
  await settleLoopback(pair)
  await play(stream, clock, room, (frame) => pair.client.send(frame), () => settleLoopback(pair))
  await settleLoopback(pair)
  pair.close()
  return frames
}

/**
 * The same stream, over a real socket to a real server.
 *
 * The server is started with a manual clock and a manual timer, so its tick
 * scheduler never fires on its own and this test drives the world by the same
 * numbers the loopback run uses. The one thing a socket needs that a loopback
 * does not is a way to know a frame has *arrived*: the server is in this
 * process, so the room's own count of admitted commands is the answer, and
 * waiting on it is what keeps the two schedules comparable.
 */
async function overWebSocket(stream: RecordedStream): Promise<ServerMessage[]> {
  const clock = manualClock()
  running = await startServer({
    // Port 0: the OS picks a free one. `readConfig` will not take a 0 from the
    // environment — a `PORT=0` on Fly is a mistake, not a request — so the test
    // sets the field rather than the variable.
    config: { ...readConfig({}), port: 0, allowedOrigins: [ALLOWED_ORIGIN] },
    clock,
    timer: manualTimer(),
    // One code, fixed, so the two welcomes can be compared field for field.
    random: fixedCode(PARITY_ROOM),
    log: () => undefined,
  })
  const server = running
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  })
  await new Promise((resolve) => socket.once('open', resolve))

  const frames: ServerMessage[] = []
  socket.on('message', (data) => {
    const parsed = parseServerMessage(String(data))
    if (parsed === null) throw new Error(`unparseable frame: ${String(data)}`)
    frames.push(parsed)
  })

  socket.send(HELLO)
  const room = await waitFor(() => server.rooms.get(PARITY_ROOM)?.room ?? null, 'the room')
  await waitFor(
    () => (room.peers[0]?.session.greeted === true ? room : null),
    'the handshake',
  )

  await play(stream, clock, room, (frame) => socket.send(frame), async (total) => {
    await waitFor(
      () => ((room.peers[0]?.session.commands ?? 0) >= total ? true : null),
      `${total} commands to arrive`,
    )
  })

  // Everything the host owed us is on the wire; wait for the last of it before
  // the two runs are compared.
  await waitFor(
    () => (hashesFrom(frames).length >= stream.batches.length ? true : null),
    'the last hash',
  )
  socket.close()
  return frames
}

describe('one input stream, two transports', () => {
  it(
    'ends on the same state hash in-process and over a socket',
    { timeout: 120_000 },
    async () => {
      const stream = recordStream(TICKS)
      const reference = referenceTrace(TICKS)

      const loopback = hashesFrom(await overLoopback(stream))
      const socket = hashesFrom(await overWebSocket(stream))

      // The claim, in the order it is worth failing in: the ticks line up, the
      // whole trace lines up, and the last hash is the one a bare `tick()` loop
      // produces from the same commands.
      expect(loopback.map((entry) => entry.tick)).toEqual(socket.map((entry) => entry.tick))

      const disagreements = loopback.flatMap((entry, index) => {
        const other = socket[index]
        return other === undefined || other.hash !== entry.hash
          ? [{ tick: entry.tick, loopback: entry.hash, socket: other?.hash }]
          : []
      })
      // Reported with the tick rather than as a bare count: a desync is only
      // debuggable if you know when it started.
      expect(disagreements.slice(0, 5)).toEqual([])

      const finalTick = loopback[loopback.length - 1]
      expect(finalTick?.tick).toBe(TICKS)
      expect(finalTick?.hash).toBe(reference[TICKS - 1] as number >>> 0)
      expect(socket[socket.length - 1]?.hash).toBe(reference[TICKS - 1] as number >>> 0)
    },
  )

  it('welcomes identically down both pipes', async () => {
    const stream = recordStream(4)
    const [loopback, socket] = await Promise.all([overLoopback(stream), overWebSocket(stream)])

    const welcomeOf = (frames: readonly ServerMessage[]) =>
      frames.find((frame) => frame.t === 'welcome')
    const one = welcomeOf(loopback)
    const two = welcomeOf(socket)
    if (one?.t !== 'welcome' || two?.t !== 'welcome') throw new Error('no welcome')

    // Everything but the session id, which is per-peer by construction.
    expect({ ...one, session: '' }).toEqual({ ...two, session: '' })
  })

  it('agrees about a world that actually went somewhere', async () => {
    // A hash comparison over a player who never moved would pass while proving
    // nothing at all.
    const state = createMapState(SERVER_MAP.source, seedForRoom(PARITY_ROOM))
    const start = state.entities[0]?.origin.slice() ?? [0, 0, 0]
    for (let tick = 1; tick <= TICKS; tick += 1) {
      simTick(state, [scriptedCommand(tick)], SERVER_MAP.world)
    }
    const end = state.entities[0]?.origin ?? [0, 0, 0]
    const moved = Math.abs((end[0] ?? 0) - (start[0] ?? 0)) + Math.abs((end[1] ?? 0) - (start[1] ?? 0))
    expect(moved).toBeGreaterThan(100)
  })
})
