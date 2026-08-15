/**
 * The first-person viewmodel: what it is holding, where it sits, and the one
 * structural property it is built for — that it cannot disagree with the view.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import {
  EntityFlag,
  EntityKind,
  type EntityState,
  NEVER_EXPIRES,
  NEVER_FIRED,
  Weapon,
  pitchUnitsFromDegrees,
  yawUnitsFromDegrees,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { INITIAL_ANIM, advanceAnim, playerNetState } from './animState.ts'
import { applyPose, createCamera, createScene } from './scene.ts'
import { cameraPose } from './view.ts'
import {
  VIEWMODEL_REST,
  VIEWMODEL_RENDERING_GROUP,
  createViewmodel,
  viewmodelPose,
} from './viewmodel.ts'

function entity(patch: Partial<EntityState> = {}): EntityState {
  return {
    id: 1,
    kind: EntityKind.Player,
    slot: 0,
    flags: EntityFlag.OnGround,
    origin: [0, 0, 0],
    velocity: [0, 0, 0],
    angles: [0, 0, 0],
    health: 100,
    weapon: Weapon.RocketLauncher,
    lastFireTick: NEVER_FIRED,
    knockbackTicks: 0,
    ownerId: 0,
    spawnTick: 0,
    expireTick: NEVER_EXPIRES,
    ...patch,
  }
}

function mounted() {
  const scene = createScene(new NullEngine())
  const camera = createCamera(scene)
  return { scene, camera, viewmodel: createViewmodel(scene, camera) }
}

function draw(
  viewmodel: ReturnType<typeof createViewmodel>,
  state: EntityState,
  tick = 0,
  alpha = 0,
) {
  const net = playerNetState(state)
  viewmodel.update(net, advanceAnim(INITIAL_ANIM, net, tick), tick, alpha)
}

describe('the viewmodel', () => {
  it('hangs off the camera, so there is one transform and not two', () => {
    const { scene, camera } = mounted()
    const root = scene.getTransformNodeByName('viewmodel')
    expect(root).not.toBeNull()
    // The whole reason for the design: nothing here recomputes the view, so
    // nothing here can get it wrong at one particular yaw.
    expect(root?.parent).toBe(camera)
  })

  it('rides the camera wherever the puppet is put', () => {
    const { scene, camera, viewmodel } = mounted()
    draw(viewmodel, entity({ weapon: Weapon.RocketLauncher }))

    applyPose(
      camera,
      cameraPose({
        origin: [512, -256, 64],
        yawUnits: yawUnitsFromDegrees(115),
        pitchUnits: pitchUnitsFromDegrees(-12),
      }),
    )
    camera.getViewMatrix()

    const barrel = scene.getMeshByName('viewmodel:rocket.body')
    barrel?.computeWorldMatrix(true)
    const eye = camera.globalPosition
    const gun = barrel?.getAbsolutePosition()

    // Held at arm's length, wherever the eye went. A broken parent chain leaves
    // it at the origin, half an arena away, which is what this catches.
    expect(gun).toBeDefined()
    expect(gun?.subtract(eye).length()).toBeLessThan(40)
  })

  it('draws in its own group, over the world', () => {
    const { scene } = mounted()
    const barrel = scene.getMeshByName('viewmodel:rocket.body')
    expect(barrel?.renderingGroupId).toBe(VIEWMODEL_RENDERING_GROUP)
  })

  it('shows nothing until a netstate arrives', () => {
    const { scene, viewmodel } = mounted()
    expect(viewmodel.weapon).toBe(Weapon.None)
    expect(scene.getTransformNodeByName('viewmodel:rocket')?.isEnabled()).toBe(false)
    expect(scene.getTransformNodeByName('viewmodel:rail')?.isEnabled()).toBe(false)
  })

  it('switches weapon within one snapshot', () => {
    const { scene, viewmodel } = mounted()
    const launcher = scene.getTransformNodeByName('viewmodel:rocket')
    const railgun = scene.getTransformNodeByName('viewmodel:rail')

    draw(viewmodel, entity({ weapon: Weapon.RocketLauncher }))
    expect(viewmodel.weapon).toBe(Weapon.RocketLauncher)
    expect(launcher?.isEnabled()).toBe(true)
    expect(railgun?.isEnabled()).toBe(false)

    draw(viewmodel, entity({ weapon: Weapon.Railgun }), 1)
    expect(viewmodel.weapon).toBe(Weapon.Railgun)
    expect(launcher?.isEnabled()).toBe(false)
    expect(railgun?.isEnabled()).toBe(true)
  })

  it('can be hidden and shown again without forgetting the weapon', () => {
    const { scene, viewmodel } = mounted()
    draw(viewmodel, entity({ weapon: Weapon.Railgun }))

    viewmodel.setVisible(false)
    expect(scene.getTransformNodeByName('viewmodel:rail')?.isEnabled()).toBe(false)
    expect(viewmodel.weapon).toBe(Weapon.Railgun)

    viewmodel.setVisible(true)
    expect(scene.getTransformNodeByName('viewmodel:rail')?.isEnabled()).toBe(true)
  })
})

describe('the viewmodel pose', () => {
  const still = playerNetState(entity())
  const stillFrame = advanceAnim(INITIAL_ANIM, still, 0)

  it('is pure', () => {
    expect(viewmodelPose(still, stillFrame, 40, 0.25)).toEqual(
      viewmodelPose(still, stillFrame, 40, 0.25),
    )
  })

  it('sways gently when standing still and never leaves the corner', () => {
    // Standing still is not standing *frozen* — a completely static viewmodel
    // reads as a paused game.
    const samples = Array.from({ length: 200 }, (_, i) =>
      viewmodelPose(still, stillFrame, i * 4, 0),
    )
    const xs = samples.map((pose) => pose.position[0])
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.2)
    for (const x of xs) expect(Math.abs(x - VIEWMODEL_REST[0])).toBeLessThan(2)
  })

  it('bobs further at a run than at a standstill', () => {
    const running = playerNetState(entity({ velocity: [320, 0, 0] }))
    const frame = advanceAnim(INITIAL_ANIM, running, 0)

    const spread = (pose: (tick: number) => number) => {
      const values = Array.from({ length: 120 }, (_, i) => pose(i))
      return Math.max(...values) - Math.min(...values)
    }

    const run = spread((tick) => viewmodelPose(running, frame, tick, 0).position[1])
    const idle = spread((tick) => viewmodelPose(still, stillFrame, tick, 0).position[1])
    expect(run).toBeGreaterThan(idle)
  })

  it('drops the weapon while airborne', () => {
    const airborne = playerNetState(entity({ flags: 0, velocity: [0, 0, 260] }))
    const frame = advanceAnim(INITIAL_ANIM, airborne, 0)
    expect(viewmodelPose(airborne, frame, 0, 0).position[1]).toBeLessThan(
      VIEWMODEL_REST[1] - 1,
    )
  })

  it('kicks back and up on a shot, then settles', () => {
    const shot = playerNetState(entity({ lastFireTick: 60 }))
    const frame = advanceAnim(INITIAL_ANIM, shot, 60)

    const fired = viewmodelPose(shot, frame, 60, 0)
    const settled = viewmodelPose(shot, frame, 90, 0)

    // Camera-local `-z` is forward, so a kick towards the eye is `+z`.
    expect(fired.position[2]).toBeGreaterThan(VIEWMODEL_REST[2] + 3)
    expect(fired.rotation[0]).toBeGreaterThan(0)
    expect(settled.position[2]).toBeCloseTo(VIEWMODEL_REST[2], 6)
    expect(settled.rotation[0]).toBeCloseTo(0, 6)
  })
})
