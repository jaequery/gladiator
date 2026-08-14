/**
 * The movement acceptance gates.
 *
 * Every number in the first block is a *measurement of the running code*, not
 * an arithmetic identity — the point is that a refactor which quietly changes
 * how a Quake player moves fails here rather than in a playtest six weeks
 * later. `docs/physics-spec.md` §1 is the normative copy of all of them.
 *
 * **Where these sample.** Every measurement is taken *after* `pmove` returns —
 * so after the second ground trace and after `SnapVector`. That matters: a
 * tolerance of one tick would otherwise be encoding an unstated decision about
 * where inside `PmoveSingle` the reading was taken. The tolerances here are two
 * ticks, and the sampling point is this sentence.
 */

import { describe, expect, it } from 'vitest'

import { PLAYER_MAXS, PLAYER_MINS } from '../bbox.ts'
import { boxBrush, createCollisionWorld } from '../collide.ts'
import type { CollisionWorld } from '../collide.ts'
import { angleVectors, dotVec3, lengthVec2, normalizeVec3, setVec3, vec3 } from '../math.ts'
import type { MutVec3 } from '../math.ts'
import { MAX_MOVE_SPEED } from '../slidemove.ts'
import { SURFACE_CLIP_EPSILON } from '../trace.ts'
import { TICK_DT, TICK_INTERVAL_MS } from '../tick.ts'
import { BUTTON_JUMP, NULL_CMD, yawUnitsFromDegrees } from '../usercmd.ts'
import type { UserCmd } from '../usercmd.ts'
import { PM_AIR_ACCELERATE, accelerate } from './accelerate.ts'
import { cmdScale } from './cmdscale.ts'
import { PM_FRICTION } from './friction.ts'
import {
  GRAVITY,
  JUMP_VELOCITY,
  RUN_SPEED,
  createPmoveBody,
  onSpeedClamp,
  pmove,
} from './index.ts'
import type { PmoveBody } from './index.ts'
import { snapVelocity } from './snap.ts'

/* --------------------------------------------------------------------------
 * Fixtures
 * ----------------------------------------------------------------------- */

/**
 * A floor and nothing else, big enough that a strafe jump never finds a wall.
 *
 * Built once: a `CollisionWorld` is level data and no test mutates it.
 */
const FLAT: CollisionWorld = createCollisionWorld([
  boxBrush([-16384, -16384, -64], [16384, 16384, 0]),
])

function cmd(overrides: Partial<UserCmd>): UserCmd {
  return { ...NULL_CMD, ...overrides }
}

/**
 * A player standing on the floor, at rest.
 *
 * Spawned at `SURFACE_CLIP_EPSILON` rather than at `z = 0`: a box resting
 * *exactly* on a plane counts as inside it (`docs/physics-spec.md` §2.2), and
 * an eighth of a unit clear is where the trace leaves a body that has landed.
 */
function standing(): PmoveBody {
  const body = createPmoveBody(PLAYER_MINS, PLAYER_MAXS)
  setVec3(body.origin, 0, 0, SURFACE_CLIP_EPSILON)
  pmove(FLAT, body, NULL_CMD)
  return body
}

/** Horizontal speed. The only speed the movement rules are about. */
function speedOf(body: PmoveBody): number {
  return lengthVec2(body.velocity)
}

/* --------------------------------------------------------------------------
 * Acceptance gate 1 — the jump apex
 * ----------------------------------------------------------------------- */

describe('the jump', () => {
  it('reaches an apex of 48.6 units on flat ground', () => {
    // 270^2 / (2 * 750) — the *effective* gravity of 750, not 800, because
    // integer snapping eats 0.4 of the 6.4 every sub-step. `snap.ts`.
    const body = standing()
    const floor = body.origin[2]

    pmove(FLAT, body, cmd({ buttons: BUTTON_JUMP }))
    let apex = body.origin[2]

    for (let i = 0; i < 500 && !body.walking; i += 1) {
      pmove(FLAT, body, NULL_CMD)
      if (body.origin[2] > apex) apex = body.origin[2]
    }

    expect(body.walking).toBe(true)
    expect(apex - floor).toBeGreaterThan(48.6 - 0.5)
    expect(apex - floor).toBeLessThan(48.6 + 0.5)
  })

  it('overrides the vertical velocity rather than adding to it', () => {
    // QuakeWorld's additive form lets a player stack a jump onto velocity they
    // already had — off a ramp, out of an explosion — and stack it again.
    const flat = standing()
    pmove(FLAT, flat, cmd({ buttons: BUTTON_JUMP }))

    const rising = standing()
    // Still under the ground trace's 10 qu/s kick-off threshold, so the body is
    // genuinely still standing when the jump lands.
    rising.velocity[2] = 5
    pmove(FLAT, rising, cmd({ buttons: BUTTON_JUMP }))

    expect(rising.velocity[2]).toBe(flat.velocity[2])
    // One tick of gravity off 270, snapped: 270 - 6.4 -> 264.
    expect(flat.velocity[2]).toBe(JUMP_VELOCITY - 6)
  })

  it('needs the key released before it fires again', () => {
    // Quake 3's PMF_JUMP_HELD. Holding space does not auto-hop, which is what
    // makes the landing tick a timing window rather than a formality.
    const held = cmd({ buttons: BUTTON_JUMP })
    const body = standing()

    pmove(FLAT, body, held)
    for (let i = 0; i < 400 && !body.walking; i += 1) pmove(FLAT, body, held)

    expect(body.walking).toBe(true)
    pmove(FLAT, body, held)
    expect(body.walking).toBe(true)
    expect(body.velocity[2]).toBe(0)
  })
})

/* --------------------------------------------------------------------------
 * Acceptance gate 2 — strafe jumping
 * ----------------------------------------------------------------------- */

/**
 * The best yaw to be holding W+D at, given a velocity.
 *
 * "Perfect" needs a definition, and there are two, because velocity is snapped
 * to whole units every sub-step:
 *
 * - `snapAware: false` — maximise the speed the acceleration step produces
 *   *before* the snap. This is what a player turning smoothly is approximating:
 *   keep the projection of the velocity onto the wish direction just under the
 *   cap, every tick, and take the largest continuous gain available.
 * - `snapAware: true` — maximise the speed *after* the snap. Because the
 *   acceleration is rounded on the world axes rather than along the velocity,
 *   a rounded step can come out both longer and better aligned than the step it
 *   was rounded from. Tuning the yaw to that lattice is worth real speed, and
 *   it is superhuman: it needs the yaw right to 1/65536 of a turn.
 *
 * Both are searched rather than solved, so the test measures what the code does
 * instead of re-deriving the mechanic and then agreeing with itself. Coarse
 * pass at half a degree, then a fine pass either side of the winner.
 */
function bestStrafeYaw(velocity: MutVec3, snapAware: boolean): number {
  const coarseStep = 91 // ~0.5 degrees in angle units
  let best = 0
  let bestSpeed = -1

  for (let yaw = 0; yaw < 65536; yaw += coarseStep) {
    const candidate = speedAfterAirAccel(velocity, yaw, snapAware)
    if (candidate > bestSpeed) {
      bestSpeed = candidate
      best = yaw
    }
  }

  for (let yaw = best - coarseStep; yaw <= best + coarseStep; yaw += 1) {
    const wrapped = ((yaw % 65536) + 65536) % 65536
    const candidate = speedAfterAirAccel(velocity, wrapped, snapAware)
    if (candidate > bestSpeed) {
      bestSpeed = candidate
      best = wrapped
    }
  }

  return best
}

/** The horizontal speed one air-acceleration step at `yaw` would produce. */
function speedAfterAirAccel(velocity: MutVec3, yaw: number, snapAware: boolean): number {
  angleVectors(0, yaw, 0, probeForward, probeRight, null)
  // W+D: forwardMove 1, sideMove 1.
  setVec3(
    probeWish,
    probeForward[0] + probeRight[0],
    probeForward[1] + probeRight[1],
    0,
  )
  const wishspeed = normalizeVec3(probeWish, probeWish) * cmdScale(1, 1, RUN_SPEED)

  const addspeed = wishspeed - dotVec3(velocity, probeWish)
  if (addspeed <= 0) return lengthVec2(velocity)

  let accelspeed = PM_AIR_ACCELERATE * TICK_DT * wishspeed
  if (accelspeed > addspeed) accelspeed = addspeed

  let x = velocity[0] + accelspeed * probeWish[0]
  let y = velocity[1] + accelspeed * probeWish[1]
  if (snapAware) {
    x = Math.round(x)
    y = Math.round(y)
  }
  return Math.sqrt(x * x + y * y)
}

const probeForward: MutVec3 = vec3()
const probeRight: MutVec3 = vec3()
const probeWish: MutVec3 = vec3()

/** Chain four frame-perfect jumps from 320 ups, holding W+D. Returns the speed. */
function fourChainedJumps(snapAware: boolean): { speed: number; airTicks: number } {
  const body = standing()
  setVec3(body.velocity, RUN_SPEED, 0, 0)

  let jumps = 0
  let ticks = 0
  let airTicks = 0
  while ((jumps < 4 || !body.walking) && ticks < 2000) {
    const grounded = body.walking
    pmove(
      FLAT,
      body,
      cmd({
        forwardMove: 1,
        sideMove: 1,
        yaw: bestStrafeYaw(body.velocity, snapAware),
        buttons: grounded ? BUTTON_JUMP : 0,
      }),
    )
    if (grounded) jumps += 1
    else airTicks += 1
    ticks += 1
  }

  if (jumps !== 4) throw new Error(`only chained ${jumps} jumps in ${ticks} ticks`)
  return { speed: speedOf(body), airTicks }
}

describe('strafe jumping', () => {
  it('reaches 832 ups over four chained perfect jumps from 320, holding W+D', () => {
    // The input is stated because the gate is input-dependent: `PM_Accelerate`
    // opens on the *projection* of velocity onto the wish direction, so what
    // the player is holding decides where the wish direction can point. W+D,
    // turning into the strafe every tick, jumping on the tick they land.
    //
    // 832 is the figure the *continuous* model predicts, and it is not a single
    // number the code produces, because velocity snapping quantises each
    // acceleration step on the world axes. What the code produces is a band,
    // and 832 sits inside it:
    //
    //   turning smoothly, ignoring the lattice   ->  794 ups
    //   turning tuned to the lattice             ->  883 ups
    //
    // The lower bound is what a human approximates; the upper is what a bot
    // with 1/65536-turn precision can extract. Both are the same mechanic, and
    // the gate here is that four jumps roughly two-and-a-half times the speed
    // you started with.
    const smooth = fourChainedJumps(false)
    const tuned = fourChainedJumps(true)

    // 89 airborne ticks plus the grounded tick the next jump fires on — which
    // is itself an air-acceleration tick, because a successful `PM_CheckJump`
    // hands the rest of the sub-step to `PM_AirMove`. 90 accelerating ticks per
    // hop, which is what the continuous model below counts.
    expect(smooth.airTicks).toBe(4 * 89)
    expect(tuned.airTicks).toBe(4 * 89)

    expect(smooth.speed).toBeGreaterThan(780)
    expect(tuned.speed).toBeLessThan(900)
    expect(832).toBeGreaterThan(smooth.speed)
    expect(832).toBeLessThan(tuned.speed)
  })

  it('predicts 832 from the continuous model, so the gap is exactly the snap', () => {
    // Each air tick adds a *constant* amount to v^2 when nothing is rounded:
    // the optimal turn keeps `dot(velocity, wishdir)` at `wishspeed - accel`,
    // so `|v + a*w|^2 = v^2 + 2a(wishspeed - a) + a^2` whatever v is. Four
    // jumps of 90 air ticks from 320 ups therefore land at 832 — which is the
    // number the acceptance gate quotes, and which the test above brackets.
    const accelspeed = PM_AIR_ACCELERATE * TICK_DT * RUN_SPEED
    expect(accelspeed).toBeCloseTo(2.56, 12)

    const perTick = 2 * accelspeed * (RUN_SPEED - accelspeed) + accelspeed * accelspeed
    const predicted = Math.sqrt(RUN_SPEED * RUN_SPEED + 4 * 90 * perTick)

    expect(predicted).toBeGreaterThan(832 - 15)
    expect(predicted).toBeLessThan(832 + 15)
  })

  it('gains speed from an acceleration exactly perpendicular to the velocity', () => {
    // **Mandatory.** This is the strafe-jump mechanic reduced to one step: the
    // gate is on `dot(velocity, wishdir)`, so a wish direction at 90 degrees to
    // the velocity sees a current speed of zero, the gate opens wide however
    // fast the body is going, and the whole step lands perpendicular — which
    // lengthens the vector. A refactor that "fixes" the maxspeed bug turns this
    // red, and it must, because it has deleted the skill ceiling of the game.
    const velocity: MutVec3 = vec3(RUN_SPEED, 0, 0)
    accelerate(velocity, [0, 1, 0], RUN_SPEED, PM_AIR_ACCELERATE, TICK_DT)

    expect(velocity[1]).toBeCloseTo(PM_AIR_ACCELERATE * TICK_DT * RUN_SPEED, 12)
    expect(lengthVec2(velocity)).toBeGreaterThan(RUN_SPEED)
  })

  it('keeps accelerating in the air far above the ground speed cap', () => {
    const body = standing()
    pmove(FLAT, body, cmd({ buttons: BUTTON_JUMP }))
    setVec3(body.velocity, 900, 0, body.velocity[2])

    // Perpendicular to +x, so the projection is zero and the gate is open.
    const before = speedOf(body)
    pmove(FLAT, body, cmd({ sideMove: -1, yaw: yawUnitsFromDegrees(0) }))

    expect(speedOf(body)).toBeGreaterThan(before)
  })
})

/* --------------------------------------------------------------------------
 * Acceptance gate 3 — the bunny hop
 * ----------------------------------------------------------------------- */

describe('chaining a jump onto a landing', () => {
  /** Jump from 500 ups along +x and fall back down, arriving grounded. */
  function landedAt500(): PmoveBody {
    const body = standing()
    setVec3(body.velocity, 500, 0, 0)
    pmove(FLAT, body, cmd({ buttons: BUTTON_JUMP }))
    for (let i = 0; i < 500 && !body.walking; i += 1) pmove(FLAT, body, NULL_CMD)
    return body
  }

  it('costs exactly nothing when the jump lands on the tick you touch down', () => {
    // `PM_CheckJump` runs before `PM_Friction` and clears `walking`, so there
    // is nothing for friction to charge. Swap those two calls and this test is
    // the one that goes red.
    const body = landedAt500()
    expect(body.walking).toBe(true)
    const before = speedOf(body)

    pmove(FLAT, body, cmd({ forwardMove: 1, buttons: BUTTON_JUMP }))

    expect(speedOf(body)).toBe(before)
  })

  it('costs 4.8% when the jump is one tick late', () => {
    const body = landedAt500()
    const before = speedOf(body)

    // Holding W, which is what a player would be doing — and which cannot
    // refill the loss, because ground acceleration is gated at 320 ups.
    pmove(FLAT, body, cmd({ forwardMove: 1 }))

    const lost = (before - speedOf(body)) / before
    const expected = PM_FRICTION * TICK_DT
    expect(expected).toBeCloseTo(0.048, 12)
    expect(lost).toBeGreaterThan(expected - 0.001)
    expect(lost).toBeLessThan(expected + 0.001)
  })

  it('applies no friction at all in the air', () => {
    const body = standing()
    setVec3(body.velocity, 500, 0, 0)
    pmove(FLAT, body, cmd({ buttons: BUTTON_JUMP }))

    const airborne = speedOf(body)
    for (let i = 0; i < 20; i += 1) pmove(FLAT, body, NULL_CMD)

    expect(body.walking).toBe(false)
    expect(speedOf(body)).toBe(airborne)
  })
})

/* --------------------------------------------------------------------------
 * Acceptance gate 4 — the acceleration and deceleration curves
 * ----------------------------------------------------------------------- */

describe('ground acceleration and friction', () => {
  it('reaches 320 ups from a standstill in 152 ms', () => {
    const body = standing()
    const forward = cmd({ forwardMove: 1 })

    let ticks = 0
    while (speedOf(body) < RUN_SPEED && ticks < 125) {
      pmove(FLAT, body, forward)
      ticks += 1
    }

    expect(speedOf(body)).toBeGreaterThanOrEqual(RUN_SPEED)
    expect(ticks * TICK_INTERVAL_MS).toBeGreaterThanOrEqual(152 - 2 * TICK_INTERVAL_MS)
    expect(ticks * TICK_INTERVAL_MS).toBeLessThanOrEqual(152 + 2 * TICK_INTERVAL_MS)
  })

  it('comes to a complete stop from 320 ups in 360 ms', () => {
    const body = standing()
    setVec3(body.velocity, RUN_SPEED, 0, 0)

    let ticks = 0
    while (speedOf(body) > 0 && ticks < 250) {
      pmove(FLAT, body, NULL_CMD)
      ticks += 1
    }

    expect(speedOf(body)).toBe(0)
    expect(ticks * TICK_INTERVAL_MS).toBeGreaterThanOrEqual(360 - 2 * TICK_INTERVAL_MS)
    expect(ticks * TICK_INTERVAL_MS).toBeLessThanOrEqual(360 + 2 * TICK_INTERVAL_MS)
  })

  it('does not let a diagonal beat a straight line', () => {
    // Un-normalised wish directions are where "hold W+D to go 1.41x faster"
    // comes from, and `PM_CmdScale` is the function that stops it.
    const straight = standing()
    const diagonal = standing()
    for (let i = 0; i < 125; i += 1) {
      pmove(FLAT, straight, cmd({ forwardMove: 1 }))
      pmove(FLAT, diagonal, cmd({ forwardMove: 1, sideMove: 1 }))
    }

    // Not exactly equal, and it cannot be: the diagonal's components settle at
    // (226, -226) once snapped, whose length is 319.61. Within a unit of the
    // straight line is the property; 1.41x faster is the bug.
    expect(speedOf(diagonal)).toBeGreaterThan(speedOf(straight) - 1)
    expect(speedOf(diagonal)).toBeLessThanOrEqual(speedOf(straight))
    expect(speedOf(straight)).toBe(RUN_SPEED)
  })

  it('runs down +x at yaw 0, and strafes right down -y, because +y is left', () => {
    const ahead = standing()
    const sideways = standing()
    for (let i = 0; i < 125; i += 1) {
      pmove(FLAT, ahead, cmd({ forwardMove: 1 }))
      pmove(FLAT, sideways, cmd({ sideMove: 1 }))
    }

    expect(ahead.velocity[0]).toBe(RUN_SPEED)
    expect(ahead.velocity[1]).toBe(0)
    expect(sideways.velocity[0]).toBe(0)
    expect(sideways.velocity[1]).toBe(-RUN_SPEED)
  })
})

/* --------------------------------------------------------------------------
 * Acceptance gate 5 — velocity snapping
 * ----------------------------------------------------------------------- */

describe('velocity snapping', () => {
  it('rounds to nearest rather than truncating', () => {
    const v: MutVec3 = vec3(2.6, -2.6, 0.5)
    snapVelocity(v)
    expect(v).toEqual([3, -3, 1])

    // Truncation would give 2 and -2 here, and would decrement a falling
    // velocity by 7 per tick instead of 6 — an effective gravity of 875 and a
    // 41.6-unit jump. `snap.ts` has the derivation.
    const negativeZero: MutVec3 = vec3(-0.4, -0.4, -0.4)
    snapVelocity(negativeZero)
    expect(Object.is(negativeZero[0], 0)).toBe(true)
  })

  it('leaves every component a whole number after every sub-step', () => {
    const body = standing()
    for (let i = 0; i < 400; i += 1) {
      pmove(
        FLAT,
        body,
        cmd({
          forwardMove: (i % 3) - 1,
          sideMove: (i % 5) - 2 > 1 ? 1 : (i % 5) - 2 < -1 ? -1 : (i % 5) - 2,
          yaw: yawUnitsFromDegrees(i * 7),
          buttons: i % 40 === 0 ? BUTTON_JUMP : 0,
        }),
      )
      for (const component of body.velocity) {
        expect(Number.isInteger(component)).toBe(true)
        expect(Number.isFinite(component)).toBe(true)
      }
    }
  })

  it('turns gravity 800 into an effective 750 for a falling body', () => {
    const body = standing()
    pmove(FLAT, body, cmd({ buttons: BUTTON_JUMP }))

    const decrements = new Set<number>()
    let previous = body.velocity[2]
    for (let i = 0; i < 60; i += 1) {
      pmove(FLAT, body, NULL_CMD)
      decrements.add(previous - body.velocity[2])
      previous = body.velocity[2]
    }

    expect([...decrements]).toEqual([6])
    expect(6 / TICK_DT).toBe(750)
    expect(GRAVITY * TICK_DT).toBeCloseTo(6.4, 12)
  })
})

/* --------------------------------------------------------------------------
 * PM_CmdScale, and the jump axis that is deliberately not in it
 * ----------------------------------------------------------------------- */

describe('PM_CmdScale', () => {
  it('asks for the same speed in every direction', () => {
    // The scale times the *length* of the un-normalised wish vector is the
    // wishspeed, so a cardinal (length 1) and a diagonal (length sqrt 2) both
    // come out at RUN_SPEED.
    expect(cmdScale(1, 0, RUN_SPEED) * 1).toBe(RUN_SPEED)
    expect(cmdScale(0, -1, RUN_SPEED) * 1).toBe(RUN_SPEED)
    expect(cmdScale(1, 1, RUN_SPEED) * Math.sqrt(2)).toBeCloseTo(RUN_SPEED, 12)
    expect(cmdScale(-1, 1, RUN_SPEED) * Math.sqrt(2)).toBeCloseTo(RUN_SPEED, 12)
  })

  it('returns nothing to accelerate along when no key is held', () => {
    expect(cmdScale(0, 0, RUN_SPEED)).toBe(0)
  })

  it('does not tax a player for holding jump', () => {
    // Quake counts `upmove` in the normalisation denominator, which cuts air
    // wishspeed from 320 to 226 while jump is held. Gladiator excludes it, so
    // these two flights are identical.
    const released = standing()
    const held = standing()

    pmove(FLAT, released, cmd({ buttons: BUTTON_JUMP }))
    pmove(FLAT, held, cmd({ buttons: BUTTON_JUMP }))

    for (let i = 0; i < 40; i += 1) {
      pmove(FLAT, released, cmd({ forwardMove: 1, sideMove: 1 }))
      pmove(FLAT, held, cmd({ forwardMove: 1, sideMove: 1, buttons: BUTTON_JUMP }))
    }

    expect(held.velocity).toEqual(released.velocity)
    expect(speedOf(held)).toBeGreaterThan(0)
  })
})

/* --------------------------------------------------------------------------
 * The one CPM borrowing
 * ----------------------------------------------------------------------- */

describe('air braking', () => {
  it('brakes 2.5x harder when the wish direction opposes the velocity', () => {
    // CPMA's `pm_airstopaccelerate`, and the only thing borrowed from it. It
    // applies if and only if `dot(velocity, wishdir) < 0`, so it can slow you
    // along your heading and never speed you up along it.
    const braking = standing()
    const coasting = standing()

    for (const body of [braking, coasting]) {
      pmove(FLAT, body, cmd({ buttons: BUTTON_JUMP }))
      setVec3(body.velocity, 200, 0, body.velocity[2])
    }

    // Facing +x, holding S: the wish direction is -x, straight into the
    // velocity. Facing +x holding nothing: no wish direction at all.
    pmove(FLAT, braking, cmd({ forwardMove: -1 }))
    pmove(FLAT, coasting, NULL_CMD)

    expect(coasting.velocity[0]).toBe(200)
    expect(braking.velocity[0]).toBeLessThan(200)
    // 2.5 * 0.008 * 320 = 6.4, snapped to 6, against air accelerate's 2.56.
    expect(200 - braking.velocity[0]).toBe(6)
  })

  it('does not brake harder when the wish direction merely differs', () => {
    const body = standing()
    pmove(FLAT, body, cmd({ buttons: BUTTON_JUMP }))
    setVec3(body.velocity, 200, 0, body.velocity[2])

    // Perpendicular: the dot product is zero, which is not less than zero.
    pmove(FLAT, body, cmd({ sideMove: 1 }))

    expect(body.velocity[0]).toBe(200)
    expect(body.velocity[1]).toBe(-3) // 1 * 0.008 * 320 = 2.56, snapped
  })
})

/* --------------------------------------------------------------------------
 * The safety rail
 * ----------------------------------------------------------------------- */

describe('the speed clamp', () => {
  it('clamps to 3000 ups and tells whoever is listening', () => {
    const seen: number[] = []
    onSpeedClamp((speed) => seen.push(speed))
    try {
      const body = standing()
      setVec3(body.velocity, 40000, 0, 0)
      pmove(FLAT, body, NULL_CMD)

      expect(seen).toEqual([40000])
      expect(lengthVec2(body.velocity)).toBeLessThanOrEqual(MAX_MOVE_SPEED)
    } finally {
      onSpeedClamp(null)
    }
  })

  it('stays out of the way of everything a match can produce', () => {
    const seen: number[] = []
    onSpeedClamp((speed) => seen.push(speed))
    try {
      // A good rocket jump peaks around 1000; four strafe jumps reach ~830.
      const body = standing()
      setVec3(body.velocity, 1200, 0, 0)
      for (let i = 0; i < 125; i += 1) pmove(FLAT, body, cmd({ forwardMove: 1 }))
      expect(seen).toEqual([])
    } finally {
      onSpeedClamp(null)
    }
  })
})

/* --------------------------------------------------------------------------
 * Determinism
 * ----------------------------------------------------------------------- */

describe('pmove as a function', () => {
  it('is total: the same body and command give the same result, bit for bit', () => {
    const script = [
      cmd({ forwardMove: 1, yaw: yawUnitsFromDegrees(37) }),
      cmd({
        forwardMove: 1,
        sideMove: -1,
        yaw: yawUnitsFromDegrees(41),
        buttons: BUTTON_JUMP,
      }),
      cmd({ sideMove: 1, yaw: yawUnitsFromDegrees(200) }),
    ]

    const play = () => {
      const body = standing()
      for (let i = 0; i < 500; i += 1) {
        pmove(FLAT, body, script[i % script.length] ?? NULL_CMD)
      }
      return body
    }

    const first = play()
    const second = play()
    expect(first.origin).toEqual(second.origin)
    expect(first.velocity).toEqual(second.velocity)
    expect(first.walking).toBe(second.walking)
    expect(first.jumpHeld).toBe(second.jumpHeld)
  })

  it('never lets a player leave the world through the floor', () => {
    const body = standing()
    for (let i = 0; i < 600; i += 1) {
      pmove(
        FLAT,
        body,
        cmd({
          forwardMove: 1,
          sideMove: i % 2 === 0 ? 1 : -1,
          yaw: yawUnitsFromDegrees(i * 13),
          buttons: i % 7 === 0 ? BUTTON_JUMP : 0,
        }),
      )
      expect(body.origin[2]).toBeGreaterThanOrEqual(0)
    }
  })
})
