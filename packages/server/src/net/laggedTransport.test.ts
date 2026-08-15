/**
 * The impairment harness, and the property that makes it worth having: a
 * failure is a *seed*, not an anecdote.
 *
 * Half of these assert that the bad things actually happen — a decorator that
 * quietly dropped nothing would make every latency test a green light for a
 * network that was never tested. The other half assert that they happen the
 * same way twice, because a reproduction that only reproduces sometimes is not
 * one.
 */
import {
  SKELETON_SEED,
  TransportState,
  type ServerMessage,
  type TransportMessage,
  createMapState,
  hashState,
  parseServerMessage,
  tick as simTick,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { manualClock } from '../clock.ts'
import { batchFrame, recordStream, scriptedCommand } from '../fixtures/recordedStream.ts'
import { SERVER_MAP, SERVER_MAP_HASH } from '../map.ts'
import { createRoom } from '../room.ts'
import { createLoopbackPair, settleLoopback } from './loopbackTransport.ts'
import { NO_LAG, laggedTransport, type LagProfile } from './laggedTransport.ts'

/** A transport that goes nowhere and remembers what it was asked to carry. */
function sink() {
  const sent: TransportMessage[] = []
  return {
    sent,
    transport: {
      readyState: TransportState.Open,
      send: (message: TransportMessage) => {
        sent.push(message)
      },
      close: () => undefined,
      setHandlers: () => undefined,
    },
  }
}

/** Send `count` numbered frames through a link and release them all. */
function pushThrough(profile: Partial<LagProfile> & { seed: number }, count: number): string[] {
  const inner = sink()
  const link = laggedTransport(inner.transport, profile)
  for (let i = 0; i < count; i += 1) {
    link.send(`frame-${i}`)
    // One millisecond of wall-clock per frame, so a frame held back by the
    // reorder delay is genuinely overtaken by the ones behind it.
    link.pump(i)
  }
  link.flush()
  return inner.sent.map(String)
}

describe('the impairments happen at all', () => {
  it('holds a frame for the latency, then releases it', () => {
    const inner = sink()
    const link = laggedTransport(inner.transport, { ...NO_LAG, latencyMs: 50, seed: 1 })

    link.send('one')
    link.pump(49)
    expect(inner.sent).toHaveLength(0)
    expect(link.inFlight).toBe(1)

    link.pump(50)
    expect(inner.sent).toEqual(['one'])
    expect(link.stats.delivered).toBe(1)
  })

  it('spreads arrivals over the jitter window', () => {
    const inner = sink()
    const link = laggedTransport(inner.transport, { latencyMs: 20, jitterMs: 20, seed: 4 })
    for (let i = 0; i < 40; i += 1) link.send(`f${i}`)

    const arrivals: number[] = []
    for (let ms = 0; ms <= 60; ms += 1) {
      const before = inner.sent.length
      link.pump(ms)
      for (let i = before; i < inner.sent.length; i += 1) arrivals.push(ms)
    }

    expect(arrivals).toHaveLength(40)
    expect(Math.min(...arrivals)).toBeGreaterThanOrEqual(20)
    expect(Math.max(...arrivals)).toBeLessThan(41)
    // Jitter that produced one arrival time is not jitter.
    expect(new Set(arrivals).size).toBeGreaterThan(5)
  })

  it('loses frames, and says how many', () => {
    const delivered = pushThrough({ lossChance: 0.25, seed: 12345 }, 200)
    expect(delivered.length).toBeGreaterThan(120)
    expect(delivered.length).toBeLessThan(180)
  })

  it('duplicates frames', () => {
    const delivered = pushThrough({ duplicateChance: 0.2, seed: 999 }, 100)
    expect(delivered.length).toBeGreaterThan(100)
    const counts = new Map<string, number>()
    for (const frame of delivered) counts.set(frame, (counts.get(frame) ?? 0) + 1)
    expect([...counts.values()].filter((n) => n === 2).length).toBeGreaterThan(5)
  })

  it('reorders frames', () => {
    const delivered = pushThrough({ reorderChance: 0.3, reorderMs: 25, seed: 777 }, 60)
    const inOrder = Array.from({ length: 60 }, (_, i) => `frame-${i}`)
    expect(delivered).toHaveLength(60)
    expect(delivered).not.toEqual(inOrder)
    // Same frames, different order — nothing was lost on the way.
    expect([...delivered].sort()).toEqual([...inOrder].sort())
  })

  it('does nothing at all under NO_LAG, beyond needing a pump', () => {
    const inner = sink()
    const link = laggedTransport(inner.transport, NO_LAG)
    for (let i = 0; i < 20; i += 1) link.send(`f${i}`)
    link.pump(0)
    expect(inner.sent.map(String)).toEqual(Array.from({ length: 20 }, (_, i) => `f${i}`))
  })
})

describe('a failure is a seed', () => {
  it('makes the same decisions twice from the same seed', () => {
    const profile = { lossChance: 0.2, duplicateChance: 0.1, reorderChance: 0.2, reorderMs: 20, seed: 0xc0ffee }
    expect(pushThrough(profile, 300)).toEqual(pushThrough(profile, 300))
  })

  it('makes different decisions from a different seed', () => {
    const shape = { lossChance: 0.2, duplicateChance: 0.1, reorderChance: 0.2, reorderMs: 20 }
    expect(pushThrough({ ...shape, seed: 1 }, 300)).not.toEqual(pushThrough({ ...shape, seed: 2 }, 300))
  })

  it('draws the same number of times whatever the magnitudes are', () => {
    // Four draws a frame, always, in the same order — the same discipline the
    // kernel keeps. So two profiles that differ only in how *much* latency they
    // add still lose and duplicate exactly the same frames.
    const lossy = { lossChance: 0.3, duplicateChance: 0.15, seed: 42 }
    const slow = pushThrough({ ...lossy, latencyMs: 200, jitterMs: 50 }, 200)
    const quick = pushThrough({ ...lossy, latencyMs: 1 }, 200)
    expect([...slow].sort()).toEqual([...quick].sort())
  })

  it('applies the same treatment to what arrives as to what is sent', () => {
    const pair = createLoopbackPair()
    const link = laggedTransport(pair.client, { latencyMs: 30, seed: 5 })
    const received: TransportMessage[] = []
    link.setHandlers({ onMessage: (message) => received.push(message) })
    pair.server.setHandlers({})

    pair.server.send('from the host')
    return settleLoopback(pair).then(() => {
      expect(link.stats.received).toBe(1)
      expect(received).toHaveLength(0)
      link.pump(30)
      expect(received).toEqual(['from the host'])
    })
  })
})

/* --------------------------------------------------------------------------
 * The latency matrix
 * ----------------------------------------------------------------------- */

/**
 * The reliable half of the matrix: everything a WebSocket over TCP really does.
 *
 * Delayed, bunched up, spread out — but every frame arrives, exactly once, in
 * the order it was sent. Which is why the world at the end has to be the same
 * world, byte for byte.
 */
const MATRIX: readonly LagProfile[] = [
  { ...NO_LAG, seed: 11 },
  { ...NO_LAG, latencyMs: 25, seed: 22 },
  { ...NO_LAG, latencyMs: 80, jitterMs: 20, seed: 33 },
  { ...NO_LAG, latencyMs: 150, jitterMs: 60, seed: 44 },
  { ...NO_LAG, latencyMs: 250, jitterMs: 120, seed: 55 },
]

/** The hash the recorded stream produces when nothing is in the way. */
function referenceHashes(ticks: number): number[] {
  const state = createMapState(SERVER_MAP.source, SKELETON_SEED)
  const hashes: number[] = []
  for (let tick = 1; tick <= ticks; tick += 1) {
    simTick(state, [scriptedCommand(tick)], SERVER_MAP.world)
    hashes.push(hashState(state))
  }
  return hashes
}

type MatrixRun = {
  readonly hashes: readonly number[]
  /** Batches whose `startTick` did not follow on — loss and reordering both show up here. */
  readonly gaps: number
  /** Commands the host actually simulated. */
  readonly commands: number
}

/** Push the recorded stream through a lagged link into a room, and collect the hashes. */
async function runMatrix(profile: LagProfile, ticks: number): Promise<MatrixRun> {
  const pair = createLoopbackPair()
  const link = laggedTransport(pair.client, profile)
  const room = createRoom({
    map: SERVER_MAP,
    clock: manualClock(),
    build: 'matrix',
    peerId: (index) => `peer-${index}`,
  })
  room.join(pair.server)

  const hashes: number[] = []
  link.setHandlers({
    onMessage: (message) => {
      if (typeof message !== 'string') throw new Error('the host answered in binary')
      const parsed: ServerMessage | null = parseServerMessage(message)
      if (parsed?.t === 'hash') hashes.push(parsed.hash >>> 0)
    },
  })

  const stream = recordStream(ticks)
  let nowMs = 0
  link.send(JSON.stringify({ t: 'hello', protocol: 3, build: 'matrix', mapHash: SERVER_MAP_HASH }))
  for (const batch of stream.batches) {
    link.send(batchFrame(batch))
    // Wall-clock advances by exactly the simulated time in the batch, so a
    // 150 ms link really is nineteen ticks behind rather than nominally so.
    nowMs += batch.cmds.length * 8
    link.pump(nowMs)
    await settleLoopback(pair)
  }

  // Drain: keep beating until nothing is held anywhere. Bounded, because a
  // harness that could spin forever is a harness that will.
  for (let beat = 0; beat < 10_000 && (link.inFlight > 0 || !pair.idle); beat += 1) {
    nowMs += 8
    link.pump(nowMs)
    await settleLoopback(pair)
  }

  const seen = room.snapshot()
  pair.close()
  return { hashes, gaps: seen.gaps, commands: seen.commands }
}

describe('the latency matrix', () => {
  const TICKS = 600

  it('agrees with the reference at every profile', { timeout: 60_000 }, async () => {
    // Latency and jitter are *reliable* impairments: every frame arrives,
    // exactly once, in order. So the world must come out identical — the link
    // changed when the host heard, never what it heard. A failure here is a
    // host that has started depending on arrival timing, which is the bug that
    // makes a game feel fine on a LAN and fall apart on a train.
    const expected = referenceHashes(TICKS)
    const batches = recordStream(TICKS).batches.length

    for (const profile of MATRIX) {
      const run = await runMatrix(profile, TICKS)
      const label = `profile ${profile.latencyMs}±${profile.jitterMs}ms`
      // One hash per batch, and the last one is the world the reference ends in.
      expect(run.hashes, label).toHaveLength(batches)
      expect(run.hashes[run.hashes.length - 1], label).toBe(expected[TICKS - 1])
      expect(run.gaps, label).toBe(0)
      expect(run.commands, label).toBe(TICKS)
    }
  })

  it('breaks the world when frames actually go missing', { timeout: 60_000 }, async () => {
    // The other half of the claim: with loss on, the world is *not* the same,
    // and the harness is not quietly repairing anything behind the test's back.
    // Coping with this is reconciliation (GLAD-6RT64L); what this ticket owes
    // is a link that can produce it on demand, from a seed.
    const expected = referenceHashes(TICKS)
    // Seed 67 rather than any seed: the first frame through the link is the
    // hello, and a run that loses *that* proves nothing about commands — it is
    // a session that never opened, which belongs to GLAD-DVDV6P.
    const run = await runMatrix({ ...NO_LAG, latencyMs: 20, lossChance: 0.3, seed: 67 }, TICKS)

    expect(run.hashes.length, 'the handshake survived').toBeGreaterThan(0)
    expect(run.hashes.length).toBeLessThan(recordStream(TICKS).batches.length)
    expect(run.commands).toBeLessThan(TICKS)
    expect(run.hashes[run.hashes.length - 1]).not.toBe(expected[TICKS - 1])
    // And the host noticed rather than renumbering the gap away.
    expect(run.gaps).toBeGreaterThan(0)
  })

  it('breaks the world when frames arrive out of order', { timeout: 60_000 }, async () => {
    // Reordering is a deliberate violation of the transport contract, offered
    // so the cost of moving to unreliable datagrams can be measured rather than
    // guessed at — `sim/src/transport.ts` lists what would break. Every command
    // still arrives; applying them in the wrong order is enough on its own.
    const expected = referenceHashes(TICKS)
    const run = await runMatrix(
      { ...NO_LAG, latencyMs: 40, reorderChance: 0.15, reorderMs: 60, seed: 77 },
      TICKS,
    )

    expect(run.hashes).toHaveLength(recordStream(TICKS).batches.length)
    expect(run.hashes[run.hashes.length - 1]).not.toBe(expected[TICKS - 1])
    expect(run.gaps).toBeGreaterThan(0)
  })
})
