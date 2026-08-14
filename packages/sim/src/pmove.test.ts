import { describe, expect, it } from 'vitest'

import { hashPlayerState } from './hash.ts'
import { JUMP_VELOCITY, PLANE_HALF_EXTENT, RUN_SPEED, SPAWN_STATE, pmove } from './pmove.ts'
import { TICK_DT, TICK_RATE } from './tick.ts'
import {
  BUTTON_JUMP,
  NULL_CMD,
  type UserCmd,
  yawUnitsFromDegrees,
} from './usercmd.ts'

function cmd(overrides: Partial<UserCmd>): UserCmd {
  return { ...NULL_CMD, ...overrides }
}

/** Run `count` ticks of the same command, from spawn. */
function run(count: number, command: UserCmd) {
  let state = SPAWN_STATE
  for (let i = 0; i < count; i += 1) state = pmove(state, command)
  return state
}

describe('pmove (skeleton)', () => {
  it('stands still with a null command', () => {
    const state = run(TICK_RATE, NULL_CMD)
    expect(state.origin).toEqual([0, 0, 0])
    expect(state.velocity).toEqual([0, 0, 0])
    expect(state.onGround).toBe(true)
  })

  it('runs forward along +x at run speed when facing yaw 0', () => {
    const state = run(TICK_RATE, cmd({ forwardMove: 1 }))
    expect(state.origin[0]).toBeCloseTo(RUN_SPEED, 6)
    expect(state.origin[1]).toBeCloseTo(0, 9)
    expect(state.origin[2]).toBe(0)
  })

  it('strafes right along -y, because +y is left in the Quake frame', () => {
    const state = run(TICK_RATE, cmd({ sideMove: 1 }))
    expect(state.origin[0]).toBeCloseTo(0, 9)
    expect(state.origin[1]).toBeCloseTo(-RUN_SPEED, 6)
  })

  it('turns the view: yaw 90 sends forward down +y', () => {
    const state = run(TICK_RATE, cmd({ forwardMove: 1, yaw: yawUnitsFromDegrees(90) }))
    expect(state.origin[0]).toBeCloseTo(0, 3)
    expect(state.origin[1]).toBeCloseTo(RUN_SPEED, 3)
  })

  it('does not let diagonal input beat forward input', () => {
    // Un-normalised wishdir is where "hold W+D to go 1.41x faster" comes from.
    const straight = run(TICK_RATE, cmd({ forwardMove: 1 }))
    const diagonal = run(TICK_RATE, cmd({ forwardMove: 1, sideMove: 1 }))
    const speedOf = (o: readonly [number, number, number]) => Math.sqrt(o[0] * o[0] + o[1] * o[1])
    expect(speedOf(diagonal.origin)).toBeCloseTo(speedOf(straight.origin), 6)
  })

  it('jumps, leaves the ground, and lands again', () => {
    const jump = cmd({ buttons: BUTTON_JUMP })
    let state = pmove(SPAWN_STATE, jump)
    expect(state.onGround).toBe(false)
    expect(state.origin[2]).toBeGreaterThan(0)

    let peak = state.origin[2]
    let airborneTicks = 1
    while (!state.onGround && airborneTicks < TICK_RATE * 5) {
      state = pmove(state, NULL_CMD)
      peak = Math.max(peak, state.origin[2])
      airborneTicks += 1
    }

    expect(state.onGround).toBe(true)
    expect(state.origin[2]).toBe(0)
    // v^2 / 2g, give or take one tick of discretisation.
    expect(peak).toBeGreaterThan(40)
    expect(peak).toBeLessThan(50)
    expect(airborneTicks).toBeCloseTo((2 * JUMP_VELOCITY) / 800 / TICK_DT, -1)
  })

  it('cannot leave the plane, and stops dead at the edge', () => {
    const state = run(TICK_RATE * 20, cmd({ forwardMove: 1 }))
    expect(state.origin[0]).toBeLessThan(PLANE_HALF_EXTENT)
    expect(state.origin[0]).toBeGreaterThan(PLANE_HALF_EXTENT - 64)
    expect(state.velocity[0]).toBe(0)
  })

  it('is a pure function: the same inputs give the same state, bit for bit', () => {
    const script = [
      cmd({ forwardMove: 1, yaw: yawUnitsFromDegrees(37) }),
      cmd({ forwardMove: 1, sideMove: -1, yaw: yawUnitsFromDegrees(41), buttons: BUTTON_JUMP }),
      cmd({ sideMove: 1, yaw: yawUnitsFromDegrees(200) }),
    ]
    const play = () => {
      let state = SPAWN_STATE
      for (let i = 0; i < 500; i += 1) state = pmove(state, script[i % script.length] ?? NULL_CMD)
      return state
    }
    const first = play()
    const second = play()
    expect(hashPlayerState(500, first)).toBe(hashPlayerState(500, second))
    expect(first.origin).toEqual(second.origin)
    expect(first.velocity).toEqual(second.velocity)
  })

  it('never produces a value the hash cannot represent', () => {
    let state = SPAWN_STATE
    for (let i = 0; i < 2000; i += 1) {
      state = pmove(
        state,
        cmd({
          forwardMove: (i % 3) - 1,
          sideMove: (i % 5) - 2 > 1 ? 1 : (i % 5) - 2 < -1 ? -1 : (i % 5) - 2,
          yaw: yawUnitsFromDegrees(i * 7),
          buttons: i % 40 === 0 ? BUTTON_JUMP : 0,
        }),
      )
      for (const value of [...state.origin, ...state.velocity]) {
        expect(Number.isFinite(value)).toBe(true)
      }
    }
  })
})
