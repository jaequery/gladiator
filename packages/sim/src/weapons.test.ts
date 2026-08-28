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
import { NEVER_FIRED, Weapon } from './weapon.ts'
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
  it('has exactly three entries, and a door that names all three', () => {
    expect(WEAPONS).toHaveLength(3)
    expect(WEAPONS.map((w) => w.id)).toEqual([
      Weapon.RocketLauncher,
      Weapon.Railgun,
      Weapon.Shield,
    ])

    // The table is a three-element tuple type, so a fourth entry is a type
    // error rather than a review comment. And the door agrees with it: a
    // command can only ever name one of these three, whatever arrives on the
    // wire.
    for (const junk of [Weapon.None, 4, -1, 1.5, 'railgun', null]) {
      const held = sanitizeUserCmd({ weapon: junk }).weapon
      expect(held).toBe(Weapon.RocketLauncher)
    }
    for (const id of WEAPONS.map((w) => w.id)) {
      expect(sanitizeUserCmd({ weapon: id }).weapon).toBe(id)
    }
  })

  it('gives every weapon unlimited ammo', () => {
    for (const weapon of WEAPONS) expect(weapon.ammo).toBe(AMMO_UNLIMITED)
  })

  it('carries Quake 3s numbers, and zero for the shield', () => {
    const [rocket, rail, shield] = WEAPONS
    expect(rocket).toMatchObject({
      damage: 100,
      splashDamage: 100,
      splashRadius: 120,
      refireMs: 800,
      speed: 900,
    })
    expect(rail).toMatchObject({ damage: 100, splashDamage: 0, refireMs: 1500, range: 8192 })
    // Every offensive number, including the refire it would need to have one.
    expect(shield).toMatchObject({
      damage: 0,
      splashDamage: 0,
      splashRadius: 0,
      refireMs: 0,
      refireTicks: 0,
      speed: 0,
      range: 0,
    })
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
  it('launches a standing player at 550 qu/s and about 201 units up', () => {
    const { state, player } = standing()

    const apex = apexOver(state, player, 240, (at) =>
      cmd({ pitch: DOWN, buttons: at === 0 ? BUTTON_ATTACK : 0 }),
    )

    // 550^2 / (2 * 750) = 201.67, and the movement reaches 201.52 of it: the
    // felt gravity is 750 rather than 800 because of velocity snapping, and the
    // apex lands between two whole ticks. `docs/physics-spec.md` §5.4 rounds
    // this *down* to 201 for map design, deliberately.
    expect(apex).toBeGreaterThan(197)
    expect(apex).toBeLessThan(207)
    expect(apex).toBeCloseTo(201.5, 1)
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

    // And it lands 3.7% under the closed form §5.4 designs to, for two reasons
    // that are both the price of the splash being a *real rocket* rather than
    // an assigned velocity. By the time the explosion lands, the jump has
    // already spent one sub-step of gravity (270 becomes 264), and the same
    // sub-step has lifted the player's feet 2.1 units off the floor the rocket
    // detonates against — which costs two points of splash and nine qu/s of
    // push. 264 + 541 = 805, and 805^2 / 1500 = 432.
    //
    // This shortfall is what caps `G_KNOCKBACK` at 1100: the mantle in the
    // next test is 18 units, and it has to cover it.
    expect(apex).toBeCloseTo(431.8, 1)
    expect(apexOf(JUMP_VELOCITY + ROCKET_JUMP_LAUNCH) - apex).toBeCloseTo(16.5, 1)
  })

  it('still gets a running player on to the 448-unit ledge §5.4 designs to', () => {
    // The apex above is 16.5 units under the design bound, and the bound is
    // still right — because of the slack §5.5 already names. `StepSlideMove` refuses
    // to step while rising and steps happily while falling, so a player
    // arriving at a ledge face on the way down mantles up to STEP_SIZE above
    // their apex. This is the assertion that keeps `maps/` honest: it drives a
    // real player with a real rocket at a ledge of exactly the height the map
    // validator promises is reachable.
    const height = 448
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
    expect(ROCKET_JUMP_LAUNCH).toBe(550)
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
    // Not exactly 550: the pitch clamp is 89 degrees rather than 90, so the
    // rocket drifts 0.8 units sideways over its first 45 and the push tilts by
    // a hair. Quake clamps the pitch for the same reason and pays the same
    // fraction of a unit.
    expect(player.velocity[2]).toBeCloseTo(550, 1)
    expect(player.knockbackTicks).toBe(25)
  })
})

describe('the railgun', () => {
  it('imparts 550 qu/s along the shooter aim', () => {
    const { state } = standing(0, 0)
    const target = spawnEntity(state, {
      kind: EntityKind.Player,
      slot: 1,
      origin: vec3(300, 0, SURFACE_CLIP_EPSILON),
      health: 100,
    })

    tick(state, [cmd({ buttons: BUTTON_ATTACK, weapon: Weapon.Railgun })], WORLD)

    expect(target.health).toBe(0)
    expect(lengthVec3(target.velocity)).toBeCloseTo(550, 6)
    // Fired down +x, so the push is down +x — not towards wherever on the box
    // the shot happened to land.
    expect(target.velocity[0]).toBeCloseTo(550, 6)
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
    expect(lengthVec3(target.velocity)).toBeCloseTo(550, 6)
    expect(target.velocity[2]).toBeLessThan(-88)
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

describe('the shield', () => {
  /**
   * Two players 200 units apart along +x, both standing on the floor.
   * `shooterSlot` says which of them does the shooting, because the whole point
   * of one of these tests is that the answer must not matter.
   *
   * `aim` is the yaw that points the shooter at the other one, and it has to be
   * carried on the *command*: the movement phase assigns `angles` from every
   * command it is handed, so a yaw written into the entity at spawn is gone by
   * the time the first shot is fired.
   */
  function duel(shooterSlot: 0 | 1): {
    state: GameState
    shooter: EntityState
    blocker: EntityState
    aim: number
  } {
    const state = createGameState(1)
    const at = (x: number, slot: number): EntityState =>
      spawnEntity(state, {
        kind: EntityKind.Player,
        slot,
        origin: vec3(x, 0, SURFACE_CLIP_EPSILON),
        health: 100,
      })

    // Spawned in slot order, so the entity array is [slot 0, slot 1] and a
    // slot-order bug has somewhere to hide.
    const first = at(0, 0)
    const second = at(200, 1)
    const facingBack = Math.round(180 * ANGLE_UNITS_PER_DEGREE)

    return shooterSlot === 0
      ? { state, shooter: first, blocker: second, aim: 0 }
      : { state, shooter: second, blocker: first, aim: facingBack }
  }

  it('raises the guard while the shield is held and the trigger is down', () => {
    const { state, player } = standing()

    tick(state, [cmd({ weapon: Weapon.Shield, buttons: BUTTON_ATTACK })], WORLD)
    expect(player.weapon).toBe(Weapon.Shield)
    expect(player.flags & EntityFlag.Blocking).not.toBe(0)

    // Holding the shield is not blocking with it. The button is the guard.
    tick(state, [cmd({ weapon: Weapon.Shield })], WORLD)
    expect(player.flags & EntityFlag.Blocking).toBe(0)

    // And switching away drops it on the tick of the switch, trigger or no.
    tick(state, [cmd({ weapon: Weapon.Shield, buttons: BUTTON_ATTACK })], WORLD)
    tick(state, [cmd({ weapon: Weapon.Railgun, buttons: BUTTON_ATTACK })], WORLD)
    expect(player.flags & EntityFlag.Blocking).toBe(0)
  })

  it('fires nothing, and does not spend or delay a shot', () => {
    const { state, player } = standing()

    for (let i = 0; i < 200; i += 1) {
      tick(state, [cmd({ weapon: Weapon.Shield, buttons: BUTTON_ATTACK, pitch: DOWN })], WORLD)
    }

    // No rocket, no trace, no muzzle flash, and above all no rocket at the
    // player's own feet: a shield that fired would kill the player holding it.
    expect(state.entities.some((e) => e.kind === EntityKind.Projectile)).toBe(false)
    expect(player.lastFireTick).toBe(NEVER_FIRED)
    expect(player.health).toBe(100)

    // The refire timer is untouched, so lowering the guard shoots immediately.
    expect(player.nextFireTick).toBe(0)
    tick(state, [cmd({ weapon: Weapon.Railgun, buttons: BUTTON_ATTACK })], WORLD)
    expect(player.lastFireTick).toBe(state.tick)
  })

  it('takes a tenth of a rail, whichever slot the blocker is in', () => {
    // The ordering test, and the reason raising the guard is a phase of its own
    // (`holdWeapons`). Both guards are settled before the first shot of the
    // tick, so a shield raised on the same tick as the shot that hits it blocks
    // that shot — in either slot. Written the tick the button goes down,
    // because that is the tick a per-entity write would get wrong for exactly
    // one of the two arrangements.
    for (const shooterSlot of [0, 1] as const) {
      const { state, shooter, blocker, aim } = duel(shooterSlot)
      const inputs: UserCmd[] = []
      inputs[shooter.slot] = cmd({ weapon: Weapon.Railgun, buttons: BUTTON_ATTACK, yaw: aim })
      inputs[blocker.slot] = cmd({ weapon: Weapon.Shield, buttons: BUTTON_ATTACK })

      tick(state, inputs, WORLD)

      expect(shooter.lastFireTick).toBe(state.tick)
      expect(blocker.health).toBe(90)
    }
  })

  it('costs the full hit again the moment the shield is put away', () => {
    const { state, shooter, blocker, aim } = duel(0)
    const shooting = cmd({ weapon: Weapon.Railgun, buttons: BUTTON_ATTACK, yaw: aim })

    const inputs: UserCmd[] = []
    inputs[shooter.slot] = shooting
    inputs[blocker.slot] = cmd({ weapon: Weapon.Shield, buttons: BUTTON_ATTACK })
    tick(state, inputs, WORLD)
    expect(blocker.health).toBe(90)

    // A rail every 1500 ms, so the second shot needs the timer to come round.
    inputs[blocker.slot] = cmd({ weapon: Weapon.Railgun })
    for (let i = 0; i < 200; i += 1) tick(state, inputs, WORLD)

    expect(blocker.weapon).toBe(Weapon.Railgun)
    expect(blocker.flags & EntityFlag.Blocking).toBe(0)
    expect(blocker.health).toBe(-10)
  })
})

describe('ammo', () => {
  it('never runs out over a match-length burst from either weapon that fires', () => {
    // Ten minutes of holding the trigger, which is longer than any match will
    // be. There is no ammunition state to decrement, so the only thing that can
    // stop a shot is the refire interval — and the assertion is that the
    // cadence at the end is exactly the cadence at the start.
    const MATCH_TICKS = 75_000

    // The shield is skipped rather than special-cased: it has no refire
    // interval because it has no shot, so "the cadence never changes" is not a
    // question that can be asked of it.
    for (const weapon of WEAPONS.filter((w) => w.refireTicks > 0)) {
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
