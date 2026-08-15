import { NULL_CMD, PROTOCOL_VERSION, encodeCmd } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { COMMAND_BURST, MAX_BUFFERED_COMMANDS, createInputQueue } from './inputQueue.ts'
import {
  CLOSE_BAD_FRAME,
  CLOSE_MAP_MISMATCH,
  CLOSE_NO_HELLO,
  CLOSE_VERSION_MISMATCH,
  applyFrame,
  createSession,
} from './session.ts'

const BUILD = '9f3c1d2'

/** Which commit, which world, which match. A fake map hash: this is a unit test
 *  of the state machine, and it never has to load a map to run one. */
const MAP_HASH = 'a1b2c3d4'
const ROOM = 'H7K2Q9'
const IDENTITY = { build: BUILD, mapHash: MAP_HASH, room: ROOM }

function hello(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    build: 'client',
    mapHash: MAP_HASH,
    ...over,
  })
}

function cmdsFrame(startTick: number, count: number, cmd = NULL_CMD) {
  return JSON.stringify({
    t: 'cmds',
    startTick,
    cmds: Array.from({ length: count }, () => encodeCmd(cmd)),
  })
}

/**
 * A session with a buffer of its own.
 *
 * The buffer is handed in rather than made by the caller of `applyFrame`,
 * because a room owns one per peer and drains it from the other side
 * (`room.ts`). Everything here is about the *door*: what a session admits, what
 * it refuses, and what it counts.
 */
function fresh() {
  return createSession('s1', 0, createInputQueue())
}

function greeted() {
  return applyFrame(fresh(), hello(), IDENTITY, 0).session
}

describe('session handshake', () => {
  it('welcomes a client on the same protocol, and names the room', () => {
    const step = applyFrame(fresh(), hello(), IDENTITY, 0)
    expect(step.replies).toEqual([
      {
        t: 'welcome',
        protocol: PROTOCOL_VERSION,
        build: BUILD,
        session: 's1',
        mapHash: MAP_HASH,
        room: ROOM,
      },
    ])
    expect(step.close).toBeUndefined()
    expect(step.session.greeted).toBe(true)
  })

  it('tells a client on the wrong protocol which build to expect, then closes', () => {
    // The failure mode this replaces is a socket that closes with no frame at
    // all, which is indistinguishable from the server being down.
    const step = applyFrame(fresh(), hello({ protocol: PROTOCOL_VERSION + 1, build: 'stale' }), IDENTITY, 0)
    expect(step.replies).toEqual([
      {
        t: 'version_mismatch',
        serverProtocol: PROTOCOL_VERSION,
        clientProtocol: PROTOCOL_VERSION + 1,
        serverBuild: BUILD,
      },
    ])
    expect(step.close).toEqual({ code: CLOSE_VERSION_MISMATCH, reason: 'protocol version' })
  })

  it('refuses a client holding a different map, and says which two', () => {
    // The scenario: Vercel has deployed and Fly has not (or the reverse). The
    // protocol matches, the build string does not have to, and the two would
    // simulate different worlds from identical inputs.
    const step = applyFrame(fresh(), hello({ mapHash: 'deadbeef' }), IDENTITY, 0)
    expect(step.replies).toEqual([
      { t: 'map_mismatch', serverMapHash: MAP_HASH, clientMapHash: 'deadbeef' },
    ])
    expect(step.close).toEqual({ code: CLOSE_MAP_MISMATCH, reason: 'map mismatch' })
    expect(step.session.greeted).toBe(false)
    expect(step.session.rejected).toBe(true)
  })

  it('does not adopt the map the client claims', () => {
    // A server that played whichever arena it was told about is a server that
    // can be told where the walls are.
    const step = applyFrame(fresh(), hello({ mapHash: 'deadbeef' }), IDENTITY, 0)
    const after = applyFrame(step.session, cmdsFrame(1, 1), IDENTITY, 0)
    expect(after.close?.code).toBe(CLOSE_NO_HELLO)
  })

  it('rejects a hello with no map hash at all rather than assuming ours', () => {
    const step = applyFrame(
      fresh(),
      JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, build: 'client' }),
      IDENTITY,
      0,
    )
    expect(step.close?.code).toBe(CLOSE_BAD_FRAME)
  })

  it('refuses commands before a hello', () => {
    const step = applyFrame(fresh(), cmdsFrame(1, 1), IDENTITY, 0)
    expect(step.close?.code).toBe(CLOSE_NO_HELLO)
  })

  it('closes on a frame it cannot parse, rather than guessing', () => {
    for (const junk of ['', 'not json', '{"t":"nope"}', '[]']) {
      const step = applyFrame(greeted(), junk, IDENTITY, 0)
      expect(step.close?.code).toBe(CLOSE_BAD_FRAME)
      expect(step.replies[0]).toMatchObject({ t: 'fault', code: 'bad-frame' })
    }
  })
})

describe('commands are admitted, not executed', () => {
  it('answers a batch with nothing at all', () => {
    // The acknowledgement a client needs is a statement about the world at the
    // tick the *scheduler* reached, so it goes out once per host frame from
    // `room.ts`. A reply per batch would be a second, faster clock in the same
    // conversation.
    const step = applyFrame(greeted(), cmdsFrame(1, 2), IDENTITY, 0)
    expect(step.replies).toEqual([])
    expect(step.close).toBeUndefined()
  })

  it('puts every command in the batch into the buffer, in tick order', () => {
    const session = greeted()
    const step = applyFrame(session, cmdsFrame(1, 3), IDENTITY, 0)

    expect(step.session.commands).toBe(3)
    expect(step.session.accepted).toBe(3)
    expect(step.session.refused).toBe(0)
    expect(step.session.lastOfferedTick).toBe(3)
    expect(session.queue.depth).toBe(3)
    expect(session.queue.take().cmd).toEqual(NULL_CMD)
  })

  it('counts what the buffer turned away without closing the session', () => {
    // A client that runs away is a client to slow down, not one to disconnect:
    // the buffer refuses the excess at the door and the player moves at exactly
    // the speed everyone else does. `inputQueue.ts`.
    const session = greeted()
    const flood = MAX_BUFFERED_COMMANDS + COMMAND_BURST + 8
    const step = applyFrame(session, cmdsFrame(1, flood), IDENTITY, 0)

    expect(step.close).toBeUndefined()
    expect(step.session.commands).toBe(flood)
    expect(step.session.accepted).toBe(MAX_BUFFERED_COMMANDS)
    expect(step.session.refused).toBe(flood - MAX_BUFFERED_COMMANDS)
  })

  it('counts a gap instead of silently renumbering it', () => {
    // Renumbering here would paper over exactly the disagreement this exists to
    // expose. What an individual command out of order costs is the buffer's
    // business and is answered there.
    const first = applyFrame(greeted(), cmdsFrame(1, 1), IDENTITY, 0)
    const second = applyFrame(first.session, cmdsFrame(99, 1), IDENTITY, 0)
    expect(second.session.gaps).toBe(1)
    expect(second.session.lastOfferedTick).toBe(99)
  })

  it('does not count a batch that follows on as a gap', () => {
    const first = applyFrame(greeted(), cmdsFrame(1, 4), IDENTITY, 0)
    const second = applyFrame(first.session, cmdsFrame(5, 4), IDENTITY, 0)
    expect(second.session.gaps).toBe(0)
    expect(second.session.accepted).toBe(8)
  })

  it('sanitises a hostile command instead of buffering a NaN', () => {
    // A tick is a total function, so the door is the only place a bad value can
    // be turned away.
    const session = greeted()
    applyFrame(session, JSON.stringify({ t: 'cmds', startTick: 1, cmds: [[1e308, 'x', null, {}, -5]] }), IDENTITY, 0)
    const taken = session.queue.take().cmd
    if (taken === null) throw new Error('the buffer took nothing')
    for (const value of [taken.forwardMove, taken.sideMove, taken.yaw, taken.pitch, taken.buttons]) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('charges the rate limit against the clock it is handed', () => {
    // The limit is commands per *wall-clock second* on the server's clock —
    // the only unit in which "too fast" means anything. A session with no clock
    // of its own is what makes that testable without waiting a second.
    const early = applyFrame(greeted(), cmdsFrame(1, COMMAND_BURST + 8), IDENTITY, 0)
    expect(early.session.refused).toBeGreaterThan(0)

    const relaxed = applyFrame(greeted(), cmdsFrame(1, COMMAND_BURST), IDENTITY, 0)
    expect(relaxed.session.refused).toBe(0)
  })
})
