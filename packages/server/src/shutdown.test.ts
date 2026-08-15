/**
 * The drain, driven by hand.
 *
 * `deploy.test.ts` runs the whole thing over real sockets. This file is about
 * the parts of leaving that a happy path does not exercise: the order the steps
 * happen in, the deadline that keeps the process ahead of SIGKILL, and the
 * second signal — which is not politeness but an override, and is the one thing
 * here that a person will discover by pressing Ctrl-C twice in a hurry.
 */
import { CloseReason, DEFAULT_MATCH_RULES, MatchPhase } from '@gladiator/sim'
import { describe, expect, it, vi } from 'vitest'

import { manualClock } from './clock.ts'
import { createResumeAuthority } from './resume.ts'
import type { RegistryStats, RoomEntry, RoomRegistry } from './rooms.ts'
import { DRAIN_RETRY_AFTER_MS, drainServer, installSignalHandlers, tellPeers } from './shutdown.ts'
import type { Drainable } from './shutdown.ts'

const SECRET = 'a-shared-secret'

type FakePeer = {
  slot: number
  open: boolean
  greeted: boolean
  sent: unknown[]
}

/**
 * A registry with rooms in it and no worlds behind them.
 *
 * The drain reads three things off a room — its phase, its score and its peers
 * — and a real `Room` would drag an arena in to answer them.
 */
function registry(
  rooms: Record<string, { phase: number; wins: [number, number]; round: number; peers: FakePeer[] }>,
): RoomRegistry & { closedWith: { code: number; reason: string } | null } {
  let closedWith: { code: number; reason: string } | null = null
  const entryOf = (code: string): RoomEntry => {
    const live = rooms[code]
    if (live === undefined) throw new Error(`no room ${code}`)
    return {
      code,
      createdMs: 0,
      emptySinceMs: null,
      room: {
        state: { match: { phase: live.phase, wins: live.wins, round: live.round } },
        peers: live.peers.map((peer) => ({
          ...peer,
          session: { greeted: peer.greeted, rejected: false },
          send: (message: unknown) => peer.sent.push(message),
        })),
      },
    } as unknown as RoomEntry
  }

  return {
    get closedWith() {
      return closedWith
    },
    codes: () => Object.keys(rooms),
    get: (code) => (code !== null && code !== undefined && code in rooms ? entryOf(code) : null),
    create: () => null,
    adopt: () => null,
    remove: () => false,
    advance: () => undefined,
    sweep: () => undefined,
    get size() {
      return Object.keys(rooms).length
    },
    stats: (): RegistryStats => ({
      rooms: Object.keys(rooms).length,
      capacity: 200,
      peers: 0,
      created: 0,
      reaped: 0,
      missed: 0,
      faulted: 0,
    }),
    closeAll: (code = CloseReason.Normal, reason = '') => {
      closedWith = { code, reason }
      for (const key of Object.keys(rooms)) delete rooms[key]
    },
  }
}

function peer(slot: number, over: Partial<FakePeer> = {}): FakePeer {
  return { slot, open: true, greeted: true, sent: [], ...over }
}

const resume = createResumeAuthority({ secret: SECRET, rules: DEFAULT_MATCH_RULES })

describe('telling the peers', () => {
  it('gives every seated peer its own ticket, naming its own seat', () => {
    const first = peer(0)
    const second = peer(1)
    const rooms = registry({
      H7K2Q9: { phase: MatchPhase.Live, wins: [1, 0], round: 2, peers: [first, second] },
    })

    const told = tellPeers({ rooms, resume, retryAfterMs: DRAIN_RETRY_AFTER_MS })
    expect(told).toEqual({ told: 2, ticketed: 2 })

    const frames = [first, second].map((one) => one.sent[0] as { resume: string; room: string })
    expect(frames[0]?.room).toBe('H7K2Q9')
    expect(resume.verify(frames[0]?.resume)).toMatchObject({
      claim: { slot: 0, score: { wins: [1, 0], roundsPlayed: 1 } },
    })
    expect(resume.verify(frames[1]?.resume)).toMatchObject({ claim: { slot: 1 } })
  })

  it('says nothing to a peer that has not finished the handshake', () => {
    // It may be a client one deploy behind, on its way to being told so. A
    // ticket is no use to something that never had a seat in the match.
    const half = peer(1, { greeted: false })
    const rooms = registry({
      H7K2Q9: { phase: MatchPhase.Live, wins: [0, 0], round: 1, peers: [peer(0), half] },
    })
    expect(tellPeers({ rooms, resume, retryAfterMs: 1 })).toEqual({ told: 1, ticketed: 1 })
    expect(half.sent).toHaveLength(0)
  })

  it('tells a finished match it is going away, with no ticket', () => {
    // There is nothing to resume. A client that reconnected on this would be
    // starting a fresh match nobody asked for.
    const only = peer(0)
    const rooms = registry({
      H7K2Q9: { phase: MatchPhase.Over, wins: [3, 1], round: 4, peers: [only] },
    })
    expect(tellPeers({ rooms, resume, retryAfterMs: 1 })).toEqual({ told: 1, ticketed: 0 })
    expect(only.sent[0]).toMatchObject({ t: 'drain', resume: '' })
  })
})

/** A `Drainable` whose sockets close after `closeAfter` polls. */
function drainable(rooms: ReturnType<typeof registry>, closeAfter = 1) {
  let sessions = 2
  let polls = 0
  let closed = false
  const target: Drainable & { readonly closed: boolean } = {
    beginDraining: vi.fn(),
    draining: false,
    rooms,
    get sessions() {
      polls += 1
      if (polls > closeAfter) sessions = 0
      return sessions
    },
    close: async () => {
      closed = true
    },
    get closed() {
      return closed
    },
  }
  return target
}

describe('draining a server', () => {
  it('stops being ready, tells everybody, then closes the rooms with 1001', async () => {
    const rooms = registry({
      H7K2Q9: { phase: MatchPhase.Live, wins: [0, 1], round: 2, peers: [peer(0), peer(1)] },
    })
    const server = drainable(rooms)

    const report = await drainServer({
      server,
      resume,
      clock: manualClock(),
      sleep: async () => undefined,
    })

    expect(server.beginDraining).toHaveBeenCalled()
    expect(report).toMatchObject({ rooms: 1, told: 2, ticketed: 2, timedOut: false })
    // 1001, not 1000: "going away" is what lets a client tell a deploy from a
    // crash and from being kicked.
    expect(rooms.closedWith?.code).toBe(CloseReason.GoingAway)
    expect(server.closed).toBe(true)
  })

  it('gives up at the deadline rather than waiting to be killed', async () => {
    // A socket that never completes its close must not hold the process past
    // `kill_timeout`: being SIGKILLed mid-drain is indistinguishable from the
    // crash this whole module exists to avoid.
    const clock = manualClock()
    const rooms = registry({
      H7K2Q9: { phase: MatchPhase.Live, wins: [0, 0], round: 1, peers: [peer(0)] },
    })
    const server: Drainable = {
      beginDraining: () => undefined,
      draining: true,
      rooms,
      sessions: 1,
      close: async () => undefined,
    }

    const report = await drainServer({
      server,
      resume,
      clock,
      deadlineMs: 100,
      // Each poll is a millisecond of the deadline's clock, so the loop ends by
      // running out of time rather than by running out of patience.
      sleep: async () => {
        clock.advance(25)
      },
    })
    expect(report.timedOut).toBe(true)
    expect(report.waitedMs).toBeGreaterThanOrEqual(100)
  })

  it('is safe to run twice', async () => {
    const rooms = registry({
      H7K2Q9: { phase: MatchPhase.Live, wins: [0, 0], round: 1, peers: [peer(0)] },
    })
    const server = drainable(rooms)
    await drainServer({ server, resume, clock: manualClock(), sleep: async () => undefined })
    const second = await drainServer({
      server,
      resume,
      clock: manualClock(),
      sleep: async () => undefined,
    })
    // The rooms have already gone, so there is nobody left to tell — and that
    // is a quiet second drain rather than an error.
    expect(second).toMatchObject({ rooms: 0, told: 0, timedOut: false })
  })
})

describe('the signal handlers', () => {
  function fakeProcess() {
    const handlers = new Map<string, () => void>()
    const exits: number[] = []
    return {
      handlers,
      exits,
      process: {
        on(signal: string, handler: () => void) {
          handlers.set(signal, handler)
          return this
        },
        exit(code: number) {
          exits.push(code)
          return undefined as never
        },
      },
    }
  }

  it('drains once and exits 0', async () => {
    const fake = fakeProcess()
    let drains = 0
    installSignalHandlers({
      process: fake.process,
      drain: async () => {
        drains += 1
      },
    })
    fake.handlers.get('SIGTERM')?.()
    await new Promise((resolve) => setImmediate(resolve))
    expect(drains).toBe(1)
    expect(fake.exits).toEqual([0])
  })

  it('treats a second signal as "stop now" rather than queueing another drain', async () => {
    // Ctrl-C pressed again because nothing appeared to happen is the commonest
    // way anyone will ever meet this code, and a handler that waited politely
    // would be a process that cannot be stopped by the one key everybody tries.
    const fake = fakeProcess()
    let drains = 0
    installSignalHandlers({
      process: fake.process,
      drain: () => {
        drains += 1
        return new Promise(() => undefined)
      },
    })
    fake.handlers.get('SIGINT')?.()
    fake.handlers.get('SIGINT')?.()
    expect(drains).toBe(1)
    expect(fake.exits).toEqual([1])
  })

  it('exits non-zero if the drain itself fails', async () => {
    const fake = fakeProcess()
    installSignalHandlers({
      process: fake.process,
      drain: async () => {
        throw new Error('the socket layer fell over')
      },
    })
    fake.handlers.get('SIGTERM')?.()
    await new Promise((resolve) => setImmediate(resolve))
    expect(fake.exits).toEqual([1])
  })
})
