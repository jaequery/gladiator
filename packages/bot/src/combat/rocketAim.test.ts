/**
 * Where the bot puts a rocket, over a set of recorded scenarios.
 * GLAD-HK3ATM's second acceptance check.
 *
 * The check is a *comparison*, not a rule: "selects a floor or wall splash point
 * rather than the body whenever the predicted splash damage exceeds the
 * direct-hit expectation". So the assertion below is the biconditional over every
 * scenario — splash exactly when it is worth more — and the scenarios exist to
 * make sure both sides of it actually happen.
 *
 * The four that matter, and what each one is for:
 *
 * | Scenario | Expected | Because |
 * | -------- | -------- | ------- |
 * | standing still, close | **direct** | a rocket in the chest is 100 and cannot be beaten |
 * | strafing across, at range | **splash** | the lead is a guess, and a guess wants 120 units of forgiveness |
 * | jittering in place | **splash** | no lead is taken at all, and they are still not where they were |
 * | airborne over a pit | **direct** | there is no floor within a splash radius to burst against |
 */

import {
  DAMAGE_ORIGIN_HEIGHT,
  PLAYER_HEIGHT,
  SURFACE_CLIP_EPSILON,
  TICK_DT,
  boxBrush,
  createCollisionWorld,
} from '@gladiator/sim'
import type { CollisionWorld, Vec3 } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { createTrack, trackTarget } from '../aim/error.ts'
import type { AimTrack } from '../aim/error.ts'
import {
  LEAD_MAX_SECONDS,
  LEAD_STRAIGHTNESS,
  PATH_SAMPLES,
  PATH_SAMPLE_TICKS,
  createPath,
  createPlan,
  interceptSeconds,
  planRocket,
  samplePath,
  straightness,
} from './rocketAim.ts'
import type { TargetPath } from './rocketAim.ts'

/* --------------------------------------------------------------------------
 * The worlds
 * ----------------------------------------------------------------------- */

/** A floor and nothing else. Everything a duel on flat ground needs. */
function floorWorld(): CollisionWorld {
  return createCollisionWorld([boxBrush([-2000, -2000, -64], [2000, 2000, 0])])
}

/**
 * A floor with a hole in the middle of it, so a target over the hole has no
 * surface within a splash radius.
 */
function pitWorld(): CollisionWorld {
  return createCollisionWorld([
    boxBrush([-2000, -2000, -64], [-400, 2000, 0]),
    boxBrush([400, -2000, -64], [2000, 2000, 0]),
  ])
}

/** Where the shot comes from: an eye at the origin, looking down `+x`. */
const MUZZLE: Vec3 = [0, 0, 50]

/* --------------------------------------------------------------------------
 * Building a target
 * ----------------------------------------------------------------------- */

function trackAt(origin: Vec3, velocity: Vec3): AimTrack {
  const track = createTrack()
  trackTarget(track, origin, velocity, 1)
  return track
}

/** A path that has genuinely gone somewhere: the target's own line, backwards. */
function straightPath(origin: Vec3, velocity: Vec3): TargetPath {
  const path = createPath()
  for (let i = 0; i < PATH_SAMPLES; i += 1) {
    const back = (PATH_SAMPLES - 1 - i) * PATH_SAMPLE_TICKS * TICK_DT
    samplePath(path, i * PATH_SAMPLE_TICKS, [
      origin[0] - velocity[0] * back,
      origin[1] - velocity[1] * back,
      origin[2] - velocity[2] * back,
    ])
  }
  return path
}

/**
 * A path that covered ground and arrived nowhere: a duellist strafing in place.
 *
 * Alternating either side of a line, which is the shape the straightness gate
 * exists to recognise — a lot of path length, no net displacement.
 */
function jitterPath(origin: Vec3, swing: number): TargetPath {
  const path = createPath()
  for (let i = 0; i < PATH_SAMPLES; i += 1) {
    samplePath(path, i * PATH_SAMPLE_TICKS, [
      origin[0],
      origin[1] + (i % 2 === 0 ? -swing : swing),
      origin[2],
    ])
  }
  return path
}

/* --------------------------------------------------------------------------
 * The scenarios
 * ----------------------------------------------------------------------- */

type Scenario = {
  readonly name: string
  readonly world: CollisionWorld
  readonly origin: Vec3
  readonly velocity: Vec3
  readonly path: (origin: Vec3, velocity: Vec3) => TargetPath
  readonly expect: 'splash' | 'direct'
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: 'standing still, 400 units away',
    world: floorWorld(),
    origin: [400, 0, 0],
    velocity: [0, 0, 0],
    path: (origin) => straightPath(origin, [0, 0, 0]),
    expect: 'direct',
  },
  {
    name: 'strafing across at run speed, 800 units away',
    world: floorWorld(),
    origin: [800, 0, 0],
    velocity: [0, 320, 0],
    path: straightPath,
    expect: 'splash',
  },
  {
    name: 'jittering in place, 600 units away',
    world: floorWorld(),
    origin: [600, 0, 0],
    velocity: [0, 320, 0],
    path: (origin) => jitterPath(origin, 40),
    expect: 'splash',
  },
  {
    name: 'airborne over a pit, 700 units away',
    world: pitWorld(),
    origin: [0, 0, 300],
    velocity: [0, 0, -100],
    path: (origin, velocity) => straightPath(origin, velocity),
    expect: 'direct',
  },
]

/** The muzzle for the pit scenario is off to the side, so the target is downrange. */
function muzzleFor(scenario: Scenario): Vec3 {
  return scenario.name.includes('pit') ? [-700, 0, 350] : MUZZLE
}

describe('the shot selection', () => {
  for (const scenario of SCENARIOS) {
    it(`picks ${scenario.expect} against a target ${scenario.name}`, () => {
      const plan = planRocket(
        createPlan(),
        scenario.world,
        muzzleFor(scenario),
        trackAt(scenario.origin, scenario.velocity),
        scenario.path(scenario.origin, scenario.velocity),
      )
      expect(plan.mode).toBe(scenario.expect)
    })
  }

  it('splashes exactly when the splash is worth more than the body', () => {
    // The acceptance check, stated as the biconditional it is. Every scenario
    // above goes through the same comparison, so this is the claim and the four
    // cases are what stop it from being vacuous.
    for (const scenario of SCENARIOS) {
      const plan = planRocket(
        createPlan(),
        scenario.world,
        muzzleFor(scenario),
        trackAt(scenario.origin, scenario.velocity),
        scenario.path(scenario.origin, scenario.velocity),
      )
      expect(plan.mode === 'splash', scenario.name).toBe(
        plan.hasSurface && plan.splashExpected > plan.directExpected,
      )
    }
  })

  it('aims a splash at a surface below the target rather than at the body', () => {
    const scenario = SCENARIOS[1]
    if (scenario === undefined) throw new Error('missing scenario')
    const plan = planRocket(
      createPlan(),
      scenario.world,
      MUZZLE,
      trackAt(scenario.origin, scenario.velocity),
      straightPath(scenario.origin, scenario.velocity),
    )
    expect(plan.mode).toBe('splash')
    expect(plan.hasSurface).toBe(true)
    // The floor, which is under the feet rather than at the middle of the box.
    // `SURFACE_CLIP_EPSILON` above the plane rather than on it, because that is
    // where `traceRay` stops and where the explosion would actually be
    // (`projectile.ts` relies on the same eighth of a unit).
    expect(plan.surface[2]).toBeLessThan(scenario.origin[2] + PLAYER_HEIGHT / 2)
    expect(plan.surface[2]).toBeCloseTo(SURFACE_CLIP_EPSILON, 6)
    // And the offset it crosses to the tick layer as is at the feet rather than
    // at the middle of the box, which is what `direct` would have written.
    expect(plan.offset[2]).toBeLessThan(DAMAGE_ORIGIN_HEIGHT)
  })

  it('finds a wall to burst against when there is no floor in reach', () => {
    // A target in the air with a wall behind them. The floor probe fails and the
    // one along the line of the shot does not, which is the fallback.
    const world = createCollisionWorld([boxBrush([700, -600, -600], [900, 600, 600])])
    const plan = planRocket(
      createPlan(),
      world,
      [0, 0, 300],
      trackAt([600, 0, 260], [0, 0, 0]),
      straightPath([600, 0, 260], [0, 0, 0]),
    )
    expect(plan.hasSurface).toBe(true)
    expect(plan.surface[0]).toBeGreaterThan(600)
  })
})

describe('leading', () => {
  it('leads a target that is travelling', () => {
    const origin: Vec3 = [900, 0, 0]
    const velocity: Vec3 = [0, 320, 0]
    const plan = planRocket(
      createPlan(),
      floorWorld(),
      MUZZLE,
      trackAt(origin, velocity),
      straightPath(origin, velocity),
    )
    expect(plan.straight).toBeGreaterThan(LEAD_STRAIGHTNESS)
    expect(plan.lead).toBeGreaterThan(0)
    expect(plan.lead).toBeLessThanOrEqual(LEAD_MAX_SECONDS)
  })

  it('does not lead a target that is strafing in place', () => {
    const origin: Vec3 = [600, 0, 0]
    const velocity: Vec3 = [0, 320, 0]
    const plan = planRocket(
      createPlan(),
      floorWorld(),
      MUZZLE,
      trackAt(origin, velocity),
      jitterPath(origin, 40),
    )
    expect(plan.straight).toBeLessThan(LEAD_STRAIGHTNESS)
    expect(plan.lead).toBe(0)
  })

  it('clamps the lead rather than extrapolating across the map', () => {
    // Far enough that the honest intercept is well over half a second. Past that
    // a linear extrapolation of a duellist is a guess about a place nobody was
    // ever going, so the lead stops growing.
    const origin: Vec3 = [2800, 0, 0]
    const velocity: Vec3 = [0, 320, 0]
    const plan = planRocket(
      createPlan(),
      floorWorld(),
      MUZZLE,
      trackAt(origin, velocity),
      straightPath(origin, velocity),
    )
    expect(plan.lead).toBe(LEAD_MAX_SECONDS)
  })

  it('solves the intercept quadratic', () => {
    // A target crossing at right angles: the rocket has to be aimed ahead by
    // exactly the distance they cover in the flight time, and the two agree only
    // if the quadratic was solved rather than approximated.
    const seconds = interceptSeconds([0, 0, 0], [900, 0, 0], [0, 300, 0])
    expect(seconds).toBeGreaterThan(0)
    const ahead = 300 * seconds
    const range = Math.sqrt(900 * 900 + ahead * ahead)
    expect(range / seconds).toBeCloseTo(900, 3)
  })

  it('gives a stationary target the plain flight time', () => {
    expect(interceptSeconds([0, 0, 0], [900, 0, 0], [0, 0, 0])).toBeCloseTo(1, 6)
  })
})

describe('straightness', () => {
  it('is 1 for a straight line and near zero for a strafe in place', () => {
    expect(straightness(straightPath([600, 0, 0], [0, 320, 0]))).toBeCloseTo(1, 6)
    expect(straightness(jitterPath([600, 0, 0], 40))).toBeLessThan(0.1)
  })

  it('is zero for a target with no history, which is the pessimistic end', () => {
    // A target the bot has only just seen is one it has no reason to believe is
    // running in a straight line.
    expect(straightness(createPath())).toBe(0)
  })

  it('is 1 for a target that has not moved at all', () => {
    expect(straightness(straightPath([600, 0, 0], [0, 0, 0]))).toBe(1)
  })
})
