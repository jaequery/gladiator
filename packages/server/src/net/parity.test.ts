/**
 * The ticket's central claim, and the only assertion that can actually catch
 * the bug it exists to prevent.
 *
 * One recorded input stream, pushed through two transports: an in-process
 * loopback into a `Room` held in this process, and a real WebSocket into a
 * `Room` held by a real HTTP server on a real port. Both must produce the same
 * hash at every tick and the same hash at the end.
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
  SKELETON_SEED,
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
import { SERVER_MAP, SERVER_MAP_HASH } from '../map.ts'
import { createRoom } from '../room.ts'
import { startServer, type GladiatorServer } from '../server.ts'
import { createLoopbackPair, settleLoopback } from './loopbackTransport.ts'

const ALLOWED_ORIGIN = 'http://localhost:5173'

/** A minute of play at 125 Hz, minus a little, so the run is long enough to drift. */
const TICKS = TICK_RATE * 57

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
  const state = createMapState(SERVER_MAP.source, SKELETON_SEED)
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
 * The stream, over an in-process loopback into a room in this process.
 *
 * The clock is a manual one that is never advanced, which is the point: this
 * whole run happens at a single instant of wall-clock, and 7125 ticks come out
 * of it. A host that needed a timer would have needed a minute.
 */
async function overLoopback(stream: RecordedStream): Promise<ServerMessage[]> {
  const pair = createLoopbackPair()
  const room = createRoom({
    map: SERVER_MAP,
    // The same build string the socket-side server reads out of its config, so
    // the two welcomes are comparable field for field.
    build: readConfig({}).build,
    clock: manualClock(),
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
  for (const batch of stream.batches) {
    pair.client.send(batchFrame(batch))
    await settleLoopback(pair)
  }
  pair.close()
  return frames
}

/** The same stream, over a real socket to a real server. */
async function overWebSocket(stream: RecordedStream): Promise<ServerMessage[]> {
  running = await startServer({
    // Port 0: the OS picks a free one. `readConfig` will not take a 0 from the
    // environment — a `PORT=0` on Fly is a mistake, not a request — so the test
    // sets the field rather than the variable.
    config: { ...readConfig({}), port: 0, allowedOrigins: [ALLOWED_ORIGIN] },
    log: () => undefined,
  })
  const socket = new WebSocket(`ws://127.0.0.1:${running.port}`, {
    headers: { Origin: ALLOWED_ORIGIN },
  })
  await new Promise((resolve) => socket.once('open', resolve))

  const frames: ServerMessage[] = []
  const done = new Promise<void>((resolve, reject) => {
    socket.on('message', (data) => {
      const parsed = parseServerMessage(String(data))
      if (parsed === null) {
        reject(new Error(`unparseable frame: ${String(data)}`))
        return
      }
      frames.push(parsed)
      if (parsed.t === 'hash' && parsed.tick >= stream.ticks) resolve()
    })
    socket.on('close', () => reject(new Error('the socket closed before the run finished')))
  })

  socket.send(HELLO)
  for (const batch of stream.batches) socket.send(batchFrame(batch))
  await done
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
    const state = createMapState(SERVER_MAP.source, SKELETON_SEED)
    const start = state.entities[0]?.origin.slice() ?? [0, 0, 0]
    for (let tick = 1; tick <= TICKS; tick += 1) {
      simTick(state, [scriptedCommand(tick)], SERVER_MAP.world)
    }
    const end = state.entities[0]?.origin ?? [0, 0, 0]
    const moved = Math.abs((end[0] ?? 0) - (start[0] ?? 0)) + Math.abs((end[1] ?? 0) - (start[1] ?? 0))
    expect(moved).toBeGreaterThan(100)
  })
})
