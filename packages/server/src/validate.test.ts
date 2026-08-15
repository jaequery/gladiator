/**
 * The frame door, and the command clamps behind it.
 *
 * Two halves of one claim: nothing a client sends is trusted. The first half is
 * how *much* it may send (`validate.ts`), the second is what the numbers inside
 * it are allowed to be (`sanitizeUserCmd`, reached through `decodeCmd`). Both
 * are asserted here rather than only over a socket, because the interesting
 * inputs are the ones nobody can produce with a browser.
 */
import {
  ANGLE_UNITS,
  ANGLE_UNITS_PER_DEGREE,
  BUTTON_ATTACK,
  BUTTON_JUMP,
  MAX_CMDS_PER_BATCH,
  MAX_MOVE,
  MAX_PITCH_UNITS,
  MAX_TICK,
  PROTOCOL_VERSION,
  Weapon,
  parseClientMessage,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { createInputQueue } from './inputQueue.ts'
import { applyFrame, createSession, type ServerIdentity } from './session.ts'
import {
  BYTE_BUDGET_PER_SECOND,
  CLOSE_FLOODING,
  FRAME_BUDGET_PER_SECOND,
  FRAME_BURST,
  FrameFate,
  MAX_FRAME_BYTES,
  MAX_REFUSED_FRAMES,
  createFrameGuard,
} from './validate.ts'

const PONG = JSON.stringify({ t: 'pong', id: 1 })

describe('the frame size cap', () => {
  it('is big enough for the largest legal batch and not much bigger', () => {
    // The number is arithmetic rather than a round figure, so the arithmetic is
    // the test: a full batch of the widest commands the protocol admits has to
    // fit, with headroom for a field the protocol has not grown yet.
    const widest = JSON.stringify({
      t: 'cmds',
      startTick: MAX_TICK - MAX_CMDS_PER_BATCH,
      cmds: Array.from({ length: MAX_CMDS_PER_BATCH }, () => [-1, -1, 65535, -16202, 65535, 1]),
    })
    expect(widest.length).toBe(7468)
    // Over twice the widest legal frame, which is headroom for a protocol that
    // grows a field — and under three times it, which is what stops the cap
    // quietly becoming a number nobody could justify.
    expect(MAX_FRAME_BYTES).toBeGreaterThan(widest.length * 2)
    expect(MAX_FRAME_BYTES).toBeLessThan(widest.length * 3)
  })

  it('refuses an oversized frame and closes on it', () => {
    const guard = createFrameGuard()
    const verdict = guard.admit('x'.repeat(MAX_FRAME_BYTES + 1), 0)
    expect(verdict.fate).toBe(FrameFate.Oversize)
    expect(verdict.text).toBeNull()
    expect(verdict.fault?.code).toBe('oversize')
    expect(verdict.close).not.toBeNull()
  })

  it('lets a frame exactly at the cap through', () => {
    const guard = createFrameGuard()
    expect(guard.admit('x'.repeat(MAX_FRAME_BYTES), 0).fate).toBe(FrameFate.Accept)
  })
})

describe('the per-connection frame rate', () => {
  it('is set by the fastest honest client, not by a round number', () => {
    // A client flushes its outbox once per rendered frame and clock sync adds
    // five pongs a second, so a 240 Hz display is 245 frames a second. The
    // budget has to be over that or the limit is a bug on a good monitor.
    expect(FRAME_BUDGET_PER_SECOND).toBeGreaterThan(240 + 5)
  })

  it('admits a 240 Hz client for a minute without refusing one frame', () => {
    const guard = createFrameGuard()
    let at = 0
    for (let frame = 0; frame < 240 * 60; frame += 1) {
      at += 1000 / 240
      expect(guard.admit(PONG, at).fate).toBe(FrameFate.Accept)
      // Five pongs a second, riding along with the command frames.
      if (frame % 48 === 0) expect(guard.admit(PONG, at).fate).toBe(FrameFate.Accept)
    }
    expect(guard.stats.refused).toBe(0)
  })

  it('throttles a flood in silence before it closes on it', () => {
    const guard = createFrameGuard()
    // A frozen clock is a client sending everything in one instant, which is
    // the shape of a flood: the bucket never refills.
    for (let i = 0; i < FRAME_BURST; i += 1) {
      expect(guard.admit(PONG, 0).fate).toBe(FrameFate.Accept)
    }

    const first = guard.admit(PONG, 0)
    expect(first.fate).toBe(FrameFate.TooFast)
    expect(first.text).toBeNull()
    // Dropped, and *not answered*: replying to a flood with one fault per frame
    // is answering a flood with a flood in our own direction.
    expect(first.fault).toBeNull()
    expect(first.close).toBeNull()

    let closed: number | null = null
    for (let i = 1; i < MAX_REFUSED_FRAMES + 8; i += 1) {
      const verdict = guard.admit(PONG, 0)
      if (verdict.close !== null && closed === null) {
        closed = i + 1
        expect(verdict.fault?.code).toBe('flooding')
        expect(verdict.close.code).toBe(CLOSE_FLOODING)
      }
    }
    expect(closed).toBe(MAX_REFUSED_FRAMES)
  })

  it('recovers on its own when the client slows down', () => {
    const guard = createFrameGuard()
    for (let i = 0; i < FRAME_BURST; i += 1) guard.admit(PONG, 0)
    expect(guard.admit(PONG, 0).fate).toBe(FrameFate.TooFast)
    // A second later the bucket is full again. A client that overshot once is
    // not a client to end a duel over.
    expect(guard.admit(PONG, 1000).fate).toBe(FrameFate.Accept)
  })
})

describe('the per-connection byte rate', () => {
  it('bounds what the frame rate alone would allow', () => {
    // 300 frames a second at the 16 kB cap is 4.8 MB/s of individually legal
    // traffic. This is the limit that says no to that.
    expect(FRAME_BUDGET_PER_SECOND * MAX_FRAME_BYTES).toBeGreaterThan(BYTE_BUDGET_PER_SECOND * 30)
  })

  it('refuses many legal-sized frames that add up', () => {
    const guard = createFrameGuard()
    const big = 'x'.repeat(MAX_FRAME_BYTES)
    let refused = 0
    // Ten seconds of wall-clock, spread across frames that individually pass
    // both the size cap and the frame rate.
    for (let i = 0; i < 300; i += 1) {
      if (guard.admit(big, i * 33).fate !== FrameFate.Accept) refused += 1
    }
    expect(refused).toBeGreaterThan(0)
    expect(guard.stats.tooLoud).toBeGreaterThan(0)
  })

  it('never refuses a single maximal frame for arriving first', () => {
    // The burst allowance is two maximal frames, and that relationship is the
    // point: an allowance smaller than one legal frame is a limit that fails on
    // exactly the input it was sized for.
    const guard = createFrameGuard()
    expect(guard.admit('x'.repeat(MAX_FRAME_BYTES), 0).fate).toBe(FrameFate.Accept)
  })
})

describe('a binary frame', () => {
  it('is refused with a sentence rather than decoded', () => {
    const guard = createFrameGuard()
    const verdict = guard.admit(new Uint8Array([0xde, 0xad, 0xbe, 0xef]), 0)
    expect(verdict.fate).toBe(FrameFate.Binary)
    expect(verdict.text).toBeNull()
    expect(verdict.fault?.detail).toContain('JSON text')
    expect(verdict.close).not.toBeNull()
  })
})

/**
 * The other half of the door: what the numbers inside an admitted frame may be.
 *
 * Driven through `applyFrame`, which is the path a real frame takes, so what is
 * being asserted is that the *server* clamps rather than that a sim function
 * exists which could.
 */
describe('command fields, clamped server-side', () => {
  const identity: ServerIdentity = { build: 'test', mapHash: 'abcdef01', room: 'H7K2Q9' }

  /** A greeted session and the queue its commands land in. */
  function greeted() {
    const queue = createInputQueue()
    const hello = JSON.stringify({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      build: 'test',
      mapHash: identity.mapHash,
    })
    const session = applyFrame(createSession('peer', 0, queue), hello, identity, 0).session
    return { session, queue }
  }

  /** Push one hostile wire command in and read back what the world will execute. */
  function throughTheDoor(wire: readonly unknown[]) {
    const { session, queue } = greeted()
    const frame = JSON.stringify({ t: 'cmds', startTick: 1, cmds: [wire] })
    applyFrame(session, frame, identity, 0)
    const taken = queue.take()
    expect(taken.cmd).not.toBeNull()
    return taken.cmd as NonNullable<typeof taken.cmd>
  }

  it('wraps a yaw past 180 degrees instead of trusting it', () => {
    // 400 degrees is 40. Wrapped rather than clamped, because a spin counter
    // that overflowed is a player still facing somewhere, and snapping them to
    // due north is a teleport of the view.
    const cmd = throughTheDoor([0, 0, Math.round(400 * ANGLE_UNITS_PER_DEGREE), 0, 0, 0])
    expect(cmd.yaw).toBeGreaterThanOrEqual(0)
    expect(cmd.yaw).toBeLessThan(ANGLE_UNITS)
    expect(cmd.yaw).toBe(Math.round(40 * ANGLE_UNITS_PER_DEGREE))
  })

  it('clamps a pitch past 89 degrees, in both directions', () => {
    const up = throughTheDoor([0, 0, 0, Math.round(180 * ANGLE_UNITS_PER_DEGREE), 0, 0])
    const down = throughTheDoor([0, 0, 0, -Math.round(180 * ANGLE_UNITS_PER_DEGREE), 0, 0])
    // 89, not 90: at exactly straight up the yaw-relative movement basis is
    // degenerate, which is why Quake has clamped it since 1996.
    expect(up.pitch).toBe(MAX_PITCH_UNITS)
    expect(down.pitch).toBe(-MAX_PITCH_UNITS)
  })

  it('clamps movement past +/-127, which is what an old client would send', () => {
    // Quake's `forwardmove` is a signed byte and its clients send +/-127. This
    // one is a *direction*; the speed it means is the simulation's business.
    const cmd = throughTheDoor([127, -127, 0, 0, 0, 0])
    expect(cmd.forwardMove).toBe(MAX_MOVE)
    expect(cmd.sideMove).toBe(-MAX_MOVE)
  })

  it('masks buttons nobody has defined', () => {
    const cmd = throughTheDoor([0, 0, 0, 0, 0xffff, 0])
    expect(cmd.buttons).toBe(BUTTON_JUMP | BUTTON_ATTACK)
  })

  it('does not turn a negative button field into every button at once', () => {
    // Two's complement makes `-1 & MASK` a held trigger, which is a rocket the
    // player never asked for.
    const cmd = throughTheDoor([0, 0, 0, 0, -1, 0])
    expect(cmd.buttons).toBe(0)
  })

  it('turns a NaN, an Infinity and a string into standing still', () => {
    const cmd = throughTheDoor([
      Number.NaN,
      Number.POSITIVE_INFINITY,
      'north',
      1.5,
      null,
      { t: 'railgun' },
    ])
    expect(cmd).toEqual({
      forwardMove: 0,
      sideMove: 0,
      yaw: 0,
      pitch: 0,
      buttons: 0,
      // Not `Weapon.None`: a player with empty hands is not a thing this game
      // has, so an unreadable weapon is the one they spawn holding.
      weapon: Weapon.RocketLauncher,
    })
  })

  it('takes a command that is not six numbers as no command at all', () => {
    expect(throughTheDoor([])).toEqual(throughTheDoor([0, 0, 0, 0, 0, 0]))
  })
})

describe('the frame parser, on input nobody could type', () => {
  it('returns null rather than throwing, whatever it is handed', () => {
    const hostile = [
      '',
      '{',
      '[]',
      'null',
      '"just a string"',
      '{"t":"cmds"}',
      '{"t":"cmds","startTick":-1,"cmds":[[0,0,0,0,0,0]]}',
      '{"t":"cmds","startTick":0,"cmds":[]}',
      `{"t":"cmds","startTick":0,"cmds":[${'[0,0,0,0,0,0],'.repeat(MAX_CMDS_PER_BATCH)}[0,0,0,0,0,0]]}`,
      '{"t":"hello","protocol":6,"build":"x","mapHash":"nope"}',
      '{"t":"pong","id":-1}',
      '{"t":"pong","id":1.5}',
      ' ',
    ]
    for (const raw of hostile) {
      expect(() => parseClientMessage(raw), raw).not.toThrow()
      expect(parseClientMessage(raw), raw).toBeNull()
    }
  })

  it('refuses a tick label that would wedge the session that sent it', () => {
    // A command labelled `MAX_SAFE_INTEGER` moves the input queue's admission
    // window there, and every honest command afterwards is refused as late — a
    // session that connects and then silently cannot move.
    const wedge = JSON.stringify({
      t: 'cmds',
      startTick: Number.MAX_SAFE_INTEGER,
      cmds: [[0, 0, 0, 0, 0, 0]],
    })
    expect(parseClientMessage(wedge)).toBeNull()

    // And the *end* of a batch is bounded, not only its start.
    const edge = JSON.stringify({
      t: 'cmds',
      startTick: MAX_TICK - 1,
      cmds: [
        [0, 0, 0, 0, 0, 0],
        [0, 0, 0, 0, 0, 0],
      ],
    })
    expect(parseClientMessage(edge)).toBeNull()
  })
})
