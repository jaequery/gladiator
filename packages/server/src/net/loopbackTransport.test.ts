/**
 * The loopback's two rules, asserted rather than asserted-in-prose.
 *
 * Everything in this file is about the one failure mode the pattern has: an
 * in-process "network" that hands the receiver the sender's own object. It
 * would pass every test written against behaviour, and it would be wrong in the
 * exact way that only shows up once there is a real socket in the middle.
 */
import { CloseReason, TransportState, type TransportMessage } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { createLoopbackPair, settleLoopback } from './loopbackTransport.ts'

/** Collect everything an end is handed, in order. */
function collect(end: { setHandlers(handlers: { onMessage?: (m: TransportMessage) => void }): void }) {
  const received: TransportMessage[] = []
  end.setHandlers({ onMessage: (message) => received.push(message) })
  return received
}

describe('what crosses the loopback', () => {
  it('puts nothing but Uint8Array on the wire', async () => {
    const wire: unknown[] = []
    const pair = createLoopbackPair({ onWire: (frame) => wire.push(frame) })
    const received = collect(pair.server)

    pair.client.send('{"t":"hello"}')
    pair.client.send(new Uint8Array([1, 2, 3]))
    await settleLoopback(pair)

    expect(wire).toHaveLength(2)
    for (const frame of wire) expect(frame).toBeInstanceOf(Uint8Array)
    // And the far side still sees the two *shapes* a WebSocket would deliver:
    // a text frame comes back as a string. A loopback that handed bytes over
    // where a socket hands a string would have reintroduced the second code
    // path this whole module exists to remove.
    expect(received[0]).toBe('{"t":"hello"}')
    expect(received[1]).toBeInstanceOf(Uint8Array)
  })

  it('does not let a sender mutate a message the receiver has not read yet', async () => {
    // The bug this is here for: a loopback that passed the caller's buffer
    // straight through shares a mutable reference between the two ends of a
    // "network", so a mutation propagates with no serialisation in between.
    const pair = createLoopbackPair()
    const received = collect(pair.server)

    const buffer = new Uint8Array([1, 2, 3])
    pair.client.send(buffer)
    buffer[0] = 99
    buffer[1] = 99
    await settleLoopback(pair)

    expect(Array.from(received[0] as Uint8Array)).toEqual([1, 2, 3])
  })

  it('does not let a receiver mutate its way back into the sender', async () => {
    const pair = createLoopbackPair()
    const buffer = new Uint8Array([7, 7, 7])
    const received = collect(pair.server)

    pair.client.send(buffer)
    await settleLoopback(pair)
    ;(received[0] as Uint8Array)[0] = 0

    expect(Array.from(buffer)).toEqual([7, 7, 7])
  })

  it('copies only the view it was given, not the buffer behind it', async () => {
    // A `Uint8Array` is very often a window onto a bigger allocation — every
    // `Buffer` Node hands out is. Copying the whole backing store would be a
    // silent size regression on every frame.
    const backing = new Uint8Array([9, 9, 1, 2, 9, 9])
    const view = backing.subarray(2, 4)
    const pair = createLoopbackPair()
    const received = collect(pair.server)

    pair.client.send(view)
    await settleLoopback(pair)

    expect(Array.from(received[0] as Uint8Array)).toEqual([1, 2])
  })

  it('round-trips text through UTF-8, not through a reference', async () => {
    const pair = createLoopbackPair()
    const received = collect(pair.server)
    const text = '{"t":"welcome","arena":"crücible ⚔"}'

    pair.client.send(text)
    await settleLoopback(pair)

    expect(received[0]).toBe(text)
    // Four bytes more than the string has code units: two two-byte characters
    // and one three-byte one, which is what proves the encoder actually ran.
    expect(pair.wireBytes).toBe(new TextEncoder().encode(text).byteLength)
    expect(pair.wireBytes).toBeGreaterThan(text.length)
  })
})

describe('the microtask boundary', () => {
  it('never delivers inside the send', () => {
    // A synchronous hand-off would let a client's send re-enter the host in the
    // middle of a tick — a re-entrancy a socket cannot produce, so nothing
    // downstream is written to survive it.
    const pair = createLoopbackPair()
    const received = collect(pair.server)

    pair.client.send('now')
    expect(received).toHaveLength(0)
    expect(pair.inFlight).toBe(1)
  })

  it('delivers a reply on a later turn than the message it answers', async () => {
    const order: string[] = []
    const pair = createLoopbackPair()

    pair.server.setHandlers({
      onMessage: (message) => {
        order.push(`server got ${String(message)}`)
        pair.server.send('pong')
        order.push('server replied')
      },
    })
    pair.client.setHandlers({
      onMessage: (message) => order.push(`client got ${String(message)}`),
    })

    pair.client.send('ping')
    order.push('client sent')
    await settleLoopback(pair)

    expect(order).toEqual(['client sent', 'server got ping', 'server replied', 'client got pong'])
  })

  it('hands a handler only the frames that were already queued', async () => {
    // A drain that kept picking up whatever arrived while it ran would turn one
    // microtask into an unbounded loop the first time two peers got chatty.
    const pair = createLoopbackPair()
    const batches: number[] = []
    let batch: number = 0

    pair.server.setHandlers({
      onMessage: () => {
        batch += 1
      },
    })
    pair.client.send('a')
    pair.client.send('b')
    await Promise.resolve()
    batches.push(batch)
    pair.client.send('c')
    await settleLoopback(pair)
    batches.push(batch)

    expect(batches).toEqual([2, 3])
  })
})

describe('the transport contract', () => {
  it('starts open at both ends', () => {
    const pair = createLoopbackPair()
    expect(pair.client.readyState).toBe(TransportState.Open)
    expect(pair.server.readyState).toBe(TransportState.Open)
  })

  it('delivers a synthetic open to handlers installed on an already-open end', async () => {
    // Without this a caller has to special-case the loopback, and single-player
    // stops being the same code path. `sim/src/transport.ts` makes it a MUST.
    const pair = createLoopbackPair()
    let opened = 0
    pair.client.setHandlers({ onOpen: () => (opened += 1) })
    await settleLoopback(pair)
    expect(opened).toBe(1)
  })

  it('queues messages sent before anyone is listening', async () => {
    const pair = createLoopbackPair()
    pair.client.send('early')
    const received = collect(pair.server)
    await settleLoopback(pair)
    expect(received).toEqual(['early'])
  })

  it('closes both ends, once, whoever asks first', async () => {
    const pair = createLoopbackPair()
    const closes: Array<[number, string]> = []
    pair.client.setHandlers({ onClose: (code, reason) => closes.push([code, reason]) })
    pair.server.setHandlers({ onClose: (code, reason) => closes.push([code, reason]) })

    pair.client.close(CloseReason.PolicyViolation, 'room full')
    pair.server.close(CloseReason.Normal, 'too late')
    await settleLoopback(pair)

    expect(closes).toEqual([
      [CloseReason.PolicyViolation, 'room full'],
      [CloseReason.PolicyViolation, 'room full'],
    ])
    expect(pair.client.readyState).toBe(TransportState.Closed)
    expect(pair.server.readyState).toBe(TransportState.Closed)
  })

  it('drops a send on a closed transport rather than throwing', async () => {
    // A caller racing a disconnect is the normal case, not an exceptional one.
    const pair = createLoopbackPair()
    const received = collect(pair.server)
    pair.close()
    expect(() => pair.client.send('after')).not.toThrow()
    await settleLoopback(pair)
    expect(received).toHaveLength(0)
  })

  it('still delivers what was already in flight when the close was asked for', async () => {
    const pair = createLoopbackPair()
    const received = collect(pair.server)
    pair.client.send('last words')
    pair.client.close()
    await settleLoopback(pair)
    expect(received).toEqual(['last words'])
  })
})
