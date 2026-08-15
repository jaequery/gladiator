import { describe, expect, it } from 'vitest'

import { boxBrush, createCollisionWorld } from './collide.ts'
import { tick } from './kernel.ts'
import { lengthVec3, vec3 } from './math.ts'
import { MISSILE_PRESTEP_MS, explodeProjectile, projectilePosition } from './projectile.ts'
import { EntityKind, createGameState, spawnEntity } from './state.ts'
import type { EntityState, GameState } from './state.ts'
import { TICK_INTERVAL_MS } from './tick.ts'
import { SURFACE_CLIP_EPSILON, rayBoxFraction } from './trace.ts'
import { BUTTON_ATTACK, NULL_CMD } from './usercmd.ts'
import type { UserCmd } from './usercmd.ts'
import { Weapon } from './weapon.ts'
import { ROCKET_SPEED, WEAPONS, spawnProjectile } from './weapons.ts'

const ROCKET = WEAPONS[0]

/** A long hall: floor, and a wall 1024 units down the +x axis. */
const HALL = createCollisionWorld([
  boxBrush([-1024, -1024, -64], [1024, 1024, 0]),
  boxBrush([1024, -1024, -64], [1088, 1024, 512]),
  boxBrush([-1024, -1024, 512], [1024, 1024, 576]),
])

function shooterAt(x: number): { state: GameState; player: EntityState } {
  const state = createGameState(1)
  const player = spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    origin: vec3(x, 0, SURFACE_CLIP_EPSILON),
    health: 100,
  })
  return { state, player }
}

function cmd(over: Partial<UserCmd> = {}): UserCmd {
  return { ...NULL_CMD, ...over }
}

function rocketsIn(state: GameState): EntityState[] {
  return state.entities.filter((e) => e.kind === EntityKind.Projectile)
}

describe('the trajectory', () => {
  it('is 45 units downrange on the tick it is fired', () => {
    // 900 qu/s for 50 ms. This is the whole of `MISSILE_PRESTEP_TIME`, and it
    // is why a rocket at your feet detonates on the frame you fire it.
    expect((ROCKET_SPEED * MISSILE_PRESTEP_MS) / 1000).toBe(45)

    const state = createGameState(1)
    const shooter = spawnEntity(state, { kind: EntityKind.Player, slot: 0, health: 100 })
    const rocket = spawnProjectile(state, shooter, ROCKET, [0, 0, 100], [1, 0, 0])

    expect(projectilePosition(vec3(), rocket, state.tick)).toEqual([45, 0, 100])
  })

  it('is a closed form of the spawn tick, not an accumulation', () => {
    const state = createGameState(1)
    const shooter = spawnEntity(state, { kind: EntityKind.Player, slot: 0, health: 100 })
    const rocket = spawnProjectile(state, shooter, ROCKET, [0, 0, 100], [1, 0, 0])

    // Evaluated out of order and twice over, because a peer that is told about
    // a rocket once has to be able to ask where it is at any tick — including
    // one it has already drawn.
    const at50 = projectilePosition(vec3(), rocket, state.tick + 50)
    const at10 = projectilePosition(vec3(), rocket, state.tick + 10)
    expect(projectilePosition(vec3(), rocket, state.tick + 50)).toEqual(at50)

    const seconds = (n: number) => (n * TICK_INTERVAL_MS + MISSILE_PRESTEP_MS) * 0.001
    expect(at10[0]).toBeCloseTo(ROCKET_SPEED * seconds(10), 9)
    expect(at50[0]).toBeCloseTo(ROCKET_SPEED * seconds(50), 9)
  })

  it('leaves the muzzle with a whole-number velocity', () => {
    const state = createGameState(1)
    const shooter = spawnEntity(state, { kind: EntityKind.Player, slot: 0, health: 100 })
    const diagonal = 1 / Math.SQRT2
    const rocket = spawnProjectile(state, shooter, ROCKET, [0, 0, 0], [diagonal, 0, diagonal])

    expect(rocket.velocity).toEqual([636, 0, 636])
    // So a diagonal rocket is fractionally slower than 900, exactly as Quake's
    // `SnapVector( bolt->s.pos.trDelta )` makes it.
    expect(lengthVec3(rocket.velocity)).toBeCloseTo(899.44, 2)
  })

  it('takes no gravity and no drag', () => {
    const { state, player } = shooterAt(-1000)
    tick(state, [cmd({ buttons: BUTTON_ATTACK })], HALL)

    const rocket = rocketsIn(state)[0]
    expect(rocket).toBeDefined()
    const launchHeight = rocket?.origin[2] ?? 0

    for (let i = 0; i < 20; i += 1) tick(state, [cmd()], HALL)

    const flying = rocketsIn(state)[0]
    expect(flying?.origin[2]).toBe(launchHeight)
    expect(flying?.velocity).toEqual(rocket?.velocity)
    expect(player.health).toBe(100)
  })
})

describe('a rocket in flight', () => {
  it('covers 7.2 units per sub-step after its first', () => {
    const { state } = shooterAt(-1000)
    tick(state, [cmd({ buttons: BUTTON_ATTACK })], HALL)

    const rocket = rocketsIn(state)[0]
    const before = rocket?.origin[0] ?? 0
    tick(state, [cmd()], HALL)

    expect((rocketsIn(state)[0]?.origin[0] ?? 0) - before).toBeCloseTo(ROCKET_SPEED * 0.008, 9)
  })

  it('detonates against a wall and is gone the same tick', () => {
    const { state } = shooterAt(990)
    tick(state, [cmd({ buttons: BUTTON_ATTACK })], HALL)

    // 990 + 14 of muzzle + 45 of prestep is past the wall at 1024, so the
    // rocket arrives on the tick it was fired rather than the one after.
    expect(rocketsIn(state)).toHaveLength(0)
  })

  it('never hits the player who fired it, but their own splash finds them', () => {
    const { state, player } = shooterAt(0)

    // Straight ahead into open air: the rocket passes through the shooter's own
    // box on its first 45 units and must not stop there.
    tick(state, [cmd({ buttons: BUTTON_ATTACK })], HALL)
    expect(rocketsIn(state)).toHaveLength(1)
    expect(player.health).toBe(100)

    // Then detonate it by hand where it stands, 45 units in front: inside the
    // splash radius, so the shooter takes half of the falloff.
    const rocket = rocketsIn(state)[0]
    expect(rocket).toBeDefined()
    if (rocket !== undefined) explodeProjectile(state, HALL, rocket)

    expect(player.health).toBeLessThan(100)
    expect(rocketsIn(state)).toHaveLength(0)
  })

  it('hits another player directly for 100 and does not splash them as well', () => {
    const { state, player } = shooterAt(0)
    const target = spawnEntity(state, {
      kind: EntityKind.Player,
      slot: 1,
      origin: vec3(400, 0, SURFACE_CLIP_EPSILON),
      health: 200,
    })

    tick(state, [cmd({ buttons: BUTTON_ATTACK })], HALL)
    expect(rocketsIn(state)).toHaveLength(1)
    for (let i = 0; i < 80 && rocketsIn(state).length > 0; i += 1) {
      tick(state, [cmd()], HALL)
    }
    expect(rocketsIn(state)).toHaveLength(0)

    // 100, not 200: Quake's splash deliberately skips whoever was hit directly.
    expect(target.health).toBe(100)
    // Pushed the way the rocket was flying, at five units of speed per point.
    expect(target.velocity[0]).toBeCloseTo(500, 6)
    expect(player.health).toBe(100)
  })

  it('explodes when its fuse runs out rather than disappearing', () => {
    const { state, player } = shooterAt(0)
    const rocket = spawnProjectile(state, player, ROCKET, [60, 0, 30], [0, 0, 1])
    // A short fuse, so the test does not have to run fifteen seconds of ticks.
    rocket.expireTick = state.tick + 2

    tick(state, [cmd()], HALL)
    expect(rocketsIn(state)).toHaveLength(1)
    expect(player.health).toBe(100)

    tick(state, [cmd()], HALL)
    expect(rocketsIn(state)).toHaveLength(0)
    // It went off where it was, and the shooter 60 units away felt it.
    expect(player.health).toBeLessThan(100)
  })

  it('carries the weapon that fired it, so a renderer knows what to draw', () => {
    const { state } = shooterAt(-1000)
    tick(state, [cmd({ buttons: BUTTON_ATTACK })], HALL)
    expect(rocketsIn(state)[0]?.weapon).toBe(Weapon.RocketLauncher)
  })
})

describe('rayBoxFraction', () => {
  const mins = [-15, -15, 0] as const
  const maxs = [15, 15, 56] as const

  it('reports where the ray enters the box', () => {
    expect(rayBoxFraction([-100, 0, 10], [100, 0, 10], [0, 0, 0], mins, maxs)).toBeCloseTo(
      85 / 200,
      9,
    )
  })

  it('is 1 for a miss, including one that passes above', () => {
    expect(rayBoxFraction([-100, 0, 10], [-50, 0, 10], [0, 0, 0], mins, maxs)).toBe(1)
    expect(rayBoxFraction([-100, 0, 80], [100, 0, 80], [0, 0, 0], mins, maxs)).toBe(1)
    expect(rayBoxFraction([-100, 100, 10], [100, 100, 10], [0, 0, 0], mins, maxs)).toBe(1)
  })

  it('is 0 for a ray that starts inside', () => {
    expect(rayBoxFraction([0, 0, 10], [100, 0, 10], [0, 0, 0], mins, maxs)).toBe(0)
  })

  it('handles a ray parallel to a face', () => {
    // Level with the box in z, so the z slab never constrains the interval.
    expect(rayBoxFraction([-100, 0, 20], [100, 0, 20], [0, 0, 0], mins, maxs)).toBeCloseTo(
      85 / 200,
      9,
    )
    expect(rayBoxFraction([-100, 0, 100], [100, 0, 100], [0, 0, 0], mins, maxs)).toBe(1)
  })
})
