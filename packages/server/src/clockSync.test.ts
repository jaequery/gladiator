/**
 * The server's stopwatch.
 *
 * Half of these assert that it measures what it says it measures. The other
 * half assert that a client cannot make it measure something else, which is the
 * reason the stopwatch is on this side of the wire at all.
 */
import { UNKNOWN_RTT } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { PING_INTERVAL_MS, createClockSync } from './clockSync.ts'

describe('the server measures the round trip', () => {
  it('reports nothing until a pong has come back', () => {
    const sync = createClockSync()
    expect(sync.rttMs).toBe(UNKNOWN_RTT)
    const ping = sync.ping(0, 100, 2)
    expect(ping).toEqual({ t: 'ping', id: 0, tick: 100, rttMs: UNKNOWN_RTT, queued: 2 })
  })

  it('measures the trip on its own clock and carries it in the next ping', () => {
    const sync = createClockSync()
    const first = sync.ping(1000, 10, 0)
    expect(sync.pong(first.id, 1042)).toBe(42)
    expect(sync.rttMs).toBe(42)
    expect(sync.ping(1200, 35, 1).rttMs).toBe(42)
  })

  it('is due immediately, then once an interval later', () => {
    const sync = createClockSync()
    expect(sync.due(0)).toBe(true)
    sync.ping(0, 0, 0)
    expect(sync.due(PING_INTERVAL_MS - 1)).toBe(false)
    expect(sync.due(PING_INTERVAL_MS)).toBe(true)
  })

  it('takes the minimum of the window, not the mean', () => {
    // Jitter is one-sided — a packet is delayed and never hurried — so the
    // smallest sample is the least contaminated estimate of the true floor. A
    // mean would be dragged upward by the one 300 ms outlier for as long as it
    // stayed in the window, and lag compensation would rewind by it.
    const sync = createClockSync({ window: 4 })
    for (const rtt of [80, 300, 90, 84]) {
      const ping = sync.ping(0, 0, 0)
      sync.pong(ping.id, rtt)
    }
    expect(sync.rttMs).toBe(80)
  })

  it('forgets samples that have left the window, so a route that slowed is followed', () => {
    const sync = createClockSync({ window: 2 })
    for (const rtt of [20, 100, 110]) {
      const ping = sync.ping(0, 0, 0)
      sync.pong(ping.id, rtt)
    }
    expect(sync.rttMs).toBe(100)
  })

  it('rounds to whole milliseconds, because that is what goes on the wire', () => {
    const sync = createClockSync()
    const ping = sync.ping(0, 0, 0)
    sync.pong(ping.id, 41.6)
    expect(sync.rttMs).toBe(42)
    expect(Number.isInteger(sync.ping(500, 0, 0).rttMs)).toBe(true)
  })
})

describe('a client cannot manufacture a round trip', () => {
  it('refuses a pong for an id it never minted', () => {
    const sync = createClockSync()
    sync.ping(0, 0, 0)
    expect(sync.pong(9999, 1)).toBe(UNKNOWN_RTT)
    expect(sync.rttMs).toBe(UNKNOWN_RTT)
    expect(sync.stats.unmatched).toBe(1)
  })

  it('refuses a second pong for an id it has already answered', () => {
    // Otherwise the cheapest attack in the game: answer the same id again a
    // microsecond later and the "round trip" collapses to nothing.
    const sync = createClockSync()
    const ping = sync.ping(0, 0, 0)
    expect(sync.pong(ping.id, 90)).toBe(90)
    expect(sync.pong(ping.id, 90.1)).toBe(UNKNOWN_RTT)
    expect(sync.rttMs).toBe(90)
    expect(sync.stats.unmatched).toBe(1)
  })

  it('never reuses an id, so a stale pong cannot answer a later ping', () => {
    const sync = createClockSync({ maxOutstanding: 2 })
    const ids = [sync.ping(0, 0, 0).id, sync.ping(200, 0, 0).id, sync.ping(400, 0, 0).id]
    expect(new Set(ids).size).toBe(3)
    // The first was given up on when the third was minted; answering it now
    // matches nothing rather than being credited to the third.
    expect(sync.pong(ids[0] as number, 401)).toBe(UNKNOWN_RTT)
  })

  it('writes off the pings a pong overtook rather than holding them forever', () => {
    const sync = createClockSync()
    const first = sync.ping(0, 0, 0)
    const second = sync.ping(200, 0, 0)
    expect(sync.outstanding).toBe(2)
    expect(sync.pong(second.id, 240)).toBe(40)
    expect(sync.outstanding).toBe(0)
    expect(sync.stats.abandoned).toBe(1)
    expect(sync.pong(first.id, 500)).toBe(UNKNOWN_RTT)
  })

  it('bounds the table a silent peer can grow', () => {
    // A peer that never answers must not be able to make the server hold a
    // send time per ping until the room closes.
    const sync = createClockSync({ maxOutstanding: 4 })
    for (let i = 0; i < 500; i += 1) sync.ping(i * PING_INTERVAL_MS, 0, 0)
    expect(sync.outstanding).toBe(4)
    expect(sync.stats.abandoned).toBe(496)
  })
})
