import { NULL_CMD, PROTOCOL_VERSION } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { createNetClient, resolveServerUrl } from './net.ts'

/**
 * A stand-in for the browser's `WebSocket`, enough of one for this module: it
 * records what was sent and lets a test push frames back.
 */
class FakeSocket {
  readyState = 0
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>()

  addEventListener(type: string, listener: (event: unknown) => void) {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 3
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  open() {
    this.readyState = 1
    this.emit('open', {})
  }

  deliver(message: unknown) {
    this.emit('message', { data: JSON.stringify(message) })
  }
}

function connected(protocolOverride?: number) {
  const socket = new FakeSocket()
  const client = createNetClient({
    url: 'ws://test',
    build: 'test-build',
    socketFactory: () => socket as unknown as WebSocket,
    now: () => 0,
    ...(protocolOverride === undefined ? {} : { protocolOverride }),
  })
  client.connect()
  socket.open()
  return { socket, client }
}

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

  it('refuses to guess on a deployed origin', () => {
    // Guessing here produces a browser error that names no cause. Better to
    // say "VITE_SERVER_URL is not set" on screen.
    expect(resolveServerUrl(undefined, { protocol: 'https:', hostname: 'gladiator.vercel.app' }))
      .toBe(null)
    expect(resolveServerUrl('', { protocol: 'https:', hostname: 'gladiator.vercel.app' })).toBe(null)
  })
})

describe('net client', () => {
  it('opens with a hello carrying the protocol version and build', () => {
    const { socket } = connected()
    expect(JSON.parse(socket.sent[0] ?? '{}')).toEqual({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      build: 'test-build',
    })
  })

  it('reports agreement when the hashes match', () => {
    const { socket, client } = connected()
    socket.deliver({ t: 'welcome', protocol: PROTOCOL_VERSION, build: 'srv', session: 's1' })
    client.record(10, 0xdeadbeef)
    socket.deliver({ t: 'hash', tick: 10, hash: 0xdeadbeef })

    const snapshot = client.snapshot()
    expect(snapshot.status).toBe('live')
    expect(snapshot.agree).toBe(true)
    expect(snapshot.compared).toBe(1)
    expect(snapshot.mismatched).toBe(0)
    expect(snapshot.clientHash).toBe(0xdeadbeef)
  })

  it('reports a mismatch, and keeps counting', () => {
    const { socket, client } = connected()
    client.record(10, 1)
    client.record(11, 2)
    socket.deliver({ t: 'hash', tick: 10, hash: 999 })
    socket.deliver({ t: 'hash', tick: 11, hash: 2 })

    const snapshot = client.snapshot()
    expect(snapshot.compared).toBe(2)
    expect(snapshot.mismatched).toBe(1)
    expect(snapshot.agree).toBe(true) // the most recent one agreed
  })

  it('ignores a hash for a tick that has aged out, rather than calling it a desync', () => {
    const { socket, client } = connected()
    client.record(10, 1)
    socket.deliver({ t: 'hash', tick: 999_999, hash: 1 })
    expect(client.snapshot().compared).toBe(0)
    expect(client.snapshot().agree).toBe(null)
  })

  it('turns a version mismatch into a message a player can act on', () => {
    const { socket, client } = connected(PROTOCOL_VERSION + 1)
    socket.deliver({
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

  it('keeps the mismatch message when the server then closes the socket', () => {
    const { socket, client } = connected()
    socket.deliver({
      t: 'version_mismatch',
      serverProtocol: 2,
      clientProtocol: 1,
      serverBuild: 'abc',
    })
    socket.emit('close', { code: 4001, reason: 'protocol version' })
    // A "disconnected (code 4001)" line here would replace the only message
    // that tells the player what to do about it.
    expect(client.snapshot().message).toContain('server is on build abc')
  })

  it('batches queued commands into one frame per flush', () => {
    const { socket, client } = connected()
    client.queue(5, NULL_CMD)
    client.queue(6, { ...NULL_CMD, forwardMove: 1 })
    client.flush()

    expect(socket.sent).toHaveLength(2)
    expect(JSON.parse(socket.sent[1] ?? '{}')).toEqual({
      t: 'cmds',
      startTick: 5,
      cmds: [
        [0, 0, 0, 0, 0],
        [1, 0, 0, 0, 0],
      ],
    })
  })

  it('sends nothing when there is nothing queued', () => {
    const { socket, client } = connected()
    client.flush()
    expect(socket.sent).toHaveLength(1) // just the hello
  })

  it('drops commands queued before the socket is open, and counts every one', () => {
    // The count is the point. A silently dropped command offsets the client's
    // tick counter from the server's for the rest of the session, and every
    // hash after that is compared against a different moment — which reads as
    // a broken simulation and is a broken clock. `main.ts` holds the world
    // still until the connection resolves so this cannot happen; the counter
    // is what would make it obvious if that ever regressed.
    const socket = new FakeSocket()
    const client = createNetClient({
      url: 'ws://test',
      build: 'b',
      socketFactory: () => socket as unknown as WebSocket,
    })
    client.connect()
    client.queue(1, NULL_CMD)
    client.queue(2, NULL_CMD)
    client.flush()
    expect(socket.sent).toHaveLength(0)
    expect(client.snapshot().dropped).toBe(2)

    socket.open()
    client.queue(3, NULL_CMD)
    client.flush()
    expect(JSON.parse(socket.sent[1] ?? '{}')).toMatchObject({ startTick: 3 })
  })

  it('says so on the HUD when a live session starts dropping commands', () => {
    const { socket, client } = connected()
    socket.deliver({ t: 'welcome', protocol: PROTOCOL_VERSION, build: 'srv', session: 's1' })
    expect(client.snapshot().status).toBe('live')

    socket.close()
    client.queue(1, NULL_CMD)
    client.flush()

    expect(client.snapshot().dropped).toBe(1)
    expect(client.snapshot().status).toBe('error')
    expect(client.snapshot().message).toContain('no longer line up')
  })

  it('says so when the deploy has no server URL, instead of failing silently', () => {
    const client = createNetClient({ url: null, build: 'b' })
    client.connect()
    expect(client.snapshot().status).toBe('unconfigured')
    expect(client.snapshot().message).toContain('VITE_SERVER_URL')

    // And playing on regardless is not "dropping" anything: there was never a
    // server to agree with, so the drop counter must stay clean for the case
    // that actually matters.
    client.queue(1, NULL_CMD)
    client.flush()
    expect(client.snapshot().dropped).toBe(0)
  })
})
