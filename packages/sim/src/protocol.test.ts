import { describe, expect, it } from 'vitest'

import {
  LifecycleEvent,
  MAX_CMDS_PER_BATCH,
  PROTOCOL_VERSION,
  UNKNOWN_RTT,
  decodeCmd,
  describeMapMismatch,
  describeVersionMismatch,
  encodeCmd,
  parseClientMessage,
  parseServerMessage,
} from './protocol.ts'
import { applyWireState } from './netstate.ts'
import { snapshotFrame } from './snapshot.ts'
import { EntityKind, createGameState, hashState, spawnEntity } from './state.ts'
import { NULL_CMD, type UserCmd } from './usercmd.ts'
import { Weapon } from './weapon.ts'

describe('wire commands', () => {
  it('round-trips a command exactly', () => {
    const cmd: UserCmd = {
      forwardMove: 1,
      sideMove: -1,
      yaw: 40000,
      pitch: -1234,
      buttons: 1,
      weapon: Weapon.Railgun,
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
      weapon: Weapon.RocketLauncher,
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
    const raw = JSON.stringify({ t: 'cmds', startTick: 7, cmds: [[1, 0, 100, 0, 1, 2]] })
    expect(parseClientMessage(raw)).toEqual({
      t: 'cmds',
      startTick: 7,
      cmds: [[1, 0, 100, 0, 1, 2]],
    })
  })

  it('refuses a batch bigger than the cap, an empty one, or a negative tick', () => {
    const oversized = new Array(MAX_CMDS_PER_BATCH + 1).fill([0, 0, 0, 0, 0, 1])
    expect(parseClientMessage(JSON.stringify({ t: 'cmds', startTick: 0, cmds: oversized }))).toBe(
      null,
    )
    expect(parseClientMessage(JSON.stringify({ t: 'cmds', startTick: 0, cmds: [] }))).toBe(null)
    expect(parseClientMessage(JSON.stringify({ t: 'cmds', startTick: -1, cmds: [[0, 0, 0, 0, 0]] })))
      .toBe(null)
  })

  it('parses a pong, and it carries nothing but the id', () => {
    expect(parseClientMessage(JSON.stringify({ t: 'pong', id: 12 }))).toEqual({ t: 'pong', id: 12 })
    // A timestamp the client filled in would be a round trip the client could
    // choose. Anything extra is dropped rather than carried through.
    expect(parseClientMessage(JSON.stringify({ t: 'pong', id: 12, receivedAtMs: 5 }))).toEqual({
      t: 'pong',
      id: 12,
    })
  })

  it('refuses a pong with an id no ping could have carried', () => {
    for (const id of [undefined, -1, 1.5, 'x', null]) {
      const raw = JSON.stringify({ t: 'pong', ...(id === undefined ? {} : { id }) })
      expect(parseClientMessage(raw), `accepted ${String(id)}`).toBe(null)
    }
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
        JSON.stringify({
          t: 'welcome',
          protocol: 1,
          build: 'b',
          session: 's',
          mapHash: '0000beef',
          room: 'H7K2Q9',
          token: 'deadbeefdeadbeefdeadbeefdeadbeef',
        }),
      ),
    ).toEqual({
      t: 'welcome',
      protocol: 1,
      build: 'b',
      session: 's',
      mapHash: '0000beef',
      room: 'H7K2Q9',
      token: 'deadbeefdeadbeefdeadbeefdeadbeef',
    })
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

  it('parses a lifecycle frame, with its countdown', () => {
    expect(
      parseServerMessage(
        JSON.stringify({
          t: 'life',
          event: 'opponent-left',
          graceMs: 30_000,
          detail: 'they forfeit in 30s',
        }),
      ),
    ).toEqual({
      t: 'life',
      event: 'opponent-left',
      graceMs: 30_000,
      detail: 'they forfeit in 30s',
    })
    for (const event of Object.values(LifecycleEvent)) {
      const raw = JSON.stringify({ t: 'life', event, graceMs: 0, detail: '' })
      expect(parseServerMessage(raw), `refused ${event}`).not.toBeNull()
    }
  })

  it('refuses a lifecycle frame nobody could act on', () => {
    for (const patch of [
      // An event this build has no handler for. Refused at the door rather than
      // arriving as a string that falls through every branch.
      { event: 'opponent-sneezed' },
      { event: 5 },
      // A countdown that has run backwards would be shown counting *up* towards
      // a forfeit that had already happened.
      { graceMs: -1 },
      { graceMs: 1.5 },
      { detail: 7 },
    ]) {
      const raw = JSON.stringify({
        t: 'life',
        event: 'opponent-left',
        graceMs: 1000,
        detail: 'x',
        ...patch,
      })
      expect(parseServerMessage(raw), `accepted ${JSON.stringify(patch)}`).toBe(null)
    }
  })

  it('refuses a welcome with no seat key in it', () => {
    // A client that stored an empty token would send it back and be refused as
    // a stranger — a failure worth having at the door rather than a minute
    // later, at the reconnect (`server/lifecycle.ts`).
    const welcome = {
      t: 'welcome',
      protocol: 1,
      build: 'b',
      session: 's',
      mapHash: '0000beef',
      room: 'H7K2Q9',
      token: 'deadbeefdeadbeefdeadbeefdeadbeef',
    }
    expect(parseServerMessage(JSON.stringify({ ...welcome, token: '' }))).toBe(null)
    const without: Record<string, unknown> = { ...welcome }
    delete without['token']
    expect(parseServerMessage(JSON.stringify(without))).toBe(null)
  })

  it('parses a ping, including the one before any round trip has completed', () => {
    expect(
      parseServerMessage(JSON.stringify({ t: 'ping', id: 3, tick: 900, rttMs: 42, queued: 2 })),
    ).toEqual({ t: 'ping', id: 3, tick: 900, rttMs: 42, queued: 2 })
    expect(
      parseServerMessage(
        JSON.stringify({ t: 'ping', id: 0, tick: 0, rttMs: UNKNOWN_RTT, queued: 0 }),
      ),
    ).toEqual({ t: 'ping', id: 0, tick: 0, rttMs: UNKNOWN_RTT, queued: 0 })
  })

  it('refuses a ping whose numbers could not have come from a clock', () => {
    // A round trip below `UNKNOWN_RTT` is a clock that ran backwards, and a
    // client that folded one into its estimate would place the server in its
    // own future.
    for (const patch of [
      { rttMs: -2 },
      { rttMs: 1.5 },
      { tick: -1 },
      { queued: -1 },
      { id: -1 },
      { id: 'x' },
    ]) {
      const raw = JSON.stringify({ t: 'ping', id: 1, tick: 5, rttMs: 20, queued: 1, ...patch })
      expect(parseServerMessage(raw), `accepted ${JSON.stringify(patch)}`).toBe(null)
    }
  })

  it('parses a snapshot, and survives the JSON round trip bit for bit', () => {
    const world = createGameState(0x5eed)
    spawnEntity(world, {
      kind: EntityKind.Player,
      slot: 0,
      // Deliberately not round numbers: the claim being made about JSON is that
      // a double survives it exactly, and a wire full of integers would not test
      // it. `Number::toString` is specified as the shortest round-tripping
      // representation, which is why this holds.
      origin: [-383.6256, 12.5, 0.125],
      velocity: [320 / 3, -0.1, 0],
      health: 100,
    })
    const frame = JSON.stringify(snapshotFrame(world, 41))
    const parsed = parseServerMessage(frame)
    if (parsed?.t !== 'snap') throw new Error('a snapshot did not parse as one')

    expect(parsed.ack).toBe(41)
    const rebuilt = createGameState(0)
    expect(applyWireState(rebuilt, parsed.state)).toBe(true)
    expect(hashState(rebuilt)).toBe(hashState(world))
  })

  it('refuses a snapshot whose state is not one', () => {
    const good = snapshotFrame(createGameState(1), 0)
    for (const patch of [
      { ack: -1 },
      { ack: 1.5 },
      { state: 'nope' },
      { state: [] },
      { state: [...good.state, 0] },
      { state: good.state.map(() => Number.NaN) },
    ]) {
      const raw = JSON.stringify({ ...good, ...patch })
      expect(parseServerMessage(raw), `accepted ${JSON.stringify(patch).slice(0, 40)}`).toBe(null)
    }
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
