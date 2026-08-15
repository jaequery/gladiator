/**
 * The performance panel's contents.
 *
 * Same split, and the same reason, as `ui/hudModel.ts` and `ui/hud.ts`: the
 * suite runs in Node, so the decisions live in a pure function and the DOM is a
 * thin writer over it. What is asserted here is the acceptance check verbatim —
 * that the panel shows the tick, the round trip, the pending-command count, the
 * predicted-versus-server error **in units**, and snapshot bytes per second.
 */
import { describe, expect, it } from 'vitest'

import { devHudRows, devMode, formatRate, formatUnits, type DevHudModel } from './devHud.ts'

function model(over: Partial<DevHudModel> = {}): DevHudModel {
  return {
    tick: 4120,
    commandTick: 4127,
    rttMs: 42,
    pending: 5,
    errorUnits: 0.37,
    worstErrorUnits: 12.5,
    snapshots: 900,
    snapshotBytesPerSecond: 18_400,
    fps: 60,
    p99Ms: 15.2,
    frameBudgetMs: 16.7,
    speedClamps: 0,
    worstClampedSpeed: 0,
    selfSplashMispredicts: 0,
    selfSplashes: 3,
    snaps: 0,
    recordedFrames: null,
    ...over,
  }
}

function valueOf(rows: readonly { key: string; value: string }[], key: string): string {
  const row = rows.find((entry) => entry.key === key)
  if (row === undefined) throw new Error(`no row ${key}`)
  return row.value
}

describe('the dev HUD', () => {
  it('is off unless the page asked for it', () => {
    expect(devMode('')).toBe(false)
    expect(devMode('?local=1')).toBe(false)
    expect(devMode('?dev=1')).toBe(true)
    expect(devMode('?dev')).toBe(true)
  })

  it('shows the five readings the ticket names', () => {
    const rows = devHudRows(model())

    expect(valueOf(rows, 'tick')).toBe('4120 / 4127')
    expect(valueOf(rows, 'rtt')).toBe('42 ms')
    expect(valueOf(rows, 'pending')).toBe('5')
    // In units, and beside the worst of the session — a live number with no
    // high-water mark beside it says nothing about the moment that felt wrong.
    expect(valueOf(rows, 'error')).toBe('0.37 / 12.50 u')
    expect(valueOf(rows, 'snap-rate')).toContain('18.4 kB/s')
  })

  it('shows the two counters that should never move', () => {
    const quiet = devHudRows(model())
    expect(valueOf(quiet, 'clamps')).toBe('0')
    expect(valueOf(quiet, 'mispredicts')).toBe('0 / 3')
    expect(quiet.find((row) => row.key === 'clamps')?.state).toBeUndefined()

    const loud = devHudRows(model({ speedClamps: 2, worstClampedSpeed: 41_000, selfSplashMispredicts: 1 }))
    expect(valueOf(loud, 'clamps')).toBe('2 · worst 41000 qu/s')
    expect(loud.find((row) => row.key === 'clamps')?.state).toBe('warn')
    expect(loud.find((row) => row.key === 'mispredicts')?.state).toBe('warn')
  })

  it('says so before the first ping, rather than showing a zero that is a lie', () => {
    expect(valueOf(devHudRows(model({ rttMs: null })), 'rtt')).toBe('—')
    expect(valueOf(devHudRows(model({ snapshotBytesPerSecond: 0 })), 'snap-rate')).toContain('—')
  })

  it('flags frame pacing over budget and nothing else', () => {
    expect(devHudRows(model({ p99Ms: 15 })).find((r) => r.key === 'pace')?.state).toBeUndefined()
    expect(devHudRows(model({ p99Ms: 40 })).find((r) => r.key === 'pace')?.state).toBe('warn')
  })

  it('mentions a recording only when there is one', () => {
    expect(devHudRows(model()).some((row) => row.key === 'demo')).toBe(false)
    expect(valueOf(devHudRows(model({ recordedFrames: 812 })), 'demo')).toBe('812 sub-steps')
  })

  it('has stable keys, so the view builds its fields once', () => {
    const keys = devHudRows(model()).map((row) => row.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(devHudRows(model({ tick: 1, pending: 900 })).map((row) => row.key)).toEqual(keys)
  })
})

describe('the formatting', () => {
  it('reads a byte rate in the unit a person reads it in', () => {
    expect(formatRate(0)).toBe('—')
    expect(formatRate(640)).toBe('640 B/s')
    expect(formatRate(18_432)).toBe('18.4 kB/s')
  })

  it('shows a correction to two places, because the noise floor is 0.1', () => {
    expect(formatUnits(0)).toBe('0')
    expect(formatUnits(0.104)).toBe('0.10')
    expect(formatUnits(123.456)).toBe('123.46')
  })
})
