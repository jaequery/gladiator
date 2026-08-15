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
  PROTOCOL_VERSION,
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
import { SERVER_MAP, SERVER_MAP_HASH, SERVER_PLAN } from '../map.ts'
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

  it('retransmits instead of losing, when asked to model TCP', () => {
    // Same seed, same profile, one field different: the frames the loss draw
    // picked arrive late instead of never. Nothing is lost, and nothing is
    // reordered — which is the whole of what a WebSocket promises.
    const lossy = { lossChance: 0.25, seed: 12345 }
    const dropped = pushThrough(lossy, 200)
    const stalled = pushThrough({ ...lossy, retransmitMs: 120 }, 200)

    const inOrder = Array.from({ length: 200 }, (_, i) => `frame-${i}`)
    expect(stalled).toEqual(inOrder)
    expect(dropped.length).toBeLessThan(200)
    // And the ones it saved are exactly the ones the other run lost.
    expect(dropped.every((frame) => stalled.includes(frame))).toBe(true)
  })

  it('stalls and then bursts, which is what head-of-line blocking looks like', () => {
    // The block is the difference between a TCP stall and a UDP gap, and it is
    // what an interpolation buffer sized for jitter does not cover. A model
    // that let the frames behind a lost one through would deliver them evenly
    // and make loss look like something the buffer already handles.
    const inner = sink()
    const link = laggedTransport(inner.transport, {
      ...NO_LAG,
      latencyMs: 10,
      lossChance: 0.2,
      retransmitMs: 150,
      seed: 20260814,
    })

    // One frame a millisecond, and a note of the millisecond each one landed on.
    const arrivals: number[] = []
    for (let ms = 0; ms < 200; ms += 1) {
      link.send(`frame-${ms}`)
      const before = inner.sent.length
      link.pump(ms)
      for (let i = before; i < inner.sent.length; i += 1) arrivals.push(ms)
    }
    link.flush()

    expect(link.stats.stalled).toBeGreaterThan(20)
    expect(link.stats.dropped).toBe(0)
    // In order, all of them: a retransmitting link loses nothing and reorders
    // nothing, which is exactly the contract `sim/src/transport.ts` states.
    expect(inner.sent.map(String)).toEqual(Array.from({ length: 200 }, (_, i) => `frame-${i}`))

    // The signature. On a link with only latency and jitter, one frame goes in
    // per millisecond and one comes out; a stall holds a run of them and then
    // releases the lot on the millisecond the refetch lands.
    const burst = new Map<number, number>()
    for (const ms of arrivals) burst.set(ms, (burst.get(ms) ?? 0) + 1)
    expect(Math.max(...burst.values())).toBeGreaterThan(1)

    // And there really were gaps to burst out of: a stretch where the link
    // delivered nothing at all for longer than its latency.
    const sorted = [...new Set(arrivals)].sort((a, b) => a - b)
    const longestGap = sorted.reduce(
      (worst, ms, index) => (index === 0 ? worst : Math.max(worst, ms - (sorted[index - 1] as number))),
      0,
    )
    expect(longestGap).toBeGreaterThan(10)
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
 * the order it was sent. That is what these profiles model and it is what the
 * matrix below asserts.
 *
 * What it deliberately no longer asserts is that the *world* comes out
 * identical on all of them. Until GLAD-FHKBN8 a room advanced by exactly the
 * batch it was handed, so arrival timing could not reach the simulation and
 * "same frames in, same hash out" was a tautology worth pinning. There is now a
 * fixed-rate scheduler in the middle with a two-tick jitter buffer in front of
 * it, and a jitter buffer's entire job is to *change the world* rather than
 * stall: a command that misses its tick is replaced by the fallback, and a
 * buffer that has run deep merges two commands into one (`inputQueue.ts`). A
 * 250 ms link with 120 ms of jitter is fifteen ticks of swing against a
 * two-tick buffer, and it would be surprising — and a bug in the policy — if
 * that produced the same world as a LAN.
 *
 * So the claim splits in two, and both halves are below. The *link* delivers
 * everything, once, in order, on every profile: that is this module's contract
 * and it is asserted at the host's door, where duplicates and lates are
 * counted. And the *world* is identical when the buffer is never asked to
 * compensate, which is the case the scheduler was written to make ordinary.
 * The end-to-end version of the second claim lives in `net/parity.test.ts`,
 * which runs one stream through a real socket and an in-process loopback on one
 * schedule and requires one hash trace out of both.
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
  /** Commands the host was offered. */
  readonly commands: number
  /** Commands the buffer took. */
  readonly accepted: number
  /** Commands the buffer turned away: a duplicate, a late one, or a flood. */
  readonly refused: number
  /** Sub-steps in which a buffer was empty and the fallback ran. */
  readonly starved: number
  /** What the link itself did, which is the contract these profiles model. */
  readonly link: { readonly dropped: number; readonly duplicated: number; readonly reordered: number }
}

/**
 * Push the recorded stream through a lagged link into a room, and collect the
 * hashes.
 *
 * The drive is the same one `net/parity.test.ts` uses, because the two tests
 * are asking about the same host: wall-clock advances by exactly the simulated
 * time in the batch about to be sent, the link is pumped, and then the room is
 * advanced by exactly that many sub-steps. So the *host* is running at a steady
 * 125 Hz on its own clock, which is the thing under test, and the only variable
 * between profiles is when the link chose to hand each frame over.
 */
async function runMatrix(profile: LagProfile, ticks: number): Promise<MatrixRun> {
  const pair = createLoopbackPair()
  const link = laggedTransport(pair.client, profile)
  const clock = manualClock()
  const room = createRoom({
    map: SERVER_MAP,
    plan: SERVER_PLAN,
    clock,
    build: 'matrix',
    peerId: (index) => `peer-${index}`,
  })
  const peer = room.join(pair.server)

  const hashes: number[] = []
  link.setHandlers({
    onMessage: (message) => {
      if (typeof message !== 'string') throw new Error('the host answered in binary')
      const parsed: ServerMessage | null = parseServerMessage(message)
      if (parsed?.t === 'hash') hashes.push(parsed.hash >>> 0)
    },
  })

  const stream = recordStream(ticks)
  link.send(
    JSON.stringify({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      build: 'matrix',
      mapHash: SERVER_MAP_HASH,
    }),
  )
  for (const batch of stream.batches) {
    // Wall-clock advances by exactly the simulated time in the batch, so a
    // 150 ms link really is nineteen ticks behind rather than nominally so —
    // and the rate limit in front of the buffer is charged the same way an
    // honest client would charge it.
    clock.advance(batch.cmds.length * 8)
    link.send(batchFrame(batch))
    link.pump(clock.nowMs())
    await settleLoopback(pair)
    room.advance(batch.cmds.length)
    await settleLoopback(pair)
  }

  // Drain: keep beating until nothing is held anywhere. Bounded, because a
  // harness that could spin forever is a harness that will.
  for (let beat = 0; beat < 10_000 && (link.inFlight > 0 || !pair.idle); beat += 1) {
    link.pump(clock.advance(8))
    await settleLoopback(pair)
  }

  const seen = room.snapshot()
  const session = peer.session
  const stats = link.stats
  pair.close()
  return {
    hashes,
    gaps: seen.gaps,
    commands: session.commands,
    accepted: session.accepted,
    refused: session.refused,
    starved: seen.starved,
    link: { dropped: stats.dropped, duplicated: stats.duplicated, reordered: stats.reordered },
  }
}

describe('the latency matrix', () => {
  const TICKS = 600

  it('delivers every command exactly once and in order, however bad the link', { timeout: 60_000 }, async () => {
    // The link's contract, asserted where a violation would actually be
    // visible: at the host's door. Every command was offered, and every batch
    // followed on from the one before it, which together say that nothing was
    // lost, nothing was duplicated and nothing overtook anything.
    //
    // What is deliberately *not* asserted is that the buffer took all of them.
    // A 250 ms link against a client with no lead delivers a quarter of a
    // second of backlog in one burst, and the buffer's hard ceiling
    // (`MAX_BUFFERED_COMMANDS`) refuses the tail of it on purpose — that
    // ceiling is what stops a peer making the host hold an unbounded array, and
    // a client that ran a real lead would never build the backlog in the first
    // place.
    for (const profile of MATRIX) {
      const run = await runMatrix(profile, TICKS)
      const label = `profile ${profile.latencyMs}±${profile.jitterMs}ms`
      expect(run.commands, label).toBe(TICKS)
      expect(run.gaps, label).toBe(0)
      expect(run.link.dropped, label).toBe(0)
      expect(run.link.duplicated, label).toBe(0)
      expect(run.link.reordered, label).toBe(0)
    }
  })

  it('produces the reference world when the buffer never has to compensate', async () => {
    // The world claim, on the one profile where the jitter buffer is not being
    // asked to do anything: every command is in the buffer before the sub-step
    // that wants it, so the host executes exactly the recorded stream and the
    // hash trace is the one a bare `tick()` loop produces. A failure here is a
    // host that has started depending on arrival timing even when there is none.
    const expected = referenceHashes(TICKS)
    const batches = recordStream(TICKS).batches.length
    const run = await runMatrix({ ...NO_LAG, seed: 11 }, TICKS)

    expect(run.starved).toBe(0)
    expect(run.hashes).toHaveLength(batches)
    expect(run.hashes[run.hashes.length - 1]).toBe(expected[TICKS - 1])
  })

  it('breaks the world when frames actually go missing', { timeout: 60_000 }, async () => {
    // The other half of the claim: with a *gap* — loss on a link that does not
    // retransmit, which is a datagram and not what this game runs on — commands
    // never reach the host at all, and it notices rather than renumbering the
    // gap away. What TCP actually does is `retransmitMs`, and that case is
    // measured in `client/src/net/netcode.test.ts`.
    const expected = referenceHashes(TICKS)
    // Seed 67 rather than any seed: the first frame through the link is the
    // hello, and a run that loses *that* proves nothing about commands — it is
    // a session that never opened, which belongs to GLAD-DVDV6P.
    const run = await runMatrix({ ...NO_LAG, latencyMs: 20, lossChance: 0.3, seed: 67 }, TICKS)

    expect(run.hashes.length, 'the handshake survived').toBeGreaterThan(0)
    expect(run.commands).toBeLessThan(TICKS)
    expect(run.hashes[run.hashes.length - 1]).not.toBe(expected[TICKS - 1])
    // And the host noticed rather than renumbering the gap away.
    expect(run.gaps).toBeGreaterThan(0)
  })

  it('breaks the world when frames arrive out of order', { timeout: 60_000 }, async () => {
    // Reordering is a deliberate violation of the transport contract, offered
    // so the cost of moving to unreliable datagrams can be measured rather than
    // guessed at — `sim/src/transport.ts` lists what would break. Every command
    // still arrives; applying them in the wrong order is enough on its own, and
    // the buffer turns some of them away as late rather than rewinding the
    // world for input.
    const expected = referenceHashes(TICKS)
    const run = await runMatrix(
      { ...NO_LAG, latencyMs: 40, reorderChance: 0.15, reorderMs: 60, seed: 77 },
      TICKS,
    )

    expect(run.commands).toBe(TICKS)
    expect(run.refused).toBeGreaterThan(0)
    expect(run.hashes[run.hashes.length - 1]).not.toBe(expected[TICKS - 1])
    expect(run.gaps).toBeGreaterThan(0)
  })
})
