/**
 * The registry, over rooms a test can count.
 *
 * The rooms are real — the same `createRoom` the server builds — because what
 * is being asserted is registry *behaviour* over live worlds: that a code
 * addresses exactly one of them, that a code nobody minted addresses none, and
 * that a room nobody is in stops existing rather than sitting in a `Map` for
 * the life of the process.
 */
import { CloseReason } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { manualClock } from './clock.ts'
import { SERVER_MAP, SERVER_PLAN } from './map.ts'
import { createLoopbackPair, settleLoopback } from './net/loopbackTransport.ts'
import { createRoom, type Room } from './room.ts'
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from './roomCode.ts'
import { EMPTY_ROOM_TTL_MS, createRoomRegistry, type RoomRegistry } from './rooms.ts'

/** A registry over real rooms, with a clock and a code source a test owns. */
function registry(options: { maxRooms?: number; codes?: readonly string[] } = {}) {
  const clock = manualClock()
  let at = 0
  const random = (): number => {
    const source = options.codes ?? []
    if (source.length === 0) {
      at += 1
      return at - 1
    }
    // Each requested code is spelt out symbol by symbol, in order, so a test
    // can arrange a collision and see what the registry does about it.
    const flat = source.join('')
    const symbol = flat[at % flat.length] ?? '0'
    at += 1
    return ROOM_CODE_ALPHABET.indexOf(symbol)
  }

  const built: Room[] = []
  const rooms: RoomRegistry = createRoomRegistry({
    clock,
    random,
    ...(options.maxRooms === undefined ? {} : { maxRooms: options.maxRooms }),
    create: (code) => {
      const room = createRoom({
        map: SERVER_MAP,
        plan: SERVER_PLAN,
        clock,
        build: 'registry',
        id: code,
        peerId: (index) => `${code}-${index}`,
      })
      built.push(room)
      return room
    },
  })
  return { clock, rooms, built }
}

/** Put a peer in a room, and hand back the far end so a test can close it. */
function join(room: Room) {
  const pair = createLoopbackPair()
  pair.client.setHandlers({ onMessage: () => undefined })
  room.join(pair.server)
  return pair
}

describe('opening a room', () => {
  it('mints a code and answers to it', () => {
    const { rooms } = registry()
    const opened = rooms.create()
    if (opened === null) throw new Error('the registry refused to open a room')

    expect(opened.code).toHaveLength(ROOM_CODE_LENGTH)
    expect(rooms.get(opened.code)?.room).toBe(opened.room)
    expect(rooms.size).toBe(1)
    // The room knows its own code, which is what puts it in the welcome.
    expect(opened.room.id).toBe(opened.code)
  })

  it('answers to a code typed the way a person types it', () => {
    const { rooms } = registry({ codes: ['H7K2Q9'] })
    const opened = rooms.create()
    expect(opened?.code).toBe('H7K2Q9')
    expect(rooms.get('h7k-2q9')?.code).toBe('H7K2Q9')
    expect(rooms.get(' H7K 2Q9 ')?.code).toBe('H7K2Q9')
  })

  it('gives every room its own world', () => {
    const { rooms } = registry()
    const first = rooms.create()
    const second = rooms.create()
    expect(first?.code).not.toBe(second?.code)
    expect(first?.room.state).not.toBe(second?.room.state)
    expect(rooms.size).toBe(2)
  })

  it('draws again when a code is already taken', () => {
    // At two hundred rooms in a billion codes this never happens; the loop is
    // here so that "draw until unique" cannot become an infinite one the day
    // somebody shrinks the alphabet.
    const { rooms } = registry({ codes: ['H7K2Q9', 'H7K2Q9', 'ABCDEF'] })
    expect(rooms.create()?.code).toBe('H7K2Q9')
    expect(rooms.create()?.code).toBe('ABCDEF')
    expect(rooms.size).toBe(2)
  })

  it('refuses rather than throwing when the machine is full', () => {
    // "This server is full" is a sentence a player has to be told, and an
    // exception is not a sentence.
    const { rooms } = registry({ maxRooms: 2 })
    expect(rooms.create()).not.toBeNull()
    expect(rooms.create()).not.toBeNull()
    expect(rooms.create()).toBeNull()
    expect(rooms.stats()).toMatchObject({ rooms: 2, capacity: 2, created: 2 })
  })
})

describe('a code that names no room', () => {
  it('is null rather than an empty room', () => {
    // The whole of "an unknown room code returns a clean error, not a hang":
    // the registry answers, immediately, with nothing — and `server.ts` turns
    // that into a fault frame and a close code.
    const { rooms } = registry({ codes: ['H7K2Q9'] })
    rooms.create()
    expect(rooms.get('ZZZZZZ')).toBeNull()
    expect(rooms.size).toBe(1)
  })

  it('is null for a string that is not a code at all', () => {
    const { rooms } = registry()
    for (const junk of ['', 'nope', 'H7K2Q', 'H7KUQ9', null, undefined]) {
      expect(rooms.get(junk), String(junk)).toBeNull()
    }
    expect(rooms.stats().missed).toBe(6)
  })
})

describe('rooms do not leak', () => {
  it('reaps a room nobody ever joined', async () => {
    // A code minted and never used is a `GameState` nobody will tick again.
    const { clock, rooms } = registry()
    const opened = rooms.create()
    if (opened === null) throw new Error('no room')

    rooms.sweep(clock.advance(EMPTY_ROOM_TTL_MS - 1))
    expect(rooms.size).toBe(1)

    rooms.sweep(clock.advance(2))
    expect(rooms.size).toBe(0)
    expect(rooms.stats().reaped).toBe(1)
  })

  it('keeps a room while somebody is waiting in it', async () => {
    // The host creates a match, pastes the link, and waits. A reaper that could
    // not tell that apart from an abandoned room would close the match out from
    // under them.
    const { clock, rooms } = registry()
    const opened = rooms.create()
    if (opened === null) throw new Error('no room')
    const pair = join(opened.room)
    await settleLoopback(pair)

    // Twenty times the empty-room grace goes by, and the room stays — because
    // somebody is in it. The peer keeps answering, which is what a real one
    // does: the room pings it five times a second and its frame loop is sending
    // commands. A peer that genuinely went silent is a different rule, and it
    // is the room's idle timeout rather than this reaper.
    for (let sweep = 0; sweep < 40; sweep += 1) {
      clock.advance(EMPTY_ROOM_TTL_MS / 2)
      pair.client.send(JSON.stringify({ t: 'pong', id: 0 }))
      await settleLoopback(pair)
      rooms.sweep(clock.nowMs())
    }
    expect(rooms.size).toBe(1)
  })

  it('reaps a room a while after the last peer leaves', async () => {
    const { clock, rooms } = registry()
    const opened = rooms.create()
    if (opened === null) throw new Error('no room')
    const pair = join(opened.room)
    await settleLoopback(pair)
    rooms.sweep(clock.nowMs())

    pair.client.close()
    await settleLoopback(pair)
    // The first sweep after it empties only *notices*; the clock has to run out
    // before the room goes, which is the grace the connection lifecycle
    // (GLAD-DVDV6P) will want to lengthen rather than invent.
    rooms.sweep(clock.nowMs())
    expect(rooms.size).toBe(1)

    rooms.sweep(clock.advance(EMPTY_ROOM_TTL_MS + 1))
    expect(rooms.size).toBe(0)
  })

  it('closes every room and every peer when the machine goes down', async () => {
    const { rooms } = registry()
    const opened = rooms.create()
    if (opened === null) throw new Error('no room')
    const closes: number[] = []
    const pair = createLoopbackPair()
    pair.client.setHandlers({ onClose: (code) => closes.push(code) })
    opened.room.join(pair.server)
    await settleLoopback(pair)

    rooms.closeAll(CloseReason.GoingAway, 'server shutting down')
    await settleLoopback(pair)

    expect(rooms.size).toBe(0)
    expect(closes).toEqual([CloseReason.GoingAway])
  })
})

describe('driving every room at once', () => {
  it('advances all of them by the same sub-steps', async () => {
    // One timer for the machine, one number for every world on it. Rooms
    // created at different moments still tick in lockstep, which is what makes
    // "the scheduler ran exactly floor(elapsed / 8) sub-steps" a statement
    // about the machine rather than about one room.
    const { rooms } = registry()
    const first = rooms.create()
    if (first === null) throw new Error('no room')
    // A room with nobody in it does not tick — see `room.ts`. Two hundred
    // rooms that players have created and not yet joined would otherwise cost
    // 25,000 sub-steps a second over worlds nobody is in.
    await settleLoopback(join(first.room))
    rooms.advance(2)

    const second = rooms.create()
    if (second === null) throw new Error('no room')
    await settleLoopback(join(second.room))
    rooms.advance(3)

    expect(first.room.tick).toBe(5)
    expect(second.room.tick).toBe(3)
  })

  it('does not tick a room nobody has joined', () => {
    const { rooms } = registry()
    const opened = rooms.create()
    rooms.advance(4)
    expect(opened?.room.tick).toBe(0)
  })

  it('does nothing at all for a frame worth no sub-steps', async () => {
    const { rooms } = registry()
    const opened = rooms.create()
    if (opened === null) throw new Error('no room')
    await settleLoopback(join(opened.room))
    rooms.advance(0)
    expect(opened.room.tick).toBe(0)
  })

  it('counts the peers across every room', async () => {
    const { rooms } = registry()
    const first = rooms.create()
    const second = rooms.create()
    if (first === null || second === null) throw new Error('no rooms')
    const pairs = [join(first.room), join(first.room), join(second.room)]
    for (const pair of pairs) await settleLoopback(pair)

    expect(rooms.stats()).toMatchObject({ rooms: 2, peers: 3 })
    expect([...rooms.codes()].sort()).toEqual([first.code, second.code].sort())
  })
})

/**
 * One room's bad day is one room's. GLAD-V7M6PQ.
 *
 * Every world on the machine is advanced by one call from one timer, so an
 * exception out of any room's sub-step would unwind through the scheduler's
 * frame and leave every *other* room silently un-ticked. The room here throws on
 * purpose — nothing in the shipping code is supposed to, which is exactly why
 * the containment has to be asserted rather than assumed.
 */
describe('a room that throws', () => {
  /** A registry seeded with one room that throws and one that does not. */
  function withAFaultyRoom() {
    const clock = manualClock()
    let at = 0
    const built = new Map<string, Room>()
    const rooms = createRoomRegistry({
      clock,
      random: () => {
        at += 1
        return at - 1
      },
      log: () => undefined,
      create: (code) => {
        const room = createRoom({
          map: SERVER_MAP,
          plan: SERVER_PLAN,
          clock,
          build: 'registry',
          id: code,
          peerId: (index) => `${code}-${index}`,
        })
        built.set(code, room)
        // The first room minted is the one that detonates. `advance` is the hot
        // path a frame takes and `sweep` is the housekeeping one; both are
        // reached from the same timer, so both are covered.
        if (built.size === 1) {
          return {
            ...room,
            advance: () => {
              throw new Error('a hostile frame got somewhere it should not have')
            },
          }
        }
        return room
      },
    })
    return { clock, rooms }
  }

  it('is closed and counted, and the other rooms keep ticking', async () => {
    const { rooms } = withAFaultyRoom()
    const faulty = rooms.create()
    const healthy = rooms.create()
    if (faulty === null || healthy === null) throw new Error('no rooms')
    await settleLoopback(join(faulty.room))
    await settleLoopback(join(healthy.room))

    rooms.advance(4)

    // The healthy room advanced by exactly the sub-steps it was handed, which
    // is the whole claim: a client that can make one world throw cannot stop
    // anybody else's duel.
    expect(healthy.room.tick).toBe(4)
    expect(rooms.get(faulty.code)).toBeNull()
    expect(rooms.stats()).toMatchObject({ rooms: 1, faulted: 1 })
  })

  it('is dropped rather than left to throw again on the next frame', async () => {
    const { rooms } = withAFaultyRoom()
    const faulty = rooms.create()
    const healthy = rooms.create()
    if (faulty === null || healthy === null) throw new Error('no rooms')
    await settleLoopback(join(faulty.room))
    await settleLoopback(join(healthy.room))

    rooms.advance(1)
    rooms.advance(1)
    rooms.advance(1)

    // Counted once, not once per frame: whatever put the world in that state is
    // still in its `GameState`, so the next frame would throw forever.
    expect(rooms.stats().faulted).toBe(1)
    expect(healthy.room.tick).toBe(3)
  })
})
