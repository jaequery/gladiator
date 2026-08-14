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
import { PointLight } from '@babylonjs/core/Lights/pointLight'
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration'
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { Scene } from '@babylonjs/core/scene'
import { type MapSource, quakeToEngine } from '@gladiator/sim'

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
  // StandardMaterial multiplies its `ambientColor` by the scene's, so this is
  // the floor under the darkest surface — and the reason it is set this high is
  // gameplay rather than taste. A face turned away from every point light
  // receives *nothing*, and a player who cannot make out the far side of the
  // arena is losing to the lighting rather than to their opponent. Baked
  // lighting (GLAD-O5ZQ5S) is what eventually earns the right to be darker.
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

/** How many of a map's lights are drawn in real time. See {@link addLighting}. */
export const MAX_MAP_LIGHTS = 4

/**
 * What a map's `intensity: 1` is worth to this renderer.
 *
 * A map author writes a number that means "a normal light"; how bright that is
 * depends on the falloff model, the tone mapping curve and the exposure, none
 * of which a map file has any business knowing about (`map/schema.ts` carries
 * lights and never reads them). So the conversion lives here, with the rest of
 * the look, and re-tuning it is a renderer change rather than a map change.
 */
export const LIGHT_INTENSITY_SCALE = 1.5

/**
 * Which way the hemispheric fill leans, engine frame.
 *
 * Mostly up, with enough sideways in it to tell one wall from another. See
 * {@link addLighting}.
 */
const FILL_DIRECTION = new Vector3(0.42, 1, 0.26).normalize()

/**
 * The map's lights, plus a hemispheric fill.
 *
 * Real lighting is baked (GLAD-O5ZQ5S); this is enough to tell a floor from a
 * wall and to make the geometry read as three-dimensional. The fill exists
 * because a surface facing away from every point light would otherwise be
 * exactly the ambient colour, and a player cannot judge distance against a flat
 * shape.
 */
export function addLighting(scene: Scene, map: MapSource): void {
  // Tilted, not straight up. A hemispheric fill pointing at the ceiling gives
  // *every* vertical surface exactly half its diffuse, so all four walls of a
  // room come out the same value and a pillar standing in front of a wall
  // vanishes into it. Leaning the fill over separates the orientations, which
  // is the cheapest legible-geometry there is — no shadow map, no second pass.
  const sky = new HemisphericLight('fill', FILL_DIRECTION, scene)
  sky.intensity = 0.85
  sky.diffuse = new Color3(0.78, 0.82, 0.92)
  sky.groundColor = new Color3(0.26, 0.25, 0.3)
  sky.specular = new Color3(0, 0, 0)

  // Four is Babylon's default per-material limit, and every light past the
  // first costs every fragment. A map that wants more wants baked lighting.
  for (const [index, light] of map.lights.slice(0, MAX_MAP_LIGHTS).entries()) {
    const [x, y, z] = quakeToEngine(light.origin)
    const point = new PointLight(`light${index}`, new Vector3(x, y, z), scene)
    point.diffuse = new Color3(light.color[0], light.color[1], light.color[2])
    point.intensity = light.intensity * LIGHT_INTENSITY_SCALE
    point.range = light.radius
    // Specular from a point light on an untextured wall reads as a smear, and
    // the materials here have no gloss to justify it.
    point.specular = new Color3(0, 0, 0)
  }
}
