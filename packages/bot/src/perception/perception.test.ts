/**
 * The four channels, one claim at a time.
 *
 * `fairness.test.ts` asserts the *boundary* — that nothing unperceived reaches
 * the bot's output. This asserts the perception itself: that the cone is the
 * width it says it is, that the two visibility thresholds are two different
 * thresholds, that a footstep below the walk speed is silent, and that a belief
 * nobody refreshes decays in a straight line to exactly zero.
 *
 * Several of these drive `observe` over a hand-built world rather than through
 * `runBot`. That is deliberate: the world is a *parameter*, so a test can hand
 * the same two bodies a different geometry on successive sub-steps and watch
 * cover appear and disappear — which is the only way to reach the acquisition
 * and maintenance thresholds separately.
 */

import {
  BUTTON_ATTACK,
  EntityKind,
  MatchPhase,
  PLAYER_VIEW_HEIGHT,
  SPAWN_ARMOR,
  SPAWN_HEALTH,
  TICK_DT,
  Weapon,
  createGameState,
  seedRng,
  spawnEntity,
  yawUnitsFromDegrees,
} from '@gladiator/sim'
import type { CollisionWorld, EntityState, GameState, RngHolder, Vec3 } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  FLOOR,
  angleBetween,
  bearingDegrees,
  beamWorld,
  createArena,
  emptyWorld,
  place,
  runBot,
} from './fixture.ts'
import { createPerception, observe } from './perceive.ts'
import type { Perception } from './perceive.ts'
import { coneCosine, visibilityFraction } from './sight.ts'
import {
  ACQUIRE_VISIBILITY,
  ALERT_TICKS,
  DAMAGE_ASSUMED_RANGE,
  FOOTSTEP_INTERVAL_TICKS,
  MEMORY_TICKS,
  SIGHT_FOV_DEGREES,
  SIGHT_HOLD_TICKS,
  SIGHT_RANGE,
  UNCERTAINTY_GROWTH,
  confidenceOf,
} from './worldModel.ts'

const RADIANS_PER_DEGREE = Math.PI / 180

/* --------------------------------------------------------------------------
 * Sight: the cone, the gate, the fraction
 * ----------------------------------------------------------------------- */

/** A body `distance` away at `degrees` off the bot's dead ahead, on the flat. */
function bodyAt(distance: number, degrees: number): Vec3 {
  const radians = degrees * RADIANS_PER_DEGREE
  return [distance * Math.cos(radians), distance * Math.sin(radians), 0]
}

const EYE: Vec3 = [0, 0, PLAYER_VIEW_HEIGHT]
const AHEAD: Vec3 = [1, 0, 0]

function fractionOf(world: CollisionWorld, origin: Vec3, fov = SIGHT_FOV_DEGREES): number {
  return visibilityFraction(world, EYE, AHEAD, coneCosine(fov), SIGHT_RANGE, origin)
}

describe('the sight cone', () => {
  const world = emptyWorld()

  it('sees a body well inside it', () => {
    expect(fractionOf(world, bodyAt(1000, 0))).toBe(1)
    expect(fractionOf(world, bodyAt(1000, 45))).toBe(1)
    expect(fractionOf(world, bodyAt(1000, -45))).toBe(1)
  })

  it('is a hundred degrees, not two hundred', () => {
    // Past the half-angle, which is the mistake worth having a test for: using
    // the full width as the half-angle gives a bot that sees behind itself.
    expect(fractionOf(world, bodyAt(1000, 55))).toBe(0)
    expect(fractionOf(world, bodyAt(1000, -55))).toBe(0)
    expect(fractionOf(world, bodyAt(1000, 180))).toBe(0)
  })

  it('widens when the bot is alert', () => {
    expect(fractionOf(world, bodyAt(1000, 70), 160)).toBe(1)
    expect(fractionOf(world, bodyAt(1000, 70))).toBe(0)
  })

  it('has a range gate', () => {
    expect(fractionOf(world, bodyAt(SIGHT_RANGE - 100, 0))).toBe(1)
    expect(fractionOf(world, bodyAt(SIGHT_RANGE + 100, 0))).toBe(0)
  })
})

describe('the visibility fraction', () => {
  const target = bodyAt(400, 0)

  it('is 1 with nothing in the way', () => {
    expect(fractionOf(emptyWorld(), target)).toBe(1)
  })

  it('is 0 behind a wall', () => {
    expect(fractionOf(beamWorld(-100, 600), target)).toBe(0)
  })

  it('drops the legs behind a low wall, and keeps the rest', () => {
    // The chest and head rays clear a 30-unit wall at the midpoint; the legs
    // ray does not.
    expect(fractionOf(beamWorld(-100, 30), target)).toBe(0.875)
  })

  it('keeps only the head over a waist-high wall', () => {
    expect(fractionOf(beamWorld(-100, 45), target)).toBe(0.375)
  })

  it('leaves only a pair of legs under a hanging beam', () => {
    // The one case the weighting exists for: below the acquisition threshold,
    // above zero. Spotting somebody by their feet is not a thing; keeping
    // track of somebody you can see the feet of is.
    const legs = fractionOf(beamWorld(35, 600), target)
    expect(legs).toBe(0.125)
    expect(legs).toBeLessThan(ACQUIRE_VISIBILITY)
    expect(legs).toBeGreaterThan(0)
  })
})

/* --------------------------------------------------------------------------
 * A bench: two bodies, and whatever geometry the test wants this sub-step
 * ----------------------------------------------------------------------- */

type Bench = {
  state: GameState
  perception: Perception
  rng: RngHolder
  self: EntityState
  enemy: EntityState
  /** Advance one sub-step and perceive, through `world`. */
  step: (world: CollisionWorld) => void
}

function bench(selfOrigin: Vec3, enemyOrigin: Vec3, yawDegrees = 0): Bench {
  const state = createGameState(1)
  const rng: RngHolder = { rng: seedRng(1) }
  const self = spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    origin: [selfOrigin[0], selfOrigin[1], selfOrigin[2]],
    angles: [0, yawUnitsFromDegrees(yawDegrees), 0],
    health: SPAWN_HEALTH,
    armor: SPAWN_ARMOR,
    weapon: Weapon.RocketLauncher,
  })
  const enemy = spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 1,
    origin: [enemyOrigin[0], enemyOrigin[1], enemyOrigin[2]],
    health: SPAWN_HEALTH,
    armor: SPAWN_ARMOR,
    weapon: Weapon.RocketLauncher,
  })
  const perception = createPerception(0, rng)
  return {
    state,
    perception,
    rng,
    self,
    enemy,
    step: (world) => {
      state.tick += 1
      observe(perception, { state, world })
    },
  }
}

describe('acquiring and maintaining are two different thresholds', () => {
  const clear = emptyWorld()
  const legsOnly = beamWorld(35, 600)
  const blocked = beamWorld(-100, 600)

  it('will not start a contact from a pair of legs', () => {
    const b = bench([0, 0, 0], [400, 0, 0])
    for (let i = 0; i < 5; i += 1) b.step(legsOnly)
    expect(b.perception.model.enemy.source).toBe('none')
  })

  it('will keep one', () => {
    const b = bench([0, 0, 0], [400, 0, 0])
    b.step(clear)
    expect(b.perception.model.enemy.visible).toBe(true)

    b.step(legsOnly)
    expect(b.perception.model.enemy.visible).toBe(true)
    expect(b.perception.model.enemy.visibility).toBe(0.125)
    expect(b.perception.model.enemy.confidence).toBe(1)
  })

  it('stops keeping one once the break outlasts the hold window', () => {
    const b = bench([0, 0, 0], [400, 0, 0])
    b.step(clear)
    for (let i = 0; i <= SIGHT_HOLD_TICKS; i += 1) b.step(blocked)

    // Still remembered — the memory window is far longer than the hold window.
    expect(b.perception.model.enemy.source).toBe('sight')
    expect(b.perception.model.enemy.visible).toBe(false)

    // And a pair of legs is no longer enough to get it back.
    b.step(legsOnly)
    expect(b.perception.model.enemy.visible).toBe(false)
  })

  it('re-acquires from a break shorter than the hold window', () => {
    const b = bench([0, 0, 0], [400, 0, 0])
    b.step(clear)
    for (let i = 0; i < SIGHT_HOLD_TICKS - 2; i += 1) b.step(blocked)
    b.step(legsOnly)
    expect(b.perception.model.enemy.visible).toBe(true)
  })
})

/* --------------------------------------------------------------------------
 * Memory
 * ----------------------------------------------------------------------- */

describe('memory', () => {
  const clear = emptyWorld()
  const blocked = beamWorld(-100, 600)

  it('decays in a straight line to exactly zero', () => {
    const b = bench([0, 0, 0], [400, 0, 0])
    b.step(clear)
    const samples: number[] = []
    for (let age = 1; age <= MEMORY_TICKS; age += 1) {
      b.step(blocked)
      samples.push(b.perception.model.enemy.confidence)
    }

    expect(samples[0]).toBeCloseTo(1 - 1 / MEMORY_TICKS, 10)
    expect(samples[Math.floor(MEMORY_TICKS / 2) - 1]).toBeCloseTo(0.5, 2)
    expect(samples[MEMORY_TICKS - 1]).toBe(0)
    expect(b.perception.model.enemy.source).toBe('none')

    // Straight: every step down is the same size, which is what makes "reaches
    // zero at 2.2 seconds" a fact rather than an asymptote.
    const first = (samples[1] ?? 0) - (samples[0] ?? 0)
    for (let i = 2; i < MEMORY_TICKS - 1; i += 1) {
      expect((samples[i] ?? 0) - (samples[i - 1] ?? 0)).toBeCloseTo(first, 10)
    }
  })

  it('dead-reckons along the velocity it last saw, and blurs while it does', () => {
    const b = bench([0, 0, 0], [400, 0, 0])
    b.enemy.velocity[1] = 320
    b.step(clear)
    expect(b.perception.model.enemy.velocity[1]).toBe(320)

    b.step(blocked)
    expect(b.perception.model.enemy.origin[1]).toBeCloseTo(320 * TICK_DT, 9)
    expect(b.perception.model.enemy.uncertainty).toBeCloseTo(UNCERTAINTY_GROWTH * TICK_DT, 9)

    b.step(blocked)
    expect(b.perception.model.enemy.origin[1]).toBeCloseTo(2 * 320 * TICK_DT, 9)
    expect(b.perception.model.enemy.uncertainty).toBeCloseTo(2 * UNCERTAINTY_GROWTH * TICK_DT, 9)
  })

  it('does not reckon a body through a wall', () => {
    // Sighted while running straight at the beam, then hidden. Sliding the
    // belief along the velocity would put it inside solid; the trace stops it.
    const b = bench([0, 0, 0], [100, 0, 0])
    b.enemy.velocity[0] = 3000
    b.step(clear)
    for (let i = 0; i < 40; i += 1) b.step(beamWorld(-100, 600))
    expect(b.perception.model.enemy.origin[0]).toBeLessThan(180)
  })

  it('is voided by a round boundary', () => {
    const b = bench([0, 0, 0], [400, 0, 0])
    b.step(clear)
    expect(b.perception.model.enemy.source).toBe('sight')

    b.state.match.round += 1
    b.state.match.phase = MatchPhase.Live
    b.step(blocked)
    expect(b.perception.model.enemy.source).toBe('none')
    expect(b.perception.model.match.round).toBe(b.state.match.round)
  })
})

/* --------------------------------------------------------------------------
 * Sound
 * ----------------------------------------------------------------------- */

describe('hearing', () => {
  /** A shot from `gap` units away, from a position the bot cannot see. */
  function shotFrom(gap: number): ReturnType<typeof createArena> {
    const arena = createArena({
      botOrigin: [0, -900, FLOOR],
      botYawDegrees: 270,
      enemyOrigin: [gap, -900, FLOOR],
    })
    runBot(arena, 6, {
      before: (a, step) => {
        if (step === 2) a.enemy.lastFireTick = a.state.tick
      },
    })
    return arena
  }

  it('carries a shot to 1800 units and no further', () => {
    expect(shotFrom(1700).bot.worldModel.enemy.source).toBe('sound')
    expect(shotFrom(1900).bot.worldModel.enemy.source).toBe('none')
  })

  it('says what weapon it was, because that is what a shot sounds like', () => {
    const arena = createArena({
      botOrigin: [0, -900, FLOOR],
      botYawDegrees: 270,
      enemyOrigin: [0, -400, FLOOR],
    })
    runBot(arena, 4, {
      enemyCmd: (step) => ({
        forwardMove: 0,
        sideMove: 0,
        yaw: yawUnitsFromDegrees(90),
        pitch: 0,
        buttons: step === 2 ? BUTTON_ATTACK : 0,
        weapon: Weapon.Railgun,
      }),
    })
    expect(arena.bot.worldModel.enemy.source).toBe('sound')
    expect(arena.bot.worldModel.enemy.weapon).toBe(Weapon.Railgun)
  })

  it('never displaces a body the bot is looking straight at', () => {
    const arena = createArena({
      botOrigin: [0, -900, FLOOR],
      botYawDegrees: 90,
      enemyOrigin: [0, -400, FLOOR],
    })
    runBot(arena, 8, {
      before: (a, step) => {
        if (step >= 2) a.enemy.lastFireTick = a.state.tick
      },
    })
    const contact = arena.bot.worldModel.enemy
    expect(contact.source).toBe('sight')
    expect(contact.uncertainty).toBe(0)
    expect(contact.origin[0]).toBeCloseTo(arena.enemy.origin[0], 6)
    expect(contact.origin[1]).toBeCloseTo(arena.enemy.origin[1], 6)
  })

  it('hears feet above the walk speed and nothing below it', () => {
    function creeping(speed: number): string {
      const arena = createArena({
        botOrigin: [0, -900, FLOOR],
        botYawDegrees: 270,
        enemyOrigin: [0, -500, FLOOR],
      })
      let first = 'none'
      runBot(arena, FOOTSTEP_INTERVAL_TICKS * 2, {
        before: (a) => {
          // Written straight on to the body, because `UserCmd` has no walk bit
          // — a movement axis is -1, 0 or +1 and there is no way to ask for
          // half of run speed through the door a player uses.
          a.enemy.velocity[0] = speed
          a.enemy.velocity[1] = 0
        },
        after: (a) => {
          if (first === 'none') first = a.bot.worldModel.enemy.source
        },
      })
      return first
    }

    expect(creeping(0)).toBe('none')
    expect(creeping(100)).toBe('none')
    expect(creeping(200)).toBe('sound')
    expect(creeping(320)).toBe('sound')
  })

  it('does not carry feet as far as it carries a shot', () => {
    const arena = createArena({
      botOrigin: [0, -1100, FLOOR],
      botYawDegrees: 270,
      enemyOrigin: [0, -200, FLOOR],
    })
    runBot(arena, FOOTSTEP_INTERVAL_TICKS * 2, {
      before: (a) => {
        a.enemy.velocity[0] = 320
        a.enemy.velocity[1] = 0
      },
    })
    // 900 units: well inside a shot's 1800 and outside a footstep's 700.
    expect(arena.bot.worldModel.enemy.source).toBe('none')
  })
})

/* --------------------------------------------------------------------------
 * Damage
 * ----------------------------------------------------------------------- */

describe('being shot', () => {
  /** Railed in the back from 2200 units — too far for feet, too far to see. */
  function railedInTheBack(): {
    bearing: number
    trueBearing: number
    source: string
    uncertainty: number
    alertUntil: number
    hitTick: number
  } {
    const arena = createArena({
      botOrigin: [-1100, -600, FLOOR],
      botYawDegrees: 180,
      enemyOrigin: [1100, -600, FLOOR],
    })
    let snapshot = {
      bearing: 0,
      trueBearing: 0,
      source: 'none',
      uncertainty: 0,
      alertUntil: -1,
      hitTick: -1,
    }
    runBot(arena, 40, {
      enemyCmd: (step) => ({
        forwardMove: 0,
        sideMove: 0,
        yaw: yawUnitsFromDegrees(180),
        pitch: 0,
        buttons: step === 5 ? BUTTON_ATTACK : 0,
        weapon: Weapon.Railgun,
      }),
      after: (a) => {
        const model = a.bot.worldModel
        if (snapshot.hitTick >= 0 || model.damageTick < 0) return
        snapshot = {
          bearing: (Math.atan2(model.damageBearing[1], model.damageBearing[0]) * 180) / Math.PI,
          trueBearing: bearingDegrees(a.self.origin, a.enemy.origin),
          source: model.enemy.source,
          uncertainty: model.enemy.uncertainty,
          alertUntil: model.alertUntilTick,
          hitTick: model.damageTick,
        }
      },
    })
    return snapshot
  }

  it('points at whoever did it, from the shove and nothing else', () => {
    const hit = railedInTheBack()
    expect(hit.hitTick).toBeGreaterThan(0)
    expect(angleBetween(hit.bearing, hit.trueBearing)).toBeLessThan(2)
  })

  it('opens the alertness window', () => {
    const hit = railedInTheBack()
    expect(hit.alertUntil).toBe(hit.hitTick + ALERT_TICKS)
  })

  it('admits it knows the direction and not the range', () => {
    const hit = railedInTheBack()
    expect(hit.source).toBe('damage')
    // The uncertainty is the whole assumed range: "somewhere along that line".
    expect(hit.uncertainty).toBe(DAMAGE_ASSUMED_RANGE)
  })

  it('is weaker than a noise, which is weaker than a sighting', () => {
    expect(confidenceOf('damage')).toBeLessThan(confidenceOf('sound'))
    expect(confidenceOf('sound')).toBeLessThan(confidenceOf('sight'))
    expect(confidenceOf('none')).toBe(0)
  })
})

/* --------------------------------------------------------------------------
 * Threats
 * ----------------------------------------------------------------------- */

describe('rockets', () => {
  function rocketAt(origin: Vec3, ownerIsBot: boolean): ReturnType<typeof createArena> {
    const arena = createArena({
      botOrigin: [0, -700, FLOOR],
      botYawDegrees: 90,
      enemyOrigin: [0, -300, FLOOR],
    })
    runBot(arena, 4, {
      before: (a, step) => {
        if (step !== 1) return
        spawnEntity(a.state, {
          kind: EntityKind.Projectile,
          origin: [origin[0], origin[1], origin[2]],
          velocity: [0, 0, 0],
          trBase: [origin[0], origin[1], origin[2]],
          ownerId: ownerIsBot ? a.self.id : a.enemy.id,
          weapon: Weapon.RocketLauncher,
          expireTick: a.state.tick + 500,
        })
      },
    })
    return arena
  }

  it('sees one coming at it', () => {
    const arena = rocketAt([0, -500, 60], false)
    expect(arena.bot.worldModel.threats).toHaveLength(1)
    expect(arena.bot.worldModel.threats[0]?.own).toBe(false)
  })

  it('does not see one on the far side of a wall', () => {
    const arena = rocketAt([0, 400, 60], false)
    expect(arena.bot.worldModel.threats).toHaveLength(0)
  })

  it('does not see one behind it', () => {
    const arena = rocketAt([0, -1000, 60], false)
    expect(arena.bot.worldModel.threats).toHaveLength(0)
  })

  it('knows about its own wherever it is, because it fired it', () => {
    const arena = rocketAt([0, 400, 60], true)
    expect(arena.bot.worldModel.threats).toHaveLength(1)
    expect(arena.bot.worldModel.threats[0]?.own).toBe(true)
  })
})

/* --------------------------------------------------------------------------
 * The bot's own body
 * ----------------------------------------------------------------------- */

describe('what the bot knows about itself', () => {
  it('is everything, because a player has a health bar', () => {
    const arena = createArena({
      botOrigin: [0, -700, FLOOR],
      botYawDegrees: 90,
      enemyOrigin: [0, -300, FLOOR],
    })
    // Long enough for the body to have fallen the one unit it was placed above
    // the floor and come to rest, so the copy and the body agree exactly.
    runBot(arena, 40)
    const self = arena.bot.worldModel.self
    expect(self.slot).toBe(0)
    expect(self.entityId).toBe(arena.self.id)
    expect(self.alive).toBe(true)
    expect(self.health).toBe(arena.self.health)
    expect(self.armor).toBe(arena.self.armor)
    expect(self.onGround).toBe(true)
    expect(self.origin).toEqual([...arena.self.origin])
  })

  it('is a copy, so nothing above the boundary can write to the world', () => {
    const arena = createArena({
      botOrigin: [0, -700, FLOOR],
      botYawDegrees: 90,
      enemyOrigin: [0, -300, FLOOR],
    })
    runBot(arena, 5)
    arena.bot.worldModel.self.health = 1
    expect(arena.self.health).toBe(SPAWN_HEALTH)
  })

  it('forgets everything when its body goes away', () => {
    const arena = createArena({
      botOrigin: [0, -700, FLOOR],
      botYawDegrees: 90,
      enemyOrigin: [0, -300, FLOOR],
    })
    runBot(arena, 5)
    expect(arena.bot.worldModel.enemy.source).toBe('sight')

    place(arena.self, [0, -700, FLOOR])
    arena.state.entities.splice(arena.state.entities.indexOf(arena.self), 1)
    runBot(arena, 1)
    expect(arena.bot.worldModel.self.alive).toBe(false)
    expect(arena.bot.worldModel.enemy.source).toBe('none')
  })
})
