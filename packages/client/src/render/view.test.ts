import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import {
  BUTTON_JUMP,
  EntityFlag,
  NEVER_FIRED,
  PLAYER_VIEW_HEIGHT,
  SKELETON_ARENA,
  type UserCmd,
  type Vec3,
  angleVectors,
  angleUnitsToRadians,
  createSkeletonState,
  findPlayer,
  pitchUnitsFromDegrees,
  quakeToEngine,
  tick as simTick,
  vec3,
  Weapon,
  yawUnitsFromDegrees,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { advance, alphaOf } from '../loop.ts'
import { commandFrom } from '../input/controller.ts'
import { applyPose, createCamera, createScene } from './scene.ts'
import {
  type CameraPose,
  type RenderView,
  cameraPose,
  interpolateNetState,
  interpolateOrigin,
  lerpAngleUnits,
  viewForwardQuake,
} from './view.ts'

/** Running forward with the jump key held: a state that keeps changing. */
const RUNNING: UserCmd = {
  forwardMove: 1,
  sideMove: 1,
  yaw: yawUnitsFromDegrees(31),
  pitch: pitchUnitsFromDegrees(-7),
  buttons: BUTTON_JUMP,
  weapon: 0,
}

/**
 * One render cadence's worth of the client's frame loop.
 *
 * The same shape as `main.ts`: fold elapsed wall-clock into the accumulator,
 * run whole ticks, interpolate the remainder, ask for a camera pose. The
 * command is constant, so both cadences drive the *same* tick sequence and any
 * difference in the pose is the renderer's fault — which is the whole point.
 *
 * Cadences are chosen to be exactly representable in binary (12.5 ms and
 * 6.25 ms), so the accumulator arithmetic is exact and "identical" can mean
 * identical rather than "close".
 */
function driveAt(cadenceMs: number, frames: number, pose: (view: RenderView) => CameraPose) {
  const state = createSkeletonState()
  // `tick()` advances in place and reuses the same vectors, so the previous
  // frame has to be *copied out* rather than referenced. `AGENTS.md`.
  const originNow = (): Vec3 => {
    const player = findPlayer(state, 0)
    return player === null ? [0, 0, 0] : [player.origin[0], player.origin[1], player.origin[2]]
  }
  let previous: Vec3 = originNow()
  let accumulatorMs = 0
  const samples = new Map<number, CameraPose>()

  for (let frame = 1; frame <= frames; frame += 1) {
    const step = advance(accumulatorMs, cadenceMs)
    accumulatorMs = step.accumulatorMs
    for (let i = 0; i < step.ticks; i += 1) {
      previous = originNow()
      simTick(state, [RUNNING], SKELETON_ARENA)
    }
    samples.set(frame * cadenceMs, {
      ...pose({
        origin: interpolateOrigin(
          { origin: previous },
          { origin: originNow() },
          alphaOf(accumulatorMs),
        ),
        yawUnits: RUNNING.yaw,
        pitchUnits: RUNNING.pitch,
      }),
    })
  }

  return samples
}

/** The instants both cadences land on. */
function coincident(
  slow: ReadonlyMap<number, CameraPose>,
  fast: ReadonlyMap<number, CameraPose>,
): number[] {
  return [...slow.keys()].filter((at) => fast.has(at))
}

describe('cameraPose', () => {
  it('puts the eye above the feet, in the engine frame', () => {
    const pose = cameraPose({ origin: [100, 200, 300], yawUnits: 0, pitchUnits: 0 })
    expect(pose.position).toEqual(quakeToEngine([100, 200, 300 + PLAYER_VIEW_HEIGHT]))
  })

  it('never rolls the view', () => {
    const pose = cameraPose({
      origin: [0, 0, 0],
      yawUnits: yawUnitsFromDegrees(123),
      pitchUnits: pitchUnitsFromDegrees(45),
    })
    expect(pose.rotation[2]).toBe(0)
  })

  it('is a pure function of its argument', () => {
    const view: RenderView = { origin: [1, 2, 3], yawUnits: 4000, pitchUnits: -500 }
    expect(cameraPose(view)).toEqual(cameraPose(view))
  })
})

describe('interpolateOrigin', () => {
  it('lands exactly on the endpoints', () => {
    const a = { origin: [0, 0, 0] } as const
    const b = { origin: [10, 20, 30] } as const
    expect(interpolateOrigin(a, b, 0)).toEqual([0, 0, 0])
    expect(interpolateOrigin(a, b, 1)).toEqual([10, 20, 30])
  })

  it('interpolates each axis independently', () => {
    expect(interpolateOrigin({ origin: [0, 0, 0] }, { origin: [4, 8, 16] }, 0.25)).toEqual([1, 2, 4])
  })
})

/**
 * The acceptance check this file exists for: the render is tick-rate
 * independent. Identical simulation state at equal interpolation alpha has to
 * produce an identical camera transform at two different render cadences.
 */
describe('tick-rate independence', () => {
  const FRAMES_SLOW = 320 // 4 s at 80 Hz
  const FRAMES_FAST = 640 // 4 s at 160 Hz

  it('produces identical camera transforms at 80 Hz and 160 Hz', () => {
    const slow = driveAt(12.5, FRAMES_SLOW, cameraPose)
    const fast = driveAt(6.25, FRAMES_FAST, cameraPose)
    const instants = coincident(slow, fast)

    // If this is small the test is not testing anything.
    expect(instants.length).toBeGreaterThan(300)
    for (const at of instants) {
      expect(slow.get(at), `at ${at} ms`).toEqual(fast.get(at))
    }
  })

  it('would catch a camera that smoothed its position — as Babylon does by default', () => {
    // Babylon's `Camera.inertia` defaults to 0.9: a low-pass filter applied
    // once per *frame*. Anything shaped like it makes the transform depend on
    // how often frames happen, which is exactly what the check above forbids.
    // Proving the harness rejects it is what stops the check above from being
    // a test that can only pass.
    let smoothed: [number, number, number] | null = null
    const withInertia = (view: RenderView): CameraPose => {
      const target = cameraPose(view)
      const [x, y, z] = target.position
      smoothed =
        smoothed === null
          ? [x, y, z]
          : [
              smoothed[0] + (x - smoothed[0]) * 0.1,
              smoothed[1] + (y - smoothed[1]) * 0.1,
              smoothed[2] + (z - smoothed[2]) * 0.1,
            ]
      return { position: smoothed, rotation: target.rotation }
    }

    smoothed = null
    const slow = driveAt(12.5, FRAMES_SLOW, withInertia)
    smoothed = null
    const fast = driveAt(6.25, FRAMES_FAST, withInertia)

    const disagreements = coincident(slow, fast).filter(
      (at) => JSON.stringify(slow.get(at)) !== JSON.stringify(fast.get(at)),
    )
    expect(disagreements.length).toBeGreaterThan(0)
  })
})

/**
 * The axis map, against a real Babylon camera rather than against the
 * derivation in `view.ts`'s header. `NullEngine` runs the whole camera without
 * a GPU, so this is the actual transform the renderer would use.
 */
describe('the pose Babylon ends up with', () => {
  const scene = createScene(new NullEngine())
  const camera = createCamera(scene)

  const cases: readonly (readonly [number, number])[] = [
    [0, 0],
    [90, 0],
    [180, 0],
    [-45, 0],
    [0, 30],
    [0, -30],
    [31, -7],
    [225, 45],
  ]

  it('looks where the simulation says, for every yaw and pitch', () => {
    for (const [yawDegrees, pitchDegrees] of cases) {
      const yawUnits = yawUnitsFromDegrees(yawDegrees)
      const pitchUnits = pitchUnitsFromDegrees(pitchDegrees)
      applyPose(camera, cameraPose({ origin: [0, 0, 0], yawUnits, pitchUnits }))

      const expected = quakeToEngine(
        viewForwardQuake(angleUnitsToRadians(yawUnits), angleUnitsToRadians(pitchUnits)),
      )
      const actual = camera.getDirection(Vector3.Forward(true))

      // Six digits, because Babylon's matrices are `Float32Array`. The failure
      // this guards against is a dropped minus sign, which is off by 2.
      const where = `yaw ${yawDegrees}, pitch ${pitchDegrees}`
      expect(actual.x, `x at ${where}`).toBeCloseTo(expected[0], 6)
      expect(actual.y, `y at ${where}`).toBeCloseTo(expected[1], 6)
      expect(actual.z, `z at ${where}`).toBeCloseTo(expected[2], 6)
    }
  })

  it('keeps the crosshair on the rocket trajectory for human aim in every direction', () => {
    for (const [yawDegrees, pitchDegrees] of cases) {
      const cmd = commandFrom(new Set(), { yawDegrees, pitchDegrees })
      applyPose(
        camera,
        cameraPose({ origin: [0, 0, 0], yawUnits: cmd.yaw, pitchUnits: cmd.pitch }),
      )

      const rocketForward = vec3()
      angleVectors(cmd.pitch, cmd.yaw, 0, rocketForward, null, null)
      const expected = quakeToEngine(rocketForward)
      const actual = camera.getDirection(Vector3.Forward(true))

      const where = `yaw ${yawDegrees}, human pitch ${pitchDegrees}`
      expect(actual.x, `x at ${where}`).toBeCloseTo(expected[0], 6)
      expect(actual.y, `y at ${where}`).toBeCloseTo(expected[1], 6)
      expect(actual.z, `z at ${where}`).toBeCloseTo(expected[2], 6)
    }
  })

  it('does not move the camera when the pose is written', () => {
    // `TargetCamera.setTarget` nudges `position.z` by an epsilon when the eye
    // and the target share it. `applyPose` assigns instead, so the camera is
    // exactly where the simulation put it and stays a puppet.
    const pose = cameraPose({
      origin: [10, 20, 30],
      yawUnits: yawUnitsFromDegrees(90),
      pitchUnits: 0,
    })
    applyPose(camera, pose)
    camera.getViewMatrix()
    expect([camera.position.x, camera.position.y, camera.position.z]).toEqual([...pose.position])
  })

  it('gives the same view matrix for the same pose', () => {
    const pose = cameraPose({ origin: [1, 2, 3], yawUnits: 12345, pitchUnits: -678 })
    applyPose(camera, pose)
    const first = [...camera.getViewMatrix().m]
    applyPose(camera, pose)
    const second = [...camera.getViewMatrix().m]
    expect(second).toEqual(first)
  })
})

describe('interpolating a netstate', () => {
  const base = {
    id: 3,
    slot: 1,
    origin: [0, 0, 0] as Vec3,
    velocity: [0, 0, 0] as Vec3,
    angles: [0, 0, 0] as Vec3,
    flags: 0,
    health: 100,
    weapon: Weapon.RocketLauncher,
    lastFireTick: NEVER_FIRED,
  }

  it('takes the short way round a yaw wrap', () => {
    // 65500 -> 36 is 72 units forward, not 65464 units backward. A plain lerp
    // spins the opponent through 359 degrees in a single frame, which is a
    // very convincing impression of a network problem.
    expect(lerpAngleUnits(65500, 36, 0.5)).toBeCloseTo(65536, 6)
    expect(lerpAngleUnits(36, 65500, 0.5)).toBeCloseTo(0, 6)
    expect(lerpAngleUnits(1000, 2000, 0.25)).toBeCloseTo(1250, 6)
  })

  it('interpolates the continuous fields', () => {
    const blended = interpolateNetState(
      { ...base, origin: [0, 0, 0], velocity: [0, 0, 0] },
      { ...base, origin: [100, -40, 8], velocity: [320, 0, -20] },
      0.25,
    )
    expect([...blended.origin]).toEqual([25, -10, 2])
    expect([...blended.velocity]).toEqual([80, 0, -5])
  })

  it('never blends a discrete one', () => {
    // Half a weapon switch is not a thing, and neither is half a death.
    const blended = interpolateNetState(
      { ...base, weapon: Weapon.RocketLauncher, health: 100, flags: 0, lastFireTick: 1 },
      { ...base, weapon: Weapon.Railgun, health: 0, flags: EntityFlag.Dead, lastFireTick: 9 },
      0.5,
    )
    expect(blended.weapon).toBe(Weapon.Railgun)
    expect(blended.health).toBe(0)
    expect(blended.flags).toBe(EntityFlag.Dead)
    expect(blended.lastFireTick).toBe(9)
  })

  it('produces a copy, so nothing downstream can reach the states it came from', () => {
    const previous = { ...base, origin: [0, 0, 0] as Vec3 }
    const current = { ...base, origin: [10, 0, 0] as Vec3 }
    const blended = interpolateNetState(previous, current, 1)
    expect(blended.origin).not.toBe(current.origin)
    expect([...blended.origin]).toEqual([...current.origin])
  })
})
