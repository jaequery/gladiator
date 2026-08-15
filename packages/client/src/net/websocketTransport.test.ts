import { CloseReason, TransportState, type TransportMessage } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { websocketTransport } from './websocketTransport.ts'

/** Enough of the browser's `WebSocket` for the adapter: events in, sends out. */
class FakeSocket {
  readyState = 0
  readonly sent: unknown[] = []
  closedWith: [number, string] | null = null
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>()

  addEventListener(type: string, listener: (event: unknown) => void) {
    const existing = this.listeners.get(type) ?? []
    existing.push(listener)
    this.listeners.set(type, existing)
  }

  send(data: unknown) {
    this.sent.push(data)
  }

  close(code?: number, reason?: string) {
    this.readyState = 3
    this.closedWith = [code ?? 1000, reason ?? '']
  }

  emit(type: string, event: unknown) {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }

  open() {
    this.readyState = 1
    this.emit('open', {})
  }
}

function adapted(prepare: (socket: FakeSocket) => void = () => undefined) {
  const socket = new FakeSocket()
  prepare(socket)
  const transport = websocketTransport('wss://test', {
    socketFactory: () => socket as unknown as WebSocket,
  })
  return { socket, transport }
}

describe('the browser WebSocket adapter', () => {
  it('reports the socket state as transport state, with no lookup table', () => {
    const { socket, transport } = adapted()
    expect(transport.readyState).toBe(TransportState.Connecting)
    socket.open()
    expect(transport.readyState).toBe(TransportState.Open)
    socket.close()
    expect(transport.readyState).toBe(TransportState.Closed)
  })

  it('forwards events to the handlers', () => {
    const { socket, transport } = adapted()
    const seen: TransportMessage[] = []
    let opened = 0
    let closed: [number, string] | null = null
    transport.setHandlers({
      onOpen: () => (opened += 1),
      onMessage: (message) => seen.push(message),
      onClose: (code, reason) => (closed = [code, reason]),
    })

    socket.open()
    socket.emit('message', { data: '{"t":"welcome"}' })
    socket.emit('close', { code: 4001, reason: 'protocol version' })

    expect(opened).toBe(1)
    expect(seen).toEqual(['{"t":"welcome"}'])
    expect(closed).toEqual([4001, 'protocol version'])
  })

  it('delivers a synthetic open when the socket was open before anyone listened', async () => {
    const { transport } = adapted((socket) => {
      socket.readyState = 1
    })
    let opened = 0
    transport.setHandlers({ onOpen: () => (opened += 1) })
    expect(opened).toBe(0)
    await Promise.resolve()
    expect(opened).toBe(1)
  })

  it('drops a send on a socket that is not open, rather than throwing', () => {
    const { socket, transport } = adapted()
    expect(() => transport.send('too early')).not.toThrow()
    expect(socket.sent).toHaveLength(0)
    socket.open()
    transport.send('now')
    expect(socket.sent).toEqual(['now'])
  })

  it('turns a constructor that threw into a transport that says so', async () => {
    // `new WebSocket('not a url')` is a SyntaxError out of the constructor, not
    // an error event. A caller that had to handle both would have two failure
    // paths for one failure.
    const transport = websocketTransport('not a url', {
      socketFactory: () => {
        throw new SyntaxError('bad url')
      },
    })
    expect(transport.readyState).toBe(TransportState.Closed)

    const seen: string[] = []
    transport.setHandlers({
      onError: (error) => seen.push(`error: ${error.message}`),
      onClose: (code) => seen.push(`close: ${code}`),
    })
    await Promise.resolve()
    expect(seen).toEqual(['error: bad url', `close: ${CloseReason.Abnormal}`])
  })
})
