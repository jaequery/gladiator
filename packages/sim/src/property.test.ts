/**
 * The collision fuzz gate.
 *
 * One property, checked 10,000 times: **a body never ends a tick inside the
 * world**. Everything else in `slidemove.ts` is a feel decision that a human
 * can argue about; this one is not, because a body inside geometry cannot be
 * shot, cannot be seen, and — before `correctAllSolid` — could not get out.
 *
 * A fuzz test is only a regression test if it runs the same thing every time,
 * so all four of the things that decide what it runs are written down here and
 * committed: the geometry ({@link createProvingGround}), the seed, the
 * iteration count and the tolerance. Change any of them in a commit and the
 * diff says so.
 *
 * It is a *walk*, not 10,000 independent drops. Each tick starts from the
 * position the last one produced, so an error that takes a hundred ticks of
 * scraping along a wall to accumulate has a hundred ticks to accumulate in —
 * which is the failure mode a per-tick test cannot see.
 */

import { describe, expect, it } from 'vitest'

import { PLAYER_MAXS, PLAYER_MINS } from './bbox.ts'
import { boxPenetration } from './collide.ts'
import {
  ARENA_CEILING,
  ARENA_HALF_EXTENT,
  PROVING_GROUND_SPAWN,
  createProvingGround,
} from './fixtures/proving-ground.ts'
import { lengthVec3 } from './math.ts'
import { GRAVITY } from './pmove.ts'
import { rngChance, rngRange, seedRng } from './rng.ts'
import type { RngHolder } from './rng.ts'
import {
  MAX_MOVE_SPEED,
  clampMoveSpeed,
  createMoveBody,
  groundTrace,
  stepSlideMove,
} from './slidemove.ts'
import { TICK_DT } from './tick.ts'

/** The committed seed. Any uint32; this one has no meaning beyond being fixed. */
const FUZZ_SEED = 0x5f3759df

/** How many ticks the walk runs for. */
const FUZZ_TICKS = 10_000

/**
 * How far into solid geometry a body may end a tick, in Quake units.
 *
 * 0.03 rather than 0 because the assertion has to survive floating-point
 * arithmetic on a plane whose normal is irrational, and 0.03 is a fortieth of
 * the 0.125-unit gap `SURFACE_CLIP_EPSILON` aims for and a thousandth
 * of the body's width. Nothing a player could perceive; everything a slow leak
 * would exceed within a few hundred ticks.
 */
const PENETRATION_TOLERANCE = 0.03

/** How often a grounded tick jumps. */
const JUMP_CHANCE = 0.05

/** How often a grounded tick gets a rocket-jump-sized shove instead. */
const IMPULSE_CHANCE = 0.02

/** How often a grounded tick gets a shove no rocket could deliver. */
const ABSURD_CHANCE = 0.01

describe('the collision layer, fuzzed', () => {
  it(`keeps a body out of solid geometry for ${FUZZ_TICKS} ticks`, () => {
    const world = createProvingGround()
    const body = createMoveBody(PLAYER_MINS, PLAYER_MAXS)
    body.origin[0] = PROVING_GROUND_SPAWN[0]
    body.origin[1] = PROVING_GROUND_SPAWN[1]
    body.origin[2] = PROVING_GROUND_SPAWN[2]

    // A vacuous pass is the thing to be afraid of here: a walk that spawns
    // inside a wall, or one that never leaves the floor, would sail through.
    expect(boxPenetration(world, body.origin, PLAYER_MINS, PLAYER_MAXS)).toBe(0)

    const rng: RngHolder = { rng: seedRng(FUZZ_SEED) }

    let worstPenetration = 0
    let worstTick = -1
    let grounded = 0
    let airborne = 0
    let bumped = 0
    let travelled = 0
    let peakSpeed = 0

    for (let tick = 0; tick < FUZZ_TICKS; tick += 1) {
      // Horizontal velocity is a damped random walk, so the body runs around at
      // plausible speeds rather than saturating at the clamp and staying there.
      body.velocity[0] = body.velocity[0] * 0.9 + rngRange(rng, -500, 500)
      body.velocity[1] = body.velocity[1] * 0.9 + rngRange(rng, -500, 500)

      // Everything that sends the body upwards launches from the floor, the way
      // a player's does — `body.groundPlane` here is last tick's ground trace.
      // Shoving it upwards from mid-air as well would keep it permanently
      // airborne, and a fuzzer that never lands never tests the ground trace.
      if (body.groundPlane) {
        if (rngChance(rng, JUMP_CHANCE)) body.velocity[2] += rngRange(rng, 270, 800)
        if (rngChance(rng, IMPULSE_CHANCE)) {
          // A rocket jump, roughly: a large shove, and the knockback timer that
          // comes with it — which puts `slideMove`'s primal-velocity restore
          // under the fuzzer too.
          body.velocity[0] += rngRange(rng, -1600, 1600)
          body.velocity[1] += rngRange(rng, -1600, 1600)
          body.velocity[2] += rngRange(rng, 0, 1600)
          body.knockbackTicks = 25
        }
        if (rngChance(rng, ABSURD_CHANCE)) {
          // And occasionally something absurd, to prove the clamp is load-bearing.
          body.velocity[0] *= 8
          body.velocity[1] *= 8
          body.velocity[2] *= 8
        }
      }
      if (body.knockbackTicks > 0) body.knockbackTicks -= 1

      const speed = clampMoveSpeed(body.velocity)
      if (speed > peakSpeed) peakSpeed = speed

      const beforeX = body.origin[0]
      const beforeY = body.origin[1]
      const beforeZ = body.origin[2]

      groundTrace(world, body)
      if (body.groundPlane) grounded += 1
      else airborne += 1

      stepSlideMove(world, body, TICK_DT, GRAVITY)

      const dx = body.origin[0] - beforeX
      const dy = body.origin[1] - beforeY
      const dz = body.origin[2] - beforeZ
      const step = Math.sqrt(dx * dx + dy * dy + dz * dz)
      travelled += step
      if (step + 0.001 < speed * TICK_DT) bumped += 1

      const penetration = boxPenetration(world, body.origin, PLAYER_MINS, PLAYER_MAXS)
      if (penetration > worstPenetration) {
        worstPenetration = penetration
        worstTick = tick
      }

      // Never NaN. One NaN in a velocity poisons every state hash after it, and
      // it would otherwise sail past every comparison below.
      expect(Number.isFinite(body.origin[0])).toBe(true)
      expect(Number.isFinite(body.origin[1])).toBe(true)
      expect(Number.isFinite(body.origin[2])).toBe(true)
      expect(Number.isFinite(lengthVec3(body.velocity))).toBe(true)
    }

    expect(
      worstPenetration,
      `deepest penetration was ${worstPenetration} units, at tick ${worstTick}`,
    ).toBeLessThan(PENETRATION_TOLERANCE)

    // The arena is sealed, so leaving it is a failure in its own right.
    expect(body.origin[0]).toBeGreaterThan(-ARENA_HALF_EXTENT)
    expect(body.origin[0]).toBeLessThan(ARENA_HALF_EXTENT)
    expect(body.origin[1]).toBeGreaterThan(-ARENA_HALF_EXTENT)
    expect(body.origin[1]).toBeLessThan(ARENA_HALF_EXTENT)
    expect(body.origin[2]).toBeGreaterThan(-1)
    expect(body.origin[2]).toBeLessThan(ARENA_CEILING)

    // And the walk was a real one: it flew, it landed, it hit things, and it
    // ran into the clamp.
    expect(grounded).toBeGreaterThan(500)
    expect(airborne).toBeGreaterThan(500)
    expect(bumped).toBeGreaterThan(1000)
    expect(travelled).toBeGreaterThan(40_000)
    expect(peakSpeed).toBe(MAX_MOVE_SPEED)
  })

  it('is reproducible: the same seed walks the same walk', () => {
    const positions: number[][] = []

    for (let run = 0; run < 2; run += 1) {
      const world = createProvingGround()
      const body = createMoveBody(PLAYER_MINS, PLAYER_MAXS)
      body.origin[0] = PROVING_GROUND_SPAWN[0]
      body.origin[1] = PROVING_GROUND_SPAWN[1]
      body.origin[2] = PROVING_GROUND_SPAWN[2]

      const rng: RngHolder = { rng: seedRng(FUZZ_SEED) }
      for (let tick = 0; tick < 200; tick += 1) {
        body.velocity[0] += rngRange(rng, -400, 400)
        body.velocity[1] += rngRange(rng, -400, 400)
        body.velocity[2] += rngRange(rng, -100, 400)
        clampMoveSpeed(body.velocity)
        groundTrace(world, body)
        stepSlideMove(world, body, TICK_DT, GRAVITY)
      }
      positions.push([body.origin[0], body.origin[1], body.origin[2]])
    }

    // Bit-identical, not close: the whole point of the package is that two
    // peers running this arrive at the same number.
    expect(positions[0]).toEqual(positions[1])
  })
})
