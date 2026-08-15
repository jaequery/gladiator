/**
 * The scene, the camera and the light — the settings that are wrong by default.
 *
 * Babylon is a general-purpose engine with defaults chosen for a product
 * configurator, not for a 125 Hz first-person shooter whose world is
 * authoritative somewhere else. Four of those defaults would each produce a
 * subtly wrong game, and all four are set here so there is one place to look:
 *
 * | Default                        | Set to      | Because                                    |
 * | ------------------------------ | ----------- | ------------------------------------------ |
 * | `useRightHandedSystem = false` | `true`      | `det(QUAKE_TO_ENGINE) = +1`, not -1        |
 * | `camera.inertia = 0.9`         | `0`         | a smoothing filter that fights prediction  |
 * | camera input attached          | never       | aim is ours; it goes in the `UserCmd`      |
 * | `fov` vertical, 0.8 rad        | Quake's 90° | muscle memory is measured in field of view |
 *
 * ## Right-handed, and set before the camera is made
 *
 * `TargetCamera` reads `scene.useRightHandedSystem` **in its constructor** to
 * decide whether its reference forward vector is `(0,0,-1)` or `(0,0,1)`.
 * Setting the flag afterwards leaves a camera that looks backwards down a
 * world that is drawn forwards. So the order in {@link createScene} and
 * {@link createCamera} is load-bearing, not stylistic.
 *
 * ## The post-processing chain is empty on purpose
 *
 * Every full-screen pass is input-to-photon latency, paid on every frame, to
 * make a still frame prettier. Tone mapping is the one exception and it is not
 * a pass: with `applyByPostProcess` left off, Babylon folds it into each
 * material's fragment shader, so it costs a few instructions rather than a
 * round trip through a render target.
 */
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import { TargetCamera } from '@babylonjs/core/Cameras/targetCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration'
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture'
import type { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Scene } from '@babylonjs/core/scene'
import type { MapSource } from '@gladiator/sim'

import type { CameraPose } from './view.ts'

/**
 * Vertical field of view, in radians.
 *
 * Quake's `fov 90` is 90 degrees *horizontally at 4:3*, which is 73.74
 * vertically. Fixing the vertical angle and letting the horizontal one follow
 * the aspect ratio is "hor+": a wider monitor shows more of the world at the
 * same vertical scale, rather than the same world squeezed. Anything else and a
 * player's flick distances change when they change monitor.
 */
export const FOV_RADIANS = 2 * Math.atan(0.75)

/** Near plane, Quake units. Quake's own is 4; closer costs depth precision. */
export const NEAR_PLANE = 4

/** Far plane, Quake units. An arena is 1024 across; this is room to spare. */
export const FAR_PLANE = 8192

/**
 * The most anisotropic taps to ask a texture for.
 *
 * 8 is the knee of the curve: floors seen at a grazing angle — which, in a
 * shooter, is most of the floor — stop smearing, and beyond it the cost rises
 * faster than the sharpness.
 */
export const MAX_ANISOTROPY = 8

/**
 * A scene with the settings that are wrong by default put right.
 *
 * Sets `useRightHandedSystem` before anything else exists, because cameras read
 * it once, at construction.
 */
export function createScene(engine: AbstractEngine): Scene {
  const scene = new Scene(engine)

  // Right-handed, because `det(QUAKE_TO_ENGINE) = +1`. A left-handed scene
  // needs a determinant of -1 — a mirrored world, where every rocket jump
  // curves the wrong way. `docs/physics-spec.md` §0.3.
  scene.useRightHandedSystem = true

  scene.clearColor = new Color4(0.03, 0.035, 0.045, 1)
  // StandardMaterial multiplies its own `ambientColor` by this one, and
  // Babylon's material default is black — so this is a floor under the
  // materials that opt in, which is now only the things that *move*: the
  // opponent's model and the viewmodel. A player who cannot make out a
  // silhouette on the far side of the arena is losing to the lighting rather
  // than to their opponent.
  //
  // The arena is not one of them any more. Its light is baked and its albedo
  // rides in `emissiveColor`, deliberately outside this multiplier, so
  // re-grading how a model reads in shadow cannot silently re-grade the level.
  // `materials.ts` is the argument.
  scene.ambientColor = new Color3(0.5, 0.51, 0.56)

  const processing = scene.imageProcessingConfiguration
  processing.toneMappingEnabled = true
  processing.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES
  processing.exposure = 1.0
  processing.contrast = 1.05
  // Folded into every material's shader rather than run as a full-screen pass.
  // See the header.
  processing.applyByPostProcess = false

  return scene
}

/**
 * The camera. A puppet: it is written to and never read from.
 *
 * No input is attached — not `attachControl`, not a pointer observer, nothing.
 * Yaw and pitch are float state the input controller owns, because they go into
 * the `UserCmd` the server simulates and lag-compensates against. Lint bans the
 * call outright; this comment is why.
 */
export function createCamera(scene: Scene): TargetCamera {
  const camera = new TargetCamera('view', Vector3.Zero(), scene)
  camera.fov = FOV_RADIANS
  camera.minZ = NEAR_PLANE
  camera.maxZ = FAR_PLANE
  // Babylon's default is 0.9 — a low-pass filter on camera movement. It would
  // smooth over exactly the corrections reconciliation makes, so a rubber-band
  // would arrive late and soft instead of on time and sharp.
  camera.inertia = 0
  camera.speed = 0
  scene.activeCamera = camera
  return camera
}

/**
 * Write a pose onto the camera.
 *
 * `position` and `rotation` are assigned rather than `setTarget`ed on purpose:
 * `TargetCamera.setTarget` nudges `position.z` by an epsilon when the eye and
 * the target share it, which happens at exactly the yaw where the view is
 * perpendicular to the engine's z axis. A camera that moves itself is no longer
 * a puppet, and the nudge would show up as a tick-rate-dependent transform.
 */
export function applyPose(camera: TargetCamera, pose: CameraPose): void {
  camera.position.set(pose.position[0], pose.position[1], pose.position[2])
  camera.rotation.set(pose.rotation[0], pose.rotation[1], pose.rotation[2])
}

/** Ask a texture for as much anisotropy as the device will give, up to 8. */
export function applyAnisotropy(texture: BaseTexture, engine: AbstractEngine): void {
  const available = engine.getCaps().maxAnisotropy
  texture.anisotropicFilteringLevel = available < MAX_ANISOTROPY ? available : MAX_ANISOTROPY
}

/**
 * Which way the hemispheric fill leans, engine frame.
 *
 * Mostly up, with enough sideways in it to tell one wall from another. See
 * {@link addLighting}.
 */
const FILL_DIRECTION = new Vector3(0.42, 1, 0.26).normalize()

/**
 * The one real-time light in the game, and what it is *not* for.
 *
 * The arena's light is baked (`tools/bake-lightmap.ts`, `docs/renderer.md`
 * §12), so the world needs no light at run time at all — its materials have
 * `disableLighting` on and the bake multiplies their albedo. What is left is
 * everything the bake cannot cover, because a bake is a function of a static
 * level and these move: the opponent's model and your own hands.
 *
 * So there is exactly one light, it is a hemispheric fill, and **the arena is
 * excluded from it**. That exclusion is the whole design in one line:
 *
 *   - lighting the arena with it as well would add a second, directional
 *     opinion on top of a bake that already knows where every photon came from,
 *     and the two would disagree in every corner the bake has an answer for
 *   - and it would cost a light loop on every fragment of the biggest thing on
 *     screen, which is precisely the cost this ticket exists to remove
 *
 * A map's `lights` are still authored and still used — by the baker, which can
 * afford all of them and can trace a shadow from each. Nothing reads them here
 * any more, which is why a map may now carry as many as it likes.
 *
 * `arena` is excluded rather than the light being given an inclusion list, so a
 * mesh added later (a prop, a rocket, a decal) is lit by default and nobody has
 * to remember to enrol it.
 */
export function addLighting(scene: Scene, _map: MapSource, arena?: AbstractMesh): void {
  // Tilted, not straight up. A hemispheric fill pointing at the ceiling gives
  // *every* vertical surface exactly half its diffuse, so both sides of a
  // player's chest come out the same value and the model reads as a cardboard
  // cut-out. Leaning the fill over separates the orientations, which is the
  // cheapest legible-geometry there is — no shadow map, no second pass.
  const sky = new HemisphericLight('fill', FILL_DIRECTION, scene)
  sky.intensity = 0.85
  sky.diffuse = new Color3(0.78, 0.82, 0.92)
  sky.groundColor = new Color3(0.26, 0.25, 0.3)
  sky.specular = new Color3(0, 0, 0)
  if (arena !== undefined) sky.excludedMeshes.push(arena)
}
