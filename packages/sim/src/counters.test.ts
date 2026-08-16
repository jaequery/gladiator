/**
 * The two counters, forced.
 *
 * A counter nobody has watched increment is a counter nobody knows is wired up
 * — the same reasoning as `scripts/guardrails.mjs`. So each of these tests
 * *makes* the condition happen and requires the tally to move, and the last one
 * makes neither happen and requires it not to.
 */
import { describe, expect, it } from 'vitest'

import { boxBrush, createCollisionWorld } from './collide.ts'
import { countSimEvents } from './counters.ts'
import { radiusDamage } from './damage.ts'
import { tick } from './kernel.ts'
import { setVec3, vec3 } from './math.ts'
import { MAX_MOVE_SPEED } from './slidemove.ts'
import {
  EntityFlag,
  EntityKind,
  NO_ENTITY,
  createGameState,
  findPlayer,
  spawnEntity,
} from './state.ts'
import type { GameState } from './state.ts'
import { BUTTON_ATTACK, MAX_PITCH_UNITS, NULL_CMD } from './usercmd.ts'
import { SPAWN_ARMOR, SPAWN_HEALTH } from './match/spawn.ts'
import { WEAPONS } from './weapons.ts'

/** A sealed box with a floor at z = 0. Enough for a body to stand and shoot. */
const WORLD = createCollisionWorld([
  boxBrush([-2048, -2048, -64], [2048, 2048, 0]),
  boxBrush([-2048, -2048, 1024], [2048, 2048, 1088]),
  boxBrush([1984, -2048, -64], [2048, 2048, 1088]),
  boxBrush([-2048, -2048, -64], [-1984, 2048, 1088]),
  boxBrush([-2048, 1984, -64], [2048, 2048, 1088]),
  boxBrush([-2048, -2048, -64], [2048, -1984, 1088]),
])

function standing(): GameState {
  const state = createGameState(1)
  spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    flags: EntityFlag.OnGround,
    origin: vec3(0, 0, 0.25),
    angles: vec3(0, 0, 0),
    health: SPAWN_HEALTH,
    armor: SPAWN_ARMOR,
  })
  return state
}

describe('the speed clamp counter', () => {
  it('counts the rail firing, and the worst speed it fired on', () => {
    const counters = countSimEvents()
    try {
      const state = standing()
      const player = findPlayer(state, 0)
      expect(player).not.toBeNull()
      if (player === null) return

      // Nothing a player can do reaches this. A bad reconciliation can, and
      // that is the whole reason the rail exists (`docs/physics-spec.md` §2.6).
      setVec3(player.velocity, 40_000, 0, 0)
      tick(state, [NULL_CMD], WORLD)
      setVec3(player.velocity, 9_000, 0, 0)
      tick(state, [NULL_CMD], WORLD)

      expect(counters.speedClamps).toBe(2)
      expect(counters.worstClampedSpeed).toBe(40_000)
    } finally {
      counters.stop()
    }
  })

  it('stays at zero through a rocket jump, which is the fastest thing in the game', () => {
    const counters = countSimEvents()
    try {
      const state = standing()
      // Straight down at your own feet: the launch is ~500 qu/s, a sixth of the
      // rail. A counter that moved here would be a counter nobody could read.
      tick(state, [{ ...NULL_CMD, pitch: MAX_PITCH_UNITS, buttons: BUTTON_ATTACK }], WORLD)
      for (let i = 0; i < 125; i += 1) tick(state, [NULL_CMD], WORLD)

      expect(counters.speedClamps).toBe(0)
      const player = findPlayer(state, 0)
      expect(player?.velocity[2]).toBeLessThan(MAX_MOVE_SPEED)
    } finally {
      counters.stop()
    }
  })
})

describe('the self-splash counter', () => {
  it('counts your own rocket and not somebody else’s', () => {
    const seen: number[] = []
    const counters = countSimEvents({ onSelfSplash: (splash) => seen.push(splash.absorbed) })
    try {
      const state = standing()
      const player = findPlayer(state, 0)
      if (player === null) throw new Error('no player')

      // A rocket at your own feet: `distanceToBox` is zero inside the box, so
      // this is the full 100 points and the full 500 qu/s launch.
      radiusDamage(
        state,
        WORLD,
        player.origin,
        WEAPONS[0].splashDamage,
        WEAPONS[0].splashRadius,
        player.id,
        NO_ENTITY,
      )
      expect(counters.selfSplashes).toBe(1)
      expect(counters.lastSelfSplash?.slot).toBe(0)
      expect(counters.lastSelfSplash?.points).toBe(WEAPONS[0].splashDamage)
      // The health-only default: half of 100 is 50, and all 50 of it is health
      // because your own splash never reaches the armour (`match/selfDamage.ts`).
      expect(seen).toEqual([50])

      // Somebody else's rocket landing on the same body is not a self-splash,
      // and the whole point of the counter is that it is a *predicate* about
      // your own prediction.
      radiusDamage(
        state,
        WORLD,
        player.origin,
        WEAPONS[0].splashDamage,
        WEAPONS[0].splashRadius,
        NO_ENTITY,
        NO_ENTITY,
      )
      expect(counters.selfSplashes).toBe(1)
    } finally {
      counters.stop()
    }
  })

  it('reports the tick it landed on, which is what a mispredict is keyed by', () => {
    const counters = countSimEvents()
    try {
      const state = standing()
      for (let i = 0; i < 3; i += 1) tick(state, [NULL_CMD], WORLD)
      tick(state, [{ ...NULL_CMD, pitch: MAX_PITCH_UNITS, buttons: BUTTON_ATTACK }], WORLD)

      expect(counters.selfSplashes).toBe(1)
      expect(counters.lastSelfSplash?.tick).toBe(4)
    } finally {
      counters.stop()
    }
  })
})

describe('the tally', () => {
  it('detaches cleanly, so one test cannot leak into the next', () => {
    const counters = countSimEvents()
    counters.stop()

    const state = standing()
    const player = findPlayer(state, 0)
    if (player === null) throw new Error('no player')
    setVec3(player.velocity, 40_000, 0, 0)
    tick(state, [NULL_CMD], WORLD)

    expect(counters.speedClamps).toBe(0)
  })

  it('resets', () => {
    const counters = countSimEvents()
    try {
      const state = standing()
      tick(state, [{ ...NULL_CMD, pitch: MAX_PITCH_UNITS, buttons: BUTTON_ATTACK }], WORLD)
      expect(counters.selfSplashes).toBe(1)
      counters.reset()
      expect(counters.selfSplashes).toBe(0)
      expect(counters.lastSelfSplash).toBeNull()
    } finally {
      counters.stop()
    }
  })
})
