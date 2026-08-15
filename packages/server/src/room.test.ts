/**
 * The host, driven over a loopback with a clock a test owns.
 *
 * Every one of these would have needed a socket and a timer before this ticket,
 * which is the whole argument for injecting both: what is being asserted here
 * is *host behaviour*, and host behaviour that can only be observed through a
 * network is host behaviour nobody asserts.
 */
import {
  MatchPhase,
  NO_SLOT,
  PROTOCOL_VERSION,
  SKELETON_SEED,
  TransportState,
  UNKNOWN_RTT,
  applyWireState,
  createMapState,
  encodeCmd,
  findPlayer,
  hashState,
  parseServerMessage,
  tick as simTick,
  type ServerMessage,
  type Transport,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { manualClock } from './clock.ts'
import { batchFrame, recordStream, scriptedCommand } from './fixtures/recordedStream.ts'
import { MAX_BUFFERED_COMMANDS } from './inputQueue.ts'
import { SERVER_MAP, SERVER_MAP_HASH, SERVER_PLAN } from './map.ts'
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

const ROOM_CODE = 'H7K2Q9'

/** A room over a loopback, plus everything the far end has been told. */
function hosted(options: { capacity?: number; clock?: ReturnType<typeof manualClock> } = {}) {
  const clock = options.clock ?? manualClock()
  const pair: LoopbackPair = createLoopbackPair()
  const room: Room = createRoom({
    map: SERVER_MAP,
    plan: SERVER_PLAN,
    clock,
    build: 'test-build',
    id: ROOM_CODE,
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

/** A second loopback into the same room, so a duel has two ends. */
function seat(room: Room) {
  const pair: LoopbackPair = createLoopbackPair()
  const heard: ServerMessage[] = []
  const closes: number[] = []
  pair.client.setHandlers({
    onMessage: (message) => {
      const parsed = parseServerMessage(String(message))
      if (parsed !== null) heard.push(parsed)
    },
    onClose: (code) => closes.push(code),
  })
  const peer = room.join(pair.server)
  return { pair, heard, closes, peer }
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
        // The host's own answer to "which match is this", so a player who
        // created one has something to send their friend.
        room: ROOM_CODE,
      },
    ])
  })

  it('buffers the commands it is sent and executes them when the scheduler says so', async () => {
    const { pair, room, heard } = hosted()
    const peer = room.join(pair.server)
    pair.client.send(helloFrame())
    await settleLoopback(pair)

    const stream = recordStream(40)
    for (const batch of stream.batches) {
      pair.client.send(batchFrame(batch))
      await settleLoopback(pair)
    }

    // Nothing has moved. A batch is admitted to this peer's jitter buffer and
    // that is all it does; the world advances on the scheduler's clock.
    expect(room.tick).toBe(0)
    expect(peer.queued).toBeGreaterThan(0)
    expect(heard.filter((frame) => frame.t === 'hash')).toHaveLength(0)

    // A room drains one command per peer per sub-step, so forty commands are
    // forty sub-steps — however they were batched on the way in. The buffer's
    // depth ceiling means only the first `MAX_BUFFERED_COMMANDS` survived, and
    // the rest of the sub-steps run the repeat fallback.
    room.advance(40)
    await settleLoopback(pair)

    const expected = createMapState(SERVER_MAP.source, SKELETON_SEED)
    for (let tick = 1; tick <= MAX_BUFFERED_COMMANDS; tick += 1) {
      simTick(expected, [scriptedCommand(tick)], SERVER_MAP.world)
    }
    expect(room.tick).toBe(40)

    // The world it reports is the world it has: one hash and one snapshot per
    // host frame, not one per batch.
    const [hashFrame, snapFrame] = heard.slice(-2)
    expect(hashFrame).toEqual({ t: 'hash', tick: 40, hash: room.hash() })
    if (snapFrame?.t !== 'snap') throw new Error('the room sent no snapshot')
    // The ack is the *client's* tick label for the last command executed, and
    // it is not the world's tick: the world ran 40 sub-steps and only the
    // buffered commands carried a label.
    expect(snapFrame.ack).toBe(MAX_BUFFERED_COMMANDS)
    const rebuilt = createMapState(SERVER_MAP.source, SKELETON_SEED)
    expect(applyWireState(rebuilt, snapFrame.state)).toBe(true)
    expect(hashState(rebuilt)).toBe(room.hash())

    // And the player moved: the first commands really were executed rather
    // than counted.
    const spawn = createMapState(SERVER_MAP.source, SKELETON_SEED)
    const moved = findPlayer(room.state, 0)?.origin[0] ?? 0
    expect(moved).not.toBe(findPlayer(spawn, 0)?.origin[0] ?? 0)
  })

  it('runs exactly the sub-steps it is given, and none for a frame worth none', () => {
    const { pair, room } = hosted()
    room.join(pair.server)

    expect(room.advance(0)).toBe(0)
    expect(room.tick).toBe(0)
    expect(room.advance(3)).toBe(3)
    expect(room.tick).toBe(3)
    expect(room.advance(125)).toBe(125)
    expect(room.tick).toBe(128)
    // A negative or fractional count is a caller bug, and running `-1` ticks is
    // not a thing a world can do. Refused rather than rounded.
    expect(room.advance(-4)).toBe(0)
    expect(room.advance(1.5)).toBe(0)
    expect(room.tick).toBe(128)
  })

  it('refuses a peer it has no seat for, and says why', async () => {
    const { pair, room } = hosted({ capacity: 1 })
    room.join(pair.server)

    const second = seat(room)
    await settleLoopback(second.pair)

    expect(second.peer.slot).toBe(NO_SLOT)
    expect(room.peers).toHaveLength(1)
    expect(second.heard[0]).toMatchObject({ t: 'fault', code: 'room-full' })
    expect(second.closes).toEqual([CLOSE_ROOM_FULL])
  })

  it('seats two peers, one per duel slot, without being asked', () => {
    // Two is the default because the game is a duel. The question a single-seat
    // room could dodge — whose command does a shared tick carry — is answered
    // by one input buffer per peer, drained one command each per sub-step.
    const { pair, room } = hosted()
    const first = room.join(pair.server)
    const other = seat(room)

    expect([first.slot, other.peer.slot]).toEqual([0, 1])
    expect(room.capacity).toBe(2)
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
  it('produces the same world wherever the clock started', async () => {
    // The property the whole listen-server pattern rests on: the world is a
    // function of the commands admitted and of how many sub-steps the room was
    // told to run — never of what the clock's origin happens to be. A `Clock`
    // is monotonic with an *arbitrary* origin (`clock.ts`), and a browser tab's
    // `performance.now()` starts at zero while a Fly machine's is however long
    // it has been up.
    //
    // "Whatever the clock *says*" is deliberately not the claim any more, and
    // the difference is the rate limit. Commands per wall-clock second is the
    // only unit in which "too fast" means anything (`inputQueue.ts`), so a peer
    // that delivers a minute of input in one instant has some of it refused at
    // the door — which is the whole point of it, and which makes admission the
    // one place elapsed time is allowed to matter.
    const stream = recordStream(60)

    const run = async (startMs: number): Promise<number> => {
      const clock = manualClock(startMs)
      const { pair, room } = hosted({ clock })
      room.join(pair.server)
      pair.client.send(helloFrame())
      await settleLoopback(pair)
      for (const batch of stream.batches) {
        clock.advance(16)
        pair.client.send(batchFrame(batch))
        await settleLoopback(pair)
        // Two sub-steps a frame, which is what a 16 ms host frame is worth —
        // and deliberately not "however much wall-clock the loop just faked".
        room.advance(2)
      }
      return room.hash()
    }

    expect(await run(0)).toBe(await run(1_000_000))
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

describe('clock sync over a room', () => {
  /** Beat the room for `ms` of wall-clock, answering every ping it sends. */
  async function converse(
    clock: ReturnType<typeof manualClock>,
    room: Room,
    pair: LoopbackPair,
    heard: ServerMessage[],
    ms: number,
    lagMs = 0,
  ): Promise<void> {
    for (let beat = 0; beat * 8 < ms; beat += 1) {
      const nowMs = clock.advance(8)
      room.sweep(nowMs)
      await settleLoopback(pair)
      for (const frame of heard) {
        if (frame.t !== 'ping') continue
        // The pong goes out `lagMs` later on the room's own clock, which is the
        // whole of what the room is measuring.
        clock.set(nowMs + lagMs)
        pair.client.send(JSON.stringify({ t: 'pong', id: frame.id }))
        await settleLoopback(pair)
        clock.set(nowMs)
      }
      heard.length = 0
    }
  }

  it('pings a seated peer and measures the trip on its own clock', async () => {
    const clock = manualClock()
    const { pair, room, heard } = hosted({ clock })
    const peer = room.join(pair.server)
    pair.client.send(helloFrame())
    await settleLoopback(pair)
    heard.length = 0

    expect(peer.rttMs).toBe(UNKNOWN_RTT)
    await converse(clock, room, pair, heard, 1_000, 37)
    expect(peer.rttMs).toBe(37)
  })

  it('does not ping a peer that has not said hello', async () => {
    // It may be a client one deploy behind, on its way to being told so.
    const clock = manualClock()
    const { pair, room, heard } = hosted({ clock })
    room.join(pair.server)

    for (let beat = 0; beat < 200; beat += 1) {
      room.sweep(clock.advance(8))
      await settleLoopback(pair)
    }
    expect(heard.filter((frame) => frame.t === 'ping')).toHaveLength(0)
  })

  it('takes a pong off the wire without touching the world', async () => {
    // A pong is not a command. It reaches the peer's stopwatch and nothing
    // else — no tick, no hash, no reply.
    const clock = manualClock()
    const { pair, room, heard } = hosted({ clock })
    room.join(pair.server)
    pair.client.send(helloFrame())
    await settleLoopback(pair)

    room.sweep(clock.advance(8))
    await settleLoopback(pair)
    const ping = heard.find((frame) => frame.t === 'ping')
    expect(ping?.t).toBe('ping')
    heard.length = 0

    const before = room.hash()
    pair.client.send(JSON.stringify({ t: 'pong', id: ping?.t === 'ping' ? ping.id : 0 }))
    await settleLoopback(pair)

    expect(heard).toEqual([])
    expect(room.tick).toBe(0)
    expect(room.hash()).toBe(before)
    expect(room.peers[0]?.open).toBe(true)
  })

  it('keeps a peer that answers ids it was never sent, and measures nothing from them', async () => {
    // Closing the socket over it is GLAD-V7M6PQ's call to make. What this
    // ticket owes is that the lie buys nothing: no sample, no round trip, no
    // extra rewind out of lag compensation.
    const clock = manualClock()
    const { pair, room } = hosted({ clock })
    const peer = room.join(pair.server)
    pair.client.send(helloFrame())
    await settleLoopback(pair)

    for (let id = 0; id < 50; id += 1) {
      pair.client.send(JSON.stringify({ t: 'pong', id }))
    }
    await settleLoopback(pair)

    expect(peer.rttMs).toBe(UNKNOWN_RTT)
    expect(peer.open).toBe(true)
  })
})

describe('two peers in one world', () => {
  it('starts the match once both seats are filled, and not before', async () => {
    // The one edge out of warmup, and it is the room's to take: the simulation
    // is not the layer that knows both players have arrived.
    const { pair, room } = hosted()
    room.join(pair.server)
    pair.client.send(helloFrame())
    await settleLoopback(pair)

    room.advance(4)
    expect(room.state.match.phase).toBe(MatchPhase.Warmup)

    const other = seat(room)
    other.pair.client.send(helloFrame())
    await settleLoopback(other.pair)

    room.advance(1)
    expect(room.state.match.phase).toBe(MatchPhase.Live)
    expect(room.state.match.round).toBe(1)
    // Both bodies are standing: a round seats two players, which is what a
    // world with one player in it could not do.
    expect(findPlayer(room.state, 0)).not.toBeNull()
    expect(findPlayer(room.state, 1)).not.toBeNull()
  })

  it('acknowledges each peer with its own tick labels', async () => {
    // `ack` is a property of the peer, not of the world: how much of *this*
    // peer's input is in the world, which is a different question from how far
    // the world has been advanced.
    const { pair, room, heard } = hosted()
    room.join(pair.server)
    pair.client.send(helloFrame())
    const other = seat(room)
    other.pair.client.send(helloFrame())
    await settleLoopback(pair)
    await settleLoopback(other.pair)

    // One peer sends four commands, the other sends one.
    pair.client.send(batchFrame({ startTick: 1, cmds: [1, 2, 3, 4].map((t) => encodeCmd(scriptedCommand(t))) }))
    other.pair.client.send(batchFrame({ startTick: 1, cmds: [encodeCmd(scriptedCommand(1))] }))
    await settleLoopback(pair)
    await settleLoopback(other.pair)

    heard.length = 0
    other.heard.length = 0
    room.advance(4)
    await settleLoopback(pair)
    await settleLoopback(other.pair)

    const ackOf = (frames: readonly ServerMessage[]) =>
      frames.flatMap((frame) => (frame.t === 'snap' ? [frame.ack] : []))
    expect(ackOf(heard)).toEqual([4])
    expect(ackOf(other.heard)).toEqual([1])
    // And the world ran four sub-steps for both of them, because a tick never
    // stalls waiting for the peer that has gone quiet.
    expect(room.tick).toBe(4)
  })

  it('does not let a silent peer stall the other one', async () => {
    const { pair, room } = hosted()
    room.join(pair.server)
    pair.client.send(helloFrame())
    const other = seat(room)
    other.pair.client.send(helloFrame())
    await settleLoopback(pair)
    await settleLoopback(other.pair)

    // Only one of them ever says anything. The world still advances by exactly
    // what it was told, and the silent peer gets the documented fallback.
    pair.client.send(batchFrame({ startTick: 1, cmds: [encodeCmd(scriptedCommand(1))] }))
    await settleLoopback(pair)

    room.advance(60)
    expect(room.tick).toBe(60)
    expect(room.snapshot().starved).toBeGreaterThan(0)
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
