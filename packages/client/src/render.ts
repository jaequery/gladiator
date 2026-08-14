/**
 * The skeleton's renderer: a box on a plane, and a camera that is a puppet.
 *
 * GLAD-0IDR6J owns the real one — WebGPU first with a WebGL2 fallback, and
 * interpolated render state. This is the smallest thing that answers "does
 * Babylon come up on a deployed origin, and does it agree with the simulation
 * about which way is up".
 *
 * Two rules it does keep, because they are cheap now and expensive later:
 *
 *   1. **The camera is a puppet.** Babylon's cameras have their own input
 *      handling; none of it is attached. Position and target are written every
 *      frame from the simulation, and the simulation is the only thing that
 *      decides where the player is.
 *   2. **The frame conversion happens exactly once, here.** The sim is entirely
 *      in the Quake frame; `quakeToEngine` is applied at this boundary and
 *      nowhere else. `docs/physics-spec.md` §0.3.
 */
import { Engine } from '@babylonjs/core/Engines/engine'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Vector3 } from '@babylonjs/core/Maths/math.vector'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { CreateGround } from '@babylonjs/core/Meshes/Builders/groundBuilder'
import { TargetCamera } from '@babylonjs/core/Cameras/targetCamera'
import { Scene } from '@babylonjs/core/scene'
import {
  PLANE_HALF_EXTENT,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  type Vec3,
  cosRad,
  quakeToEngine,
  sinRad,
} from '@gladiator/sim'

/** How far behind the player the chase camera sits, in Quake units. */
const CAMERA_DISTANCE = 220

/** How far above the player's feet the camera looks, in Quake units. */
const CAMERA_HEIGHT = 64

export type RenderView = {
  /** Player feet, Quake frame, already interpolated. */
  readonly origin: Vec3
  readonly yawRadians: number
  readonly pitchRadians: number
}

export type Renderer = {
  render(view: RenderView): void
  resize(): void
  dispose(): void
  /** Something to put on the HUD: which backend actually came up. */
  readonly description: string
}

/** A grid, drawn into a canvas texture so the plane reads as ground. */
function createGridTexture(scene: Scene): DynamicTexture {
  const size = 512
  const texture = new DynamicTexture('grid', { width: size, height: size }, scene, false)
  const context = texture.getContext() as unknown as CanvasRenderingContext2D
  context.fillStyle = '#1b1f24'
  context.fillRect(0, 0, size, size)
  context.strokeStyle = '#2f3742'
  context.lineWidth = 2
  const step = size / 8
  for (let i = 0; i <= 8; i += 1) {
    context.beginPath()
    context.moveTo(i * step, 0)
    context.lineTo(i * step, size)
    context.moveTo(0, i * step)
    context.lineTo(size, i * step)
    context.stroke()
  }
  texture.update()
  texture.uScale = 16
  texture.vScale = 16
  return texture
}

/**
 * Build the scene. Throws if a WebGL context cannot be created — the caller
 * turns that into a message on the page rather than a blank screen.
 */
export function createRenderer(canvas: HTMLCanvasElement): Renderer {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false }, true)
  const scene = new Scene(engine)

  // Right-handed, because `det(QUAKE_TO_ENGINE) = +1`. A left-handed scene
  // would need a determinant of -1, i.e. a mirrored world.
  scene.useRightHandedSystem = true
  scene.clearColor = new Color4(0.05, 0.06, 0.08, 1)

  const camera = new TargetCamera('chase', new Vector3(0, CAMERA_HEIGHT, CAMERA_DISTANCE), scene)
  camera.minZ = 1
  camera.maxZ = 8000
  // Deliberately no `attachControl`: the simulation drives this camera.

  const light = new HemisphericLight('sky', new Vector3(0, 1, 0), scene)
  light.intensity = 0.9
  light.groundColor = new Color3(0.15, 0.16, 0.2)

  const groundMaterial = new StandardMaterial('ground', scene)
  groundMaterial.diffuseTexture = createGridTexture(scene)
  groundMaterial.specularColor = new Color3(0, 0, 0)

  const ground = CreateGround(
    'plane',
    { width: PLANE_HALF_EXTENT * 2, height: PLANE_HALF_EXTENT * 2 },
    scene,
  )
  ground.material = groundMaterial

  const playerMaterial = new StandardMaterial('player', scene)
  playerMaterial.diffuseColor = new Color3(0.85, 0.35, 0.2)
  playerMaterial.specularColor = new Color3(0.2, 0.2, 0.2)

  const player = CreateBox(
    'player',
    { width: PLAYER_HALF_WIDTH * 2, depth: PLAYER_HALF_WIDTH * 2, height: PLAYER_HEIGHT },
    scene,
  )
  player.material = playerMaterial

  // A second, static box, so that running past something makes the movement
  // legible. There is no collision against it — GLAD-3SCN0U owns that.
  const landmarkMaterial = new StandardMaterial('landmark', scene)
  landmarkMaterial.diffuseColor = new Color3(0.25, 0.5, 0.75)
  const landmark = CreateBox('landmark', { width: 128, depth: 128, height: 256 }, scene)
  landmark.material = landmarkMaterial
  const landmarkOrigin = quakeToEngine([512, 512, 128])
  landmark.position.set(landmarkOrigin[0], landmarkOrigin[1], landmarkOrigin[2])

  const eye = new Vector3()
  const target = new Vector3()

  return {
    description: `Babylon ${Engine.Version} · ${engine.description ?? 'WebGL'}`,

    render(view) {
      const [ox, oy, oz] = view.origin

      // The box is centred on its own middle; the simulation's origin is feet.
      const centre = quakeToEngine([ox, oy, oz + PLAYER_HEIGHT / 2])
      player.position.set(centre[0], centre[1], centre[2])
      // Babylon's +Y rotation is the engine frame's up, which is Quake's yaw.
      player.rotation.y = view.yawRadians

      // Chase camera: sit behind the player along their view direction, in the
      // Quake frame, then convert. Doing the trigonometry in the engine frame
      // is where sign errors come from.
      const cosPitch = cosRad(view.pitchRadians)
      const forward: Vec3 = [
        cosRad(view.yawRadians) * cosPitch,
        sinRad(view.yawRadians) * cosPitch,
        sinRad(view.pitchRadians),
      ]
      const eyeQuake: Vec3 = [
        ox - forward[0] * CAMERA_DISTANCE,
        oy - forward[1] * CAMERA_DISTANCE,
        oz + CAMERA_HEIGHT - forward[2] * CAMERA_DISTANCE,
      ]
      const eyeEngine = quakeToEngine(eyeQuake)
      const targetEngine = quakeToEngine([ox, oy, oz + CAMERA_HEIGHT])

      eye.set(eyeEngine[0], eyeEngine[1], eyeEngine[2])
      target.set(targetEngine[0], targetEngine[1], targetEngine[2])
      camera.position.copyFrom(eye)
      camera.setTarget(target)

      scene.render()
    },

    resize() {
      engine.resize()
    },

    dispose() {
      scene.dispose()
      engine.dispose()
    },
  }
}
