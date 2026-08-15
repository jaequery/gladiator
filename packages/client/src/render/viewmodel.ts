/**
 * The weapon in your own hands.
 *
 * A viewmodel does one job that nothing else in the renderer does: it tells you
 * what you are holding and confirms that you fired, in the corner of your eye,
 * without you having to look at anything. Quake's has been the same shape since
 * 1996 — bottom right, bobbing with the stride, kicking on the shot — because
 * that shape is read by peripheral vision, which is the only vision spare
 * during a duel.
 *
 * ## Camera-parented, not a second transform
 *
 * The ticket left this open, and the answer is: the rig is a child of the
 * camera node, and the only things written to it are *local* offsets.
 *
 * The alternative — a mesh in world space, positioned from the same
 * `CameraPose` the camera gets — would mean two pieces of code computing the
 * same transform from the same numbers, and the failure mode of that is a
 * viewmodel that is right at every yaw except one. Parenting makes the
 * agreement structural: there is one transform, Babylon composes the offsets
 * onto it, and no arithmetic here can disagree with the view.
 *
 * It does not weaken `docs/renderer.md` §1. The camera is still written and
 * never read: this file writes `position` and `rotation` on a *child* node and
 * never reads the parent's.
 *
 * ## Its own depth range
 *
 * The viewmodel draws in rendering group 1 with the depth buffer cleared in
 * front of it, so a gun held 26 units from the eye cannot poke through a wall
 * 20 units away. That is what every shooter does and it is not a hack: the
 * viewmodel is not in the world — it is a diagram of what your hands are doing,
 * drawn over the top of the world.
 *
 * ## And it is still driven by netstate
 *
 * Weapon and fire come from the same `PlayerNetState` the opponent's model uses
 * — the local player's, which under prediction (GLAD-6RT64L) is the predicted
 * entity and under a stall is the last one the server confirmed. So a shot the
 * server rejected stops kicking, rather than the viewmodel insisting on a
 * rocket that never left.
 */
import type { TargetCamera } from '@babylonjs/core/Cameras/targetCamera'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Scene } from '@babylonjs/core/scene'
import { TICK_DT, type Vec3, Weapon } from '@gladiator/sim'

import { type AnimFrame, FIRE_TICKS, type PlayerNetState } from './animState.ts'
import { STRIDE_DISTANCE } from './playerModel.ts'

/**
 * The rendering group the viewmodel draws in, with its own cleared depth.
 *
 * Group 0 is the world. Anything in a higher group is drawn after it, and
 * clearing depth in between is what stops the gun intersecting geometry it is
 * nowhere near.
 */
export const VIEWMODEL_RENDERING_GROUP = 1

/** Where the weapon sits at rest, in camera-local units: right, down, forward. */
export const VIEWMODEL_REST: Vec3 = [9, -7.5, -24]

/** How far the model swings sideways at a full run, camera-local units. */
const BOB_SIDE = 1.5

/** How far it dips, camera-local units. Twice per stride — one dip per foot. */
const BOB_RISE = 1.1

/** Breathing, when standing still: units, and cycles per second. */
const IDLE_SWAY = 0.35
const IDLE_RATE = 0.45

/** How far the weapon drops while airborne, camera-local units. */
const AIR_DROP = 1.8

/** How far the weapon is driven back by a shot, camera-local units. */
const KICK_BACK = 3.6

/** How far the muzzle rises on a shot, radians. */
const KICK_PITCH = 0.13

/** A pose for the viewmodel root, in the camera's local frame. */
export type ViewmodelPose = {
  readonly position: Vec3
  /** `(pitch, yaw, roll)` in radians, camera-local. */
  readonly rotation: Vec3
}

/** `0` at `from`, `1` at `from + span`, clamped. */
function ramp(now: number, from: number, span: number): number {
  const t = (now - from) / span
  if (t <= 0) return 0
  return t >= 1 ? 1 : t
}

/**
 * Where the weapon is this frame. Pure: no clock, no camera, no engine.
 *
 * The bob is derived from distance travelled, exactly like the opponent's
 * stride (`playerModel.ts`), so the gun and the legs of a player watching
 * themselves in a mirror would agree. The idle sway is derived from the
 * simulation tick, which is the only clock either peer has.
 */
export function viewmodelPose(
  net: PlayerNetState,
  frame: AnimFrame,
  tick: number,
  alpha: number,
): ViewmodelPose {
  const now = tick + alpha
  const seconds = now * TICK_DT

  const gait = frame.speed >= STRIDE_DISTANCE * 4 ? 1 : frame.speed / (STRIDE_DISTANCE * 4)
  const phase = (2 * Math.PI * frame.speed * seconds) / STRIDE_DISTANCE
  const idle = Math.sin(2 * Math.PI * IDLE_RATE * seconds) * IDLE_SWAY * (1 - gait)

  const bobX = Math.sin(phase) * BOB_SIDE * gait
  // `abs`, so the weapon dips once per *foot* rather than once per stride.
  const bobY = -Math.abs(Math.sin(phase)) * BOB_RISE * gait

  const kick =
    net.lastFireTick >= 0 && now - net.lastFireTick < FIRE_TICKS
      ? 1 - ramp(now, net.lastFireTick, FIRE_TICKS)
      : 0

  return {
    position: [
      VIEWMODEL_REST[0] + bobX + idle,
      VIEWMODEL_REST[1] + bobY + idle * 0.5 - (frame.airborne ? AIR_DROP : 0),
      // Camera-local `-z` is forward, so recoil is `+z`: towards the eye.
      VIEWMODEL_REST[2] + KICK_BACK * kick,
    ],
    rotation: [KICK_PITCH * kick, bobX * 0.02, -bobX * 0.03],
  }
}

export type Viewmodel = {
  /** The weapon currently drawn, or `Weapon.None` when nothing is. */
  readonly weapon: Weapon
  /** Write this frame's pose. Reads nothing back. */
  update(net: PlayerNetState, frame: AnimFrame, tick: number, alpha: number): void
  /** Hide it — a death camera, or a spectator with no hands. */
  setVisible(visible: boolean): void
  dispose(): void
}

function viewmodelMaterial(scene: Scene, name: string, tint: Vec3): StandardMaterial {
  const material = new StandardMaterial(name, scene)
  material.diffuseColor = new Color3(tint[0], tint[1], tint[2])
  material.ambientColor = new Color3(tint[0], tint[1], tint[2])
  // Lit almost entirely by itself. A viewmodel that goes dark in a shadowed
  // corridor reads as a bug, and it is the one object on screen whose lighting
  // nobody is trying to judge distance from.
  material.emissiveColor = new Color3(tint[0] * 0.55, tint[1] * 0.55, tint[2] * 0.55)
  material.specularColor = new Color3(0.15, 0.15, 0.18)
  material.specularPower = 48
  return material
}

function part(
  scene: Scene,
  name: string,
  size: Vec3,
  at: Vec3,
  parent: TransformNode,
  material: StandardMaterial,
): void {
  const mesh = CreateBox(name, { width: size[0], height: size[1], depth: size[2] }, scene)
  mesh.position.set(at[0], at[1], at[2])
  mesh.parent = parent
  mesh.material = material
  mesh.isPickable = false
  mesh.renderingGroupId = VIEWMODEL_RENDERING_GROUP
  // The world's frustum culling has no idea what to make of a mesh 26 units
  // from the eye that is always in shot; skipping the test is both cheaper and
  // correct.
  mesh.alwaysSelectAsActiveMesh = true
}

/**
 * Build the viewmodel and hang it off the camera.
 *
 * Both weapons are built once and one is enabled at a time, so a weapon switch
 * mid-fight is a boolean rather than a mesh construction — the same reason the
 * opponent's rig carries both (`playerModel.ts`).
 */
export function createViewmodel(scene: Scene, camera: TargetCamera): Viewmodel {
  // Draw group 1 after the world with a fresh depth buffer — depth yes, stencil
  // no, colour never (`setRenderingAutoClearDepthStencil` does not touch it).
  // So the world stays visible behind the gun and the gun is in front of all of
  // it, whatever it is standing in.
  scene.setRenderingAutoClearDepthStencil(VIEWMODEL_RENDERING_GROUP, true, true, false)

  const metal = viewmodelMaterial(scene, 'viewmodel:metal', [0.5, 0.52, 0.58])
  const accent = viewmodelMaterial(scene, 'viewmodel:accent', [0.75, 0.4, 0.16])

  const root = new TransformNode('viewmodel', scene)
  root.parent = camera

  const launcher = new TransformNode('viewmodel:rocket', scene)
  launcher.parent = root
  part(scene, 'viewmodel:rocket.body', [5, 5, 18], [0, 0, -7], launcher, metal)
  part(scene, 'viewmodel:rocket.muzzle', [7.5, 7.5, 3.5], [0, 0, -17], launcher, accent)
  part(scene, 'viewmodel:rocket.grip', [2.6, 5, 3], [0, -3.6, 1], launcher, metal)

  const railgun = new TransformNode('viewmodel:rail', scene)
  railgun.parent = root
  part(scene, 'viewmodel:rail.body', [3, 3, 26], [0, 0, -11], railgun, metal)
  part(scene, 'viewmodel:rail.coil', [4.4, 4.4, 4], [0, 0, -18], railgun, accent)
  part(scene, 'viewmodel:rail.grip', [2.4, 5, 3], [0, -3.4, 1], railgun, metal)

  let weapon: Weapon = Weapon.None
  let visible = true

  const show = (): void => {
    launcher.setEnabled(visible && weapon === Weapon.RocketLauncher)
    railgun.setEnabled(visible && weapon === Weapon.Railgun)
  }
  show()

  return {
    get weapon() {
      return weapon
    },

    update(net, frame, tick, alpha) {
      if (net.weapon !== weapon) {
        weapon = net.weapon
        show()
      }
      const pose = viewmodelPose(net, frame, tick, alpha)
      root.position.set(pose.position[0], pose.position[1], pose.position[2])
      root.rotation.set(pose.rotation[0], pose.rotation[1], pose.rotation[2])
    },

    setVisible(next) {
      visible = next
      show()
    },

    dispose() {
      root.dispose(false, false)
      metal.dispose()
      accent.dispose()
    },
  }
}
