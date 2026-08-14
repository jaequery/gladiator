/**
 * The animation state machine, driven by recorded netstate.
 *
 * The suite the acceptance check names: a recorded sequence of `EntityState`
 * goes in and a sequence of animation states comes out, asserted literally. No
 * engine, no canvas, no clock — if any of those were needed to answer "what
 * animation is this player playing", the answer would not be a function of
 * network state, which is the property the whole file exists to have.
 */
import {
  EntityFlag,
  EntityKind,
  type EntityState,
  NEVER_EXPIRES,
  NEVER_FIRED,
  type MutVec3,
  Weapon,
  yawUnitsFromDegrees,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  AnimState,
  FIRE_TICKS,
  INITIAL_ANIM,
  LAND_TICKS,
  MoveDirection,
  advanceAnim,
  animSequence,
  moveDirection,
  playerNetState,
} from './animState.ts'

type EntityPatch = {
  origin?: MutVec3
  velocity?: MutVec3
  angles?: MutVec3
  flags?: number
  health?: number
  weapon?: Weapon
  lastFireTick?: number
}

/** One player entity, exactly as a snapshot would carry it. */
function entity(patch: EntityPatch = {}): EntityState {
  return {
    id: 7,
    kind: EntityKind.Player,
    slot: 1,
    flags: patch.flags ?? EntityFlag.OnGround,
    origin: patch.origin ?? [0, 0, 0],
    velocity: patch.velocity ?? [0, 0, 0],
    angles: patch.angles ?? [0, 0, 0],
    health: patch.health ?? 100,
    weapon: patch.weapon ?? Weapon.RocketLauncher,
    lastFireTick: patch.lastFireTick ?? NEVER_FIRED,
    knockbackTicks: 0,
    ownerId: 0,
    spawnTick: 0,
    expireTick: NEVER_EXPIRES,
  }
}

const STANDING = entity()
const RUNNING = entity({ velocity: [300, 0, 0] })
const AIRBORNE = entity({ flags: 0, velocity: [300, 0, 220] })
const DEAD = entity({ flags: EntityFlag.Dead, health: 0 })

/**
 * A recorded duel, one entry per tick: stand, run, jump, land, shoot a rocket,
 * switch to the rail, shoot that, die.
 *
 * Written as runs rather than as 200 literals, because what is being asserted
 * is the *transitions*, and a list long enough to hide one is a list nobody
 * will read.
 */
function recorded(): EntityState[] {
  const frames: EntityState[] = []
  const repeat = (state: EntityState, times: number) => {
    for (let i = 0; i < times; i += 1) frames.push(state)
  }

  repeat(STANDING, 3) //            ticks 0-2:   idle
  repeat(RUNNING, 3) //             ticks 3-5:   run
  repeat(AIRBORNE, 4) //            ticks 6-9:   jump
  repeat(RUNNING, 3) //             ticks 10-12: land, then still landing
  frames.push(entity({ velocity: [300, 0, 0], lastFireTick: 13 })) // 13: rocket
  frames.push(entity({ velocity: [300, 0, 0], lastFireTick: 13 })) // 14: still
  frames.push(
    entity({ velocity: [300, 0, 0], weapon: Weapon.Railgun, lastFireTick: 15 }),
  ) //                              tick 15:     rail
  repeat(DEAD, 2) //                ticks 16-17: death
  return frames
}

describe('the animation state machine', () => {
  it('turns a recorded netstate sequence into an animation sequence', () => {
    const states = recorded().map(playerNetState)
    const sequence = animSequence(states).map((frame) => frame.state)

    expect(sequence).toEqual([
      AnimState.Idle,
      AnimState.Idle,
      AnimState.Idle,
      AnimState.Run,
      AnimState.Run,
      AnimState.Run,
      AnimState.Jump,
      AnimState.Jump,
      AnimState.Jump,
      AnimState.Jump,
      // Airborne last tick, on the ground this one: a landing, held for
      // LAND_TICKS whatever the legs are doing.
      AnimState.Land,
      AnimState.Land,
      AnimState.Land,
      AnimState.FireRocket,
      AnimState.FireRocket,
      AnimState.FireRail,
      AnimState.Death,
      AnimState.Death,
    ])
  })

  it('is a pure function: the same recording twice is the same sequence', () => {
    const states = recorded().map(playerNetState)
    expect(animSequence(states)).toEqual(animSequence(states))
  })

  it('never writes to the state it was given', () => {
    // The readonly boundary, proved at runtime rather than only in the types: a
    // frozen entity would throw on assignment in a module, which is strict
    // mode. `playerNetState` copies, so the frozen arrays are safe to hand over.
    const source = entity({ velocity: [300, 0, 0] })
    Object.freeze(source.origin)
    Object.freeze(source.velocity)
    Object.freeze(source.angles)
    Object.freeze(source)

    const net = playerNetState(source)
    expect(() => animSequence([net, net, net])).not.toThrow()
  })

  it('is readonly at compile time, which is where the boundary is enforced', () => {
    // The runtime checks above are belt; this is braces, and it is the stronger
    // half. `tsc` fails the build if either of these assignments becomes legal,
    // so there is no way to write a render-layer value back towards the
    // simulation — not even by accident, and not only in code somebody tested.
    const net = playerNetState(entity())

    // @ts-expect-error — `PlayerNetState` is readonly, field by field.
    net.weapon = Weapon.Railgun
    // @ts-expect-error — and `Vec3` is a readonly tuple, so not through a
    // vector either.
    net.origin[0] = 1
  })

  it('copies rather than aliases, so a later tick cannot change the past', () => {
    const source = entity({ velocity: [300, 0, 0] })
    const net = playerNetState(source)
    // `tick()` mutates entities in place and keeps the same objects, so a view
    // that held a reference would silently follow the simulation forward.
    source.velocity[0] = -1
    source.weapon = Weapon.Railgun
    expect(net.velocity[0]).toBe(300)
    expect(net.weapon).toBe(Weapon.RocketLauncher)
  })

  it('holds the landing for LAND_TICKS and then goes back to running', () => {
    const airborne = playerNetState(AIRBORNE)
    const running = playerNetState(RUNNING)

    let frame = advanceAnim(INITIAL_ANIM, airborne, 0)
    expect(frame.state).toBe(AnimState.Jump)

    frame = advanceAnim(frame, running, 1)
    expect(frame.state).toBe(AnimState.Land)
    expect(frame.since).toBe(1)

    frame = advanceAnim(frame, running, 1 + LAND_TICKS - 1)
    expect(frame.state).toBe(AnimState.Land)

    frame = advanceAnim(frame, running, 1 + LAND_TICKS)
    expect(frame.state).toBe(AnimState.Run)
  })

  it('shows the firing pose for FIRE_TICKS and no longer', () => {
    const net = playerNetState(entity({ lastFireTick: 100 }))

    expect(advanceAnim(INITIAL_ANIM, net, 100).state).toBe(AnimState.FireRocket)
    expect(advanceAnim(INITIAL_ANIM, net, 100 + FIRE_TICKS - 1).state).toBe(
      AnimState.FireRocket,
    )
    expect(advanceAnim(INITIAL_ANIM, net, 100 + FIRE_TICKS).state).toBe(AnimState.Idle)
    // A shot the client has not reached yet — a snapshot from ahead of us.
    expect(advanceAnim(INITIAL_ANIM, net, 99).state).toBe(AnimState.Idle)
  })

  it('distinguishes the two weapons in the firing pose', () => {
    const rocket = playerNetState(entity({ lastFireTick: 4 }))
    const rail = playerNetState(entity({ weapon: Weapon.Railgun, lastFireTick: 4 }))
    const empty = playerNetState(entity({ weapon: Weapon.None, lastFireTick: 4 }))

    expect(advanceAnim(INITIAL_ANIM, rocket, 4).state).toBe(AnimState.FireRocket)
    expect(advanceAnim(INITIAL_ANIM, rail, 4).state).toBe(AnimState.FireRail)
    // Nothing in your hands, nothing to fire — and no crash either.
    expect(advanceAnim(INITIAL_ANIM, empty, 4).state).toBe(AnimState.Idle)
  })

  it('reads death from either the flag or the health', () => {
    const flagged = playerNetState(entity({ flags: EntityFlag.Dead }))
    const bled = playerNetState(entity({ health: 0 }))
    // Death outranks a shot fired on the same tick.
    const shotDead = playerNetState(entity({ health: 0, lastFireTick: 9 }))

    expect(advanceAnim(INITIAL_ANIM, flagged, 9).state).toBe(AnimState.Death)
    expect(advanceAnim(INITIAL_ANIM, bled, 9).state).toBe(AnimState.Death)
    expect(advanceAnim(INITIAL_ANIM, shotDead, 9).state).toBe(AnimState.Death)
  })

  it('keeps `since` at the tick a state was entered', () => {
    const running = playerNetState(RUNNING)
    let frame = advanceAnim(INITIAL_ANIM, running, 40)
    expect(frame).toMatchObject({ state: AnimState.Run, since: 40 })

    frame = advanceAnim(frame, running, 41)
    expect(frame.since).toBe(40)
  })
})

describe('directional running', () => {
  const facingNorth = yawUnitsFromDegrees(90)

  it('reads travel relative to facing, not to the world', () => {
    // Facing +x (yaw 0). Quake: +x forward, +y left.
    expect(moveDirection([300, 0, 0], 0)).toBe(MoveDirection.Forward)
    expect(moveDirection([-300, 0, 0], 0)).toBe(MoveDirection.Back)
    expect(moveDirection([0, 300, 0], 0)).toBe(MoveDirection.Left)
    expect(moveDirection([0, -300, 0], 0)).toBe(MoveDirection.Right)
  })

  it('turns with the player: the same velocity reads differently at a new yaw', () => {
    // Travelling +x while facing +y is a *right* strafe: the world velocity has
    // not changed, only where the player is looking. A mirrored version of this
    // is the bug the test exists for — it tells you the opponent is about to
    // move the wrong way.
    expect(moveDirection([300, 0, 0], facingNorth)).toBe(MoveDirection.Right)
    expect(moveDirection([0, 300, 0], facingNorth)).toBe(MoveDirection.Forward)
  })

  it('is still below the idle threshold, whatever the yaw', () => {
    expect(moveDirection([1, 1, 0], 0)).toBe(MoveDirection.Still)
    expect(moveDirection([0, 0, 900], 0)).toBe(MoveDirection.Still)
  })

  it('carries a direction while airborne, because a jump has one', () => {
    const frame = advanceAnim(INITIAL_ANIM, playerNetState(AIRBORNE), 0)
    expect(frame.state).toBe(AnimState.Jump)
    expect(frame.move).toBe(MoveDirection.Forward)
    expect(frame.airborne).toBe(true)
  })
})
