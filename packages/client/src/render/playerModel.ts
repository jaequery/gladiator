/**
 * The opponent, as a thing you can see and read.
 *
 * Two halves, deliberately split: {@link playerPose} is a pure function from an
 * {@link AnimFrame} and a {@link PlayerNetState} to a set of joint angles, and
 * {@link createPlayerRig} is the Babylon hierarchy that those angles are
 * *written onto*. The same shape as the camera (`view.ts` decides, `scene.ts`
 * writes), and for the same reason: the half that decides anything can be
 * tested without a GPU, and the half that touches the engine decides nothing.
 *
 * ## Silhouette over fidelity
 *
 * At arena distance an opponent is a few dozen pixels, and what has to survive
 * that is: which way are they moving, and which weapon is in their hands. So
 * the body is nine boxes with strongly different proportions — a wide chest, a
 * small head, limbs that swing visibly — and the two weapons in its hand have
 * outlines that cannot be confused: the launcher is a fat octagonal tube with a
 * flared bore and a sight along the top, the rail is a thin rod with a scope.
 * Polygon count buys nothing here that a clearer outline does not buy more of.
 *
 * What the weapons are made of is `weaponModel.ts`, and it is shared with the
 * first-person viewmodel, so the launcher pointed at you is the launcher you
 * are holding.
 *
 * It is also placeholder art with no licence attached to it, which is the
 * second reason it is boxes: the ticket says not to block on final art, and a
 * downloaded rig is exactly the kind of thing that turns out to be
 * redistributable-in-a-public-repo only if you did not read the licence.
 * GLAD-PGS73O owns the real asset pipeline.
 *
 * ## The rig is never asked where anything is
 *
 * Hitboxes are the simulation's 30x30x56 AABB (`bbox.ts`) and are never derived
 * from a mesh or a bone — nothing in this file is read by anything that decides
 * a hit, and nothing in it can be, because it has no way to reach the
 * simulation. The rig is deliberately sized to sit *inside* that box so that
 * what a player aims at and what they see line up; if the two ever disagree,
 * the box is right.
 *
 * ## The local frame
 *
 * The root sits at the opponent's feet in the engine frame, and the model is
 * authored facing local `-z` with `+y` up — the same convention as Babylon's
 * camera, which is why `root.rotation.y` is Quake's yaw in radians, unchanged.
 * `docs/renderer.md` §1 has the derivation for the camera; it is the same one.
 */
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Scene } from '@babylonjs/core/scene'
import {
  PLAYER_HEIGHT,
  TICK_DT,
  type Vec3,
  Weapon,
  angleUnitsToRadians,
  quakeToEngine,
} from '@gladiator/sim'

import {
  type AnimFrame,
  AnimState,
  FIRE_TICKS,
  INITIAL_ANIM,
  LAND_TICKS,
  MoveDirection,
  type PlayerNetState,
  advanceAnim,
} from './animState.ts'
import {
  RAILGUN_WORLD,
  ROCKET_LAUNCHER_WORLD,
  buildWeapon,
  finishMaterials,
  weaponFinishes,
} from './weaponModel.ts'

/* --------------------------------------------------------------------------
 * Proportions
 *
 * Quake units, measured from the soles, and every one of them chosen to keep
 * the model inside the simulation's 30x30x56 box.
 * ----------------------------------------------------------------------- */

/** Where the hips are: the top of the legs and the bottom of the torso. */
export const HIP_HEIGHT = 26

/** Half the distance between the two hip joints. */
const HIP_SPREAD = 5.5

const LEG_LENGTH = HIP_HEIGHT
const LEG_THICKNESS = 9

const CHEST_HEIGHT = 19
const CHEST_WIDTH = 21
const CHEST_DEPTH = 12

const HEAD_SIZE = 11

const SHOULDER_HEIGHT = CHEST_HEIGHT - 3
const SHOULDER_SPREAD = 12.5
const ARM_LENGTH = 18
const ARM_THICKNESS = 5

/** The hand, in the right shoulder's local frame. Where a weapon is held. */
const HAND: Vec3 = [0, -ARM_LENGTH + 2, -3]

/* --------------------------------------------------------------------------
 * Motion
 * ----------------------------------------------------------------------- */

/**
 * Quake units travelled per complete stride cycle.
 *
 * The stride rate is derived from *speed* rather than from a clock, so a player
 * skimming along at 700 qu/s out of a rocket jump has their legs going at the
 * rate that speed implies. Tuned against `RUN_SPEED` (320): a player at a walk
 * takes a little under four steps a second, which is what a person looks like.
 */
export const STRIDE_DISTANCE = 88

/** The most a leg swings, radians. */
const LEG_SWING = 0.62

/** The most the free arm swings, radians. */
const ARM_SWING = 0.42

/** The angle at which an arm points straight ahead. See the header. */
const AIM = Math.PI / 2

/**
 * How the hand is turned relative to the shoulder that carries it.
 *
 * The arm swings about its shoulder, so its own local axes are a quarter turn
 * away from the body's: at {@link AIM} the arm's length lies along the world's
 * forward, which puts the arm's local `-z` along the world's *up*. A weapon
 * hung straight off the shoulder therefore points at the sky, and this quarter
 * turn back is what makes the hand a frame in which `-z` is down the barrel —
 * the same convention as the rest of this file, the viewmodel and the camera.
 *
 * With it, `weaponRecoil` moves the hand back along `-y`, which is the arm's
 * own axis, so a shot drives the weapon towards the shoulder rather than in
 * whatever direction the body happens to be facing.
 */
const GRASP = -Math.PI / 2

/** How far the hips drop at the bottom of a landing, in Quake units. */
const LAND_DIP = 9

/** How far a body leans into a strafe, radians. */
const LEAN = 0.13

/** How far the weapon travels back on firing, in Quake units. */
const RECOIL = 7

/** Sub-steps a body takes to topple over. 40 = 320 ms. */
const DEATH_TICKS = 40

/** How much of the view pitch the torso takes; the head takes the rest. */
const TORSO_PITCH_SHARE = 0.35

/* --------------------------------------------------------------------------
 * The pose
 * ----------------------------------------------------------------------- */

/**
 * Every joint angle the rig has, in radians, plus the two offsets.
 *
 * Flat rather than a tree, because it is a *value*: a test can compare two of
 * them, and there is exactly one place — {@link applyPlayerPose} — that knows
 * which Babylon node each field lands on.
 */
export type PlayerPose = {
  /** Vertical offset of the whole body, Quake units. Negative is a crouch. */
  readonly bodyDip: number
  /** Pitch of the whole body about the feet, radians. The death topple. */
  readonly bodyPitch: number
  /** Roll of the whole body, radians. The lean into a strafe. */
  readonly bodyRoll: number
  /** Facing, radians. Quake's yaw, unchanged — see the header. */
  readonly yaw: number
  readonly torsoPitch: number
  readonly headPitch: number
  readonly leftLeg: number
  readonly rightLeg: number
  readonly leftArm: number
  readonly rightArm: number
  /** How far the weapon has recoiled, Quake units along the barrel. */
  readonly weaponRecoil: number
}

/** `0` at `from`, `1` at `from + span`, clamped. */
function ramp(now: number, from: number, span: number): number {
  const t = (now - from) / span
  if (t <= 0) return 0
  return t >= 1 ? 1 : t
}

/**
 * The phase of the stride cycle, in radians.
 *
 * A function of distance travelled rather than of time: `speed * seconds` is
 * how far the player has gone, and one stride is {@link STRIDE_DISTANCE} of it.
 * The clock is the *simulation's* — `tick + alpha` — so two clients drawing the
 * same snapshot at different frame rates draw the same legs.
 */
export function stridePhase(speed: number, tick: number, alpha: number): number {
  const seconds = (tick + alpha) * TICK_DT
  return (2 * Math.PI * speed * seconds) / STRIDE_DISTANCE
}

/**
 * Joint angles for one player, one frame. Pure, and the only thing that decides
 * what the model looks like.
 *
 * `alpha` is the accumulator's remainder — the same fraction the position is
 * interpolated by — so the animation and the position advance together instead
 * of the body sliding while the legs step at tick rate.
 */
export function playerPose(
  frame: AnimFrame,
  net: PlayerNetState,
  tick: number,
  alpha: number,
): PlayerPose {
  const now = tick + alpha
  const pitch = angleUnitsToRadians(net.angles[0])
  const yaw = angleUnitsToRadians(net.angles[1])

  const swing = Math.sin(stridePhase(frame.speed, tick, alpha))
  // Legs swing at full amplitude by running pace and no further: a player at
  // 900 qu/s out of a rocket jump is not taking three-metre strides.
  const gait = frame.speed >= STRIDE_DISTANCE * 4 ? 1 : frame.speed / (STRIDE_DISTANCE * 4)

  const dead = frame.state === AnimState.Death
  const firing = frame.state === AnimState.FireRocket || frame.state === AnimState.FireRail
  const airborne = frame.airborne

  // A landing is a dip that recovers, not a step down: deepest at the moment of
  // contact, back to standing by the end of the window.
  const landing = frame.state === AnimState.Land ? 1 - ramp(now, frame.since, LAND_TICKS) : 0
  const topple = dead ? ramp(now, frame.since, DEATH_TICKS) : 0
  const recoil =
    firing && net.lastFireTick >= 0 ? 1 - ramp(now, net.lastFireTick, FIRE_TICKS) : 0

  const lean =
    frame.move === MoveDirection.Left
      ? LEAN * gait
      : frame.move === MoveDirection.Right
        ? -LEAN * gait
        : 0

  // Tucked in the air, splayed on a landing, swinging on the ground.
  const legs = airborne
    ? { left: 0.55, right: -0.3 }
    : { left: swing * LEG_SWING * gait, right: -swing * LEG_SWING * gait }

  return {
    bodyDip: -LAND_DIP * landing,
    // Topples backwards about the feet, so the body ends up lying on the floor
    // in front of where it stood rather than standing in the ground.
    bodyPitch: -(Math.PI / 2) * topple,
    bodyRoll: dead ? 0 : lean,
    yaw,
    torsoPitch: dead ? 0 : pitch * TORSO_PITCH_SHARE - landing * 0.25,
    headPitch: dead ? 0 : pitch * (1 - TORSO_PITCH_SHARE),
    leftLeg: dead ? 0.2 : legs.left - landing * 0.4,
    rightLeg: dead ? -0.2 : legs.right - landing * 0.4,
    // The free arm counter-swings the legs; the weapon arm holds the weapon out
    // where it can be seen, because being able to see it is the point.
    leftArm: dead ? 0 : airborne ? -0.4 : -swing * ARM_SWING * gait,
    rightArm: dead ? 0 : AIM + pitch * (1 - TORSO_PITCH_SHARE) * -1 + recoil * 0.22,
    weaponRecoil: RECOIL * recoil,
  }
}

/* --------------------------------------------------------------------------
 * The rig
 * ----------------------------------------------------------------------- */

export type PlayerRig = {
  /** The node everything hangs off. Positioned in the engine frame. */
  readonly root: TransformNode
  /** Which weapon is currently in the model's hands. */
  readonly weapon: Weapon
  readonly visible: boolean
  setVisible(visible: boolean): void
  /**
   * Draw this player where `net` says they are, in the pose `frame` implies.
   *
   * `net.origin` is the feet in the Quake frame, already interpolated by
   * `interpolateNetState`. Everything else it needs arrives as arguments; it
   * reads no clock and no engine state. Note the `readonly` types on the way
   * in: `PlayerNetState` is a copy of a slice of `EntityState` and there is no
   * path from here back into `GameState`.
   */
  update(net: PlayerNetState, frame: AnimFrame, tick: number, alpha: number): void
  dispose(): void
}

export type PlayerRigOptions = {
  /** Distinguishes the two duellists at a glance. */
  readonly tint: Vec3
  /** Used to name the nodes, so a scene inspector is readable. */
  readonly name: string
}

/**
 * A material that stays legible in an unlit corner.
 *
 * Emissive, not just diffuse: a player who is hard to see because the lighting
 * is honest is a player losing to the renderer. Same argument as the ambient
 * floor in `scene.ts`, applied to the thing that matters most.
 */
function rigMaterial(scene: Scene, name: string, tint: Vec3, lift: number): StandardMaterial {
  const material = new StandardMaterial(name, scene)
  material.diffuseColor = new Color3(tint[0], tint[1], tint[2])
  material.ambientColor = new Color3(tint[0], tint[1], tint[2])
  material.emissiveColor = new Color3(tint[0] * lift, tint[1] * lift, tint[2] * lift)
  material.specularColor = new Color3(0, 0, 0)
  material.maxSimultaneousLights = 5
  return material
}

function box(
  scene: Scene,
  name: string,
  size: Vec3,
  at: Vec3,
  parent: TransformNode,
  material: StandardMaterial,
): Mesh {
  const mesh = CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene)
  mesh.position.set(at[0], at[1], at[2])
  mesh.parent = parent
  mesh.material = material
  // Nothing in this scene is picked — aim is a trace against the simulation's
  // brushes and boxes, never against a mesh.
  mesh.isPickable = false
  return mesh
}

/**
 * Build one opponent.
 *
 * Allocates freely: rigs are created when a player joins, not in a frame. The
 * renderer keeps one per entity id and disposes it when that entity leaves.
 */
export function createPlayerRig(scene: Scene, options: PlayerRigOptions): PlayerRig {
  const { name, tint } = options

  const skin = rigMaterial(scene, `${name}:skin`, tint, 0.28)
  // The weapon's three finishes, lit the way this rig lights everything: just
  // enough emissive to stay legible in an unlit corner, and no more.
  const weapons = weaponFinishes(
    (materialName, colour) => rigMaterial(scene, materialName, colour, 0.16),
    name,
  )

  const root = new TransformNode(name, scene)
  const body = new TransformNode(`${name}:body`, scene)
  body.parent = root

  const hipLeft = new TransformNode(`${name}:hip.l`, scene)
  hipLeft.parent = body
  hipLeft.position.set(-HIP_SPREAD, HIP_HEIGHT, 0)
  box(
    scene,
    `${name}:leg.l`,
    [LEG_THICKNESS, LEG_LENGTH, LEG_THICKNESS],
    [0, -LEG_LENGTH / 2, 0],
    hipLeft,
    skin,
  )

  const hipRight = new TransformNode(`${name}:hip.r`, scene)
  hipRight.parent = body
  hipRight.position.set(HIP_SPREAD, HIP_HEIGHT, 0)
  box(
    scene,
    `${name}:leg.r`,
    [LEG_THICKNESS, LEG_LENGTH, LEG_THICKNESS],
    [0, -LEG_LENGTH / 2, 0],
    hipRight,
    skin,
  )

  const torso = new TransformNode(`${name}:torso`, scene)
  torso.parent = body
  torso.position.set(0, HIP_HEIGHT, 0)
  box(
    scene,
    `${name}:chest`,
    [CHEST_WIDTH, CHEST_HEIGHT, CHEST_DEPTH],
    [0, CHEST_HEIGHT / 2, 0],
    torso,
    skin,
  )

  const neck = new TransformNode(`${name}:neck`, scene)
  neck.parent = torso
  neck.position.set(0, CHEST_HEIGHT, 0)
  box(
    scene,
    `${name}:head`,
    [HEAD_SIZE, PLAYER_HEIGHT - HIP_HEIGHT - CHEST_HEIGHT, HEAD_SIZE],
    [0, (PLAYER_HEIGHT - HIP_HEIGHT - CHEST_HEIGHT) / 2, 0],
    neck,
    skin,
  )

  const shoulderLeft = new TransformNode(`${name}:shoulder.l`, scene)
  shoulderLeft.parent = torso
  shoulderLeft.position.set(-SHOULDER_SPREAD, SHOULDER_HEIGHT, 0)
  box(
    scene,
    `${name}:arm.l`,
    [ARM_THICKNESS, ARM_LENGTH, ARM_THICKNESS],
    [0, -ARM_LENGTH / 2, 0],
    shoulderLeft,
    skin,
  )

  const shoulderRight = new TransformNode(`${name}:shoulder.r`, scene)
  shoulderRight.parent = torso
  shoulderRight.position.set(SHOULDER_SPREAD, SHOULDER_HEIGHT, 0)
  box(
    scene,
    `${name}:arm.r`,
    [ARM_THICKNESS, ARM_LENGTH, ARM_THICKNESS],
    [0, -ARM_LENGTH / 2, 0],
    shoulderRight,
    skin,
  )

  // The hand, and what is in it. Both weapons are built once and one of them is
  // enabled: switching is then a boolean rather than a mesh construction in the
  // middle of a fight, which is the difference between a weapon switch and a
  // hitch. See `setWeapon`.
  const hand = new TransformNode(`${name}:hand`, scene)
  hand.parent = shoulderRight
  hand.position.set(HAND[0], HAND[1], HAND[2])
  // And it holds the weapon the way a hand does, which is the one rotation in
  // this rig that is not an animated joint.
  hand.rotation.set(GRASP, 0, 0)

  const launcher = new TransformNode(`${name}:rocket`, scene)
  launcher.parent = hand
  buildWeapon(scene, ROCKET_LAUNCHER_WORLD, launcher, weapons, {
    namePrefix: `${name}:rocket`,
  })

  const railgun = new TransformNode(`${name}:rail`, scene)
  railgun.parent = hand
  buildWeapon(scene, RAILGUN_WORLD, railgun, weapons, {
    namePrefix: `${name}:rail`,
  })

  let weapon: Weapon = Weapon.None
  let visible = true

  const setWeapon = (next: Weapon): void => {
    if (next === weapon) return
    weapon = next
    launcher.setEnabled(visible && next === Weapon.RocketLauncher)
    railgun.setEnabled(visible && next === Weapon.Railgun)
  }

  launcher.setEnabled(false)
  railgun.setEnabled(false)

  return {
    root,
    get weapon() {
      return weapon
    },
    get visible() {
      return visible
    },

    setVisible(next) {
      visible = next
      root.setEnabled(next)
      launcher.setEnabled(next && weapon === Weapon.RocketLauncher)
      railgun.setEnabled(next && weapon === Weapon.Railgun)
    },

    update(net, frame, tick, alpha) {
      // Within one snapshot, by construction: the weapon comes off the
      // netstate every frame, so the frame after a snapshot that changed it is
      // drawn with the new one.
      setWeapon(net.weapon)

      const pose = playerPose(frame, net, tick, alpha)
      const [x, y, z] = quakeToEngine(net.origin)
      root.position.set(x, y, z)
      root.rotation.set(0, pose.yaw, 0)

      body.position.set(0, pose.bodyDip, 0)
      body.rotation.set(pose.bodyPitch, 0, pose.bodyRoll)

      hipLeft.rotation.set(pose.leftLeg, 0, 0)
      hipRight.rotation.set(pose.rightLeg, 0, 0)
      torso.rotation.set(pose.torsoPitch, 0, 0)
      neck.rotation.set(pose.headPitch, 0, 0)
      shoulderLeft.rotation.set(pose.leftArm, 0, 0)
      shoulderRight.rotation.set(pose.rightArm, 0, 0)
      // Back along the arm, which is where the barrel points: the hand sits at
      // `-y` from the shoulder, so recoil is towards `+y`. See `GRASP`.
      hand.position.set(HAND[0], HAND[1] + pose.weaponRecoil, HAND[2])
    },

    dispose() {
      // Recurses, which is every node and mesh above. The materials are shared
      // between them, so they are disposed once, here, rather than once per
      // mesh on the way down.
      root.dispose(false, false)
      skin.dispose()
      for (const material of finishMaterials(weapons)) material.dispose()
    },
  }
}

/* --------------------------------------------------------------------------
 * Everyone on screen
 * ----------------------------------------------------------------------- */

/**
 * The colours the duellists are drawn in, by slot.
 *
 * Two hues that stay apart at arena distance, under this scene's lighting, and
 * for the common colour-vision deficiencies: orange and cyan differ in blue as
 * well as in red, so they separate on an axis that a red-green deficiency does
 * not take away. A duel has exactly two players, so a list of two is the whole
 * scheme; a slot past the end falls back to the last entry rather than to
 * nothing, because an unexpected third player should be *visible* and wrongly
 * coloured rather than invisible and correct.
 */
export const PLAYER_TINTS: readonly Vec3[] = [
  [0.92, 0.42, 0.16],
  [0.24, 0.68, 0.9],
]

export function tintForSlot(slot: number): Vec3 {
  return PLAYER_TINTS[slot] ?? PLAYER_TINTS[PLAYER_TINTS.length - 1] ?? [1, 1, 1]
}

/**
 * Every opponent currently on screen, and the animation each is playing.
 *
 * The animation machine's memory lives here, keyed by entity id, because it is
 * per-*player* state rather than per-frame: `advanceAnim` needs the previous
 * frame to recognise a landing (`animState.ts`). A player who stops appearing
 * in the roster's input is disposed on that frame — meshes, materials and
 * memory together — which is what stops a match that cycles through opponents
 * leaking a rig per join.
 */
export type PlayerRoster = {
  readonly count: number
  /** Draw everyone in `players`, and retire everyone who is not in it. */
  draw(players: readonly PlayerNetState[], tick: number, alpha: number): void
  /** The animation this player is in, or `null` if they are not on screen. */
  animOf(id: number): AnimFrame | null
  rigOf(id: number): PlayerRig | null
  dispose(): void
}

type Drawn = { readonly rig: PlayerRig; anim: AnimFrame }

export function createPlayerRoster(scene: Scene): PlayerRoster {
  const drawn = new Map<number, Drawn>()

  return {
    get count() {
      return drawn.size
    },

    draw(players, tick, alpha) {
      const present = new Set<number>()

      for (const net of players) {
        present.add(net.id)
        let entry = drawn.get(net.id)
        if (entry === undefined) {
          entry = {
            rig: createPlayerRig(scene, {
              name: `player${net.id}`,
              tint: tintForSlot(net.slot),
            }),
            anim: INITIAL_ANIM,
          }
          drawn.set(net.id, entry)
        }
        entry.anim = advanceAnim(entry.anim, net, tick)
        entry.rig.update(net, entry.anim, tick, alpha)
      }

      if (drawn.size === present.size) return
      for (const [id, entry] of drawn) {
        if (present.has(id)) continue
        entry.rig.dispose()
        drawn.delete(id)
      }
    },

    animOf: (id) => drawn.get(id)?.anim ?? null,
    rigOf: (id) => drawn.get(id)?.rig ?? null,

    dispose() {
      for (const entry of drawn.values()) entry.rig.dispose()
      drawn.clear()
    },
  }
}
