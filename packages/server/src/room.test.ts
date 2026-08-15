/**
 * The host, driven over a loopback with a clock a test owns.
 *
 * Every one of these would have needed a socket and a timer before this ticket,
 * which is the whole argument for injecting both: what is being asserted here
 * is *host behaviour*, and host behaviour that can only be observed through a
 * network is host behaviour nobody asserts.
 */
import {
  NO_SLOT,
  PROTOCOL_VERSION,
  SKELETON_SEED,
  TransportState,
  createMapState,
  hashState,
  parseServerMessage,
  tick as simTick,
  type ServerMessage,
  type Transport,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { manualClock } from './clock.ts'
import { batchFrame, recordStream, scriptedCommand } from './fixtures/recordedStream.ts'
import { SERVER_MAP, SERVER_MAP_HASH } from './map.ts'
import { createLoopbackPair, settleLoopback, type LoopbackPair } from './net/loopbackTransport.ts'
import { CLOSE_ROOM_FULL } from './session.ts'
import { createRoom, DEFAULT_IDLE_TIMEOUT_MS, type Room } from './room.ts'

function helloFrame(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    build: 'test',
    mapHash: SERVER_MAP_HASH,
    ...over,
  })
}

/** A room over a loopback, plus everything the far end has been told. */
function hosted(options: { capacity?: number; clock?: ReturnType<typeof manualClock> } = {}) {
  const clock = options.clock ?? manualClock()
  const pair: LoopbackPair = createLoopbackPair()
  const room: Room = createRoom({
    map: SERVER_MAP,
    clock,
    build: 'test-build',
    peerId: (index) => `peer-${index}`,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
  })
  const heard: ServerMessage[] = []
  const closes: Array<[number, string]> = []
  pair.client.setHandlers({
    onMessage: (message) => {
      if (typeof message !== 'string') throw new Error('the host answered in binary')
      const parsed = parseServerMessage(message)
      if (parsed !== null) heard.push(parsed)
    },
    onClose: (code, reason) => closes.push([code, reason]),
  })
  return { clock, pair, room, heard, closes }
}

describe('seating a peer', () => {
  it('takes a transport, welcomes it and seats it in slot 0', async () => {
    const { pair, room, heard } = hosted()
    const peer = room.join(pair.server)
    expect(peer.slot).toBe(0)
    expect(room.peers).toHaveLength(1)

    pair.client.send(helloFrame())
    await settleLoopback(pair)

    expect(heard).toEqual([
      {
        t: 'welcome',
        protocol: PROTOCOL_VERSION,
        build: 'test-build',
        session: 'peer-1',
        mapHash: SERVER_MAP_HASH,
      },
    ])
  })

  it('advances its world by the commands it is sent, and hashes the result', async () => {
    const { pair, room, heard } = hosted()
    room.join(pair.server)
    pair.client.send(helloFrame())
    await settleLoopback(pair)

    const stream = recordStream(40)
    for (const batch of stream.batches) {
      pair.client.send(batchFrame(batch))
      await settleLoopback(pair)
    }

    const expected = createMapState(SERVER_MAP.source, SKELETON_SEED)
    for (let tick = 1; tick <= 40; tick += 1) {
      simTick(expected, [scriptedCommand(tick)], SERVER_MAP.world)
    }

    expect(room.tick).toBe(40)
    expect(room.hash()).toBe(hashState(expected))
    const last = heard[heard.length - 1]
    expect(last).toEqual({ t: 'hash', tick: 40, hash: hashState(expected) })
  })

  it('refuses a peer it has no seat for, and says why', async () => {
    const { pair, room } = hosted()
    room.join(pair.server)

    const second = createLoopbackPair()
    const heard: ServerMessage[] = []
    const closes: number[] = []
    second.client.setHandlers({
      onMessage: (message) => {
        const parsed = parseServerMessage(String(message))
        if (parsed !== null) heard.push(parsed)
      },
      onClose: (code) => closes.push(code),
    })

    const refused = room.join(second.server)
    await settleLoopback(second)

    expect(refused.slot).toBe(NO_SLOT)
    expect(room.peers).toHaveLength(1)
    expect(heard[0]).toMatchObject({ t: 'fault', code: 'room-full' })
    expect(closes).toEqual([CLOSE_ROOM_FULL])
  })

  it('seats a second peer in slot 1 when there is room for one', () => {
    // The seat exists; what does not yet exist is the answer to "whose command
    // does a shared tick carry" — GLAD-5995PA. Which is why capacity is one by
    // default rather than two.
    const { pair, room } = hosted({ capacity: 2 })
    const first = room.join(pair.server)
    const second = createLoopbackPair()
    const other = room.join(second.server)

    expect([first.slot, other.slot]).toEqual([0, 1])
  })

  it('forgets a peer whose transport closed', async () => {
    const { pair, room } = hosted()
    room.join(pair.server)
    expect(room.peers).toHaveLength(1)

    pair.client.close()
    await settleLoopback(pair)

    expect(room.peers).toHaveLength(0)
  })

  it('refuses a binary frame rather than guessing what it meant', async () => {
    const { pair, room, heard, closes } = hosted()
    room.join(pair.server)
    pair.client.send(new Uint8Array([1, 2, 3]))
    await settleLoopback(pair)

    expect(heard[0]).toMatchObject({ t: 'fault', code: 'binary' })
    expect(closes[0]?.[0]).toBe(4002)
  })
})

describe('the clock never reaches the simulation', () => {
  it('produces the same world whatever the clock says', async () => {
    // The property the whole listen-server pattern rests on: the world is a
    // function of the commands, never of when they turned up. If this ever
    // fails, one recorded stream will stop producing one hash and the parity
    // test will start failing in a way nobody can reproduce.
    const stream = recordStream(60)

    const run = async (startMs: number, stepMs: number): Promise<number> => {
      const clock = manualClock(startMs)
      const { pair, room } = hosted({ clock })
      room.join(pair.server)
      pair.client.send(helloFrame())
      await settleLoopback(pair)
      for (const batch of stream.batches) {
        clock.advance(stepMs)
        pair.client.send(batchFrame(batch))
        await settleLoopback(pair)
      }
      return room.hash()
    }

    expect(await run(0, 0)).toBe(await run(1_000_000, 997))
  })

  it('stamps a peer with the clock it was given', async () => {
    const clock = manualClock(500)
    const { pair, room } = hosted({ clock })
    const peer = room.join(pair.server)
    expect(peer.lastHeardMs).toBe(500)

    clock.advance(250)
    pair.client.send(helloFrame())
    await settleLoopback(pair)
    expect(peer.lastHeardMs).toBe(750)
  })
})

describe('sweep', () => {
  it('lets go of a peer that has stopped talking', async () => {
    const clock = manualClock()
    const { pair, room, closes } = hosted({ clock })
    room.join(pair.server)
    pair.client.send(helloFrame())
    await settleLoopback(pair)

    room.sweep(clock.advance(DEFAULT_IDLE_TIMEOUT_MS - 1))
    expect(room.peers).toHaveLength(1)

    room.sweep(clock.advance(2))
    await settleLoopback(pair)
    expect(room.peers).toHaveLength(0)
    expect(closes[0]?.[1]).toBe('idle')
  })

  it('never advances the world', async () => {
    const clock = manualClock()
    const { pair, room } = hosted({ clock })
    room.join(pair.server)
    pair.client.send(helloFrame())
    await settleLoopback(pair)

    const before = room.hash()
    for (let beat = 0; beat < 100; beat += 1) room.sweep(clock.advance(8))
    expect(room.tick).toBe(0)
    expect(room.hash()).toBe(before)
  })
})

describe('what a room is not allowed to be', () => {
  it('takes a transport rather than making one', () => {
    // A structural assertion, and a cheap one: the only way into a room is a
    // value satisfying `Transport`. A room that could open its own connection
    // could not run in a browser tab, and there would be two hosts again.
    const { pair, room } = hosted()
    const transport: Transport = pair.server
    expect(transport.readyState).toBe(TransportState.Open)
    expect(room.join(transport).slot).toBe(0)
  })

  it('closes every peer when it closes', async () => {
    const { pair, room, closes } = hosted()
    room.join(pair.server)
    room.close()
    await settleLoopback(pair)
    expect(room.peers).toHaveLength(0)
    expect(closes).toHaveLength(1)
  })
})
