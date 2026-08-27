/**
 * Getting a graphics context, WebGPU first.
 *
 * WebGPU is worth reaching for before WebGL2 for one reason that matters to
 * this game specifically: its draw submission costs a fraction of WebGL's per
 * call, and a duel is a scene the CPU has to re-record every frame while also
 * simulating, predicting and reconciling. Everywhere it is missing — Safari
 * before 26, Firefox on Linux, every locked-down corporate browser — WebGL2 is
 * the floor, and the floor has to be silent: a player must never see a
 * capability negotiation.
 *
 * So: try WebGPU, take WebGL2 if anything at all goes wrong, and say which one
 * came up on the HUD. Nothing else in the renderer knows the difference.
 *
 * ## Why the WebGPU imports are dynamic
 *
 * `@babylonjs/core/Engines/webgpuEngine` drags in the WGSL shader processor,
 * the bind-group cache and the render-bundle machinery. A browser that will
 * never use them should not download them, so everything WebGPU is reached
 * through {@link loadWebGPU} — behind an `await import()`, and emitted by Vite
 * as its own chunk. That is also the one place an engine extension WebGPU does
 * not register for itself gets asked for; see {@link loadWebGPU}.
 *
 * ## Pixel ratio is the quality dial
 *
 * At this scene complexity the bottleneck is fill rate, not draw calls, so the
 * number of pixels is the knob with the most travel. It is clamped on the way
 * in — a 3x phone display asks for nine times the fragments of a 1x one for a
 * difference nobody can see at arm's length — and stepped down under load
 * before anything else is sacrificed, because a slightly softer image at a
 * steady frame rate beats a crisp one that hitches. See {@link nextPixelRatio}.
 */
import { Engine } from '@babylonjs/core/Engines/engine'
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import type { WebGPUEngineOptions } from '@babylonjs/core/Engines/webgpuEngine'

/** Which backend actually came up. Reported, never branched on. */
export type Backend = 'webgpu' | 'webgl2' | 'webgl1'

export type RenderEngine = {
  readonly engine: AbstractEngine
  readonly backend: Backend
  /** One line for the HUD: backend, Babylon version, driver string. */
  readonly description: string
}

/**
 * The part of an engine and scene needed to submit one frame.
 *
 * Kept structural so the lifecycle can be checked without constructing a GPU
 * in a unit test. The production values are an {@link AbstractEngine} and a
 * Babylon `Scene`.
 */
export type FrameEngine = Pick<AbstractEngine, 'beginFrame' | 'endFrame'>
export type FrameScene = { render(): void }

/**
 * Draw and submit one frame when the application owns the animation loop.
 *
 * `AbstractEngine.runRenderLoop()` normally puts these calls around the render
 * callback. Gladiator cannot use that loop because `main.ts` owns the one
 * clock read that drives input, simulation, networking and rendering. WebGL
 * submits draws eagerly and happened to tolerate a bare `scene.render()`;
 * WebGPU records commands and submits them from `endFrame()`, so omitting this
 * lifecycle leaves a healthy, ready scene displaying only the clear colour.
 */
export function renderFrame(engine: FrameEngine, scene: FrameScene): void {
  engine.beginFrame()
  try {
    scene.render()
  } finally {
    // Submit even when Babylon throws while drawing, so the engine does not
    // carry an open frame into a later recovery or disposal path.
    engine.endFrame()
  }
}

/**
 * The most device pixels per CSS pixel worth rendering.
 *
 * 2. Beyond it the cost is quadratic and the improvement is invisible at the
 * distance a monitor is actually viewed from; the pixels are better spent on
 * frame rate, which is the thing a competitive shooter is judged on.
 */
export const MAX_PIXEL_RATIO = 2

/**
 * The rungs the quality controller may stand on.
 *
 * Descending, and coarse on purpose: a continuous dial would spend its life
 * hunting, and every change reallocates the framebuffer.
 *
 * The bottom three are ugly and they are supposed to be. A machine that cannot
 * hold the budget at half resolution — a software rasteriser, an old integrated
 * part, a CI runner — used to stop there and play the rest of the match at 20
 * frames a second, which in a duel is not playing. Quarter resolution is a
 * blurry picture; 20 fps is a lost round, and the HUD is DOM and stays sharp
 * either way. This file's header states the trade and these rungs are it.
 */
export const PIXEL_RATIO_LADDER: readonly number[] = [
  2, 1.5, 1.25, 1, 0.85, 0.75, 0.6, 0.5, 0.4, 0.33, 0.25,
]

/**
 * The share of a window that may miss the budget before quality steps down.
 *
 * A fifth. Under vsync a missed budget is a *doubled* interval — the frame
 * waits for the next refresh — so this counts whole dropped refreshes, and a
 * fifth of them is a picture that visibly stutters rather than one that is
 * merely not perfect.
 */
export const STEP_DOWN_SHARE = 0.2

/**
 * The share it has to fall to before quality steps back up.
 *
 * A twentieth, and the gap to {@link STEP_DOWN_SHARE} is one half of the
 * hysteresis: stepping up the moment there is room would put the renderer
 * straight back into the state that made it step down.
 */
export const STEP_UP_SHARE = 0.05

/**
 * How many clean windows in a row it takes to step back up.
 *
 * Three — six seconds — and it is the other half of the hysteresis, because a
 * share threshold on its own cannot supply it. The rungs are coarse, so two
 * neighbours can straddle the budget: at 0.85 a quarter of the frames miss and
 * at 0.75 none do, and a dial with no memory then alternates between them for
 * as long as the scene is that size. Going down on one window and up only on
 * three makes the wrong rung a quarter of the time rather than half, and a
 * scene that genuinely got cheaper — a player who walked out of the busy room
 * — waits six seconds for a sharper picture, which nobody notices.
 */
export const RECOVER_WINDOWS = 3

/**
 * The share past which the dial takes two rungs instead of one.
 *
 * Half the window. One rung per window is the right *shape* — it settles
 * without hunting — and the wrong *speed* for a machine that is nowhere near
 * the budget: at 20 fps a window is a couple of seconds and the ladder is
 * eleven rungs long, so a match could be half over before the dial arrives.
 * Missing more than half the frames is not a near miss, and the rungs below are
 * coarse enough that overshooting one costs a window to climb back.
 */
export const LEAP_SHARE = 0.5

/**
 * The GPU features the KTX2 decoder may transcode a 2D texture into.
 *
 * A WebGPU adapter advertising a feature is not enough: it has to be requested
 * when the device is created before Babylon exposes the matching texture cap.
 * `WebGPUEngine` filters this list against the adapter, so a machine may enable
 * any subset and the decoder chooses among the formats it actually received.
 */
export const WEBGPU_TEXTURE_FEATURES: readonly GPUFeatureName[] = [
  'texture-compression-bc',
  'texture-compression-etc2',
  'texture-compression-astc',
]

/** A fresh options object because Babylon filters `requiredFeatures` in place. */
export function createWebGPUOptions(): WebGPUEngineOptions {
  return {
    antialias: true,
    stencil: false,
    audioEngine: false,
    powerPreference: 'high-performance',
    adaptToDeviceRatio: false,
    deviceDescriptor: { requiredFeatures: [...WEBGPU_TEXTURE_FEATURES] },
  }
}

/**
 * How far over budget a frame has to be before it counts as having missed it.
 *
 * 1.15, and it is not a fudge factor — it is the difference between a frame
 * that *missed* its budget and one that was quantised past it. A 60 Hz display
 * hands out intervals of 16.7 or 16.8 ms, and the budget is 1000/60 = 16.667:
 * without this, every 60 Hz machine in the world reads as permanently over
 * budget and the quality controller walks its image down to the bottom rung on
 * a screen that is keeping perfect time.
 */
export const QUALITY_TOLERANCE = 1.15

/** Clamp a device pixel ratio into something worth rendering. */
export function clampPixelRatio(devicePixelRatio: number, max: number = MAX_PIXEL_RATIO): number {
  if (!Number.isFinite(devicePixelRatio) || devicePixelRatio <= 0) return 1
  return devicePixelRatio > max ? max : devicePixelRatio
}

/**
 * The rung at or below `ratio`. The ceiling the ladder starts from.
 */
export function ladderRung(ratio: number): number {
  for (const rung of PIXEL_RATIO_LADDER) if (rung <= ratio) return rung
  return PIXEL_RATIO_LADDER[PIXEL_RATIO_LADDER.length - 1] ?? 0.5
}

/**
 * One evaluation of the quality dial: what the pixel ratio should be next.
 *
 * Pure, so the hysteresis is testable without a GPU. Steps down when too much
 * of the window missed the budget, up when almost none of it did, and
 * otherwise leaves well alone.
 *
 * `missShare` is the fraction of the window's frames that came in over
 * `budgetMs * QUALITY_TOLERANCE`, and choosing *that* over a summary statistic
 * is the whole design of this function.
 *
 * It used to be the **median** interval, on the reasoning that a percentile
 * measures smoothness and a median measures cost, and only cost is something
 * fewer pixels can fix. The reasoning is right and the statistic does not
 * survive vsync. A display hands out its refresh interval or a multiple of it,
 * so a renderer taking 15 ms a frame and one taking 16.6 ms both read as a
 * median of 16.7 — and so does one taking 20 ms, right up until *half* its
 * frames miss. The median is pinned to the monitor, not to the scene, and a
 * dial reading it is blind between "comfortable" and "dropping every third
 * frame". Measured on the browser smoke test's runner: a median of 16.7 ms
 * with a mean of 21.3, which is a quarter of the frames missing a refresh, and
 * a controller that sat at 0.85 through all of it.
 *
 * What vsync leaves visible is *how many* frames missed, and that is a measure
 * of cost rather than of smoothness: fewer pixels move it directly. It also
 * keeps the property the median was chosen for — a tail of stalls from the
 * operating system descheduling the tab is a handful of frames out of hundreds,
 * which is nowhere near {@link STEP_DOWN_SHARE} and correctly changes nothing.
 */
export function nextPixelRatio(
  current: number,
  missShare: number,
  ceiling: number,
  cleanWindows = RECOVER_WINDOWS,
): number {
  const rungs = PIXEL_RATIO_LADDER
  const index = rungs.indexOf(current)
  // A ratio that is not on the ladder was set by hand — leave it alone rather
  // than snapping the image size out from under whoever chose it.
  if (index === -1) return current

  if (missShare > STEP_DOWN_SHARE) {
    const leap = missShare > LEAP_SHARE ? 2 : 1
    return rungs[index + leap] ?? rungs[rungs.length - 1] ?? current
  }
  if (missShare < STEP_UP_SHARE && cleanWindows >= RECOVER_WINDOWS) {
    const up = rungs[index - 1]
    return up !== undefined && up <= ceiling ? up : current
  }
  return current
}

/**
 * Babylon's hardware scaling level for a pixel ratio.
 *
 * Babylon multiplies the CSS size by `1 / level`, so a level of 0.5 renders two
 * device pixels per CSS pixel. Inverted from the way everyone thinks about it,
 * which is why the conversion has a name.
 */
export function hardwareScalingFor(pixelRatio: number): number {
  return 1 / pixelRatio
}

export type EngineOptions = {
  /**
   * Keep the drawing buffer readable after the frame has been composited.
   *
   * Costs a copy every frame, so it is off in play and on only for the
   * reference-screenshot mode, which reads the canvas back.
   */
  readonly preserveDrawingBuffer?: boolean
  /** Skip the WebGPU attempt. The e2e uses it to exercise the fallback. */
  readonly forceWebGL?: boolean
}

/**
 * The WebGPU engine, and the extension it does not bring with it.
 *
 * Babylon 9 splits every engine extension in two: a pure module, and a
 * side-effecting one that patches the method on to an engine prototype.
 * `Engines/webgpuEngine` imports nine of those for you and
 * `engine.dynamicTexture` is not one of them — so it has to be asked for by
 * name, here, or `WebGPUEngine.prototype.createDynamicTexture` never exists.
 *
 * Nothing else in the client imports it, and until GLAD-ZCEQMN nothing had to:
 * `new DynamicTexture(...)` registers the **ThinEngine** half from inside its
 * own constructor, and `Engine` is a `ThinEngine`, so the WebGL path has always
 * worked without a line like this. `WebGPUEngine` descends from
 * `AbstractEngine` instead and never saw that registration. Since
 * `render/materials.ts` builds three detail textures before the first frame,
 * the entire WebGPU path was a blank page and a `TypeError:
 * engine.createDynamicTexture is not a function` — on exactly the machines
 * whose browser was *best* supported.
 *
 * Both imports are dynamic and reachable only from here, so a browser that will
 * never run WebGPU still downloads none of it.
 *
 * Exported because it is the half of the WebGPU path that can be checked
 * without a GPU: `engine.test.ts` asserts the prototype came up carrying the
 * methods. `docs/renderer.md` §3.
 */
export async function loadWebGPU() {
  const [{ WebGPUEngine }] = await Promise.all([
    import('@babylonjs/core/Engines/webgpuEngine'),
    import('@babylonjs/core/Engines/WebGPU/Extensions/engine.dynamicTexture'),
  ])
  return WebGPUEngine
}

/**
 * Try WebGPU. Returns `null` for every kind of "no" there is — unsupported,
 * adapter refused, `initAsync` threw — because the caller's response to all of
 * them is the same and a player must not be shown the difference.
 */
async function tryWebGPU(canvas: HTMLCanvasElement): Promise<AbstractEngine | null> {
  try {
    const WebGPUEngine = await loadWebGPU()
    if (!(await WebGPUEngine.IsSupportedAsync)) return null
    // `preserveDrawingBuffer` is deliberately not forwarded: it is a WebGL
    // concept, and the one thing that reads the canvas back — the reference
    // screenshot — pins itself to WebGL precisely so the committed image does
    // not depend on which backend the machine happened to offer.
    const engine = new WebGPUEngine(canvas, createWebGPUOptions())
    await engine.initAsync()
    return engine
  } catch {
    return null
  }
}

/** WebGL2 where it exists, WebGL1 where it does not. Throws if neither does. */
function createWebGL(canvas: HTMLCanvasElement, options: EngineOptions): Engine {
  return new Engine(
    canvas,
    true,
    {
      preserveDrawingBuffer: options.preserveDrawingBuffer === true,
      stencil: false,
      // Audio is GLAD-26Q67K's, and creating an AudioContext before a user
      // gesture earns a console warning on every load.
      audioEngine: false,
      powerPreference: 'high-performance',
      // A software rasteriser is much better than a blank page — headless CI
      // renders on SwiftShader and so, occasionally, do real players.
      failIfMajorPerformanceCaveat: false,
      adaptToDeviceRatio: false,
    },
    false,
  )
}

/**
 * Acquire a graphics context and report which one it is.
 *
 * Throws only when there is no context of any kind to be had; the caller turns
 * that into a message on the page rather than a blank screen.
 */
export async function createEngine(
  canvas: HTMLCanvasElement,
  pixelRatio: number,
  options: EngineOptions = {},
): Promise<RenderEngine> {
  const webgpu = options.forceWebGL === true ? null : await tryWebGPU(canvas)
  const engine = webgpu ?? createWebGL(canvas, options)

  const backend: Backend = engine.isWebGPU
    ? 'webgpu'
    : engine instanceof Engine && engine.webGLVersion >= 2
      ? 'webgl2'
      : 'webgl1'

  engine.setHardwareScalingLevel(hardwareScalingFor(pixelRatio))

  return {
    engine,
    backend,
    description: `${backend} · Babylon ${Engine.Version} · ${engine.description}`,
  }
}
