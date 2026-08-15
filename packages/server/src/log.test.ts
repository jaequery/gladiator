/**
 * The log's shape, asserted rather than eyeballed.
 *
 * The claim this file exists to hold is narrow and mechanical: **every line is
 * one JSON object, and every one of them carries a `room` and a `tick`.** So
 * the test parses rather than matching strings — a test that asserted on the
 * sentence would break the first time a field was added, which is exactly the
 * change structured logging exists to make cheap.
 *
 * The second half drives a real `Room` and a real registry through the events
 * that produce lines, because a shape held by `log.ts` and broken by a call
 * site is a shape nobody has.
 */
import {
  PROTOCOL_VERSION,
  SKELETON_SEED,
  type ServerMessage,
  parseServerMessage,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { manualClock } from './clock.ts'
import { NO_LOG, createLogCollector, createLogger, scopeToRoom, type LogValue } from './log.ts'
import { SERVER_MAP, SERVER_MAP_HASH, SERVER_PLAN } from './map.ts'
import { createLoopbackPair, settleLoopback, type LoopbackPair } from './net/loopbackTransport.ts'
import { createRoom, DEFAULT_IDLE_TIMEOUT_MS, type Room } from './room.ts'
import { EMPTY_ROOM_TTL_MS, createRoomRegistry } from './rooms.ts'

function helloFrame(): string {
  return JSON.stringify({
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    build: 'test',
    mapHash: SERVER_MAP_HASH,
  })
}

/** Every entry has both index fields, and both are of the right kind. */
function isIndexed(entry: Record<string, LogValue>): boolean {
  return (
    'room' in entry &&
    'tick' in entry &&
    (entry['room'] === null || typeof entry['room'] === 'string') &&
    (entry['tick'] === null || typeof entry['tick'] === 'number')
  )
}

describe('a log line', () => {
  it('is one JSON object, with the index fields first', () => {
    const lines: string[] = []
    const log = createLogger({ write: (line) => lines.push(line), time: () => 1_700_000_000_000 })

    log('room.match_start', { room: 'AB12CD', tick: 412, peers: 2 })

    expect(lines).toHaveLength(1)
    expect(Object.keys(JSON.parse(lines[0] ?? ''))).toEqual([
      'time',
      'level',
      'event',
      'room',
      'tick',
      'peers',
    ])
    expect(JSON.parse(lines[0] ?? '')).toEqual({
      time: '2023-11-14T22:13:20.000Z',
      level: 'info',
      event: 'room.match_start',
      room: 'AB12CD',
      tick: 412,
      peers: 2,
    })
  })

  it('carries `room` and `tick` even when the event has neither', () => {
    const collected = createLogCollector()
    collected.log('registry.full', { level: 'warn', live: 200 })

    const [entry] = collected.entries()
    expect(entry).toBeDefined()
    if (entry === undefined) return
    // A consumer that can always project `.room` never has to branch on
    // whether the key is there — see the header of `log.ts`.
    expect(entry['room']).toBeNull()
    expect(entry['tick']).toBeNull()
    expect(entry['level']).toBe('warn')
  })

  it('reads the tick at write time, not at scope time', () => {
    const collected = createLogCollector()
    let tick = 0
    const scoped = scopeToRoom(collected.log, 'H7K2Q9', () => tick)

    scoped('room.join', { peer: 'peer-1' })
    tick = 900
    scoped('room.peer_idle', { peer: 'peer-1' })

    expect(collected.entries().map((entry) => entry['tick'])).toEqual([0, 900])
    expect(collected.entries().every((entry) => entry['room'] === 'H7K2Q9')).toBe(true)
  })

  it('lets a call site override the scope when it means to', () => {
    const collected = createLogCollector()
    const scoped = scopeToRoom(collected.log, 'H7K2Q9', () => 5)
    scoped('registry.reaped', { room: 'OTHER1', tick: 12 })
    expect(collected.entries()[0]?.['room']).toBe('OTHER1')
  })

  it('discards, for a host in a browser tab that has nowhere to write', () => {
    expect(() => NO_LOG('room.join', { peer: 'x' })).not.toThrow()
  })
})

describe('a room’s own lines', () => {
  it('all carry the room code and the tick the world was on', async () => {
    const collected = createLogCollector()
    const clock = manualClock()
    const room: Room = createRoom({
      map: SERVER_MAP,
      plan: SERVER_PLAN,
      clock,
      build: 'test-build',
      id: 'H7K2Q9',
      seed: SKELETON_SEED,
      capacity: 2,
      peerId: (index) => `peer-${index}`,
      log: collected.log,
    })

    const pairs: LoopbackPair[] = []
    const heard: ServerMessage[] = []
    for (let i = 0; i < 2; i += 1) {
      const pair = createLoopbackPair()
      pair.client.setHandlers({
        onMessage: (message) => {
          const parsed = parseServerMessage(String(message))
          if (parsed !== null) heard.push(parsed)
        },
      })
      room.join(pair.server)
      pair.client.send(helloFrame())
      pairs.push(pair)
    }
    for (const pair of pairs) await settleLoopback(pair)

    // Both seats filled, so the match starts, and the world is somewhere other
    // than tick zero by the time the line is written.
    room.advance(40)
    room.advance(40)

    // A third peer, refused.
    const extra = createLoopbackPair()
    room.join(extra.server)

    // And a peer that goes quiet for longer than the room will wait.
    clock.advance(DEFAULT_IDLE_TIMEOUT_MS + 1)
    room.sweep(clock.nowMs())

    const entries = collected.entries()
    const events = entries.map((entry) => entry['event'])
    expect(events).toContain('room.join')
    expect(events).toContain('room.match_start')
    expect(events).toContain('room.join_refused')
    expect(events).toContain('room.peer_idle')

    expect(entries.every(isIndexed)).toBe(true)
    // Not merely present — *this* room, and a real tick.
    expect(entries.every((entry) => entry['room'] === 'H7K2Q9')).toBe(true)
    expect(entries.every((entry) => typeof entry['tick'] === 'number')).toBe(true)

    // The match starts *between* sub-steps, on the first advance after both
    // seats filled, so its line is stamped with the tick the world had reached
    // — which is still zero. The refusal, eighty sub-steps later, is not.
    const start = entries.find((entry) => entry['event'] === 'room.match_start')
    expect(start?.['tick']).toBe(0)
    const refused = entries.find((entry) => entry['event'] === 'room.join_refused')
    expect(refused?.['tick']).toBe(80)

    for (const pair of [...pairs, extra]) pair.close()
  })
})

describe('the registry’s lines', () => {
  it('name the room they are about, and every one parses', () => {
    const collected = createLogCollector()
    const clock = manualClock()
    let opened = 0
    const registry = createRoomRegistry({
      clock,
      log: collected.log,
      maxRooms: 1,
      create: (code) =>
        createRoom({
          map: SERVER_MAP,
          plan: SERVER_PLAN,
          clock,
          build: 'test-build',
          id: code,
          log: collected.log,
        }),
    })

    const first = registry.create()
    expect(first).not.toBeNull()
    opened += 1
    // The machine is full at one room, which is the other branch.
    expect(registry.create()).toBeNull()

    clock.advance(EMPTY_ROOM_TTL_MS + 1)
    registry.sweep(clock.nowMs())

    const entries = collected.entries()
    const events = entries.map((entry) => entry['event'])
    expect(opened).toBe(1)
    expect(events).toContain('registry.opened')
    expect(events).toContain('registry.full')
    expect(events).toContain('registry.reaped')
    expect(entries.every(isIndexed)).toBe(true)

    const reaped = entries.find((entry) => entry['event'] === 'registry.reaped')
    expect(reaped?.['room']).toBe(first?.code)
  })

  it('says so when a demo hook throws, instead of taking the shutdown with it', () => {
    const collected = createLogCollector()
    const clock = manualClock()
    const registry = createRoomRegistry({
      clock,
      log: collected.log,
      onClosing: () => {
        throw new Error('disk full')
      },
      create: (code) =>
        createRoom({ map: SERVER_MAP, plan: SERVER_PLAN, clock, build: 'test-build', id: code }),
    })
    const entry = registry.create()
    expect(entry).not.toBeNull()
    expect(() => registry.closeAll()).not.toThrow()

    const failure = collected.entries().find((e) => e['event'] === 'registry.on_closing_failed')
    expect(failure?.['level']).toBe('error')
    expect(String(failure?.['error'])).toContain('disk full')
  })
})
