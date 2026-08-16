/**
 * The opponent's rig: where it is drawn, what it is holding, and what it may
 * not touch.
 *
 * Runs against a real Babylon scene under `NullEngine`, so the transforms
 * asserted here are the ones the engine composes rather than the ones this
 * repository believes it composes. That distinction is what caught the winding
 * bug in `mapMesh.ts`, and it is worth paying for again.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import {
  EntityFlag,
  EntityKind,
  type EntityState,
  NEVER_EXPIRES,
  NEVER_FIRED,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  Weapon,
  angleUnitsToRadians,
  quakeToEngine,
  yawUnitsFromDegrees,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  AnimState,
  INITIAL_ANIM,
  LAND_TICKS,
  type PlayerNetState,
  advanceAnim,
  playerNetState,
} from './animState.ts'
import {
  HIP_HEIGHT,
  createPlayerRig,
  createPlayerRoster,
  playerPose,
  stridePhase,
  tintForSlot,
} from './playerModel.ts'
import { createScene } from './scene.ts'

function entity(patch: Partial<EntityState> = {}): EntityState {
  return {
    id: 7,
    kind: EntityKind.Player,
    slot: 1,
    flags: EntityFlag.OnGround,
    origin: [0, 0, 0],
    velocity: [0, 0, 0],
    angles: [0, 0, 0],
    health: 100,
    armor: 100,
    weapon: Weapon.RocketLauncher,
    lastFireTick: NEVER_FIRED,
    knockbackTicks: 0,
    ownerId: 0,
    nextFireTick: 0,
    trBase: [0, 0, 0],
    spawnTick: 0,
    expireTick: NEVER_EXPIRES,
    ...patch,
  }
}

function rigged() {
  const scene = createScene(new NullEngine())
  const rig = createPlayerRig(scene, { name: 'player7', tint: [1, 0.5, 0.2] })
  return { scene, rig }
}

/** Drive one netstate through the machine and onto the rig. */
function draw(
  rig: ReturnType<typeof createPlayerRig>,
  net: PlayerNetState,
  tick = 0,
  alpha = 0,
) {
  const frame = advanceAnim(INITIAL_ANIM, net, tick)
  rig.update(net, frame, tick, alpha)
  return frame
}

describe('the opponent rig', () => {
  it('stands where the netstate says, in the engine frame', () => {
    const { rig } = rigged()
    const origin: [number, number, number] = [128, -64, 32]
    draw(rig, playerNetState(entity({ origin })))

    const [x, y, z] = quakeToEngine(origin)
    expect(rig.root.position.x).toBeCloseTo(x, 6)
    expect(rig.root.position.y).toBeCloseTo(y, 6)
    expect(rig.root.position.z).toBeCloseTo(z, 6)
  })

  it('faces where the netstate says: Quake yaw, unchanged, in radians', () => {
    const { rig } = rigged()
    const yawUnits = yawUnitsFromDegrees(37)
    draw(rig, playerNetState(entity({ angles: [0, yawUnits, 0] })))

    expect(rig.root.rotation.y).toBeCloseTo(angleUnitsToRadians(yawUnits), 9)
    // No roll on the root, ever: a rolled *body* is a lean, and it belongs on
    // the node below so that facing stays exactly the netstate's yaw.
    expect(rig.root.rotation.z).toBe(0)
  })

  it('draws the interpolated position it is handed, not a rounded one', () => {
    const { rig } = rigged()
    // What `interpolateNetState` produces halfway between two ticks.
    draw(rig, playerNetState(entity({ origin: [10.5, 0, 0] })))
    expect(rig.root.position.z).toBeCloseTo(-10.5, 9)
  })

  it('switches the visible weapon within one snapshot', () => {
    const { scene, rig } = rigged()
    const launcher = scene.getTransformNodeByName('player7:rocket') as TransformNode
    const railgun = scene.getTransformNodeByName('player7:rail') as TransformNode

    draw(rig, playerNetState(entity({ weapon: Weapon.RocketLauncher })))
    expect(rig.weapon).toBe(Weapon.RocketLauncher)
    expect(launcher.isEnabled()).toBe(true)
    expect(railgun.isEnabled()).toBe(false)

    // Exactly one more update — one snapshot's worth — and the rail is out.
    draw(rig, playerNetState(entity({ weapon: Weapon.Railgun })), 1)
    expect(rig.weapon).toBe(Weapon.Railgun)
    expect(launcher.isEnabled()).toBe(false)
    expect(railgun.isEnabled()).toBe(true)
  })

  it('shows nothing when the netstate says empty hands', () => {
    const { scene, rig } = rigged()
    const launcher = scene.getTransformNodeByName('player7:rocket') as TransformNode
    const railgun = scene.getTransformNodeByName('player7:rail') as TransformNode

    draw(rig, playerNetState(entity({ weapon: Weapon.RocketLauncher })))
    draw(rig, playerNetState(entity({ weapon: Weapon.None })), 1)

    expect(rig.weapon).toBe(Weapon.None)
    expect(launcher.isEnabled()).toBe(false)
    expect(railgun.isEnabled()).toBe(false)
  })

  it('keeps the body inside the simulation box, which owns the hitbox', () => {
    const { rig } = rigged()
    draw(rig, playerNetState(entity()))
    rig.root.computeWorldMatrix(true)

    // The weapon is *held out*, and so is the arm holding it, exactly the way
    // Quake's models have always been: what a player shoots at is the body, and
    // the body is what has to agree with the box. The rest is a hand and a gun
    // sticking out in front of it.
    const held = [':rocket', ':rail', ':arm.r']

    for (const mesh of rig.root.getChildMeshes()) {
      if (held.some((part) => mesh.name.includes(part))) continue
      // Computing the world matrix is what refreshes `*World` on the bounding
      // box; there is nothing else to ask for.
      mesh.computeWorldMatrix(true)
      const { minimumWorld, maximumWorld } = mesh.getBoundingInfo().boundingBox

      // Engine frame: `(qx, qy, qz) -> (-qy, qz, -qx)`, so the Quake box
      // `+/-15 x +/-15 x 0..56` is `+/-15 x 0..56 x +/-15`.
      expect(minimumWorld.x).toBeGreaterThanOrEqual(-PLAYER_HALF_WIDTH - 0.01)
      expect(maximumWorld.x).toBeLessThanOrEqual(PLAYER_HALF_WIDTH + 0.01)
      expect(minimumWorld.y).toBeGreaterThanOrEqual(-0.01)
      expect(maximumWorld.y).toBeLessThanOrEqual(PLAYER_HEIGHT + 0.01)
      expect(minimumWorld.z).toBeGreaterThanOrEqual(-PLAYER_HALF_WIDTH - 0.01)
      expect(maximumWorld.z).toBeLessThanOrEqual(PLAYER_HALF_WIDTH + 0.01)
    }
  })

  it('points the weapon where the player is facing, not at the sky', () => {
    const { scene, rig } = rigged()
    draw(rig, playerNetState(entity({ weapon: Weapon.RocketLauncher })))
    rig.root.computeWorldMatrix(true)

    const at = (name: string) => {
      const mesh = scene.getMeshByName(name)
      mesh?.computeWorldMatrix(true)
      return mesh?.getAbsolutePosition()
    }
    const breech = at('player7:rocket.breech')
    const bore = at('player7:rocket.bore')
    expect(breech).toBeDefined()
    expect(bore).toBeDefined()

    // The rig faces `-z` at yaw zero, so a weapon held out in front has its
    // muzzle further along `-z` than its breech, by most of its length.
    // Getting this wrong is not subtle and it is not loud either: the arm
    // swings about its shoulder, so a weapon hung straight off it points
    // *upwards*, and an opponent holds their launcher like a flagpole. See
    // `GRASP`.
    expect((bore?.z ?? 0) - (breech?.z ?? 0)).toBeLessThan(-20)
    // And it stays at about the height of the hand holding it.
    expect(Math.abs((bore?.y ?? 0) - (breech?.y ?? 0))).toBeLessThan(2)
    expect(bore?.y).toBeGreaterThan(HIP_HEIGHT)
    expect(bore?.y).toBeLessThan(PLAYER_HEIGHT)
  })

  it('drives the weapon back along its own barrel when it fires', () => {
    const { scene, rig } = rigged()
    const shot = playerNetState(entity({ weapon: Weapon.RocketLauncher, lastFireTick: 100 }))

    const handAt = (tick: number) => {
      rig.update(shot, advanceAnim(INITIAL_ANIM, shot, tick), tick, 0)
      return scene.getTransformNodeByName('player7:hand')?.position.clone()
    }

    const fired = handAt(100)
    const settled = handAt(140)
    expect(fired).toBeDefined()

    // The hand hangs off the shoulder along `-y`, so the barrel lies along the
    // arm and recoil is towards `+y` — back into the shoulder. Written on `z`
    // instead, which is what it used to be, the same number drives the weapon
    // *sideways* out of the hand, and every assertion about the pose value it
    // came from still passes.
    expect(fired?.y).toBeGreaterThan((settled?.y ?? 0) + 4)
    expect(fired?.x).toBeCloseTo(settled?.x ?? 0, 6)
    expect(fired?.z).toBeCloseTo(settled?.z ?? 0, 6)
  })

  it('never writes back into the state it was given', () => {
    const { rig } = rigged()
    const source = entity({ origin: [16, 8, 4], velocity: [300, 0, 0] })
    const before = JSON.stringify(source)

    const net = playerNetState(source)
    Object.freeze(net)
    Object.freeze(net.origin)
    Object.freeze(net.velocity)
    Object.freeze(net.angles)

    expect(() => draw(rig, net)).not.toThrow()
    expect(JSON.stringify(source)).toBe(before)
  })

  it('disposes its meshes and its materials', () => {
    const { scene, rig } = rigged()
    draw(rig, playerNetState(entity()))
    const meshes = scene.meshes.length
    expect(meshes).toBeGreaterThan(0)

    rig.dispose()
    expect(scene.meshes).toHaveLength(0)
    expect(scene.getTransformNodeByName('player7')).toBeNull()
  })
})

describe('the pose', () => {
  const net = playerNetState(entity({ velocity: [300, 0, 0] }))

  it('is a pure function of the frame, the netstate and the clock', () => {
    const frame = advanceAnim(INITIAL_ANIM, net, 12)
    expect(playerPose(frame, net, 12, 0.5)).toEqual(playerPose(frame, net, 12, 0.5))
  })

  it('paces the stride by distance travelled, not by wall-clock', () => {
    // Twice the speed, half the time: the same point in the stride. That is
    // what makes a player at rocket-jump speed look like they are moving fast
    // rather than like a film played faster.
    expect(stridePhase(600, 20, 0)).toBeCloseTo(stridePhase(300, 40, 0), 9)
    // And it advances smoothly *within* a tick, so the legs do not step at
    // 125 Hz while the body slides at 144.
    expect(stridePhase(300, 40, 0.5)).toBeGreaterThan(stridePhase(300, 40, 0))
  })

  it('swings the legs when running and stops them when standing', () => {
    const still = playerNetState(entity())
    const running = advanceAnim(INITIAL_ANIM, net, 30)
    const standing = advanceAnim(INITIAL_ANIM, still, 30)

    expect(playerPose(standing, still, 30, 0).leftLeg).toBe(0)
    // Somewhere in the cycle the legs are apart; sampling one tick could catch
    // the crossing point, so this asks the whole stride.
    const swings = Array.from({ length: 24 }, (_, i) =>
      Math.abs(playerPose(running, net, 30 + i, 0).leftLeg),
    )
    expect(Math.max(...swings)).toBeGreaterThan(0.2)
  })

  it('dips on landing and recovers', () => {
    const airborne = playerNetState(entity({ flags: 0, velocity: [0, 0, -300] }))
    const grounded = playerNetState(entity())

    const jump = advanceAnim(INITIAL_ANIM, airborne, 9)
    const landed = advanceAnim(jump, grounded, 10)
    expect(landed.state).toBe(AnimState.Land)

    // Deepest at contact, back to standing by the end of the window.
    expect(playerPose(landed, grounded, 10, 0).bodyDip).toBeLessThan(-5)
    expect(playerPose(landed, grounded, 17, 0).bodyDip).toBeGreaterThan(-5)
    expect(playerPose(landed, grounded, 10 + LAND_TICKS, 0).bodyDip).toBeCloseTo(0, 9)
  })

  it('topples over a death rather than snapping flat', () => {
    const dead = playerNetState(entity({ health: 0 }))
    const frame = advanceAnim(INITIAL_ANIM, dead, 50)

    expect(playerPose(frame, dead, 50, 0).bodyPitch).toBeCloseTo(0, 6)
    const halfway = playerPose(frame, dead, 70, 0).bodyPitch
    const settled = playerPose(frame, dead, 200, 0).bodyPitch
    expect(halfway).toBeLessThan(0)
    expect(halfway).toBeGreaterThan(settled)
    expect(settled).toBeCloseTo(-Math.PI / 2, 6)
  })

  it('kicks the weapon back on a shot and recovers it', () => {
    const shooting = playerNetState(entity({ lastFireTick: 100 }))
    const frame = advanceAnim(INITIAL_ANIM, shooting, 100)

    expect(playerPose(frame, shooting, 100, 0).weaponRecoil).toBeGreaterThan(6)
    expect(playerPose(frame, shooting, 120, 0).weaponRecoil).toBeLessThan(2)
  })

  it('leans into a strafe and stands up straight when it stops', () => {
    const left = playerNetState(entity({ velocity: [0, 300, 0] }))
    const right = playerNetState(entity({ velocity: [0, -300, 0] }))
    const still = playerNetState(entity())

    const leanLeft = playerPose(advanceAnim(INITIAL_ANIM, left, 5), left, 5, 0).bodyRoll
    const leanRight = playerPose(advanceAnim(INITIAL_ANIM, right, 5), right, 5, 0).bodyRoll
    const straight = playerPose(advanceAnim(INITIAL_ANIM, still, 5), still, 5, 0).bodyRoll

    expect(leanLeft).toBeGreaterThan(0)
    expect(leanRight).toBeLessThan(0)
    expect(straight).toBe(0)
  })

  it('splits the view pitch between the torso and the head', () => {
    const looking = playerNetState(entity({ angles: [4000, 0, 0] }))
    const frame = advanceAnim(INITIAL_ANIM, looking, 3)
    const pose = playerPose(frame, looking, 3, 0)
    const pitch = angleUnitsToRadians(4000)

    expect(pose.torsoPitch + pose.headPitch).toBeCloseTo(pitch, 9)
    expect(pose.torsoPitch).toBeGreaterThan(0)
    expect(pose.headPitch).toBeGreaterThan(pose.torsoPitch)
  })
})

describe('proportions', () => {
  it('puts the hips inside the box they have to fit in', () => {
    expect(HIP_HEIGHT).toBeGreaterThan(0)
    expect(HIP_HEIGHT).toBeLessThan(PLAYER_HEIGHT)
  })
})

describe('the roster', () => {
  const opponent = (id: number, slot: number, patch: Partial<EntityState> = {}) =>
    playerNetState(entity({ id, slot, ...patch }))

  it('builds a rig the first time it sees a player and reuses it after', () => {
    const scene = createScene(new NullEngine())
    const roster = createPlayerRoster(scene)

    roster.draw([opponent(11, 0)], 0, 0)
    expect(roster.count).toBe(1)
    const first = roster.rigOf(11)

    roster.draw([opponent(11, 0)], 1, 0)
    expect(roster.count).toBe(1)
    expect(roster.rigOf(11)).toBe(first)
  })

  it('retires a player who is no longer in the view, meshes and all', () => {
    const scene = createScene(new NullEngine())
    const roster = createPlayerRoster(scene)

    roster.draw([opponent(11, 0), opponent(12, 1)], 0, 0)
    expect(roster.count).toBe(2)
    const meshes = scene.meshes.length

    roster.draw([opponent(11, 0)], 1, 0)
    expect(roster.count).toBe(1)
    expect(roster.rigOf(12)).toBeNull()
    // Half the meshes went with them: a rig that leaks is a match that gets
    // slower the longer it goes on.
    expect(scene.meshes.length).toBeLessThan(meshes)
  })

  it('carries each player their own animation memory', () => {
    const scene = createScene(new NullEngine())
    const roster = createPlayerRoster(scene)

    const jumping = opponent(11, 0, { flags: 0, velocity: [300, 0, 200] })
    const standing = opponent(12, 1)

    roster.draw([jumping, standing], 0, 0)
    expect(roster.animOf(11)?.state).toBe(AnimState.Jump)
    expect(roster.animOf(12)?.state).toBe(AnimState.Idle)

    // 11 lands; 12 has been standing all along and must not land with them.
    roster.draw([opponent(11, 0), standing], 1, 0)
    expect(roster.animOf(11)?.state).toBe(AnimState.Land)
    expect(roster.animOf(12)?.state).toBe(AnimState.Idle)
  })

  it('tints the two duellists apart', () => {
    expect(tintForSlot(0)).not.toEqual(tintForSlot(1))
    // An unexpected third player is visible and wrongly coloured rather than
    // invisible and correct.
    expect(tintForSlot(7)).toEqual(tintForSlot(1))
  })

  it('disposes everyone at once', () => {
    const scene = createScene(new NullEngine())
    const roster = createPlayerRoster(scene)
    roster.draw([opponent(11, 0), opponent(12, 1)], 0, 0)

    roster.dispose()
    expect(roster.count).toBe(0)
    expect(scene.meshes).toHaveLength(0)
  })
})
