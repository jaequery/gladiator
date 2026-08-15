/**
 * Coming back: which closes are worth it, how long to wait, and what the world
 * has to throw away on the way in.
 *
 * The policy is pure and tested as such; the behaviour is tested against a
 * `NetClient` with a fake pipe, because "shows *reconnecting* rather than *match
 * over*" is a claim about a status field a HUD reads and not about a function's
 * return value.
 */
import {
  CloseReason,
  PROTOCOL_VERSION,
  TransportState,
  type Transport,
  type TransportHandlers,
  type TransportMessage,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { createNetClient, mustHoldStill, rejoinUrl, type RedialContext } from './client.ts'
import {
  RECONNECT_BASE_MS,
  RECONNECT_CEILING_MS,
  RECONNECT_WINDOW_MS,
  Retry,
  backoffMs,
  createReconnectPolicy,
  retryVerdict,
} from './reconnect.ts'
import {
  CLOSE_MAP_MISMATCH,
  CLOSE_MATCH_ENDED,
  CLOSE_NO_SUCH_ROOM,
  CLOSE_REPLACED,
  CLOSE_ROOM_FULL,
  CLOSE_VERSION_MISMATCH,
} from '@gladiator/server/session'

const MAP_HASH = 'a1b2c3d4'
const ROOM = 'H7K2Q9'
const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef'

describe('which closes are worth coming back from', () => {
  it('backs off for the ones that are a moment rather than a verdict', () => {
    // A deploy, a broken wire, a host having a bad time. None of them is an
    // answer to anything, and all of them are over in seconds.
    expect(retryVerdict(CloseReason.GoingAway)).toBe(Retry.Backoff)
    expect(retryVerdict(CloseReason.Abnormal)).toBe(Retry.Backoff)
    expect(retryVerdict(1011)).toBe(Retry.Backoff)
    expect(retryVerdict(1012)).toBe(Retry.Backoff)
  })

  it('stops for the ones the host meant', () => {
    // Every one of these is still true a second later, so retrying is a client
    // hammering a host that has already told it the truth — and a player
    // watching a spinner instead of reading a sentence.
    expect(retryVerdict(CloseReason.Normal)).toBe(Retry.Stop)
    expect(retryVerdict(CloseReason.PolicyViolation)).toBe(Retry.Stop)
    expect(retryVerdict(CLOSE_VERSION_MISMATCH)).toBe(Retry.Stop)
    expect(retryVerdict(CLOSE_MAP_MISMATCH)).toBe(Retry.Stop)
    expect(retryVerdict(CLOSE_ROOM_FULL)).toBe(Retry.Stop)
    expect(retryVerdict(CLOSE_NO_SUCH_ROOM)).toBe(Retry.Stop)
    expect(retryVerdict(CLOSE_MATCH_ENDED)).toBe(Retry.Stop)
    // And the one that would otherwise be an infinite loop between two tabs,
    // each evicting the other from the same seat.
    expect(retryVerdict(CLOSE_REPLACED)).toBe(Retry.Stop)
  })
})

describe('the backoff', () => {
  it('stays inside 250 ms and 4 s, whatever the draw', () => {
    for (const draw of [0, 0.5, 0.999999]) {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const delay = backoffMs(attempt, { random: () => draw })
        expect(delay).toBeGreaterThanOrEqual(RECONNECT_BASE_MS)
        expect(delay).toBeLessThanOrEqual(RECONNECT_CEILING_MS)
      }
    }
  })

  it('doubles the window it draws from, and stops at the ceiling', () => {
    const worst = (attempt: number) => backoffMs(attempt, { random: () => 0.999999 })
    expect(worst(0)).toBe(RECONNECT_BASE_MS)
    expect(worst(1)).toBeCloseTo(2 * RECONNECT_BASE_MS, -1)
    expect(worst(2)).toBeCloseTo(4 * RECONNECT_BASE_MS, -1)
    expect(worst(20)).toBeCloseTo(RECONNECT_CEILING_MS, -1)
  })

  it('spreads a machine full of clients rather than releasing them together', () => {
    // The reason this is not a plain doubling: a host that restarts drops every
    // socket it holds in the same millisecond, and clients that all waited
    // exactly 250 then 500 then 1000 ms would arrive back in lockstep.
    const draws = [0.01, 0.2, 0.4, 0.6, 0.8, 0.99]
    const delays = draws.map((draw) => backoffMs(4, { random: () => draw }))
    expect(new Set(delays).size).toBe(draws.length)
    expect(Math.max(...delays) - Math.min(...delays)).toBeGreaterThan(RECONNECT_CEILING_MS / 2)
  })

  it('keeps trying past the host\'s window, then gives up', () => {
    // A deadline rather than a count, because what decides whether coming back
    // is worth anything is the seat's thirty seconds — and with full jitter, a
    // count is anywhere between three seconds and half a minute of trying.
    const policy = createReconnectPolicy({ random: () => 0.5 })
    let nowMs = 0

    // Still going well past the grace window a seat is held for.
    while (nowMs < 30_000) {
      const wait = policy.next(CloseReason.Abnormal, nowMs)
      expect(wait).not.toBeNull()
      nowMs += (wait ?? 0) + 1
    }
    expect(policy.exhausted).toBe(false)

    expect(policy.next(CloseReason.Abnormal, RECONNECT_WINDOW_MS)).toBeNull()
    expect(policy.exhausted).toBe(true)
  })

  it('starts the window again after a connection that worked', () => {
    const policy = createReconnectPolicy({ random: () => 0 })
    policy.next(CloseReason.Abnormal, 0)
    policy.next(CloseReason.Abnormal, 100)
    expect(policy.attempts).toBe(2)
    expect(policy.next(CloseReason.Abnormal, RECONNECT_WINDOW_MS)).toBeNull()

    policy.succeed()
    expect(policy.attempts).toBe(0)
    expect(policy.exhausted).toBe(false)
    // And the clock it measures from is the *next* failure, not the last one.
    expect(policy.next(CloseReason.Abnormal, RECONNECT_WINDOW_MS)).toBe(RECONNECT_BASE_MS)
  })
})

describe('rejoinUrl', () => {
  it('puts the room and the seat key on the URL that was dialled', () => {
    const context: RedialContext = { room: ROOM, token: TOKEN, attempt: 1 }
    expect(rejoinUrl('wss://host/', context)).toBe(`wss://host/?room=${ROOM}&token=${TOKEN}`)
  })

  it("prefers the host's own code to whatever the player typed", () => {
    // A player may have typed it with a hyphen in it; the host folds it and
    // answers with the canonical form (`@gladiator/server/roomCode.ts`).
    const url = rejoinUrl('wss://host/?room=h7k-2q9', { room: ROOM, token: TOKEN, attempt: 1 })
    expect(new URL(url).searchParams.get('room')).toBe(ROOM)
  })

  it('keeps the room the page asked for when no welcome ever arrived', () => {
    // A socket that died during the handshake has no seat and no code of its
    // own, and dialling the bare URL again would open a *new* room rather than
    // retrying the one the player was sent a link to.
    const url = rejoinUrl('wss://host/?room=ABC123', { room: null, token: null, attempt: 1 })
    expect(new URL(url).searchParams.get('room')).toBe('ABC123')
    expect(new URL(url).searchParams.get('token')).toBeNull()
  })
})

/* --------------------------------------------------------------------------
 * The client, coming back
 * ----------------------------------------------------------------------- */

class FakePipe implements Transport {
  readyState: TransportState = TransportState.Connecting
  readonly sent: string[] = []
  private handlers: TransportHandlers = {}

  send(message: TransportMessage) {
    this.sent.push(String(message))
  }

  close(code: number = CloseReason.Normal, reason = '') {
    this.readyState = TransportState.Closed
    this.handlers.onClose?.(code, reason)
  }

  setHandlers(handlers: TransportHandlers) {
    this.handlers = handlers
  }

  open() {
    this.readyState = TransportState.Open
    this.handlers.onOpen?.()
  }

  deliver(message: unknown) {
    this.handlers.onMessage?.(JSON.stringify(message))
  }

  hangUp(code: number, reason = '') {
    this.readyState = TransportState.Closed
    this.handlers.onClose?.(code, reason)
  }
}

function welcomeFrame(over: Record<string, unknown> = {}) {
  return {
    t: 'welcome',
    protocol: PROTOCOL_VERSION,
    build: 'srv',
    session: 's1',
    mapHash: MAP_HASH,
    room: ROOM,
    token: TOKEN,
    ...over,
  }
}

/** A live session, plus the levers a test needs: the clock and the redials. */
function session() {
  let nowMs = 0
  let resumes = 0
  const dialled: RedialContext[] = []
  const pipes: FakePipe[] = [new FakePipe()]

  const client = createNetClient({
    transport: pipes[0] ?? null,
    endpoint: 'ws://test',
    build: 'test-build',
    mapHash: MAP_HASH,
    now: () => nowMs,
    reconnect: { random: () => 0 },
    redial: (context) => {
      dialled.push(context)
      const next = new FakePipe()
      pipes.push(next)
      return next
    },
    onResume: () => {
      resumes += 1
    },
  })

  client.connect()
  const first = pipes[0]
  if (first === undefined) throw new Error('no pipe')
  first.open()
  first.deliver(welcomeFrame())

  return {
    client,
    dialled,
    pipes,
    get resumes() {
      return resumes
    },
    advance(ms: number) {
      nowMs += ms
    },
    /** The newest pipe, which is the one the client is talking to. */
    live(): FakePipe {
      const pipe = pipes[pipes.length - 1]
      if (pipe === undefined) throw new Error('no pipe')
      return pipe
    },
  }
}

describe('a client whose host went away', () => {
  it('says reconnecting rather than closed, and holds the world still', () => {
    // The rolling-deploy case. A 1001 is "come back in a moment" and a 1006 is
    // "the wire broke"; a client that could not tell them apart would either
    // hammer a dead host or give up on a restart. Both land here as a *pending*
    // session rather than a finished one.
    const live = session()
    expect(live.client.snapshot().status).toBe('live')

    live.live().hangUp(CloseReason.GoingAway, 'server shutting down')

    const snapshot = live.client.snapshot()
    expect(snapshot.status).toBe('reconnecting')
    expect(snapshot.message).toContain('reconnecting')
    // Nothing about it says the match is over.
    expect(snapshot.message).not.toContain('disconnected')
    // And nothing is predicted across the gap: every tick simulated now is a
    // tick the host will never be told about.
    expect(mustHoldStill(snapshot.status)).toBe(true)
  })

  it('waits out the backoff before dialling, and dials with the seat key', () => {
    const live = session()
    live.live().hangUp(CloseReason.Abnormal)

    // Not yet: a client that redialled on the close event would produce exactly
    // the storm the backoff exists to prevent.
    live.client.poll()
    expect(live.dialled).toHaveLength(0)

    live.advance(RECONNECT_BASE_MS)
    live.client.poll()

    expect(live.dialled).toHaveLength(1)
    expect(live.dialled[0]).toMatchObject({ room: ROOM, token: TOKEN })
    expect(live.client.snapshot().reconnects).toBe(1)
  })

  it('is live again, and tells the frame loop to throw its prediction away', () => {
    const live = session()
    live.live().hangUp(CloseReason.Abnormal)
    live.advance(RECONNECT_BASE_MS)
    live.client.poll()

    const second = live.live()
    second.open()
    // The hello goes out on the new pipe by itself, as it did on the first.
    expect(second.sent.some((frame) => frame.includes('"hello"'))).toBe(true)

    second.deliver(welcomeFrame())
    expect(live.client.snapshot().status).toBe('live')
    expect(live.client.snapshot().message).toContain('back in room')
    // The cue to discard the pending commands and hard-snap. Replaying input
    // across a gap that long draws a journey nobody made.
    expect(live.resumes).toBe(1)
    // And the next drop starts from the floor again rather than from wherever
    // the last one left the backoff.
    expect(live.client.snapshot().retries).toBe(0)
  })

  it('does not come back from a close that was an answer', () => {
    const live = session()
    live.live().hangUp(4007, 'match ended')

    live.advance(60_000)
    live.client.poll()

    expect(live.dialled).toHaveLength(0)
    expect(live.client.snapshot().status).toBe('closed')
  })

  it('ignores a dead pipe that speaks after it has been replaced', () => {
    // A socket that has been given up on can still deliver a late error or a
    // second close, and acting on one would restart a backoff that has already
    // been replaced by a live connection.
    const live = session()
    const first = live.pipes[0]
    if (first === undefined) throw new Error('no pipe')
    first.hangUp(CloseReason.Abnormal)
    live.advance(RECONNECT_BASE_MS)
    live.client.poll()
    const second = live.live()
    second.open()
    second.deliver(welcomeFrame())

    first.hangUp(CloseReason.Abnormal, 'late')
    expect(live.client.snapshot().status).toBe('live')

    live.advance(60_000)
    live.client.poll()
    expect(live.dialled).toHaveLength(1)
  })

  it('stops for good once the window has closed', () => {
    const live = session()
    let dialled = 0
    while (live.client.snapshot().status !== 'closed') {
      live.live().hangUp(CloseReason.Abnormal)
      if (live.client.snapshot().status === 'closed') break
      live.advance(RECONNECT_CEILING_MS)
      live.client.poll()
      dialled += 1
      expect(dialled).toBeLessThan(200)
    }

    // It tried for longer than the seat could possibly have been held, and it
    // stopped rather than dialling a room that is not there any more.
    expect(dialled).toBeGreaterThan(RECONNECT_WINDOW_MS / RECONNECT_CEILING_MS - 1)
    const gaveUpAt = live.dialled.length
    live.advance(60_000)
    live.client.poll()
    expect(live.dialled).toHaveLength(gaveUpAt)
  })

  it('counts down the window its opponent is inside', () => {
    const live = session()
    live.live().deliver({
      t: 'life',
      event: 'opponent-left',
      graceMs: 30_000,
      detail: "your opponent's connection dropped",
    })

    expect(live.client.snapshot().graceLeftMs).toBe(30_000)
    expect(live.client.snapshot().message).toContain('30s')

    // The countdown is the client's own subtraction: a grace window is thirty
    // seconds of wall-clock and the host has better things to do than tell
    // sixty clients a second what it comes to.
    live.advance(25_000)
    expect(live.client.snapshot().graceLeftMs).toBe(5_000)
    expect(live.client.snapshot().message).toContain('5s')

    live.advance(10_000)
    expect(live.client.snapshot().graceLeftMs).toBe(0)
  })

  it('shows what the host said about the other player', () => {
    const live = session()
    live.live().deliver({
      t: 'life',
      event: 'forfeit',
      graceMs: 0,
      detail: 'your opponent did not come back — you take the match by forfeit',
    })
    expect(live.client.snapshot().message).toContain('by forfeit')
    expect(live.client.snapshot().lifecycle?.event).toBe('forfeit')
  })

  it('never reconnects a session that has no pipe to dial', () => {
    // A listen server: the host is an object in this tab, so a closed loopback
    // means the tab is going away and there is nothing to come back to.
    const pipe = new FakePipe()
    const client = createNetClient({
      transport: pipe,
      endpoint: 'the host in this tab',
      build: 'test-build',
      mapHash: MAP_HASH,
      now: () => 0,
    })
    client.connect()
    pipe.open()
    pipe.deliver(welcomeFrame())
    pipe.hangUp(CloseReason.Abnormal)

    expect(client.snapshot().status).toBe('closed')
    client.poll()
    expect(client.snapshot().reconnects).toBe(0)
  })
})
