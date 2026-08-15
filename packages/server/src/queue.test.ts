/**
 * The quick-match line, over a real registry holding real rooms.
 *
 * Real, because every interesting thing the queue does is a question about a
 * room somebody may have left: an entry is a claim about a code, and the whole
 * design is that the claim is re-checked rather than trusted. A fake room whose
 * peer count a test set by hand would be a fake of exactly the thing under
 * test.
 *
 * The clock is manual, so a minute-long wait costs the arithmetic rather than
 * the minute.
 */
import { describe, expect, it } from 'vitest'

import { manualClock } from './clock.ts'
import { SERVER_MAP, SERVER_PLAN } from './map.ts'
import { createLoopbackPair, settleLoopback } from './net/loopbackTransport.ts'
import { QUEUE_WAIT_TIMEOUT_MS, createMatchQueue, type MatchQueue } from './queue.ts'
import { createRoom, type Room } from './room.ts'
import { EMPTY_ROOM_TTL_MS, createRoomRegistry, type RoomEntry } from './rooms.ts'

/** A queue over a registry over real rooms, with a clock this file owns. */
function harness(options: { maxRooms?: number; waitTimeoutMs?: number } = {}) {
  const clock = manualClock()
  let at = 0
  const timedOut: Array<{ code: string; waitedMs: number }> = []

  const rooms = createRoomRegistry({
    clock,
    random: () => {
      at += 1
      return at
    },
    ...(options.maxRooms === undefined ? {} : { maxRooms: options.maxRooms }),
    create: (code) =>
      createRoom({
        map: SERVER_MAP,
        plan: SERVER_PLAN,
        clock,
        build: 'queue-test',
        id: code,
        peerId: (index) => `${code}-${index}`,
      }),
  })

  const queue: MatchQueue = createMatchQueue({
    rooms,
    clock,
    ...(options.waitTimeoutMs === undefined ? {} : { waitTimeoutMs: options.waitTimeoutMs }),
    onTimeout: (entry: RoomEntry, waitedMs: number) => {
      timedOut.push({ code: entry.code, waitedMs })
    },
  })

  return { clock, rooms, queue, timedOut }
}

/** Seat a peer, the way a socket does. The far end is handed back to close. */
async function seat(room: Room) {
  const pair = createLoopbackPair()
  pair.client.setHandlers({ onMessage: () => undefined })
  room.join(pair.server)
  await settleLoopback(pair)
  return pair
}

describe('the first arrival', () => {
  it('is parked in a room of its own, with a deadline', async () => {
    const { queue } = harness()
    const admission = queue.admit()

    expect(admission.kind).toBe('waiting')
    if (admission.kind !== 'waiting') throw new Error('unreachable')
    // A real room with a real code from the first instant — which is what makes
    // the timeout an outcome rather than a dead end: this player is already
    // holding six characters they can send somebody.
    expect(admission.entry.code).toHaveLength(6)
    expect(admission.timeoutMs).toBe(QUEUE_WAIT_TIMEOUT_MS)
    expect(queue.size).toBe(1)
    expect(queue.codes()).toEqual([admission.entry.code])

    await seat(admission.entry.room)
    expect(admission.entry.room.peers).toHaveLength(1)
  })

  it('is refused when the machine has no room left to open', () => {
    const { rooms, queue } = harness({ maxRooms: 1 })
    expect(rooms.create()).not.toBeNull()
    expect(queue.admit()).toEqual({ kind: 'full' })
    expect(queue.size).toBe(0)
  })
})

describe('pairing', () => {
  it('puts the next arrival in the waiting room, and says what it cost', async () => {
    const { clock, queue } = harness()
    const first = queue.admit()
    if (first.kind !== 'waiting') throw new Error('expected a wait')
    await seat(first.entry.room)

    clock.advance(4_000)
    const second = queue.admit()
    expect(second.kind).toBe('paired')
    if (second.kind !== 'paired') throw new Error('unreachable')
    expect(second.entry.code).toBe(first.entry.code)
    expect(second.waitedMs).toBe(4_000)

    // The line is empty again, and the room seats the pair.
    expect(queue.size).toBe(0)
    await seat(second.entry.room)
    expect(second.entry.room.peers.map((peer) => peer.slot)).toEqual([0, 1])
    expect(queue.stats()).toMatchObject({ waiting: 0, parked: 1, paired: 1 })
  })

  it('pairs the longest wait first', async () => {
    // Two players can only be waiting at once if the front of the line went
    // stale between them, which is exactly when the order matters: whoever has
    // been sitting there longest is the one owed a duel.
    const { clock, queue } = harness()
    const first = queue.admit()
    if (first.kind !== 'waiting') throw new Error('expected a wait')
    const firstPair = await seat(first.entry.room)

    // The first player's room fills up by code, which takes them out of the
    // line — so the next arrival waits instead of pairing.
    await seat(first.entry.room)
    clock.advance(1_000)
    const second = queue.admit()
    if (second.kind !== 'waiting') throw new Error('expected a wait')
    await seat(second.entry.room)
    expect(second.entry.code).not.toBe(first.entry.code)

    clock.advance(1_000)
    const third = queue.admit()
    if (third.kind !== 'paired') throw new Error('expected a pair')
    expect(third.entry.code).toBe(second.entry.code)

    firstPair.client.close()
  })
})

describe('a player who queues and walks away', () => {
  it('is never paired with anybody', async () => {
    // The acceptance check, and the reason an entry is a claim that gets
    // re-checked rather than a promise: nothing tells this module that a socket
    // closed.
    const { queue } = harness()
    const first = queue.admit()
    if (first.kind !== 'waiting') throw new Error('expected a wait')
    const pair = await seat(first.entry.room)

    pair.client.close()
    await settleLoopback(pair)
    expect(first.entry.room.peers).toHaveLength(0)

    const second = queue.admit()
    expect(second.kind).toBe('waiting')
    if (second.kind !== 'waiting') throw new Error('unreachable')
    expect(second.entry.code).not.toBe(first.entry.code)
    expect(queue.stats()).toMatchObject({ dropped: 1, paired: 0 })
  })

  it('is out of the line by the next sweep, not merely at the next arrival', async () => {
    // So that "how many people are waiting" is a number worth serving on
    // `/healthz` rather than one that only becomes true when somebody asks.
    const { clock, queue } = harness()
    const admission = queue.admit()
    if (admission.kind !== 'waiting') throw new Error('expected a wait')
    const pair = await seat(admission.entry.room)

    queue.sweep(clock.nowMs())
    expect(queue.size).toBe(1)

    pair.client.close()
    await settleLoopback(pair)
    queue.sweep(clock.nowMs())
    expect(queue.size).toBe(0)
    expect(queue.stats()).toMatchObject({ waiting: 0, dropped: 1 })
  })

  it('takes their room with them when the reaper gets to it', async () => {
    const { clock, rooms, queue } = harness()
    const admission = queue.admit()
    if (admission.kind !== 'waiting') throw new Error('expected a wait')

    // Never even connected: the code was minted and the socket died on the way.
    // The registry reaps the room a minute later and the queue must not go on
    // pointing at it.
    rooms.sweep(clock.advance(EMPTY_ROOM_TTL_MS + 1))
    expect(rooms.size).toBe(0)

    queue.sweep(clock.nowMs())
    expect(queue.size).toBe(0)
    expect(queue.stats()).toMatchObject({ dropped: 1 })
  })
})

describe('a room that filled some other way', () => {
  it('leaves the line rather than being offered a third player', async () => {
    // A friend arriving with the code is a *better* outcome than the queue's,
    // and the queue's job at that point is to get out of the way.
    const { clock, queue } = harness()
    const admission = queue.admit()
    if (admission.kind !== 'waiting') throw new Error('expected a wait')
    await seat(admission.entry.room)
    await seat(admission.entry.room)

    queue.sweep(clock.nowMs())
    expect(queue.size).toBe(0)

    const next = queue.admit()
    if (next.kind !== 'waiting') throw new Error('expected a wait')
    expect(next.entry.code).not.toBe(admission.entry.code)
  })
})

describe('the wait running out', () => {
  it('ends it once, with the room the player is still sitting in', async () => {
    const { clock, queue, timedOut } = harness({ waitTimeoutMs: 10_000 })
    const admission = queue.admit()
    if (admission.kind !== 'waiting') throw new Error('expected a wait')
    await seat(admission.entry.room)

    queue.sweep(clock.advance(9_999))
    expect(timedOut).toEqual([])

    queue.sweep(clock.advance(1))
    expect(timedOut).toEqual([{ code: admission.entry.code, waitedMs: 10_000 }])

    // Once. A sweep runs every host frame — 62 times a second — and a timeout
    // that fired on each of them would be a frame of one player's socket per
    // 16 ms for as long as they sat there.
    queue.sweep(clock.advance(60_000))
    expect(timedOut).toHaveLength(1)
    expect(queue.stats()).toMatchObject({ timedOut: 1, waiting: 0 })
  })

  it('leaves the player in their room, and out of the line', async () => {
    // The timeout ends the *matching*, not the session: the socket stays open
    // and the code stays live, because "send this to a friend" is the whole
    // point of the sentence the player is about to read.
    const { clock, rooms, queue } = harness({ waitTimeoutMs: 5_000 })
    const admission = queue.admit()
    if (admission.kind !== 'waiting') throw new Error('expected a wait')
    const pair = await seat(admission.entry.room)

    queue.sweep(clock.advance(5_000))
    expect(rooms.get(admission.entry.code)).not.toBeNull()
    expect(admission.entry.room.peers).toHaveLength(1)

    // And they are not quietly paired with the next arrival after being told
    // that nobody came.
    const next = queue.admit()
    if (next.kind !== 'waiting') throw new Error('expected a wait')
    expect(next.entry.code).not.toBe(admission.entry.code)

    pair.client.close()
  })

  it('does not fire for a player who left before it', async () => {
    const { clock, queue, timedOut } = harness({ waitTimeoutMs: 5_000 })
    const admission = queue.admit()
    if (admission.kind !== 'waiting') throw new Error('expected a wait')
    const pair = await seat(admission.entry.room)

    pair.client.close()
    await settleLoopback(pair)
    queue.sweep(clock.advance(60_000))

    expect(timedOut).toEqual([])
    expect(queue.stats()).toMatchObject({ dropped: 1, timedOut: 0 })
  })
})
