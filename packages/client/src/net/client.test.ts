import {
  CloseReason,
  NULL_CMD,
  PROTOCOL_VERSION,
  TransportState,
  UNKNOWN_RTT,
  Weapon,
  type Transport,
  type TransportHandlers,
  type TransportMessage,
} from '@gladiator/sim'
import { JITTER_BUFFER_TICKS } from '@gladiator/server/inputQueue'
import { describe, expect, it } from 'vitest'

import {
  createNetClient,
  joinUrl,
  mustHoldStill,
  quickMatchRequested,
  resolveServerUrl,
} from './client.ts'

/**
 * A stand-in for the pipe, enough of one for this module: it records what was
 * sent and lets a test push frames back.
 *
 * A fake *transport* rather than a fake WebSocket, which is the whole change
 * this ticket made here: what the client talks to is an interface a socket, a
 * loopback and (later) a WebTransport session all satisfy, so the tests below
 * are equally true of single-player.
 */
class FakeTransport implements Transport {
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

  fail() {
    this.handlers.onError?.(new Error('nope'))
  }

  hangUp(code: number, reason: string) {
    this.handlers.onClose?.(code, reason)
  }

  /**
   * Closing, and nobody has been told yet.
   *
   * A real gap, not a contrivance: a socket stops accepting sends the moment
   * `close()` is called and the close event arrives a turn or more later. Every
   * command queued in between is dropped with the session still reading `live`.
   */
  stall() {
    this.readyState = TransportState.Closing
  }
}

/** The map hash this fake client claims to hold. */
const MAP_HASH = 'a1b2c3d4'

/** The room the host seated this session in. Six Crockford characters. */
const ROOM = 'H7K2Q9'

/** The key to this session's seat, which a reconnect has to present back.
 *  `@gladiator/server/lifecycle.ts`. */
const TOKEN = 'deadbeefdeadbeefdeadbeefdeadbeef'

function connected(protocolOverride?: number) {
  const transport = new FakeTransport()
  const client = createNetClient({
    transport,
    endpoint: 'ws://test',
    build: 'test-build',
    mapHash: MAP_HASH,
    now: () => 0,
    ...(protocolOverride === undefined ? {} : { protocolOverride }),
  })
  client.connect()
  transport.open()
  return { transport, client }
}

describe('joinUrl', () => {
  it('asks for a new room when the player named none', () => {
    // The host mints the code and puts it in the welcome, so a player who
    // pressed "create a match" has a link to send.
    expect(joinUrl('wss://gladiator.fly.dev', null)).toBe('wss://gladiator.fly.dev')
    expect(joinUrl('wss://gladiator.fly.dev', '')).toBe('wss://gladiator.fly.dev')
  })

  it('carries the code through verbatim, whatever the player typed', () => {
    // Not folded here. The host is the only thing that knows which codes exist
    // and it does the folding (`@gladiator/server/roomCode.ts`); a client with
    // its own opinion of the alphabet would be a second copy to keep in step.
    expect(joinUrl('wss://gladiator.fly.dev', 'H7K2Q9')).toBe(
      'wss://gladiator.fly.dev/?room=H7K2Q9',
    )
    expect(joinUrl('wss://gladiator.fly.dev', 'h7k-2q9')).toContain('room=h7k-2q9')
  })

  it('keeps whatever else the socket URL already carried', () => {
    expect(joinUrl('ws://localhost:8787/?x=1', 'H7K2Q9')).toBe(
      'ws://localhost:8787/?x=1&room=H7K2Q9',
    )
  })

  it('asks to be matched with a stranger for a player who asked for one', () => {
    expect(joinUrl('wss://gladiator.fly.dev', null, true)).toBe(
      'wss://gladiator.fly.dev/?queue=1',
    )
    // Normalised rather than echoed, which is why the request arrives here as a
    // boolean and the reading of the page's own URL is one function of its own:
    // the host only asks whether the parameter is there, so `?queue=yes` and a
    // click on a button put the same one shape of request on the wire.
    expect(quickMatchRequested('?queue=1')).toBe(true)
    expect(quickMatchRequested('?queue=yes')).toBe(true)
    expect(quickMatchRequested('?room=H7K2Q9')).toBe(false)
  })

  it('lets a code beat the queue, the way the host does', () => {
    // Six characters somebody typed is a request for a *particular* match, and
    // putting that player in front of a stranger instead would be the worst
    // possible way to answer it.
    expect(joinUrl('wss://gladiator.fly.dev', 'H7K2Q9', true)).toBe(
      'wss://gladiator.fly.dev/?room=H7K2Q9',
    )
  })
})

describe('resolveServerUrl', () => {
  it('prefers the configured URL', () => {
    expect(resolveServerUrl('wss://gladiator.fly.dev', { protocol: 'https:', hostname: 'x' })).toBe(
      'wss://gladiator.fly.dev',
    )
  })

  it('falls back to the local dev server over plain http', () => {
    expect(resolveServerUrl(undefined, { protocol: 'http:', hostname: 'localhost' })).toBe(
      'ws://localhost:8787',
    )
  })

  it('uses the page origin when the deployment serves client and host together', () => {
    expect(
      resolveServerUrl(
        undefined,
        { protocol: 'https:', hostname: 'gladiator.fly.dev', host: 'gladiator.fly.dev' },
        true,
      ),
    ).toBe('wss://gladiator.fly.dev')
    expect(
      resolveServerUrl(
        undefined,
        { protocol: 'http:', hostname: '127.0.0.1', host: '127.0.0.1:8787' },
        true,
      ),
    ).toBe('ws://127.0.0.1:8787')
  })

  it('refuses to guess on a deployed origin', () => {
    // Guessing here produces a browser error that names no cause. Better to
    // say "VITE_SERVER_URL is not set" on screen.
    expect(resolveServerUrl(undefined, { protocol: 'https:', hostname: 'gladiator.vercel.app' }))
      .toBe(null)
    expect(resolveServerUrl('', { protocol: 'https:', hostname: 'gladiator.vercel.app' })).toBe(null)
  })
})

describe('net client', () => {
  it('opens with a hello carrying the protocol version, the build and the map', () => {
    const { transport } = connected()
    expect(JSON.parse(transport.sent[0] ?? '{}')).toEqual({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      build: 'test-build',
      mapHash: MAP_HASH,
    })
  })

  it('greets a transport that was already open when it arrived', () => {
    // The loopback always is. Without the synthetic open the contract requires,
    // this client would hang waiting for an event that had already happened —
    // and single-player would need a branch of its own.
    const transport = new FakeTransport()
    transport.readyState = TransportState.Open
    const client = createNetClient({
      transport,
      endpoint: 'the host in this tab',
      build: 'b',
      mapHash: MAP_HASH,
    })
    client.connect()
    transport.open()
    expect(JSON.parse(transport.sent[0] ?? '{}')).toMatchObject({ t: 'hello' })
  })

  it('stops the world and says which two arenas when the host refuses the map', () => {
    // What the player must see. Continuing to simulate would mean running into
    // walls that are not there on the authoritative side, which looks like the
    // movement being broken and is the map being wrong.
    const { transport, client } = connected()
    transport.deliver({ t: 'map_mismatch', serverMapHash: '00000000', clientMapHash: MAP_HASH })

    const snapshot = client.snapshot()
    expect(snapshot.status).toBe('map-mismatch')
    expect(mustHoldStill(snapshot.status)).toBe(true)
    expect(snapshot.serverMapHash).toBe('00000000')
    expect(snapshot.message).toContain(MAP_HASH)
    expect(snapshot.message).toContain('00000000')
    expect(snapshot.message).toContain('reload')
  })

  it('keeps the mismatch message when the host then closes the pipe', () => {
    // The close arrives a moment after the frame. Overwriting the explanation
    // with "disconnected (code 4004)" is how a diagnosable failure becomes a
    // mystery.
    const { transport, client } = connected()
    transport.deliver({ t: 'map_mismatch', serverMapHash: '00000000', clientMapHash: MAP_HASH })
    transport.hangUp(4004, 'map mismatch')
    expect(client.snapshot().status).toBe('map-mismatch')
    expect(client.snapshot().message).toContain('reload')
  })

  it('plays on when the host is holding the same arena', () => {
    const { transport, client } = connected()
    transport.deliver({
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      build: 'srv',
      session: 's1',
      mapHash: MAP_HASH,
      room: ROOM,
      token: TOKEN,
      slot: 0,
    })
    expect(client.snapshot().serverMapHash).toBe(MAP_HASH)
    expect(mustHoldStill(client.snapshot().status)).toBe(false)
  })

  it('carries the room the host seated this session in', () => {
    // How a player who *created* a match learns the code to send: they asked
    // for no room at all, and this is the host's answer. `ui/menu.ts` puts it
    // on screen and `main.ts` writes it into the address bar.
    const { transport, client } = connected()
    expect(client.snapshot().room).toBe(null)
    transport.deliver({
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      build: 'srv',
      session: 's1',
      mapHash: MAP_HASH,
      room: ROOM,
      token: TOKEN,
      slot: 0,
    })
    expect(client.snapshot().room).toBe(ROOM)
  })

  it('reports agreement when the hashes match', () => {
    const { transport, client } = connected()
    transport.deliver({
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      build: 'srv',
      session: 's1',
      mapHash: MAP_HASH,
      room: ROOM,
      token: TOKEN,
      slot: 0,
    })
    client.record(10, 0xdeadbeef)
    transport.deliver({ t: 'hash', tick: 10, hash: 0xdeadbeef })

    const snapshot = client.snapshot()
    expect(snapshot.status).toBe('live')
    expect(snapshot.agree).toBe(true)
    expect(snapshot.compared).toBe(1)
    expect(snapshot.mismatched).toBe(0)
    expect(snapshot.clientHash).toBe(0xdeadbeef)
  })

  it('reports a mismatch, and keeps counting', () => {
    const { transport, client } = connected()
    client.record(10, 1)
    client.record(11, 2)
    transport.deliver({ t: 'hash', tick: 10, hash: 999 })
    transport.deliver({ t: 'hash', tick: 11, hash: 2 })

    const snapshot = client.snapshot()
    expect(snapshot.compared).toBe(2)
    expect(snapshot.mismatched).toBe(1)
    expect(snapshot.agree).toBe(true) // the most recent one agreed
  })

  it('ignores a hash for a tick that has aged out, rather than calling it a desync', () => {
    const { transport, client } = connected()
    client.record(10, 1)
    transport.deliver({ t: 'hash', tick: 999_999, hash: 1 })
    expect(client.snapshot().compared).toBe(0)
    expect(client.snapshot().agree).toBe(null)
  })

  it('turns a version mismatch into a message a player can act on', () => {
    const { transport, client } = connected(PROTOCOL_VERSION + 1)
    transport.deliver({
      t: 'version_mismatch',
      serverProtocol: PROTOCOL_VERSION,
      clientProtocol: PROTOCOL_VERSION + 1,
      serverBuild: '9f3c1d2',
    })

    const snapshot = client.snapshot()
    expect(snapshot.status).toBe('version-mismatch')
    expect(snapshot.message).toContain('server is on build 9f3c1d2')
    expect(snapshot.message).toContain('reload')
  })

  it('keeps the version-mismatch message when the host then closes the pipe', () => {
    const { transport, client } = connected()
    transport.deliver({
      t: 'version_mismatch',
      serverProtocol: 2,
      clientProtocol: 1,
      serverBuild: 'abc',
    })
    transport.hangUp(4001, 'protocol version')
    // A "disconnected (code 4001)" line here would replace the only message
    // that tells the player what to do about it.
    expect(client.snapshot().message).toContain('server is on build abc')
  })

  it('names the endpoint when the pipe fails', () => {
    const { transport, client } = connected()
    transport.fail()
    expect(client.snapshot().status).toBe('error')
    expect(client.snapshot().message).toContain('ws://test')
  })

  it('keeps the drain notice, ticket and all, when the host is deploying', () => {
    // The frame that says a socket is about to close *because of a deploy*, and
    // where the match went. The ticket in it is the only copy of the score
    // (`server/resume.ts`), so a client that read the frame and kept nothing
    // would be a client whose duel ended at the next deploy.
    const transport = new FakeTransport()
    const seen: unknown[] = []
    const client = createNetClient({
      transport,
      endpoint: 'ws://test',
      build: 'test-build',
      mapHash: MAP_HASH,
      now: () => 0,
      onDrain: (notice) => seen.push(notice),
    })
    client.connect()
    transport.open()
    transport.deliver({ t: 'drain', room: ROOM, retryAfterMs: 3000, resume: 'g1.abc.def' })

    expect(seen).toEqual([{ t: 'drain', room: ROOM, retryAfterMs: 3000, resume: 'g1.abc.def' }])
    expect(client.snapshot().drain).toMatchObject({ room: ROOM, resume: 'g1.abc.def' })
    expect(client.snapshot().message).toContain(ROOM)

    // And it survives the close that follows — both the notice and the sentence
    // it put on the screen. "The machine went away" and "the duel ended" are
    // the same event on the socket and two very different things to read
    // mid-match.
    transport.hangUp(1001, 'server is deploying')
    expect(client.snapshot().drain).not.toBeNull()
    expect(client.snapshot().status).toBe('closed')
    expect(client.snapshot().message).toContain(ROOM)
  })

  it('batches queued commands into one frame per flush', () => {
    const { transport, client } = connected()
    client.queue(5, NULL_CMD)
    client.queue(6, { ...NULL_CMD, forwardMove: 1 })
    client.flush()

    expect(transport.sent).toHaveLength(2)
    expect(JSON.parse(transport.sent[1] ?? '{}')).toEqual({
      t: 'cmds',
      startTick: 5,
      cmds: [
        [0, 0, 0, 0, 0, Weapon.RocketLauncher],
        [1, 0, 0, 0, 0, Weapon.RocketLauncher],
      ],
    })
  })

  it('sends nothing when there is nothing queued', () => {
    const { transport, client } = connected()
    client.flush()
    expect(transport.sent).toHaveLength(1) // just the hello
  })

  it('drops commands queued before the pipe is open, and counts every one', () => {
    // The count is the point. A silently dropped command offsets the client's
    // tick counter from the host's for the rest of the session, and every hash
    // after that is compared against a different moment — which reads as a
    // broken simulation and is a broken clock. `main.ts` holds the world still
    // until the connection resolves so this cannot happen; the counter is what
    // would make it obvious if that ever regressed.
    const transport = new FakeTransport()
    const client = createNetClient({
      transport,
      endpoint: 'ws://test',
      build: 'b',
      mapHash: MAP_HASH,
    })
    client.connect()
    client.queue(1, NULL_CMD)
    client.queue(2, NULL_CMD)
    client.flush()
    expect(transport.sent).toHaveLength(0)
    expect(client.snapshot().dropped).toBe(2)

    transport.open()
    client.queue(3, NULL_CMD)
    client.flush()
    expect(JSON.parse(transport.sent[1] ?? '{}')).toMatchObject({ startTick: 3 })
  })

  it('says so on the HUD when a live session starts dropping commands', () => {
    const { transport, client } = connected()
    transport.deliver({
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      build: 'srv',
      session: 's1',
      mapHash: MAP_HASH,
      room: ROOM,
      token: TOKEN,
      slot: 0,
    })
    expect(client.snapshot().status).toBe('live')

    transport.stall()
    client.queue(1, NULL_CMD)
    client.flush()

    expect(client.snapshot().dropped).toBe(1)
    expect(client.snapshot().status).toBe('error')
    expect(client.snapshot().message).toContain('no longer line up')
  })

  it('prefers the close code to the drop count once the pipe has actually gone', () => {
    // "disconnected (code 1006)" is the more useful sentence of the two: it
    // says what happened rather than what it broke.
    const { transport, client } = connected()
    transport.deliver({
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      build: 'srv',
      session: 's1',
      mapHash: MAP_HASH,
      room: ROOM,
      token: TOKEN,
      slot: 0,
    })
    transport.close(CloseReason.Abnormal, 'gone')
    client.queue(1, NULL_CMD)
    client.flush()

    expect(client.snapshot().dropped).toBe(1)
    expect(client.snapshot().status).toBe('closed')
    expect(client.snapshot().message).toContain('1006')
  })

  it('says so when the deploy has no host at all, instead of failing silently', () => {
    const client = createNetClient({
      transport: null,
      endpoint: 'nowhere',
      build: 'b',
      mapHash: MAP_HASH,
    })
    client.connect()
    expect(client.snapshot().status).toBe('unconfigured')
    expect(client.snapshot().message).toContain('VITE_SERVER_URL')

    // And playing on regardless is not "dropping" anything: there was never a
    // host to agree with, so the drop counter must stay clean for the case that
    // actually matters.
    client.queue(1, NULL_CMD)
    client.flush()
    expect(client.snapshot().dropped).toBe(0)
  })
})

describe('clock sync over the wire', () => {
  /** A connected client whose `performance.now()` a test owns. */
  function ticking() {
    const transport = new FakeTransport()
    let nowMs = 0
    const client = createNetClient({
      transport,
      endpoint: 'ws://test',
      build: 'test-build',
      mapHash: MAP_HASH,
      now: () => nowMs,
    })
    client.connect()
    transport.open()
    transport.deliver({
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      build: 'srv',
      session: 's1',
      mapHash: MAP_HASH,
      room: ROOM,
      token: TOKEN,
      slot: 0,
    })
    return {
      transport,
      client,
      at(ms: number) {
        nowMs = ms
      },
    }
  }

  it('answers a ping with a pong carrying nothing but the id', () => {
    const { transport, client } = ticking()
    transport.sent.length = 0
    transport.deliver({ t: 'ping', id: 7, tick: 1000, rttMs: 60, queued: 2 })

    // Nothing in the reply the client chose. A timestamp here would be a round
    // trip the client could shrink, and lag compensation rewinds by that number.
    expect(JSON.parse(transport.sent[0] ?? '{}')).toEqual({ t: 'pong', id: 7 })
    expect(client.snapshot().pings).toBe(1)
  })

  it('reports the round trip the server measured, and never one of its own', () => {
    const { transport, client } = ticking()
    expect(client.snapshot().rttMs).toBe(null)

    transport.deliver({ t: 'ping', id: 0, tick: 10, rttMs: UNKNOWN_RTT, queued: 0 })
    expect(client.snapshot().rttMs).toBe(null)

    transport.deliver({ t: 'ping', id: 1, tick: 30, rttMs: 64, queued: 2 })
    expect(client.snapshot().rttMs).toBe(64)
    expect(client.snapshot().queuedAtServer).toBe(2)
    // Half of 64 ms is four ticks, plus the two the server wants buffered.
    expect(client.snapshot().leadTicks).toBe(4 + JITTER_BUFFER_TICKS)
  })

  it('estimates the server tick from the ping, and moves it on with the clock', () => {
    const { transport, client, at } = ticking()
    at(1_000)
    // A 64 ms trip means the ping left four ticks ago, so tick 500 was current
    // at 968 ms and the server is on 504 by the time we see it.
    transport.deliver({ t: 'ping', id: 1, tick: 500, rttMs: 64, queued: 2 })
    expect(client.snapshot().serverTickEstimate).toBe(504)

    // A hundred milliseconds later it has moved on by twelve and a half ticks,
    // with no further pings needed to know it.
    at(1_100)
    expect(client.snapshot().serverTickEstimate).toBe(516)
    expect(client.clock.targetTick(1_100)).toBe(516 + 4 + JITTER_BUFFER_TICKS)
  })

  it('has no estimate before the first ping, and does not invent one', () => {
    const { client } = ticking()
    expect(client.snapshot().serverTickEstimate).toBe(null)
    expect(client.snapshot().pings).toBe(0)
  })
})

describe('the quick-match line', () => {
  /** A connected client whose `performance.now()` a test owns. */
  function queueing() {
    const transport = new FakeTransport()
    let nowMs = 0
    const client = createNetClient({
      transport,
      endpoint: 'ws://test',
      build: 'test-build',
      mapHash: MAP_HASH,
      now: () => nowMs,
    })
    client.connect()
    transport.open()
    return {
      transport,
      client,
      at(ms: number) {
        nowMs = ms
      },
    }
  }

  it('is null for a session that never asked to be in one', () => {
    // Which is what the panel branches on: a duel between two friends must not
    // grow a "looking for an opponent" spinner because one of them is late.
    const { transport, client } = queueing()
    transport.deliver({
      t: 'welcome',
      protocol: PROTOCOL_VERSION,
      build: 'srv',
      session: 's1',
      mapHash: MAP_HASH,
      room: ROOM,
      token: TOKEN,
      slot: 0,
    })
    expect(client.snapshot().queue).toBeNull()
  })

  it('keeps the wait running between frames', () => {
    // The host says "you have waited 0 ms" once and then says nothing until
    // something happens. A readout that printed that verbatim would be a
    // stopped clock in front of the one player who is watching a clock.
    const { transport, client, at } = queueing()
    transport.deliver({ t: 'queue', state: 'waiting', room: ROOM, waitedMs: 0, timeoutMs: 60_000 })
    expect(client.snapshot().queue).toEqual({
      state: 'waiting',
      room: ROOM,
      waitedMs: 0,
      timeoutMs: 60_000,
      sinceMs: 0,
    })

    at(12_500)
    expect(client.snapshot().queue).toMatchObject({ waitedMs: 12_500, sinceMs: 12_500 })
  })

  it('stops the wait when the wait is over, and keeps counting since', () => {
    const { transport, client, at } = queueing()
    transport.deliver({
      t: 'queue',
      state: 'matched',
      room: ROOM,
      waitedMs: 4_000,
      timeoutMs: 0,
    })
    at(3_000)
    // Four seconds is what the *other* player waited, and it is finished. What
    // goes on running is how long ago they were told — which is what takes
    // "opponent found" off the screen by itself (`ui/queue.ts`).
    expect(client.snapshot().queue).toMatchObject({
      state: 'matched',
      waitedMs: 4_000,
      sinceMs: 3_000,
    })
  })

  it('carries the room code out of a wait that ran out', () => {
    // The whole point of the timeout frame: this player is holding six
    // characters somebody can be sent.
    const { transport, client } = queueing()
    transport.deliver({
      t: 'queue',
      state: 'timeout',
      room: ROOM,
      waitedMs: 60_000,
      timeoutMs: 0,
    })
    expect(client.snapshot().queue).toMatchObject({ state: 'timeout', room: ROOM })
    // And a queue frame is not a connection error: the socket is fine and the
    // session is still live.
    expect(client.snapshot().status).not.toBe('error')
  })
})
