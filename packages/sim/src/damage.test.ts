import { describe, expect, it } from 'vitest'

import { PLAYER_MAXS, PLAYER_MINS } from './bbox.ts'
import { boxBrush, createCollisionWorld } from './collide.ts'
import {
  KNOCKBACK_DAMAGE_CAP,
  KNOCKBACK_PER_DAMAGE,
  applyDamage,
  canDamage,
  distanceToBox,
  knockbackSpeed,
  knockbackTicksFor,
  radiusDamage,
} from './damage.ts'
import { lengthVec3, vec3 } from './math.ts'
import { BLOCK_DAMAGE_SCALE, SELF_DAMAGE_SCALE, SelfDamage } from './match/selfDamage.ts'
import { isSpawnProtected } from './match/spawn.ts'
import { EntityFlag, EntityKind, NO_ENTITY, createGameState, spawnEntity } from './state.ts'
import type { EntityState, GameState } from './state.ts'
import { WEAPONS } from './weapons.ts'

const ROCKET = WEAPONS[0]

/** A floor at z = 0 and nothing else, so splash reaches everywhere. */
const OPEN = createCollisionWorld([boxBrush([-1024, -1024, -64], [1024, 1024, 0])])

function worldWithPlayer(x = 0, y = 0, z = 0): { state: GameState; player: EntityState } {
  const state = createGameState(1)
  const player = spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    origin: vec3(x, y, z),
    health: 100,
  })
  return { state, player }
}

describe('distanceToBox', () => {
  it('is zero inside the box, which is why a rocket at your feet does full damage', () => {
    expect(distanceToBox([0, 0, 0], [0, 0, 0], PLAYER_MINS, PLAYER_MAXS)).toBe(0)
    expect(distanceToBox([10, -10, 30], [0, 0, 0], PLAYER_MINS, PLAYER_MAXS)).toBe(0)
  })

  it('measures to the nearest face, not to the centre', () => {
    // 48 from the origin is 33 from the side of a 30-wide box. That 15 units is
    // the whole reason dx = 48 is 72 damage rather than 60.
    expect(distanceToBox([48, 0, 0], [0, 0, 0], PLAYER_MINS, PLAYER_MAXS)).toBe(33)
    expect(distanceToBox([0, 0, 100], [0, 0, 0], PLAYER_MINS, PLAYER_MAXS)).toBe(44)
  })

  it('is Euclidean across corners', () => {
    expect(distanceToBox([15 + 3, 15 + 4, 0], [0, 0, 0], PLAYER_MINS, PLAYER_MAXS)).toBeCloseTo(5, 9)
  })
})

describe('the knockback formula', () => {
  it('is five and a half units of speed per point of damage', () => {
    expect(KNOCKBACK_PER_DAMAGE).toBe(5.5)
    expect(knockbackSpeed(100)).toBe(550)
    expect(knockbackSpeed(72)).toBe(396)
  })

  it('stops growing at the damage cap', () => {
    expect(knockbackSpeed(KNOCKBACK_DAMAGE_CAP + 500)).toBe(knockbackSpeed(KNOCKBACK_DAMAGE_CAP))
  })

  it('arms a 200 ms window for a full hit and a 50 ms floor for a scratch', () => {
    expect(knockbackTicksFor(100)).toBe(25)
    expect(knockbackTicksFor(1)).toBe(6)
  })
})

describe('applyDamage', () => {
  it('adds to the velocity rather than replacing it', () => {
    const { state, player } = worldWithPlayer()
    player.velocity = vec3(0, 0, 270)

    applyDamage(state, player, NO_ENTITY, [0, 0, 1], 100)

    // A jump you fire a rocket into keeps the jump. This is the whole of
    // `jump + rocket = 820`.
    expect(player.velocity[2]).toBe(820)
  })

  it('normalises the direction it is handed', () => {
    const { state, player } = worldWithPlayer()
    applyDamage(state, player, NO_ENTITY, [0, 0, 9999], 100)
    expect(player.velocity[2]).toBe(550)
  })

  it('halves self-damage in health but not in knockback', () => {
    // Stated in `full`, because that is the mode this rule *is*: the halving
    // happens after the push has been derived from the whole 100. What the
    // remainder then costs is `match/selfDamage.ts`'s, and the match default
    // (`health_only`) is exercised in `match/round.test.ts`.
    const { state, player } = worldWithPlayer()

    applyDamage(state, player, player.id, [0, 0, 1], 100, SelfDamage.Full)

    expect(player.velocity[2]).toBe(550)
    expect(player.health).toBe(100 - 100 * SELF_DAMAGE_SCALE)
  })

  it('only arms the knockback timer when one is not already running', () => {
    const { state, player } = worldWithPlayer()

    applyDamage(state, player, NO_ENTITY, [0, 0, 1], 100)
    expect(player.knockbackTicks).toBe(25)

    player.knockbackTicks = 3
    applyDamage(state, player, NO_ENTITY, [0, 0, 1], 100)
    expect(player.knockbackTicks).toBe(3)
  })

  it('charges a tenth for a hit taken behind a raised guard', () => {
    // Check 2 of GLAD-ZPE5LN, at the gate every hit passes through: 100 points
    // of anything cost 10 while `Blocking` is set, and the return value — what
    // the hit actually cost — says so too.
    const { state, player } = worldWithPlayer()
    player.flags |= EntityFlag.Blocking

    const absorbed = applyDamage(state, player, NO_ENTITY, [0, 0, 1], 100)

    expect(absorbed).toBe(100 * BLOCK_DAMAGE_SCALE)
    expect(player.health).toBe(90)
  })

  it('shoves a blocking player exactly as far as an unguarded one', () => {
    // The invariant the whole design hangs off: the guard changes the bill and
    // never the push, for the same reason the self-damage modes do not.
    const { state, player } = worldWithPlayer()
    const { player: guarded } = worldWithPlayer()
    guarded.flags |= EntityFlag.Blocking

    applyDamage(state, player, NO_ENTITY, [0, 0, 1], 100)
    applyDamage(state, guarded, NO_ENTITY, [0, 0, 1], 100)

    expect(guarded.velocity[2]).toBe(player.velocity[2])
    expect(guarded.knockbackTicks).toBe(player.knockbackTicks)
  })

  it('takes the tenth off the whole hit, not off what the armour left', () => {
    // 10 points in total, however they are split: 7 off the armour (`ceil(10 *
    // 0.66)`) and 3 off the health. Blocking after the armour instead would
    // make the discount depend on how much armour you happened to be standing
    // on, which is a rule nobody could count in their head.
    const { state, player } = worldWithPlayer()
    player.armor = 100
    player.flags |= EntityFlag.Blocking

    expect(applyDamage(state, player, NO_ENTITY, [0, 0, 1], 100)).toBe(10)
    expect(player.armor).toBe(93)
    expect(player.health).toBe(97)
  })

  it('does not let a guard discount your own splash', () => {
    // A raised shield is not a cheaper rocket jump. The push has already come
    // off the full 100 by this point, so blocking your own splash would buy the
    // launch for a tenth of its price — see `match/selfDamage.ts`.
    const { state, player } = worldWithPlayer()
    player.flags |= EntityFlag.Blocking

    applyDamage(state, player, player.id, [0, 0, 1], 100, SelfDamage.Full)

    expect(player.velocity[2]).toBe(550)
    expect(player.health).toBe(100 - 100 * SELF_DAMAGE_SCALE)
  })

  it('charges the full hit again once the guard comes down', () => {
    // Check 3 of GLAD-ZPE5LN. The same hit on the same body, with the one bit
    // cleared, is the number it has always been.
    const { state, player } = worldWithPlayer()

    expect(applyDamage(state, player, NO_ENTITY, [0, 0, 1], 100)).toBe(100)
    expect(player.health).toBe(0)
  })

  it('marks a player dead at zero health and then leaves them alone', () => {
    const { state, player } = worldWithPlayer()

    applyDamage(state, player, NO_ENTITY, [0, 0, 1], 100)
    expect(player.flags & EntityFlag.Dead).not.toBe(0)

    const velocity = player.velocity[2]
    applyDamage(state, player, NO_ENTITY, [0, 0, 1], 100)
    expect(player.velocity[2]).toBe(velocity)
  })
})

describe('radiusDamage', () => {
  it('deals 72 and 396 at 48 units, directed 45 degrees up and away', () => {
    // The acceptance check, and every number in it is a consequence of a
    // different Quake detail: 33 rather than 48 because distance is to the box,
    // 72 rather than 72.5 because damage truncates, 396 because knockback is
    // derived from the truncated figure, and 45 degrees because the direction
    // is measured from 24 above the feet and then biased 24 further up.
    const { state, player } = worldWithPlayer()

    radiusDamage(state, OPEN, [48, 0, 0], ROCKET.splashDamage, ROCKET.splashRadius, 99, NO_ENTITY)

    expect(player.health).toBe(100 - 72)
    expect(lengthVec3(player.velocity)).toBeCloseTo(396, 9)
    expect(player.velocity[0]).toBeCloseTo(-396 / Math.SQRT2, 9)
    expect(player.velocity[1]).toBe(0)
    expect(player.velocity[2]).toBeCloseTo(396 / Math.SQRT2, 9)
  })

  it('deals its full damage and a straight-up push at your feet', () => {
    const { state, player } = worldWithPlayer()

    radiusDamage(state, OPEN, [0, 0, 0], ROCKET.splashDamage, ROCKET.splashRadius, 99, NO_ENTITY)

    expect(player.health).toBe(0)
    expect(player.velocity).toEqual([0, 0, 550])
  })

  it('reaches nobody outside the radius', () => {
    const { state, player } = worldWithPlayer()

    radiusDamage(state, OPEN, [136, 0, 0], ROCKET.splashDamage, ROCKET.splashRadius, 99, NO_ENTITY)

    expect(player.health).toBe(100)
    expect(player.velocity).toEqual([0, 0, 0])
  })

  it('skips whoever took the direct hit', () => {
    const { state, player } = worldWithPlayer()

    radiusDamage(state, OPEN, [0, 0, 0], ROCKET.splashDamage, ROCKET.splashRadius, 99, player.id)

    expect(player.health).toBe(100)
  })

  it('does not pass through a wall', () => {
    // A slab between the explosion and the player, tall and wide enough that
    // none of `canDamage`'s five rays gets around it.
    const world = createCollisionWorld([
      boxBrush([-1024, -1024, -64], [1024, 1024, 0]),
      boxBrush([20, -256, 0], [28, 256, 256]),
    ])
    const { state, player } = worldWithPlayer()

    radiusDamage(state, world, [48, 0, 0], ROCKET.splashDamage, ROCKET.splashRadius, 99, NO_ENTITY)

    expect(player.health).toBe(100)
    expect(player.velocity).toEqual([0, 0, 0])
  })

  it('reaches around a pillar too narrow to block every ray, as Quake does', () => {
    // A pillar directly on the line to the middle of the box, but only 8 units
    // wide: the midpoint ray is blocked and a corner ray gets past. Quake's
    // occlusion test is five rays rather than a volume, and this is the shape
    // of its optimism — worth pinning so a change to it is a decision.
    const world = createCollisionWorld([
      boxBrush([-1024, -1024, -64], [1024, 1024, 0]),
      boxBrush([20, -4, 0], [28, 4, 256]),
    ])
    const { state, player } = worldWithPlayer()

    radiusDamage(state, world, [48, 0, 0], ROCKET.splashDamage, ROCKET.splashRadius, 99, NO_ENTITY)

    expect(player.health).toBe(100 - 72)
  })

  it('can see a player standing in the open', () => {
    const { player } = worldWithPlayer()
    expect(canDamage(OPEN, player, [48, 0, 0])).toBe(true)
  })

  it('respects spawn protection, which is currently a window of zero ticks', () => {
    // GLAD-AKODBZ decided the window is zero and left `isSpawnProtected` as the
    // seam; `applyDamage` calls it, so turning it on is one constant rather
    // than one constant and a search for the places that should have asked.
    const { state, player } = worldWithPlayer()
    expect(isSpawnProtected(state, player)).toBe(false)

    radiusDamage(state, OPEN, [0, 0, 0], ROCKET.splashDamage, ROCKET.splashRadius, 99, NO_ENTITY)
    expect(player.health).toBe(0)
  })
})
