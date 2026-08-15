import { describe, expect, it } from 'vitest'

import {
  MAX_CMDS_PER_BATCH,
  PROTOCOL_VERSION,
  decodeCmd,
  describeMapMismatch,
  describeVersionMismatch,
  encodeCmd,
  parseClientMessage,
  parseServerMessage,
} from './protocol.ts'
import { NULL_CMD, type UserCmd } from './usercmd.ts'

describe('wire commands', () => {
  it('round-trips a command exactly', () => {
    const cmd: UserCmd = {
      forwardMove: 1,
      sideMove: -1,
      yaw: 40000,
      pitch: -1234,
      buttons: 1,
      weapon: 1,
    }
    expect(decodeCmd(encodeCmd(cmd))).toEqual(cmd)
  })

  it('survives JSON, which is the round-trip that actually happens', () => {
    const cmd: UserCmd = {
      forwardMove: -1,
      sideMove: 1,
      yaw: 65535,
      pitch: 16202,
      buttons: 0,
      weapon: 0,
    }
    const overTheWire = JSON.parse(JSON.stringify(encodeCmd(cmd))) as unknown
    expect(decodeCmd(overTheWire)).toEqual(cmd)
  })

  it('turns a malformed tuple into a standing-still command', () => {
    for (const junk of [null, 'x', [], [1, 2, 3], [1, 2, 3, 4, 5], [1, 2, 3, 4, 5, 6, 7]]) {
      expect(decodeCmd(junk)).toEqual(NULL_CMD)
    }
  })
})

describe('parseClientMessage', () => {
  it('parses a hello', () => {
    const raw = JSON.stringify({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      build: 'abc123',
      mapHash: 'a1b2c3d4',
    })
    expect(parseClientMessage(raw)).toEqual({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      build: 'abc123',
      mapHash: 'a1b2c3d4',
    })
  })

  it('refuses a hello whose map hash is missing or not eight hex digits', () => {
    // Not defaulting to the server's own map is the point: a client that did
    // not say which arena it holds has not agreed to anything.
    for (const mapHash of [undefined, '', 'A1B2C3D4', 'a1b2c3d', 'a1b2c3d4e', 'zzzzzzzz', 1234]) {
      const raw = JSON.stringify({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        build: 'abc123',
        ...(mapHash === undefined ? {} : { mapHash }),
      })
      expect(parseClientMessage(raw), `accepted ${String(mapHash)}`).toBe(null)
    }
  })

  it('parses a command batch', () => {
    const raw = JSON.stringify({ t: 'cmds', startTick: 7, cmds: [[1, 0, 100, 0, 1, 1]] })
    expect(parseClientMessage(raw)).toEqual({
      t: 'cmds',
      startTick: 7,
      cmds: [[1, 0, 100, 0, 1, 1]],
    })
  })

  it('refuses a batch bigger than the cap, an empty one, or a negative tick', () => {
    const oversized = new Array(MAX_CMDS_PER_BATCH + 1).fill([0, 0, 0, 0, 0, 0])
    expect(parseClientMessage(JSON.stringify({ t: 'cmds', startTick: 0, cmds: oversized }))).toBe(
      null,
    )
    expect(parseClientMessage(JSON.stringify({ t: 'cmds', startTick: 0, cmds: [] }))).toBe(null)
    expect(parseClientMessage(JSON.stringify({ t: 'cmds', startTick: -1, cmds: [[0, 0, 0, 0, 0]] })))
      .toBe(null)
  })

  it('refuses anything that is not a frame', () => {
    for (const raw of ['', 'not json', '[]', 'null', '4', '{"t":"unknown"}', '{"t":"hello"}']) {
      expect(parseClientMessage(raw)).toBe(null)
    }
  })
})

describe('parseServerMessage', () => {
  it('parses every server frame', () => {
    expect(
      parseServerMessage(
        JSON.stringify({ t: 'welcome', protocol: 1, build: 'b', session: 's', mapHash: '0000beef' }),
      ),
    ).toEqual({ t: 'welcome', protocol: 1, build: 'b', session: 's', mapHash: '0000beef' })
    expect(
      parseServerMessage(
        JSON.stringify({
          t: 'map_mismatch',
          serverMapHash: '0000beef',
          clientMapHash: 'deadbeef',
        }),
      ),
    ).toEqual({ t: 'map_mismatch', serverMapHash: '0000beef', clientMapHash: 'deadbeef' })
    expect(parseServerMessage(JSON.stringify({ t: 'hash', tick: 3, hash: 42 }))).toEqual({
      t: 'hash',
      tick: 3,
      hash: 42,
    })
    expect(
      parseServerMessage(
        JSON.stringify({
          t: 'version_mismatch',
          serverProtocol: 2,
          clientProtocol: 1,
          serverBuild: 'deadbee',
        }),
      ),
    ).toEqual({
      t: 'version_mismatch',
      serverProtocol: 2,
      clientProtocol: 1,
      serverBuild: 'deadbee',
    })
    expect(parseServerMessage(JSON.stringify({ t: 'fault', code: 'x', detail: 'y' }))).toEqual({
      t: 'fault',
      code: 'x',
      detail: 'y',
    })
  })

  it('refuses junk', () => {
    for (const raw of ['', '{}', '{"t":"hash"}', '{"t":"hash","tick":1.5,"hash":2}']) {
      expect(parseServerMessage(raw)).toBe(null)
    }
  })
})

describe('describeMapMismatch', () => {
  it('names both arenas and tells the player what to do', () => {
    const text = describeMapMismatch({
      t: 'map_mismatch',
      serverMapHash: '0000beef',
      clientMapHash: 'deadbeef',
    })
    expect(text).toContain('deadbeef')
    expect(text).toContain('0000beef')
    expect(text).toContain('reload')
  })
})

describe('describeVersionMismatch', () => {
  it('names the build and tells the player what to do', () => {
    const text = describeVersionMismatch({
      t: 'version_mismatch',
      serverProtocol: 2,
      clientProtocol: 1,
      serverBuild: '9f3c1d2',
    })
    // The acceptance criterion is a *readable* message, not a silent close.
    expect(text).toContain('server is on build 9f3c1d2')
    expect(text).toContain('reload')
    expect(text).toContain('protocol 2')
  })
})
