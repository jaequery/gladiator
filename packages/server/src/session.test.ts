import {
  NULL_CMD,
  PROTOCOL_VERSION,
  SKELETON_ARENA,
  type GameState,
  createSkeletonState,
  encodeCmd,
  findPlayer,
  hashState,
  tick as simTick,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  CLOSE_BAD_FRAME,
  CLOSE_MAP_MISMATCH,
  CLOSE_NO_HELLO,
  CLOSE_VERSION_MISMATCH,
  applyFrame,
  createSession,
} from './session.ts'

const BUILD = '9f3c1d2'

/** Which commit and which world. A fake map hash: this is a unit test of the
 *  state machine, and it never has to load a map to run one. */
const MAP_HASH = 'a1b2c3d4'
const IDENTITY = { build: BUILD, mapHash: MAP_HASH }

function hello(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    build: 'client',
    mapHash: MAP_HASH,
    ...over,
  })
}

/** The one player a session's world holds. */
function playerOf(state: GameState) {
  const player = findPlayer(state, 0)
  if (player === null) throw new Error('a session with no player in slot 0')
  return player
}

function greeted() {
  return applyFrame(createSession('s1'), hello(), IDENTITY).session
}

describe('session handshake', () => {
  it('welcomes a client on the same protocol', () => {
    const step = applyFrame(
      createSession('s1'),
      hello(),
      IDENTITY,
    )
    expect(step.replies).toEqual([
      { t: 'welcome', protocol: PROTOCOL_VERSION, build: BUILD, session: 's1', mapHash: MAP_HASH },
    ])
    expect(step.close).toBeUndefined()
    expect(step.session.greeted).toBe(true)
  })

  it('tells a client on the wrong protocol which build to expect, then closes', () => {
    // The failure mode this replaces is a socket that closes with no frame at
    // all, which is indistinguishable from the server being down.
    const step = applyFrame(
      createSession('s1'),
      hello({ protocol: PROTOCOL_VERSION + 1, build: 'stale' }),
      IDENTITY,
    )
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
    const step = applyFrame(createSession('s1'), hello({ mapHash: 'deadbeef' }), IDENTITY)
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
    const step = applyFrame(createSession('s1'), hello({ mapHash: 'deadbeef' }), IDENTITY)
    const after = applyFrame(
      step.session,
      JSON.stringify({ t: 'cmds', startTick: 1, cmds: [encodeCmd(NULL_CMD)] }),
      IDENTITY,
    )
    expect(after.close?.code).toBe(CLOSE_NO_HELLO)
  })

  it('rejects a hello with no map hash at all rather than assuming ours', () => {
    const step = applyFrame(
      createSession('s1'),
      JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, build: 'client' }),
      IDENTITY,
    )
    expect(step.close?.code).toBe(CLOSE_BAD_FRAME)
  })

  it('refuses commands before a hello', () => {
    const step = applyFrame(
      createSession('s1'),
      JSON.stringify({ t: 'cmds', startTick: 1, cmds: [encodeCmd(NULL_CMD)] }),
      IDENTITY,
    )
    expect(step.close?.code).toBe(CLOSE_NO_HELLO)
  })

  it('closes on a frame it cannot parse, rather than guessing', () => {
    for (const junk of ['', 'not json', '{"t":"nope"}', '[]']) {
      const step = applyFrame(greeted(), junk, IDENTITY)
      expect(step.close?.code).toBe(CLOSE_BAD_FRAME)
      expect(step.replies[0]).toMatchObject({ t: 'fault', code: 'bad-frame' })
    }
  })
})

describe('session simulation', () => {
  it('replies with the hash at the last tick of the batch', () => {
    const cmds = [encodeCmd({ ...NULL_CMD, forwardMove: 1 }), encodeCmd(NULL_CMD)]
    const step = applyFrame(greeted(), JSON.stringify({ t: 'cmds', startTick: 1, cmds }), IDENTITY)

    const expected = createSkeletonState()
    simTick(expected, [{ ...NULL_CMD, forwardMove: 1 }], SKELETON_ARENA)
    simTick(expected, [NULL_CMD], SKELETON_ARENA)
    expect(step.replies).toEqual([{ t: 'hash', tick: 2, hash: hashState(expected) }])
    expect(step.session.tick).toBe(2)

    // And the state really did advance, rather than the hash being of nothing.
    expect(playerOf(step.session.state).origin[0]).toBeGreaterThan(0)
  })

  it('counts a gap instead of silently renumbering it', () => {
    // Renumbering here would paper over exactly the disagreement this ticket
    // exists to expose.
    const first = applyFrame(
      greeted(),
      JSON.stringify({ t: 'cmds', startTick: 1, cmds: [encodeCmd(NULL_CMD)] }),
      IDENTITY,
    )
    const second = applyFrame(
      first.session,
      JSON.stringify({ t: 'cmds', startTick: 99, cmds: [encodeCmd(NULL_CMD)] }),
      IDENTITY,
    )
    expect(second.session.gaps).toBe(1)
    expect(second.session.tick).toBe(2)
  })

  it('sanitises a hostile command instead of poisoning the hash', () => {
    const step = applyFrame(
      greeted(),
      JSON.stringify({ t: 'cmds', startTick: 1, cmds: [[1e308, 'x', null, {}, -5]] }),
      IDENTITY,
    )
    const hash = step.replies[0]
    expect(hash).toMatchObject({ t: 'hash', tick: 1 })
    const player = playerOf(step.session.state)
    for (const value of [...player.origin, ...player.velocity]) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })

  it('is deterministic: the same batch twice gives the same hash', () => {
    const frame = JSON.stringify({
      t: 'cmds',
      startTick: 1,
      cmds: Array.from({ length: 50 }, (_, i) =>
        encodeCmd({ ...NULL_CMD, forwardMove: 1, yaw: i * 91, buttons: i % 7 === 0 ? 1 : 0 }),
      ),
    })
    const a = applyFrame(greeted(), frame, IDENTITY)
    const b = applyFrame(greeted(), frame, IDENTITY)
    expect(a.replies).toEqual(b.replies)
  })
})
