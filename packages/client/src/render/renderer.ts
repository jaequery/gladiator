/**
 * The renderer, assembled.
 *
 * Everything interesting is in the modules this one wires together —
 * `engine.ts` picks a backend, `scene.ts` fixes the defaults that would
 * otherwise be wrong, `mapMesh.ts` turns brushes into triangles, `view.ts`
 * turns simulation state into a camera transform and `frameStats.ts` says
 * whether any of it is fast enough. What is left here is the wiring, the frame
 * order and the two things that need to be true every frame:
 *
 *   1. **The camera is written, never read.** `applyPose` assigns position and
 *      rotation from `cameraPose`, which is a pure function of interpolated
 *      simulation state. Nothing reads the camera back, so there is no path by
 *      which the renderer can become the source of truth for where the player
 *      is or what they are aiming at.
 *   2. **The renderer does not read a clock.** The frame interval is passed in
 *      by the caller, which reads `performance.now()` once per frame for the
 *      whole client. A second clock read here would be a second opinion about
 *      what a frame is.
 *
 * ## No engine collision, ever
 *
 * `mesh.checkCollisions`, `camera.applyGravity`, `camera.ellipsoid` and
 * `moveWithCollisions()` need no plugin and no dependency, and they are what
 * every Babylon first-person tutorial reaches for. Any of them would run a
 * second, different physics against the authoritative one and produce movement
 * that is *almost* right — the hardest possible bug to see and the worst
 * possible one to have in a game about movement. ESLint bans all four by name,
 * along with the physics plugin API, and `scripts/no-physics-plugin.mjs` fails
 * the build if a physics engine ever appears in the lockfile.
 */
import type { TargetCamera } from '@babylonjs/core/Cameras/targetCamera'
import type { Scene } from '@babylonjs/core/scene'
import { type MapGeometry, type MapSource, type Weapon } from '@gladiator/sim'

import { type AnimFrame, INITIAL_ANIM, type PlayerNetState, advanceAnim } from './animState.ts'
import {
  type Backend,
  type RenderEngine,
  clampPixelRatio,
  createEngine,
  hardwareScalingFor,
  ladderRung,
  nextPixelRatio,
} from './engine.ts'
import {
  FRAME_BUDGET_MS,
  type FrameStats,
  type FrameVerdict,
  createFrameMeter,
  meterVerdict,
} from './frameStats.ts'
import { configureKtx2 } from './ktx2.ts'
import { type MapMesh, buildMapMesh, createGridTexture } from './mapMesh.ts'
import { type PlayerRoster, createPlayerRoster } from './playerModel.ts'
import { addLighting, applyPose, createCamera, createScene } from './scene.ts'
import { type RenderView, cameraPose } from './view.ts'
import { type Viewmodel, createViewmodel } from './viewmodel.ts'

/**
 * How many frames the quality controller watches before it decides anything.
 *
 * 240 — four seconds at 60 fps. Long enough that one slow frame does not soften
 * the whole image, short enough that a player who alt-tabs back into a heavy
 * scene is not left at 20 fps for a minute.
 */
export const QUALITY_WINDOW_FRAMES = 240

export type RendererOptions = {
  readonly canvas: HTMLCanvasElement
  readonly map: MapSource
  readonly geometry: MapGeometry
  /** Defaults to the clamped `devicePixelRatio`. */
  readonly pixelRatio?: number
  /** Step the pixel ratio down under load. Off for reference screenshots. */
  readonly adaptQuality?: boolean
  /** Read the canvas back after a frame. Reference screenshots only. */
  readonly preserveDrawingBuffer?: boolean
  /** Skip the WebGPU attempt, so a screenshot is always of the same backend. */
  readonly forceWebGL?: boolean
  /** What the quality controller defends. Defaults to {@link FRAME_BUDGET_MS}. */
  readonly frameBudgetMs?: number
}

export type Renderer = {
  /** Draw one frame. `intervalMs` is the wall-clock since the last one. */
  render(view: RenderView, intervalMs: number): void
  resize(): void
  dispose(): void
  /** A copy of the last frame, scaled. For the reference screenshot. */
  capture(width: number, height: number): HTMLCanvasElement
  frameStats(): FrameStats
  verdict(budgetMs?: number): FrameVerdict
  /**
   * Forget every interval measured so far.
   *
   * The browser smoke test measures a clean 30 second window; the frames spent
   * compiling shaders and settling the layout are not the ones under test.
   */
  resetFrameStats(): void
  readonly backend: Backend
  readonly description: string
  /**
   * `scene.isReady(true)` has resolved: every shader compiled, every texture
   * loaded.
   *
   * This is the real loading gate. Without it the first rocket explosion
   * compiles its material mid-fight and stalls for a few hundred milliseconds,
   * which is a lost duel. The loading screen that waits on it is GLAD-NPCTU8's;
   * the compile is kicked off at construction either way.
   */
  readonly ready: boolean
  readonly frames: number
  readonly pixelRatio: number
  /** The arena's triangles. The player rigs are not counted. */
  readonly triangles: number
  /** How many opponent rigs are currently in the scene. */
  readonly drawnPlayers: number
  /** The weapon the viewmodel is showing, or `Weapon.None` for no hands. */
  readonly viewmodelWeapon: Weapon
}

export async function createRenderer(options: RendererOptions): Promise<Renderer> {
  // Before anything can ask for a texture. It points Babylon's KTX2 decoder and
  // meshopt decoder at our own origin instead of cdn.babylonjs.com, and turns
  // off the two defaults that would decode a compressed texture to uncompressed
  // RGBA on an integrated GPU. `ktx2.ts` argues both.
  configureKtx2()

  const budgetMs = options.frameBudgetMs ?? FRAME_BUDGET_MS
  const ceiling = ladderRung(
    options.pixelRatio ?? clampPixelRatio(globalThis.devicePixelRatio ?? 1),
  )

  const rendering: RenderEngine = await createEngine(options.canvas, ceiling, {
    preserveDrawingBuffer: options.preserveDrawingBuffer === true,
    forceWebGL: options.forceWebGL === true,
  })
  const engine = rendering.engine

  const scene: Scene = createScene(engine)
  const camera: TargetCamera = createCamera(scene)
  addLighting(scene, options.map)
  const grid = createGridTexture(scene, engine)
  const arena: MapMesh = buildMapMesh(scene, options.map, options.geometry, grid)
  // Built now rather than the first time a weapon is drawn, so its shaders
  // compile behind the loading screen with everything else. It draws nothing
  // until a view arrives carrying a `self` — which the reference screenshot
  // never does. See `viewmodel.ts`.
  const viewmodel: Viewmodel = createViewmodel(scene, camera)
  const roster: PlayerRoster = createPlayerRoster(scene)

  // The whole point of the pre-warm: force every shader to compile now, behind
  // the loading screen, rather than the first time something is drawn.
  let ready = false
  void scene.whenReadyAsync(true).then(() => {
    // Only now: freezing a material that has not compiled yet freezes it
    // broken. See `MapMesh.freeze`.
    arena.freeze()
    ready = true
  })

  const meter = createFrameMeter()
  // A second, short meter, so a step-down is judged on the frames since the
  // last decision rather than on a minute of history it has already reacted to.
  const recent = createFrameMeter(QUALITY_WINDOW_FRAMES)
  let sinceDecision = 0
  let pixelRatio = ceiling
  let frames = 0

  // The local player's animation. Only the viewmodel reads it — you never see
  // your own model — but it is the same fold over the same netstate, so the
  // hands bob at the speed the legs would run at.
  let selfAnim: AnimFrame = INITIAL_ANIM

  const drawViewmodel = (view: RenderView, tick: number, alpha: number): void => {
    const self: PlayerNetState | undefined = view.self
    if (self === undefined) {
      viewmodel.setVisible(false)
      return
    }
    viewmodel.setVisible(true)
    selfAnim = advanceAnim(selfAnim, self, tick)
    viewmodel.update(self, selfAnim, tick, alpha)
  }

  return {
    backend: rendering.backend,
    description: rendering.description,
    triangles: arena.triangles,

    get ready() {
      return ready
    },
    get frames() {
      return frames
    },
    get pixelRatio() {
      return pixelRatio
    },
    get drawnPlayers() {
      return roster.count
    },
    get viewmodelWeapon() {
      return viewmodel.weapon
    },

    render(view, intervalMs) {
      meter.record(intervalMs)
      recent.record(intervalMs)

      applyPose(camera, cameraPose(view))
      // After the camera and before the draw: everything below is written from
      // the same view the camera was, so a frame is one consistent moment.
      const tick = view.tick ?? 0
      const alpha = view.alpha ?? 0
      roster.draw(view.players ?? [], tick, alpha)
      drawViewmodel(view, tick, alpha)

      scene.render()
      frames += 1

      if (options.adaptQuality === false) return
      sinceDecision += 1
      if (sinceDecision < QUALITY_WINDOW_FRAMES) return
      sinceDecision = 0
      // The median, not the tail. See `nextPixelRatio`.
      const next = nextPixelRatio(pixelRatio, recent.stats().medianMs, budgetMs, ceiling)
      recent.reset()
      if (next === pixelRatio) return
      pixelRatio = next
      engine.setHardwareScalingLevel(hardwareScalingFor(next))
    },

    resize() {
      engine.resize()
    },

    capture(width, height) {
      // Drawn again first, so the copy is of a frame that is definitely in the
      // buffer: without `preserveDrawingBuffer` the contents are only valid
      // until the browser composites, which is the end of this task.
      scene.render()
      const target = document.createElement('canvas')
      target.width = width
      target.height = height
      const context = target.getContext('2d')
      if (context === null) throw new Error('no 2d context to capture into')
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      context.drawImage(options.canvas, 0, 0, width, height)
      return target
    },

    frameStats: () => meter.stats(),
    verdict: (budget = budgetMs) => meterVerdict(meter, budget),
    resetFrameStats: () => meter.reset(),

    dispose() {
      roster.dispose()
      viewmodel.dispose()
      arena.dispose()
      grid.dispose()
      scene.dispose()
      engine.dispose()
    },
  }
}
