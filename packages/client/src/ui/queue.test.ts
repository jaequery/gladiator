/**
 * What the quick-match panel says, which is the half of it that decides
 * anything.
 *
 * The suite runs in Node, so the DOM half of `ui/queue.ts` is checked in a
 * browser like the rest of the HUD. Everything worth asserting is here: that a
 * player who is waiting is told they are waiting *and* when it will end, that
 * both endings say what happened, and that the panel is never on the screen
 * over a match somebody is playing.
 */
import { QueueState } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import type { QueueStatus } from '../net/client.ts'
import { MATCHED_DWELL_MS, formatWait, queueReadout } from './queue.ts'

const ROOM = 'H7K2Q9'

function status(over: Partial<QueueStatus> = {}): QueueStatus {
  return {
    state: QueueState.Waiting,
    room: ROOM,
    waitedMs: 0,
    timeoutMs: 60_000,
    sinceMs: 0,
    ...over,
  }
}

describe('formatWait', () => {
  it('reads in whole seconds, and in minutes once there are any', () => {
    expect(formatWait(0)).toBe('0s')
    expect(formatWait(999)).toBe('0s')
    expect(formatWait(12_400)).toBe('12s')
    expect(formatWait(60_000)).toBe('1:00')
    expect(formatWait(64_500)).toBe('1:04')
    // A deadline that has already gone by is `0s`, never a negative one.
    expect(formatWait(-500)).toBe('0s')
  })
})

describe('waiting', () => {
  it('says what is happening and when it stops', () => {
    // The whole difference between feedback and a spinner: a spinner says
    // "something is happening", and this says "for this much longer".
    const readout = queueReadout(status({ waitedMs: 12_000 }), false)
    if (readout === null) throw new Error('expected a readout')
    expect(readout.headline).toBe('Looking for an opponent')
    expect(readout.detail).toContain('waiting 12s')
    expect(readout.detail).toContain('giving up in 48s')
    expect(readout.progress).toBeCloseTo(0.2)
  })

  it('never runs the bar past the end of the wait', () => {
    const readout = queueReadout(status({ waitedMs: 90_000 }), false)
    expect(readout?.progress).toBe(1)
    expect(readout?.detail).toContain('giving up in 0s')
  })

  it('draws no bar when there is no deadline to draw', () => {
    expect(queueReadout(status({ waitedMs: 4_000, timeoutMs: 0 }), false)?.progress).toBe(0)
  })
})

describe('matched', () => {
  it('says so, and leaves by itself', () => {
    const found = queueReadout(status({ state: QueueState.Matched, sinceMs: 0 }), false)
    expect(found?.headline).toBe('Opponent found')
    expect(found?.detail).toContain(ROOM)

    // Gone before the first rocket. It goes on its own clock rather than on the
    // match starting, because the two are the same moment and the panel would
    // otherwise still be up over the countdown a player is aiming through.
    expect(queueReadout(status({ state: QueueState.Matched, sinceMs: MATCHED_DWELL_MS }), false))
      .toBeNull()
  })
})

describe('the wait running out', () => {
  it('reads as an outcome with something to do, not as a failure', () => {
    const readout = queueReadout(
      status({ state: QueueState.Timeout, waitedMs: 60_000, timeoutMs: 0, sinceMs: 30_000 }),
      false,
    )
    if (readout === null) throw new Error('expected a readout')
    expect(readout.headline).toBe('Nobody is waiting right now')
    // The code is the thing to do next: the player is already sitting in a room
    // and anyone sent those six characters lands in it.
    expect(readout.detail).toContain(ROOM)
    expect(readout.detail).toContain('friend')
  })

  it('stays up, because the code is still worth reading', () => {
    // Unlike "opponent found", this one has no successor state of its own. What
    // takes it off the screen is a match starting, which is the next case.
    const late = status({ state: QueueState.Timeout, timeoutMs: 0, sinceMs: 10 * 60_000 })
    expect(queueReadout(late, false)).not.toBeNull()
  })
})

describe('a match that has started', () => {
  it('takes the panel off the screen whatever the queue last said', () => {
    // A friend can walk into a timed-out player's room with the code minutes
    // later, and the host says nothing about the queue when they do — so the
    // world's own answer to "has a match begun" is what ends the panel.
    for (const state of [QueueState.Waiting, QueueState.Matched, QueueState.Timeout]) {
      expect(queueReadout(status({ state }), true), state).toBeNull()
    }
  })

  it('is nothing at all for a session that never asked to be matched', () => {
    expect(queueReadout(null, false)).toBeNull()
    expect(queueReadout(null, true)).toBeNull()
  })
})
