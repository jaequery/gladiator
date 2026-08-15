/**
 * Being stuck: the clock, the recovery, and the line in the log.
 *
 * The detector is driven directly here rather than through a wedged bot, because what
 * is being asserted is the *policy* — three seconds, thirty-two units, a bounded
 * recovery, a report at four — and a real wedge is a slow and indirect way to state a
 * number. That a real bot in a real match never exceeds the budget is
 * `tools/bot-arena.ts`'s claim, measured from the body over two hundred matches.
 */

import { TICK_RATE, vec3 } from '@gladiator/sim'
import type { Vec3 } from '@gladiator/sim'
import { afterEach, describe, expect, it } from 'vitest'

import {
  RECOVERY_BACK_TICKS,
  RECOVERY_TICKS,
  STUCK_RADIUS,
  STUCK_REPORT_TICKS,
  STUCK_TICKS,
  createStuck,
  isRecovering,
  onNavStuck,
  recoverySteer,
  resetStuck,
  trackProgress,
} from './stuck.ts'
import type { NavStuck } from './stuck.ts'

afterEach(() => {
  onNavStuck(null)
})

const HERE: Vec3 = [100, 200, 0]

/** Hold still at `HERE` for `ticks`, and report which sub-step recovery began on. */
function holdStill(ticks: number, active = true): { began: number; stuck: ReturnType<typeof createStuck> } {
  const stuck = createStuck()
  let began = -1
  for (let tick = 0; tick < ticks; tick += 1) {
    const recovering = trackProgress(stuck, 0, tick, HERE, active)
    if (recovering && began < 0) began = tick
  }
  return { began, stuck }
}

describe('the numbers', () => {
  it('are the ones the acceptance check names', () => {
    expect(STUCK_RADIUS).toBe(32)
    expect(STUCK_TICKS).toBe(3 * TICK_RATE)
    expect(RECOVERY_TICKS).toBe(Math.round(1.5 * TICK_RATE))
    expect(STUCK_REPORT_TICKS).toBe(4 * TICK_RATE)
  })

  it('report later than they recover, so a quiet wedge is one that got fixed', () => {
    expect(STUCK_REPORT_TICKS).toBeGreaterThan(STUCK_TICKS)
    expect(STUCK_REPORT_TICKS).toBeLessThan(STUCK_TICKS + RECOVERY_TICKS)
  })
})

describe('the clock', () => {
  it('does not run at all while there is nothing to walk towards', () => {
    // A bot holding an angle in a duel is stationary on purpose, and so is a dead one
    // and one in an intermission. Every one of them would trip a bare "has not moved".
    const { began, stuck } = holdStill(STUCK_TICKS * 3, false)
    expect(began).toBe(-1)
    expect(isRecovering(stuck)).toBe(false)
  })

  it('starts a recovery after three seconds of no progress and not before', () => {
    expect(holdStill(STUCK_TICKS).began).toBe(-1)
    expect(holdStill(STUCK_TICKS + 2).began).toBe(STUCK_TICKS + 1)
  })

  it('restarts the moment the bot covers the radius, and clears the recovery', () => {
    const stuck = createStuck()
    for (let tick = 0; tick <= STUCK_TICKS + 10; tick += 1) trackProgress(stuck, 0, tick, HERE, true)
    expect(isRecovering(stuck)).toBe(true)

    const moved: Vec3 = [HERE[0] + STUCK_RADIUS + 1, HERE[1], HERE[2]]
    expect(trackProgress(stuck, 0, STUCK_TICKS + 11, moved, true)).toBe(false)
    expect(isRecovering(stuck)).toBe(false)
    expect(Array.from(stuck.anchor)).toEqual(Array.from(moved))
  })

  it('counts progress in three dimensions, so falling is progress', () => {
    const stuck = createStuck()
    trackProgress(stuck, 0, 0, HERE, true)
    const below: Vec3 = [HERE[0], HERE[1], HERE[2] - STUCK_RADIUS - 1]
    trackProgress(stuck, 0, 1, below, true)
    expect(stuck.anchorTick).toBe(1)
  })

  it('does not count a shuffle inside the radius', () => {
    const stuck = createStuck()
    for (let tick = 0; tick <= STUCK_TICKS + 5; tick += 1) {
      const wobble: Vec3 = [HERE[0] + (tick % 2 === 0 ? 30 : 0), HERE[1], HERE[2]]
      trackProgress(stuck, 0, tick, wobble, true)
    }
    expect(isRecovering(stuck)).toBe(true)
  })

  it('gives up on a failed escape after 1.5 s and tries the other side', () => {
    const stuck = createStuck()
    let began = -1
    let flipped = -1
    const side = stuck.side
    for (let tick = 0; tick <= STUCK_TICKS + RECOVERY_TICKS + 4; tick += 1) {
      trackProgress(stuck, 0, tick, HERE, true)
      if (began < 0 && isRecovering(stuck)) began = tick
      if (flipped < 0 && stuck.side !== side) flipped = tick
    }
    expect(flipped).toBe(began + RECOVERY_TICKS)
    expect(stuck.episodes).toBe(2)
  })

  it('forgets everything when it is reset', () => {
    const stuck = createStuck()
    for (let tick = 0; tick <= STUCK_TICKS + 5; tick += 1) trackProgress(stuck, 0, tick, HERE, true)
    resetStuck(stuck)
    expect(isRecovering(stuck)).toBe(false)
    expect(stuck.reported).toBe(false)
  })
})

describe('the NAV_STUCK line', () => {
  it('fires once, at four seconds, with the position in it', () => {
    const events: NavStuck[] = []
    onNavStuck((event) => events.push(event))
    const stuck = createStuck()
    for (let tick = 0; tick <= STUCK_REPORT_TICKS + 50; tick += 1) {
      trackProgress(stuck, 7, tick, HERE, true)
    }
    expect(events).toHaveLength(1)
    const event = events[0]
    expect(event?.slot).toBe(7)
    expect(event?.tick).toBe(STUCK_REPORT_TICKS)
    expect(event?.ticksStuck).toBe(STUCK_REPORT_TICKS)
    expect(Array.from(event?.origin ?? [])).toEqual(Array.from(HERE))
  })

  it('does not fire for a wedge the recovery resolved in time', () => {
    const events: NavStuck[] = []
    onNavStuck((event) => events.push(event))
    const stuck = createStuck()
    for (let tick = 0; tick < STUCK_REPORT_TICKS - 1; tick += 1) {
      trackProgress(stuck, 0, tick, HERE, true)
    }
    trackProgress(stuck, 0, STUCK_REPORT_TICKS - 1, [HERE[0] + 100, HERE[1], HERE[2]], true)
    expect(events).toEqual([])
  })

  it('carries a copy of the position rather than the caller’s vector', () => {
    // The follower passes the model's own origin, which is overwritten every
    // sub-step. A log line holding that reference would print wherever the bot ended
    // up rather than where it was stuck.
    const events: NavStuck[] = []
    onNavStuck((event) => events.push(event))
    const origin = vec3(1, 2, 3)
    const stuck = createStuck()
    for (let tick = 0; tick <= STUCK_REPORT_TICKS; tick += 1) {
      trackProgress(stuck, 0, tick, origin, true)
    }
    origin[0] = 999
    expect(events[0]?.origin[0]).toBe(1)
  })

  it('is off when nobody installed one', () => {
    const stuck = createStuck()
    expect(() => {
      for (let tick = 0; tick <= STUCK_REPORT_TICKS; tick += 1) {
        trackProgress(stuck, 0, tick, HERE, true)
      }
    }).not.toThrow()
  })
})

describe('the escape', () => {
  const out = vec3()

  /** Compare a direction component-wise, so that `-0` and `0` are the same answer. */
  function expectDirection(x: number, y: number): void {
    expect(out[0]).toBeCloseTo(x, 12)
    expect(out[1]).toBeCloseTo(y, 12)
    expect(out[2]).toBe(0)
  }

  it('backs straight off first', () => {
    const stuck = createStuck()
    stuck.recoveryTick = 0
    const jump = recoverySteer(stuck, 0, 1, 0, out)
    expectDirection(-1, 0)
    expect(jump).toBe(false)
  })

  it('then goes around, with exactly one jump in it', () => {
    const stuck = createStuck()
    stuck.recoveryTick = 0
    stuck.side = 1

    expect(recoverySteer(stuck, RECOVERY_BACK_TICKS - 1, 1, 0, out)).toBe(false)
    // The first perpendicular sub-step asks for the jump, and no other one does — a
    // jump that repeats is a bot bouncing on the spot.
    expect(recoverySteer(stuck, RECOVERY_BACK_TICKS, 1, 0, out)).toBe(true)
    expectDirection(0, 1)
    expect(recoverySteer(stuck, RECOVERY_BACK_TICKS + 1, 1, 0, out)).toBe(false)
    expectDirection(0, 1)
  })

  it('goes around the other way on the other side', () => {
    const stuck = createStuck()
    stuck.recoveryTick = 0
    stuck.side = -1
    recoverySteer(stuck, RECOVERY_BACK_TICKS, 1, 0, out)
    expectDirection(0, -1)
  })

  it('normalises whatever it was handed', () => {
    const stuck = createStuck()
    stuck.recoveryTick = 0
    recoverySteer(stuck, 0, 300, 400, out)
    expect(out[0]).toBeCloseTo(-0.6, 12)
    expect(out[1]).toBeCloseTo(-0.8, 12)
  })

  it('has an answer even when the bot wanted to go nowhere', () => {
    const stuck = createStuck()
    stuck.recoveryTick = 0
    recoverySteer(stuck, 0, 0, 0, out)
    expect(Math.sqrt(out[0] * out[0] + out[1] * out[1])).toBeCloseTo(1, 12)
  })
})
