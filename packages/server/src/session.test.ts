import {
  NULL_CMD,
  PROTOCOL_VERSION,
  SPAWN_STATE,
  encodeCmd,
  hashPlayerState,
  pmove,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  CLOSE_BAD_FRAME,
  CLOSE_NO_HELLO,
  CLOSE_VERSION_MISMATCH,
  applyFrame,
  createSession,
} from './session.ts'

const BUILD = '9f3c1d2'

function greeted() {
  const step = applyFrame(
    createSession('s1'),
    JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, build: 'client' }),
    BUILD,
  )
  return step.session
}

describe('session handshake', () => {
  it('welcomes a client on the same protocol', () => {
    const step = applyFrame(
      createSession('s1'),
      JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION, build: 'client' }),
      BUILD,
    )
    expect(step.replies).toEqual([
      { t: 'welcome', protocol: PROTOCOL_VERSION, build: BUILD, session: 's1' },
    ])
    expect(step.close).toBeUndefined()
    expect(step.session.greeted).toBe(true)
  })

  it('tells a client on the wrong protocol which build to expect, then closes', () => {
    // The failure mode this replaces is a socket that closes with no frame at
    // all, which is indistinguishable from the server being down.
    const step = applyFrame(
      createSession('s1'),
      JSON.stringify({ t: 'hello', protocol: PROTOCOL_VERSION + 1, build: 'stale' }),
      BUILD,
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

  it('refuses commands before a hello', () => {
    const step = applyFrame(
      createSession('s1'),
      JSON.stringify({ t: 'cmds', startTick: 1, cmds: [encodeCmd(NULL_CMD)] }),
      BUILD,
    )
    expect(step.close?.code).toBe(CLOSE_NO_HELLO)
  })

  it('closes on a frame it cannot parse, rather than guessing', () => {
    for (const junk of ['', 'not json', '{"t":"nope"}', '[]']) {
      const step = applyFrame(greeted(), junk, BUILD)
      expect(step.close?.code).toBe(CLOSE_BAD_FRAME)
      expect(step.replies[0]).toMatchObject({ t: 'fault', code: 'bad-frame' })
    }
  })
})

describe('session simulation', () => {
  it('replies with the hash at the last tick of the batch', () => {
    const cmds = [encodeCmd({ ...NULL_CMD, forwardMove: 1 }), encodeCmd(NULL_CMD)]
    const step = applyFrame(greeted(), JSON.stringify({ t: 'cmds', startTick: 1, cmds }), BUILD)

    const expected = pmove(pmove(SPAWN_STATE, { ...NULL_CMD, forwardMove: 1 }), NULL_CMD)
    expect(step.replies).toEqual([{ t: 'hash', tick: 2, hash: hashPlayerState(2, expected) }])
    expect(step.session.tick).toBe(2)

    // And the state really did advance, rather than the hash being of nothing.
    expect(step.session.state.origin[0]).toBeGreaterThan(0)
  })

  it('counts a gap instead of silently renumbering it', () => {
    // Renumbering here would paper over exactly the disagreement this ticket
    // exists to expose.
    const first = applyFrame(
      greeted(),
      JSON.stringify({ t: 'cmds', startTick: 1, cmds: [encodeCmd(NULL_CMD)] }),
      BUILD,
    )
    const second = applyFrame(
      first.session,
      JSON.stringify({ t: 'cmds', startTick: 99, cmds: [encodeCmd(NULL_CMD)] }),
      BUILD,
    )
    expect(second.session.gaps).toBe(1)
    expect(second.session.tick).toBe(2)
  })

  it('sanitises a hostile command instead of poisoning the hash', () => {
    const step = applyFrame(
      greeted(),
      JSON.stringify({ t: 'cmds', startTick: 1, cmds: [[1e308, 'x', null, {}, -5]] }),
      BUILD,
    )
    const hash = step.replies[0]
    expect(hash).toMatchObject({ t: 'hash', tick: 1 })
    for (const value of [...step.session.state.origin, ...step.session.state.velocity]) {
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
    const a = applyFrame(greeted(), frame, BUILD)
    const b = applyFrame(greeted(), frame, BUILD)
    expect(a.replies).toEqual(b.replies)
  })
})
