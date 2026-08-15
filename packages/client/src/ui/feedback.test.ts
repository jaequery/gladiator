/**
 * Hit confirmation and the damage arc.
 *
 * The acceptance check this file exists for is *"hit confirmation fires on the
 * same frame the server confirms the hit"*, and the way to test that is to
 * insist there is nowhere for a delay to hide: the fold is handed the frame in
 * which the opponent's health drops and must return full intensity from that
 * same call, not the next one. Everything else here is the arithmetic of the
 * arc, which is worth pinning because a direction indicator that is 90 degrees
 * out is worse than none at all.
 */
import { ANGLE_UNITS_PER_DEGREE, SPAWN_ARMOR, SPAWN_HEALTH, Weapon } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  DAMAGE_TICKS,
  HIT_TICKS,
  INITIAL_FEEDBACK,
  MIN_SHOVE,
  advanceFeedback,
  createFeedbackTracker,
  shoveSourceAngle,
} from './feedback.ts'
import type { HudModel, HudPlayer } from './hudModel.ts'

const SHOVE = 500

type Frame = {
  tick?: number
  health?: number
  armor?: number
  velocity?: readonly [number, number]
  yawDegrees?: number
  opponentHealth?: number
  opponentPresent?: boolean
}

function person(health: number, armor: number, velocity: readonly [number, number], yawUnits: number): HudPlayer {
  return {
    present: true,
    alive: health > 0,
    health,
    armor,
    healthFraction: health / SPAWN_HEALTH,
    armorFraction: armor / SPAWN_ARMOR,
    weapon: Weapon.RocketLauncher,
    weaponName: 'rocket launcher',
    cooldownMs: 0,
    cooldownFraction: 0,
    velocity: [velocity[0], velocity[1], 0],
    yawUnits,
  }
}

const ABSENT: HudPlayer = { ...person(0, 0, [0, 0], 0), present: false, alive: false }

function frame(frameSpec: Frame = {}): HudModel {
  const {
    tick = 0,
    health = SPAWN_HEALTH,
    armor = SPAWN_ARMOR,
    velocity = [0, 0],
    yawDegrees = 0,
    opponentHealth = SPAWN_HEALTH,
    opponentPresent = true,
  } = frameSpec

  return {
    tick,
    slot: 0,
    self: person(health, armor, velocity, Math.round(yawDegrees * ANGLE_UNITS_PER_DEGREE)),
    opponent: opponentPresent ? person(opponentHealth, 0, [0, 0], 0) : ABSENT,
    match: {
      phase: 1,
      round: 1,
      wins: [0, 0],
      roundsToWin: 3,
      remainingMs: null,
      lastRoundWinner: -1,
      winner: -1,
    },
  }
}

/** Run a sequence through the fold and return every frame's state. */
function run(frames: readonly HudModel[]) {
  let memory = INITIAL_FEEDBACK
  return frames.map((model) => {
    const result = advanceFeedback(memory, model)
    memory = result.memory
    return result.state
  })
}

describe('first sight', () => {
  it('emits nothing at all, so a spawn does not ring every bell', () => {
    const [first] = run([frame({ health: 20, armor: 0, opponentHealth: 10 })])
    expect(first).toEqual({ hit: 0, damage: 0, damageAngle: null })
  })
})

describe('hit confirmation', () => {
  it('is at full strength on the very frame the opponent loses health', () => {
    const states = run([
      frame({ tick: 0, opponentHealth: 100 }),
      frame({ tick: 1, opponentHealth: 60 }),
    ])
    // Not "by the next frame" — on this one. There is no queue between the
    // fold and the pixels, which is the whole acceptance check.
    expect(states[1]?.hit).toBe(1)
  })

  it('fades out over its window and then stays out', () => {
    const frames = [frame({ tick: 0, opponentHealth: 100 }), frame({ tick: 1, opponentHealth: 60 })]
    for (let tick = 2; tick <= 1 + HIT_TICKS + 5; tick += 1) {
      frames.push(frame({ tick, opponentHealth: 60 }))
    }
    const states = run(frames)

    expect(states[1]?.hit).toBe(1)
    expect(states[1 + Math.floor(HIT_TICKS / 2)]?.hit).toBeCloseTo(0.5, 1)
    expect(states[1 + HIT_TICKS]?.hit).toBe(0)
    expect(states[states.length - 1]?.hit).toBe(0)
  })

  it('snaps back to full on a second hit rather than continuing to fade', () => {
    const states = run([
      frame({ tick: 0, opponentHealth: 100 }),
      frame({ tick: 1, opponentHealth: 60 }),
      frame({ tick: 20, opponentHealth: 60 }),
      frame({ tick: 21, opponentHealth: 20 }),
    ])
    expect(states[2]?.hit).toBeLessThan(1)
    expect(states[3]?.hit).toBe(1)
  })

  it('is not rung by an opponent leaving the world', () => {
    const states = run([
      frame({ tick: 0, opponentHealth: 100 }),
      frame({ tick: 1, opponentPresent: false }),
    ])
    expect(states[1]?.hit).toBe(0)
  })

  it('does not fire for your own health going down', () => {
    const states = run([frame({ tick: 0 }), frame({ tick: 1, health: 20 })])
    expect(states[1]?.hit).toBe(0)
    expect(states[1]?.damage).toBe(1)
  })
})

describe('damage taken', () => {
  it('fires on health or on armour, because both are a hit', () => {
    expect(run([frame({ tick: 0 }), frame({ tick: 1, health: 60 })])[1]?.damage).toBe(1)
    expect(run([frame({ tick: 0 }), frame({ tick: 1, armor: 60 })])[1]?.damage).toBe(1)
  })

  it('is not fired by a round start putting both pools back up', () => {
    const states = run([
      frame({ tick: 0, health: 20, armor: 0 }),
      frame({ tick: 1, health: SPAWN_HEALTH, armor: SPAWN_ARMOR }),
    ])
    expect(states[1]?.damage).toBe(0)
  })

  it('fades over its own, longer window', () => {
    const frames = [frame({ tick: 0 }), frame({ tick: 1, health: 60 })]
    for (let tick = 2; tick <= 1 + DAMAGE_TICKS; tick += 1) {
      frames.push(frame({ tick, health: 60 }))
    }
    const states = run(frames)
    expect(states[1]?.damage).toBe(1)
    expect(states[1 + DAMAGE_TICKS]?.damage).toBe(0)
    expect(DAMAGE_TICKS).toBeGreaterThan(HIT_TICKS)
  })
})

describe('where it came from', () => {
  /**
   * Facing world `+x`. Quake's frame is `+x` forward, `+y` left, so an attacker
   * on your right is at `-y`, and the shove they give you is towards `+y`.
   */
  const cases: ReadonlyArray<readonly [string, readonly [number, number], number]> = [
    ['dead ahead', [-SHOVE, 0], 0],
    ['behind', [SHOVE, 0], 180],
    ['on the right', [0, SHOVE], 90],
    ['on the left', [0, -SHOVE], -90],
  ]

  for (const [where, shove, degrees] of cases) {
    it(`points at an attacker ${where}`, () => {
      const states = run([frame({ tick: 0 }), frame({ tick: 1, health: 60, velocity: shove })])
      const angle = states[1]?.damageAngle
      expect(angle).not.toBeNull()
      expect(Math.abs((angle ?? 0) * (180 / Math.PI))).toBeCloseTo(Math.abs(degrees), 4)
      if (degrees !== 180) {
        expect(Math.sign((angle ?? 0) * (180 / Math.PI))).toBe(Math.sign(degrees))
      }
    })
  }

  it('stays pinned to the attacker as the player turns to face them', () => {
    // Hit from dead ahead, then turn 90 degrees to the left. Quake yaw
    // increases anticlockwise, so what was in front is now on the right.
    const states = run([
      frame({ tick: 0 }),
      frame({ tick: 1, health: 60, velocity: [-SHOVE, 0] }),
      frame({ tick: 2, health: 60, velocity: [-SHOVE, 0], yawDegrees: 90 }),
    ])
    expect((states[1]?.damageAngle ?? 0) * (180 / Math.PI)).toBeCloseTo(0, 4)
    expect((states[2]?.damageAngle ?? 0) * (180 / Math.PI)).toBeCloseTo(90, 4)
  })

  it('withholds the direction, but not the flash, when the shove says nothing', () => {
    const states = run([
      frame({ tick: 0 }),
      frame({ tick: 1, health: 60, velocity: [0, MIN_SHOVE / 4] }),
    ])
    expect(states[1]?.damage).toBe(1)
    expect(states[1]?.damageAngle).toBeNull()
  })

  it('goes away with the flash rather than hanging about pointing at nothing', () => {
    const frames = [frame({ tick: 0 }), frame({ tick: 1, health: 60, velocity: [-SHOVE, 0] })]
    for (let tick = 2; tick <= 1 + DAMAGE_TICKS; tick += 1) {
      frames.push(frame({ tick, health: 60, velocity: [-SHOVE, 0] }))
    }
    const states = run(frames)
    expect(states[states.length - 1]?.damage).toBe(0)
    expect(states[states.length - 1]?.damageAngle).toBeNull()
  })

  it('refuses to guess below the smallest push a hit can give', () => {
    expect(shoveSourceAngle([0, 0], [MIN_SHOVE - 1, 0])).toBeNull()
    expect(shoveSourceAngle([0, 0], [MIN_SHOVE + 1, 0])).not.toBeNull()
  })
})

describe('the tracker', () => {
  it('carries the memory forward so a caller does not have to', () => {
    const tracker = createFeedbackTracker()
    expect(tracker.observe(frame({ tick: 0, opponentHealth: 100 })).hit).toBe(0)
    expect(tracker.observe(frame({ tick: 1, opponentHealth: 60 })).hit).toBe(1)
  })

  it('forgets on reset, so a reconnection is a first sighting again', () => {
    const tracker = createFeedbackTracker()
    tracker.observe(frame({ tick: 0, opponentHealth: 100 }))
    tracker.reset()
    expect(tracker.observe(frame({ tick: 1, opponentHealth: 60 })).hit).toBe(0)
  })
})
