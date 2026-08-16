import { describe, expect, it } from 'vitest'

import { PLAYER_VIEW_HEIGHT } from './bbox.ts'
import { boxBrush, createCollisionWorld } from './collide.ts'
import type { CollisionWorld } from './collide.ts'
import { tick } from './kernel.ts'
import { lengthVec3, vec3 } from './math.ts'
import { ROCKET_JUMP_LAUNCH, apexOf } from './map/reachability.ts'
import { JUMP_VELOCITY } from './pmove/index.ts'
import { EntityFlag, EntityKind, createGameState, spawnEntity } from './state.ts'
import type { EntityState, GameState } from './state.ts'
import { TICK_INTERVAL_MS } from './tick.ts'
import { SURFACE_CLIP_EPSILON } from './trace.ts'
import {
  ANGLE_UNITS_PER_DEGREE,
  BUTTON_ATTACK,
  BUTTON_JUMP,
  MAX_PITCH_UNITS,
  NULL_CMD,
  sanitizeUserCmd,
} from './usercmd.ts'
import type { UserCmd } from './usercmd.ts'
import { Weapon } from './weapon.ts'
import { AMMO_UNLIMITED, MUZZLE_FORWARD, WEAPONS, muzzlePoint, refireTicksOf } from './weapons.ts'

/**
 * A sealed box with the floor at z = 0. Big enough that a rocket fired level
 * from the middle takes a while to arrive, and small enough to be cheap.
 */
function arena(): CollisionWorld {
  return createCollisionWorld([
    boxBrush([-1024, -1024, -64], [1024, 1024, 0]),
    boxBrush([-1024, -1024, 512], [1024, 1024, 576]),
    boxBrush([1024, -1088, -64], [1088, 1088, 576]),
    boxBrush([-1088, -1088, -64], [-1024, 1088, 576]),
    boxBrush([-1024, 1024, -64], [1024, 1088, 576]),
    boxBrush([-1024, -1088, -64], [1024, -1024, 576]),
  ])
}

const WORLD = arena()

/** Looking straight down, as far as the pitch clamp allows. */
const DOWN = MAX_PITCH_UNITS

function standing(x = 0, y = 0): { state: GameState; player: EntityState } {
  const state = createGameState(1)
  const player = spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    // A spawn names a floor height and a resting body sits an eighth of a unit
    // clear of it, exactly as `createSkeletonState` does.
    origin: vec3(x, y, SURFACE_CLIP_EPSILON),
    health: 100,
    // What a round stands a player up with, and — under the default
    // self-damage mode — the only thing a rocket jump can cost them.
    armor: 100,
  })
  return { state, player }
}

function cmd(over: Partial<UserCmd> = {}): UserCmd {
  return { ...NULL_CMD, ...over }
}

/**
 * Run `ticks` sub-steps of `state`, returning the highest the player's feet
 * got above where they started.
 *
 * `commands` is consulted per tick so a test can press a button on exactly one
 * of them, which is the whole subject here.
 */
function apexOver(
  state: GameState,
  player: EntityState,
  ticks: number,
  commands: (atTick: number) => UserCmd,
): number {
  const start = player.origin[2]
  let apex = 0
  for (let i = 0; i < ticks; i += 1) {
    tick(state, [commands(i)], WORLD)
    const height = player.origin[2] - start
    if (height > apex) apex = height
  }
  return apex
}

describe('the weapon table', () => {
  it('has exactly two entries, and always will', () => {
    expect(WEAPONS).toHaveLength(2)
    expect(WEAPONS.map((w) => w.id)).toEqual([Weapon.RocketLauncher, Weapon.Railgun])

    // The table is a two-element tuple type, so a third entry is a type error
    // rather than a review comment. And the door agrees with it: a command can
    // only ever name one of these two, whatever arrives on the wire.
    for (const junk of [Weapon.None, 3, -1, 1.5, 'railgun', null]) {
      const held = sanitizeUserCmd({ weapon: junk }).weapon
      expect(WEAPONS.some((w) => w.id === held)).toBe(true)
    }
  })

  it('gives both weapons unlimited ammo', () => {
    for (const weapon of WEAPONS) expect(weapon.ammo).toBe(AMMO_UNLIMITED)
  })

  it('carries Quake 3s numbers', () => {
    const [rocket, rail] = WEAPONS
    expect(rocket).toMatchObject({
      damage: 100,
      splashDamage: 100,
      splashRadius: 120,
      refireMs: 800,
      speed: 900,
    })
    expect(rail).toMatchObject({ damage: 100, splashDamage: 0, refireMs: 1500, range: 8192 })
  })

  it('rounds a refire interval up to whole sub-steps', () => {
    // 800 ms is exactly 100 ticks; 1500 ms is 187.5 and becomes 188, because
    // rounding down would be a free increase in damage per second.
    expect(refireTicksOf(800)).toBe(100)
    expect(refireTicksOf(1500)).toBe(188)
    expect(WEAPONS[0].refireTicks * TICK_INTERVAL_MS).toBe(800)
    expect(WEAPONS[1].refireTicks * TICK_INTERVAL_MS).toBe(1504)
  })
})

describe('the muzzle', () => {
  it('sits at eye height, 14 units along the aim, on whole units', () => {
    const { player } = standing()
    player.origin = vec3(10, 20, 30)

    expect(muzzlePoint(vec3(), player, [1, 0, 0])).toEqual([
      10 + MUZZLE_FORWARD,
      20,
      30 + PLAYER_VIEW_HEIGHT,
    ])
  })

  it('drops 14 units below the eye when you look at your feet', () => {
    // Which is what puts the floor inside the rocket's 45-unit first step. See
    // `projectile.ts`.
    const { player } = standing()
    const muzzle = muzzlePoint(vec3(), player, [0, 0, -1])
    expect(muzzle[2]).toBe(Math.round(SURFACE_CLIP_EPSILON + PLAYER_VIEW_HEIGHT - MUZZLE_FORWARD))
  })
})

describe('the rocket jump', () => {
  it('launches a standing player at 500 qu/s and about 166 units up', () => {
    const { state, player } = standing()

    const apex = apexOver(state, player, 240, (at) =>
      cmd({ pitch: DOWN, buttons: at === 0 ? BUTTON_ATTACK : 0 }),
    )

    // 500^2 / (2 * 750) = 166.67, and the movement reaches 166.66 of it: the
    // felt gravity is 750 rather than 800 because of velocity snapping, and the
    // apex lands between two whole ticks. `docs/physics-spec.md` §5.4 rounds
    // this *down* to 166 for map design, deliberately.
    expect(apex).toBeGreaterThan(162)
    expect(apex).toBeLessThan(172)
    expect(apex).toBeCloseTo(166.5, 1)
  })

  it('adds the jump to the rocket rather than replacing it', () => {
    const { state, player } = standing()

    const apex = apexOver(state, player, 400, (at) =>
      cmd({ pitch: DOWN, buttons: at === 0 ? BUTTON_ATTACK | BUTTON_JUMP : 0 }),
    )

    // Comfortably past a jump and past a standing rocket jump: the two
    // compose, which is the property `PM_CheckJump` assigning `velocity[2]`
    // makes fragile and the phase order protects.
    expect(apex).toBeGreaterThan(apexOf(JUMP_VELOCITY) + apexOf(ROCKET_JUMP_LAUNCH))

    // And it lands 3.6% under the closed form §5.4 designs to, for two reasons
    // that are both the price of the splash being a *real rocket* rather than
    // an assigned velocity. By the time the explosion lands, the jump has
    // already spent one sub-step of gravity (270 becomes 264), and the same
    // sub-step has lifted the player's feet 2.1 units off the floor the rocket
    // detonates against — which costs two points of splash and ten qu/s of
    // push. 264 + 490 = 754, and 754^2 / 1500 = 379.
    expect(apex).toBeCloseTo(380.9, 1)
    expect(apexOf(JUMP_VELOCITY + ROCKET_JUMP_LAUNCH) - apex).toBeCloseTo(14.3, 1)
  })

  it('still gets a running player on to the 395-unit ledge §5.4 designs to', () => {
    // The apex above is 14 units under the design bound, and the bound is still
    // right — because of the slack §5.5 already names. `StepSlideMove` refuses
    // to step while rising and steps happily while falling, so a player
    // arriving at a ledge face on the way down mantles up to STEP_SIZE above
    // their apex. This is the assertion that keeps `maps/` honest: it drives a
    // real player with a real rocket at a ledge of exactly the height the map
    // validator promises is reachable.
    const height = 395
    const lip = 512
    const world = createCollisionWorld([
      boxBrush([-4096, -4096, -64], [4096, 4096, 0]),
      boxBrush([lip, -4096, 0], [4096, 4096, height]),
    ])
    const state = createGameState(1)
    const player = spawnEntity(state, {
      kind: EntityKind.Player,
      slot: 0,
      origin: vec3(-1400, 0, SURFACE_CLIP_EPSILON),
      // Plenty of both, so this measures the climb rather than the round rules.
      health: 1000,
      armor: 1000,
    })

    const run = cmd({ forwardMove: 1 })
    // Fire 16 units short of the ledge, running flat out at it.
    const launch = cmd({ forwardMove: 1, pitch: DOWN, buttons: BUTTON_JUMP | BUTTON_ATTACK })

    let launched = false
    let landed = false
    for (let i = 0; i < 900; i += 1) {
      const fire = !launched && player.origin[0] >= lip - 16
      if (fire) launched = true
      tick(state, [fire ? launch : run], world)
      if (launched && (player.flags & EntityFlag.OnGround) !== 0 && player.origin[2] > height - 1) {
        landed = true
        break
      }
    }

    expect(landed).toBe(true)
    expect(player.origin[2]).toBeGreaterThanOrEqual(height)
  })

  it('is the launch `map/reachability.ts` designs ledges around', () => {
    expect(ROCKET_JUMP_LAUNCH).toBe(500)
  })

  it('costs half your health and none of your armour', () => {
    const { state, player } = standing()
    tick(state, [cmd({ pitch: DOWN, buttons: BUTTON_ATTACK })], WORLD)

    // 100 points of splash, halved because it is your own, and then charged
    // entirely to the health — the default `health_only` mode never consults
    // the armour for your own rocket (`match/selfDamage.ts`). The full 100 went
    // into the knockback before any of that, which is why the push below is
    // unchanged and is the same in all four modes.
    expect(player.armor).toBe(100)
    expect(player.health).toBe(50)
    // Not exactly 500: the pitch clamp is 89 degrees rather than 90, so the
    // rocket drifts 0.8 units sideways over its first 45 and the push tilts by
    // a hair. Quake clamps the pitch for the same reason and pays the same
    // fraction of a unit.
    expect(player.velocity[2]).toBeCloseTo(500, 1)
    expect(player.knockbackTicks).toBe(25)
  })
})

describe('the railgun', () => {
  it('imparts 500 qu/s along the shooter aim', () => {
    const { state } = standing(0, 0)
    const target = spawnEntity(state, {
      kind: EntityKind.Player,
      slot: 1,
      origin: vec3(300, 0, SURFACE_CLIP_EPSILON),
      health: 100,
    })

    tick(state, [cmd({ buttons: BUTTON_ATTACK, weapon: Weapon.Railgun })], WORLD)

    expect(target.health).toBe(0)
    expect(lengthVec3(target.velocity)).toBeCloseTo(500, 6)
    // Fired down +x, so the push is down +x — not towards wherever on the box
    // the shot happened to land.
    expect(target.velocity[0]).toBeCloseTo(500, 6)
    expect(target.velocity[1]).toBeCloseTo(0, 9)
    expect(target.velocity[2]).toBeCloseTo(0, 9)
    expect(target.knockbackTicks).toBe(25)
  })

  it('pushes along the aim even when the aim is angled', () => {
    const { state, player } = standing(0, 0)
    const target = spawnEntity(state, {
      kind: EntityKind.Player,
      slot: 1,
      origin: vec3(200, 0, SURFACE_CLIP_EPSILON),
      health: 100,
    })
    // Ten degrees down at a target 200 units away: the shot lands low on a
    // 56-unit box, and the push tilts with the aim rather than with where on
    // the box it connected.
    const pitch = Math.round(10 * ANGLE_UNITS_PER_DEGREE)

    tick(state, [cmd({ pitch, buttons: BUTTON_ATTACK, weapon: Weapon.Railgun })], WORLD)

    expect(target.health).toBe(0)
    expect(lengthVec3(target.velocity)).toBeCloseTo(500, 6)
    expect(target.velocity[2]).toBeLessThan(-80)
    // And the shooter feels nothing. A railgun has recoil in no Quake.
    expect(player.velocity).toEqual([0, 0, 0])
  })

  it('stops at a wall rather than shooting through it', () => {
    const world = createCollisionWorld([
      boxBrush([-1024, -1024, -64], [1024, 1024, 0]),
      boxBrush([100, -256, 0], [108, 256, 256]),
    ])
    const state = createGameState(1)
    spawnEntity(state, {
      kind: EntityKind.Player,
      slot: 0,
      origin: vec3(0, 0, SURFACE_CLIP_EPSILON),
      health: 100,
    })
    const target = spawnEntity(state, {
      kind: EntityKind.Player,
      slot: 1,
      origin: vec3(300, 0, SURFACE_CLIP_EPSILON),
      health: 100,
    })

    tick(state, [cmd({ buttons: BUTTON_ATTACK, weapon: Weapon.Railgun })], world)

    expect(target.health).toBe(100)
    expect(target.velocity).toEqual([0, 0, 0])
  })

  it('spawns no entity — it is hitscan', () => {
    const { state } = standing()
    tick(state, [cmd({ buttons: BUTTON_ATTACK, weapon: Weapon.Railgun })], WORLD)
    expect(state.entities.filter((e) => e.kind === EntityKind.Projectile)).toHaveLength(0)
  })
})

describe('refire', () => {
  it('holds a weapon to its interval however hard the button is held', () => {
    const { state, player } = standing()
    let shots = 0

    // Aimed level at a distant wall, so nothing that happens downrange
    // interferes with the player doing the shooting.
    for (let i = 0; i < 500; i += 1) {
      const before = player.nextFireTick
      tick(state, [cmd({ buttons: BUTTON_ATTACK })], WORLD)
      if (player.nextFireTick !== before) shots += 1
    }

    expect(shots).toBe(1 + Math.floor(499 / WEAPONS[0].refireTicks))
  })

  it('shares one timer between the two weapons', () => {
    const { state, player } = standing()

    tick(state, [cmd({ buttons: BUTTON_ATTACK })], WORLD)
    const after = player.nextFireTick

    // Switching does not reset the timer, so a switch cannot be used to fire
    // sooner than either weapon's interval allows.
    tick(state, [cmd({ buttons: BUTTON_ATTACK, weapon: Weapon.Railgun })], WORLD)
    expect(player.nextFireTick).toBe(after)
    expect(player.weapon).toBe(Weapon.Railgun)
  })
})

describe('ammo', () => {
  it('never runs out over a match-length burst from either weapon', () => {
    // Ten minutes of holding the trigger, which is longer than any match will
    // be. There is no ammunition state to decrement, so the only thing that can
    // stop a shot is the refire interval — and the assertion is that the
    // cadence at the end is exactly the cadence at the start.
    const MATCH_TICKS = 75_000

    for (const weapon of WEAPONS) {
      const { state, player } = standing()
      // Facing a wall 1024 away, so the player's own splash never reaches them
      // and they stay alive for the whole burst.
      let shots = 0
      let first = -1
      let last = -1

      for (let i = 0; i < MATCH_TICKS; i += 1) {
        const before = player.nextFireTick
        tick(state, [cmd({ buttons: BUTTON_ATTACK, weapon: weapon.id })], WORLD)
        if (player.nextFireTick !== before) {
          shots += 1
          if (first < 0) first = state.tick
          last = state.tick
        }
      }

      expect(player.health).toBe(100)
      expect(shots).toBe(1 + Math.floor((MATCH_TICKS - 1) / weapon.refireTicks))
      expect(last - first).toBe((shots - 1) * weapon.refireTicks)
    }
  })
})
