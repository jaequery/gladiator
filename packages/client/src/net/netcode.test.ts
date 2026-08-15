/**
 * The netcode acceptance checks, over a real host and a bad network.
 *
 * A minute of play at 60 frames a second, four times, on four latency profiles
 * with jitter and packet loss on all of them. The client is the shipping one
 * (`fixtures/netcodeHarness.ts` says so at length); the host is a real `Room`;
 * the only thing invented is the wall clock, which is a number this file
 * advances so that four minutes of duel cost CI a few seconds.
 *
 * ## Loss is a stall
 *
 * Every profile below sets `retransmitMs`. The transport is a WebSocket, which
 * is TCP, and TCP does not drop data — it retransmits it, which stalls
 * everything behind the missing frame for about a round trip and then delivers
 * the lot in a burst. That is a materially harder thing for prediction to sit
 * through than a gap would be, because the client keeps sending into the stall
 * and gets a burst of acknowledgements back at the end of it. Modelling it as a
 * gap would be modelling a network this game does not run on, and it would let
 * an 80 ms interpolation buffer look like it covered loss.
 *
 * ## What the last test is really for
 *
 * The tick-for-tick hash comparison is this project's physics-engine
 * containment mechanism. Lint catches the imports somebody anticipated; a
 * hash that has to match a host's, on every tick of a minute, catches the
 * category — an engine collision routine, a camera read back into the
 * simulation, a stray `Math.random`, a field the wire codec forgot. None of
 * those has to be thought of in advance to be caught here.
 */
import { SKELETON_SEED, createMapState, hashState, tick as simTick } from '@gladiator/sim'
import { NO_LAG, type LagProfile } from '@gladiator/server/net/laggedTransport'
import { describe, expect, it } from 'vitest'

import { CLIENT_MAP } from '../map.ts'
import { playSession, type PlayedSession } from './fixtures/netcodeHarness.ts'
import { NOTICEABLE_CORRECTION_UNITS } from './prediction.ts'
import { CorrectionBand } from './reconcile.ts'

/** A minute of play at 60 Hz. 3600 frames is 7500 ticks. */
const FRAMES = 3600

/**
 * The four links the acceptance check names, one way each — so `latencyMs` is
 * half the round trip. Every one of them loses frames and retransmits them,
 * because a link that never lost anything would prove nothing about the half of
 * this ticket that exists for the ones that do.
 */
const PROFILES: ReadonlyArray<{ readonly name: string; readonly profile: LagProfile }> = [
  {
    name: 'LAN',
    profile: {
      ...NO_LAG,
      latencyMs: 0.5,
      jitterMs: 1,
      lossChance: 0.001,
      retransmitMs: 5,
      seed: 0x1a4e,
    },
  },
  {
    name: '40 ms',
    profile: {
      ...NO_LAG,
      latencyMs: 20,
      jitterMs: 5,
      lossChance: 0.005,
      retransmitMs: 40,
      seed: 0x2b5f,
    },
  },
  {
    name: '80 ms',
    profile: {
      ...NO_LAG,
      latencyMs: 40,
      jitterMs: 10,
      lossChance: 0.01,
      retransmitMs: 80,
      seed: 0x3c60,
    },
  },
  {
    name: '180 ms',
    profile: {
      ...NO_LAG,
      latencyMs: 90,
      jitterMs: 25,
      lossChance: 0.02,
      retransmitMs: 180,
      seed: 0x4d71,
    },
  },
]

/**
 * The hash at every tick of a bare `tick()` loop over the same commands.
 *
 * Not a restatement of the client: the client's world is *overwritten* by an
 * authoritative snapshot several times a second and rebuilt by replaying
 * whatever was unacknowledged. This is what it is supposed to come out equal
 * to, and it is the only way to make "tick-for-tick" mean every tick rather
 * than every batch boundary — the host only hashes once per batch, because 125
 * hashes a second in the other direction to say "still fine" is not a thing to
 * spend a duel's bandwidth on.
 */
function referenceTrace(session: PlayedSession): number[] {
  const state = createMapState(CLIENT_MAP.source, SKELETON_SEED)
  const trace: number[] = []
  for (const cmd of session.sent) {
    simTick(state, [cmd], CLIENT_MAP.world)
    trace.push(hashState(state))
  }
  return trace
}

async function played(profile: LagProfile, frames = FRAMES): Promise<PlayedSession> {
  const session = playSession({ map: CLIENT_MAP, profile })
  await session.run(frames)
  return session
}

describe.each(PROFILES)('a minute of play over $name', ({ profile }) => {
  it(
    'never hard-snaps, never desyncs, and stays inside the correction budget',
    { timeout: 180_000 },
    async () => {
      const session = await played(profile)
      const stats = session.predictor.stats
      const net = session.net.snapshot()

      // The run happened at all: a session that never went live would pass
      // every assertion below by doing nothing.
      expect(net.status).toBe('live')
      expect(stats.predicted).toBeGreaterThan(7000)
      expect(net.dropped).toBe(0)

      // And the network really was bad. `stalled` is the loss injection: frames
      // the loss draw picked, held for a retransmission, holding up everything
      // behind them.
      expect(session.link.stats.stalled).toBeGreaterThan(0)
      expect(session.link.stats.dropped).toBe(0)

      // Reconciliation ran, and had something to do: a run in which every
      // snapshot arrived with nothing outstanding would exercise the adopt and
      // never the replay.
      expect(stats.reconciled).toBeGreaterThan(2000)
      expect(stats.replayed).toBeGreaterThan(stats.reconciled)
      expect(stats.rejected).toBe(0)
      expect(stats.overflowed).toBe(0)

      // No hard snaps. A snap is a teleport, a telefrag or a desync, and none
      // of the three is a thing a working link produces.
      expect(stats.snaps).toBe(0)
      expect(session.corrections.some((c) => c.band === CorrectionBand.Snap)).toBe(false)

      // No desync events: every hash the host sent matched the one this client
      // had predicted for that tick.
      expect(net.compared).toBeGreaterThan(2000)
      expect(net.mismatched).toBe(0)

      // Corrections over a unit, on under 5% of ticks.
      const rate = stats.noticeable / stats.predicted
      expect(rate, `${stats.noticeable} corrections over ${NOTICEABLE_CORRECTION_UNITS} qu`).toBeLessThan(0.05)

      session.stop()
    },
  )
})

describe('the containment mechanism', () => {
  it(
    'agrees with a bare tick() loop on every one of 7500 ticks, at 80 ms with loss',
    { timeout: 180_000 },
    async () => {
      const profile = PROFILES[2]?.profile
      if (profile === undefined) throw new Error('no 80 ms profile')
      const session = await played(profile)
      // A run ends with a round trip of commands still in the air. Comparing
      // the two endpoints needs the network to have gone quiet first.
      await session.drain()

      const reference = referenceTrace(session)
      expect(reference.length).toBeGreaterThan(7000)

      // The host arrived at the same place, which is what makes the reference
      // above the *server's* trace and not merely a second opinion of the
      // client's.
      expect(session.room.tick).toBe(reference.length)
      expect(session.room.hash()).toBe(reference[reference.length - 1])

      // And the client predicted every one of those ticks identically — while
      // its world was being overwritten by an authoritative snapshot and
      // rebuilt from the unacknowledged commands sixty times a second.
      const divergences: Array<{ tick: number; ours: number; reference: number }> = []
      for (let index = 0; index < reference.length; index += 1) {
        const tick = index + 1
        const ours = session.predictedHashes.get(tick)
        if (ours !== reference[index]) {
          divergences.push({ tick, ours: ours ?? -1, reference: reference[index] as number })
        }
      }
      // Reported with the tick rather than as a bare count: a desync is only
      // debuggable if you know when it started.
      expect(divergences.slice(0, 5)).toEqual([])
      expect(divergences).toHaveLength(0)

      // And the run went somewhere, rather than agreeing about a player who
      // never moved.
      const first = session.eyes[0]
      const last = session.eyes[session.eyes.length - 1]
      const travelled =
        Math.abs((last?.[0] ?? 0) - (first?.[0] ?? 0)) +
        Math.abs((last?.[1] ?? 0) - (first?.[1] ?? 0))
      expect(travelled).toBeGreaterThan(100)

      session.stop()
    },
  )
})
