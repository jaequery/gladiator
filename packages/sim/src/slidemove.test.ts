import { describe, expect, it } from 'vitest'

import { PLAYER_MAXS, PLAYER_MINS } from './bbox.ts'
import { boxBrush, boxPenetration, brush, createCollisionWorld } from './collide.ts'
import type { CollisionWorld } from './collide.ts'
import { lengthVec3, vec3 } from './math.ts'
import type { MutVec3 } from './math.ts'
import { GRAVITY } from './pmove.ts'
import {
  MAX_MOVE_SPEED,
  MIN_WALK_NORMAL,
  OVERCLIP,
  STEP_SIZE,
  clampMoveSpeed,
  clipVelocity,
  createClipPlanes,
  createMoveBody,
  groundTrace,
  slideMove,
  slideVelocityAlongPlanes,
  stepSlideMove,
} from './slidemove.ts'
import type { MoveBody } from './slidemove.ts'
import { SURFACE_CLIP_EPSILON, createTrace, traceBox } from './trace.ts'
import { TICK_DT } from './tick.ts'

/** A player-shaped body at `origin`, at rest, in mid-air. */
function playerAt(origin: MutVec3, velocity: MutVec3 = vec3()): MoveBody {
  const body = createMoveBody(PLAYER_MINS, PLAYER_MAXS)
  body.origin[0] = origin[0]
  body.origin[1] = origin[1]
  body.origin[2] = origin[2]
  body.velocity[0] = velocity[0]
  body.velocity[1] = velocity[1]
  body.velocity[2] = velocity[2]
  return body
}

/** How far above a floor surface a body comes to rest: the trace's epsilon. */
const RESTING = SURFACE_CLIP_EPSILON

const FLOOR = boxBrush([-2048, -2048, -64], [2048, 2048, 0])

/* --------------------------------------------------------------------------
 * PM_ClipVelocity — the OVERCLIP reflection
 * ----------------------------------------------------------------------- */

describe('clipVelocity', () => {
  // Acceptance check: landing at -500 ups leaves +0.5 ups upward.
  it('landing at -500 ups leaves half a unit per second upward', () => {
    const out = clipVelocity(vec3(), [0, 0, -500], [0, 0, 1], OVERCLIP)
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(0)
    expect(out[2]).toBeCloseTo(0.5, 10)
    expect(out[2]).toBeGreaterThan(0)
  })

  // Acceptance check: 700 ups into a 45-degree up-ramp yields (349.7, 350.3) +/- 1.
  it('turns 700 ups horizontal into (349.6, 350.4) on a 45-degree ramp', () => {
    const rampNormal: MutVec3 = [-Math.SQRT1_2, 0, Math.SQRT1_2]
    const out = clipVelocity(vec3(), [700, 0, 0], rampNormal, OVERCLIP)
    expect(out[0]).toBeCloseTo(349.7, 0)
    expect(out[2]).toBeCloseTo(350.3, 0)
    expect(out[1]).toBe(0)
  })

  it('takes nothing off a ramp beyond the projection, and leaves the surface', () => {
    const rampNormal: MutVec3 = [-Math.SQRT1_2, 0, Math.SQRT1_2]
    const out = clipVelocity(vec3(), [700, 0, 0], rampNormal, OVERCLIP)

    // What is left is exactly the projection of 700 onto the ramp — no
    // friction term, no fudge factor. That is what "lossless" means here: the
    // ramp redirects the speed rather than eating it, which is why a run-up
    // converts into 350 qu/s of climb, well over a jump's 270.
    const projection = 700 * Math.SQRT1_2
    expect(lengthVec3(out)).toBeGreaterThan(projection)
    expect(lengthVec3(out)).toBeCloseTo(projection, 1)

    // And the extra tenth of a percent points away from the ramp, so the body
    // is leaving it rather than resting on it.
    const intoRamp = out[0] * rampNormal[0] + out[2] * rampNormal[2]
    expect(intoRamp).toBeGreaterThan(0)
  })

  it('divides rather than multiplies when the velocity is already leaving', () => {
    const out = clipVelocity(vec3(), [0, 0, 500], [0, 0, 1], OVERCLIP)
    // 500 - 500/1.001 = 0.4995..., towards the plane rather than away from it.
    expect(out[2]).toBeGreaterThan(0)
    expect(out[2]).toBeLessThan(0.5)
  })

  it('leaves a velocity parallel to the plane alone', () => {
    const out = clipVelocity(vec3(), [300, 0, 0], [0, 0, 1], OVERCLIP)
    expect(out).toEqual([300, 0, 0])
  })
})

/* --------------------------------------------------------------------------
 * The clip-plane set
 * ----------------------------------------------------------------------- */

describe('slideVelocityAlongPlanes', () => {
  it('slides along a single wall, keeping the component parallel to it', () => {
    const planes = createClipPlanes()
    planes[0][0] = -1
    const velocity: MutVec3 = [400, 300, 0]
    const endVelocity: MutVec3 = [400, 300, 0]

    expect(slideVelocityAlongPlanes(velocity, endVelocity, planes, 1)).toBe(false)
    expect(velocity[0]).toBeCloseTo(-0.4, 6)
    expect(velocity[1]).toBe(300)
  })

  // Acceptance check: entering a three-plane corner leaves |velocity| === 0.
  it('stops dead — exactly zero — on entering a third plane', () => {
    // A funnel: three walls at 120 degrees, each leaning 60 degrees off
    // vertical, meeting at a point below. A body dropped down the axis is
    // deflected by the first, creased between the first two, and has nowhere
    // left to go when the crease runs into the third.
    const planes = createClipPlanes()
    const tilt = Math.sqrt(3) / 2
    planes[0][0] = tilt
    planes[0][2] = 0.5
    planes[1][0] = -tilt / 2
    planes[1][1] = tilt * tilt
    planes[1][2] = 0.5
    planes[2][0] = -tilt / 2
    planes[2][1] = -tilt * tilt
    planes[2][2] = 0.5

    const velocity: MutVec3 = [0, 0, -100]
    const endVelocity: MutVec3 = [0, 0, -100]

    expect(slideVelocityAlongPlanes(velocity, endVelocity, planes, 3)).toBe(true)
    expect(velocity).toEqual([0, 0, 0])
    expect(lengthVec3(velocity)).toBe(0)
  })

  it('slides along the crease of two planes rather than alternating between them', () => {
    // The same funnel with the third wall removed: the body should come out
    // travelling along the seam of the two that are left, not stopped.
    const planes = createClipPlanes()
    const tilt = Math.sqrt(3) / 2
    planes[0][0] = tilt
    planes[0][2] = 0.5
    planes[1][0] = -tilt / 2
    planes[1][1] = tilt * tilt
    planes[1][2] = 0.5

    const velocity: MutVec3 = [0, 0, -100]
    const endVelocity: MutVec3 = [0, 0, -100]

    expect(slideVelocityAlongPlanes(velocity, endVelocity, planes, 2)).toBe(false)
    expect(lengthVec3(velocity)).toBeGreaterThan(0)
    // Along the crease means perpendicular to both normals.
    expect(velocity[0] * planes[0][0] + velocity[2] * planes[0][2]).toBeCloseTo(0, 9)
    expect(
      velocity[0] * planes[1][0] + velocity[1] * planes[1][1] + velocity[2] * planes[1][2],
    ).toBeCloseTo(0, 9)
  })

  it('leaves a velocity that is not running into anything alone', () => {
    const planes = createClipPlanes()
    planes[0][2] = 1
    const velocity: MutVec3 = [400, 0, 200]
    const endVelocity: MutVec3 = [400, 0, 200]
    expect(slideVelocityAlongPlanes(velocity, endVelocity, planes, 1)).toBe(false)
    expect(velocity).toEqual([400, 0, 200])
  })
})

/* --------------------------------------------------------------------------
 * slideMove
 * ----------------------------------------------------------------------- */

describe('slideMove', () => {
  const flatWorld = createCollisionWorld([FLOOR])

  it('reports an unobstructed move, and moves the whole way', () => {
    const body = playerAt([0, 0, 128], [500, 0, 0])
    expect(slideMove(flatWorld, body, TICK_DT, 0)).toBe(false)
    expect(body.origin[0]).toBeCloseTo(500 * TICK_DT, 9)
  })

  it('lands with the OVERCLIP reflection intact when there is horizontal travel', () => {
    const body = playerAt([0, 0, 1], [300, 0, -500])
    slideMove(flatWorld, body, TICK_DT, 0)
    expect(body.velocity[2]).toBeCloseTo(0.5, 9)
    expect(body.velocity[0]).toBe(300)
  })

  it('does not bounce a dead-vertical landing, because that would reverse it', () => {
    // The "never turn against original velocity" plane is seeded from the
    // direction of travel, and a straight-down drop makes it the exact opposite
    // of the floor normal. The reflection and that plane cancel, which is
    // Quake's behaviour and is why a drop lands rather than hops.
    const body = playerAt([0, 0, 1], [0, 0, -500])
    slideMove(flatWorld, body, TICK_DT, 0)
    expect(body.velocity).toEqual([0, 0, 0])
  })

  // Acceptance check: 700 ups into a 45-degree up-ramp, through the real trace.
  it('turns 700 ups into (349.6, 350.4) on a ramp built out of brushes', () => {
    // The wedge is sunk into the floor, the way a ramp is built in a real map,
    // so the only face above z = 0 is the slope itself.
    const rampWorld = createCollisionWorld([
      FLOOR,
      brush([
        { normal: [0, 0, -1], dist: 64 },
        { normal: [1, 0, 0], dist: 256 },
        { normal: [0, 1, 0], dist: 128 },
        { normal: [0, -1, 0], dist: 128 },
        { normal: [-1, 0, 1], dist: -128 },
      ]),
    ])

    const body = playerAt([110, 0, RESTING], [700, 0, 0])
    slideMove(rampWorld, body, TICK_DT, 0)

    expect(body.velocity[0]).toBeCloseTo(349.7, 0)
    expect(body.velocity[1]).toBe(0)
    expect(body.velocity[2]).toBeCloseTo(350.3, 0)
    // The climb is worth more than a jump: 350 qu/s against JUMP_VELOCITY's 270.
    expect(body.velocity[2]).toBeGreaterThan(270)
  })

  it('restores the velocity it started with while the knockback timer runs', () => {
    const wallWorld = createCollisionWorld([FLOOR, boxBrush([100, -256, 0], [164, 256, 192])])

    const scraped = playerAt([80, 0, RESTING], [900, 0, 0])
    slideMove(wallWorld, scraped, TICK_DT, 0)
    expect(scraped.velocity[0]).toBeCloseTo(0, 3)

    const knocked = playerAt([80, 0, RESTING], [900, 0, 0])
    knocked.knockbackTicks = 25
    slideMove(wallWorld, knocked, TICK_DT, 0)
    // Same wall, same contact — and it keeps every unit of its speed. This is
    // what makes a rocket jump survive scraping along a wall.
    expect(knocked.velocity).toEqual([900, 0, 0])
    // It still did not go through the wall.
    expect(knocked.origin[0]).toBeLessThan(100 - PLAYER_MAXS[0])
  })

  it('applies gravity as a half-step, so the endpoint velocity is the full tick', () => {
    const body = playerAt([0, 0, 256], [0, 0, 0])
    slideMove(flatWorld, body, TICK_DT, GRAVITY)
    expect(body.velocity[2]).toBeCloseTo(-GRAVITY * TICK_DT, 9)
    // The move itself used the midpoint velocity: half of a full tick's fall.
    expect(body.origin[2]).toBeCloseTo(256 - GRAVITY * TICK_DT * TICK_DT * 0.5, 9)
  })
})

/* --------------------------------------------------------------------------
 * The speed clamp, and not tunnelling at it
 * ----------------------------------------------------------------------- */

describe('clampMoveSpeed', () => {
  it('scales the whole vector, preserving direction', () => {
    const velocity: MutVec3 = [4000, 3000, 0]
    expect(clampMoveSpeed(velocity)).toBe(MAX_MOVE_SPEED)
    expect(lengthVec3(velocity)).toBeCloseTo(MAX_MOVE_SPEED, 9)
    expect(velocity[0] / velocity[1]).toBeCloseTo(4 / 3, 9)
  })

  it('leaves anything under the clamp alone', () => {
    const velocity: MutVec3 = [900, 0, 0]
    expect(clampMoveSpeed(velocity)).toBe(900)
    expect(velocity).toEqual([900, 0, 0])
  })
})

describe('at the speed clamp', () => {
  // Acceptance check: a player driven into a wall at 3000 ups never tunnels.
  it('never gets through an 8-unit wall, however long it is driven at it', () => {
    // 3000 qu/s is 24 units a tick — three times the thickness of the wall.
    const world = createCollisionWorld([FLOOR, boxBrush([100, -512, 0], [108, 512, 256])])
    const body = playerAt([-64, 0, RESTING])

    for (let tick = 0; tick < 500; tick += 1) {
      body.velocity[0] = MAX_MOVE_SPEED
      body.velocity[1] = 0
      clampMoveSpeed(body.velocity)
      groundTrace(world, body)
      stepSlideMove(world, body, TICK_DT, GRAVITY)

      expect(body.origin[0] + PLAYER_MAXS[0]).toBeLessThanOrEqual(100)
      expect(boxPenetration(world, body.origin, PLAYER_MINS, PLAYER_MAXS)).toBeLessThan(0.03)
    }

    // And it did get all the way up to the wall, rather than stopping early.
    expect(body.origin[0] + PLAYER_MAXS[0]).toBeGreaterThan(100 - 1)
  })

  it('never gets through a wall approached diagonally at the clamp either', () => {
    // The wall runs the length of the world, so sliding along it cannot become
    // going round the end of it.
    const world = createCollisionWorld([FLOOR, boxBrush([100, -2048, 0], [108, 2048, 256])])
    const body = playerAt([-64, -400, RESTING])
    const diagonal = MAX_MOVE_SPEED / Math.SQRT2

    // 100 ticks, because sliding along the wall covers 17 units of y a tick and
    // more than that would take the body past the end of a 4096-unit wall.
    for (let tick = 0; tick < 100; tick += 1) {
      body.velocity[0] = diagonal
      body.velocity[1] = diagonal
      groundTrace(world, body)
      stepSlideMove(world, body, TICK_DT, GRAVITY)
      expect(body.origin[0] + PLAYER_MAXS[0]).toBeLessThanOrEqual(100)
    }

    // It reached the wall and slid along it rather than stopping in open space.
    expect(body.origin[0] + PLAYER_MAXS[0]).toBeGreaterThan(99)
    expect(body.origin[1]).toBeGreaterThan(0)
  })
})

/* --------------------------------------------------------------------------
 * stepSlideMove
 * ----------------------------------------------------------------------- */

describe('stepSlideMove', () => {
  function stepWorld(height: number): CollisionWorld {
    return createCollisionWorld([FLOOR, boxBrush([100, -512, 0], [612, 512, height])])
  }

  it('walks up a 16-unit step', () => {
    const world = stepWorld(16)
    const body = playerAt([50, 0, RESTING])
    for (let tick = 0; tick < 40; tick += 1) {
      body.velocity[0] = 320
      groundTrace(world, body)
      stepSlideMove(world, body, TICK_DT, GRAVITY)
    }
    expect(body.origin[0]).toBeGreaterThan(100)
    expect(body.origin[2]).toBeGreaterThan(16 - 1)
    expect(body.origin[2]).toBeLessThan(16 + 1)
  })

  it('walks up a step of exactly STEP_SIZE', () => {
    const world = stepWorld(STEP_SIZE)
    const body = playerAt([50, 0, RESTING])
    for (let tick = 0; tick < 40; tick += 1) {
      body.velocity[0] = 320
      groundTrace(world, body)
      stepSlideMove(world, body, TICK_DT, GRAVITY)
    }
    expect(body.origin[0]).toBeGreaterThan(100)
    expect(body.origin[2]).toBeGreaterThan(STEP_SIZE - 1)
  })

  it('does not walk up a step taller than STEP_SIZE', () => {
    const world = stepWorld(STEP_SIZE + 8)
    const body = playerAt([50, 0, RESTING])
    for (let tick = 0; tick < 40; tick += 1) {
      body.velocity[0] = 320
      groundTrace(world, body)
      stepSlideMove(world, body, TICK_DT, GRAVITY)
    }
    expect(body.origin[0] + PLAYER_MAXS[0]).toBeLessThanOrEqual(100)
    expect(body.origin[2]).toBeLessThan(1)
  })

  it('never steps up while rising', () => {
    // A ledge whose top is 8 units above the body's feet — comfortably inside
    // STEP_SIZE, so it is a step it *could* take. The only difference between
    // the two runs below is the sign of the vertical velocity.
    const world = createCollisionWorld([FLOOR, boxBrush([100, -512, 0], [612, 512, 72])])

    const rising = playerAt([80, 0, 64], [2000, 0, 200])
    stepSlideMove(world, rising, TICK_DT, 0)
    // Stopped against the side of the ledge, at the height it was already at.
    expect(rising.origin[0] + PLAYER_MAXS[0]).toBeLessThan(100)
    expect(rising.origin[0] + PLAYER_MAXS[0]).toBeGreaterThan(99.8)
    expect(rising.origin[2]).toBeCloseTo(64 + 200 * TICK_DT, 9)

    const falling = playerAt([80, 0, 64], [2000, 0, -200])
    stepSlideMove(world, falling, TICK_DT, 0)
    // Same ledge, same speed, and it is standing on top of it.
    expect(falling.origin[0]).toBeGreaterThan(90)
    expect(falling.origin[2]).toBeCloseTo(72 + SURFACE_CLIP_EPSILON, 9)
  })
})

/* --------------------------------------------------------------------------
 * groundTrace
 * ----------------------------------------------------------------------- */

describe('groundTrace', () => {
  const world = createCollisionWorld([FLOOR])

  it('finds the floor under a resting body', () => {
    const body = playerAt([0, 0, RESTING])
    groundTrace(world, body)
    expect(body.groundPlane).toBe(true)
    expect(body.walking).toBe(true)
    expect(body.groundNormal).toEqual([0, 0, 1])
  })

  it('does not find it from more than a quarter of a unit up', () => {
    const body = playerAt([0, 0, 0.5])
    groundTrace(world, body)
    expect(body.groundPlane).toBe(false)
    expect(body.walking).toBe(false)
    expect(body.groundNormal).toEqual([0, 0, 0])
  })

  it('kicks off the ground for a body leaving it faster than 10 ups', () => {
    const jumping = playerAt([0, 0, RESTING], [0, 0, 270])
    groundTrace(world, jumping)
    expect(jumping.groundPlane).toBe(false)

    // Under the threshold, it is still standing there.
    const twitching = playerAt([0, 0, RESTING], [0, 0, 9])
    groundTrace(world, twitching)
    expect(twitching.groundPlane).toBe(true)
  })

  it('reports a slope too steep to walk on as ground, but not as walking', () => {
    // A 53-degree face: its normal is (0, -0.8, 0.6), and 0.6 is under
    // MIN_WALK_NORMAL. Steeper than the ramp, and you slide off it.
    const steepWorld = createCollisionWorld([
      brush([
        { normal: [0, -1, 0], dist: 384 },
        { normal: [0, 1, 0], dist: -320 },
        { normal: [0, 0, -1], dist: 64 },
        { normal: [1, 0, 0], dist: 256 },
        { normal: [-1, 0, 0], dist: 256 },
        { normal: [0, -4, 3], dist: 1536 },
      ]),
    ])
    // Dropped straight down onto the face rather than placed by hand: where a
    // body comes to rest on a slope is what the trace says it is.
    const dropped = traceBox(
      createTrace(),
      steepWorld,
      [0, -352, 300],
      [0, -352, -100],
      PLAYER_MINS,
      PLAYER_MAXS,
    )
    expect(dropped.fraction).toBeLessThan(1)

    const body = playerAt([dropped.endpos[0], dropped.endpos[1], dropped.endpos[2]])
    groundTrace(steepWorld, body)
    expect(body.groundPlane).toBe(true)
    expect(body.walking).toBe(false)
    expect(body.groundNormal[2]).toBeCloseTo(0.6, 9)
    expect(body.groundNormal[2]).toBeLessThan(MIN_WALK_NORMAL)
  })

  it('finds nothing over a void', () => {
    const body = playerAt([0, 0, 512])
    groundTrace(world, body)
    expect(body.groundPlane).toBe(false)
  })
})
