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
 * ## Why the WebGPU import is dynamic
 *
 * `@babylonjs/core/Engines/webgpuEngine` drags in the WGSL shader processor,
 * the bind-group cache and the render-bundle machinery. A browser that will
 * never use them should not download them, so the module is behind an
 * `await import()` and Vite emits it as its own chunk.
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

/** Which backend actually came up. Reported, never branched on. */
export type Backend = 'webgpu' | 'webgl2' | 'webgl1'

export type RenderEngine = {
  readonly engine: AbstractEngine
  readonly backend: Backend
  /** One line for the HUD: backend, Babylon version, driver string. */
  readonly description: string
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
 */
export const PIXEL_RATIO_LADDER: readonly number[] = [2, 1.5, 1.25, 1, 0.85, 0.75, 0.6, 0.5]

/**
 * How far under budget p99 has to sit before quality is stepped back up.
 *
 * 0.7 — a 30% margin. Stepping up the moment there is room would put the
 * renderer straight back into the state that made it step down, once per
 * evaluation window, forever.
 */
export const RECOVER_FRACTION = 0.7

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
 * Pure, so the hysteresis is testable without a GPU. Steps down one rung when
 * the 99th-percentile frame misses the budget, up one rung when it is
 * comfortably inside it, and otherwise leaves well alone.
 */
export function nextPixelRatio(
  current: number,
  p99Ms: number,
  budgetMs: number,
  ceiling: number,
): number {
  const rungs = PIXEL_RATIO_LADDER
  const index = rungs.indexOf(current)
  // A ratio that is not on the ladder was set by hand — leave it alone rather
  // than snapping the image size out from under whoever chose it.
  if (index === -1) return current

  if (p99Ms > budgetMs) return rungs[index + 1] ?? current
  if (p99Ms > 0 && p99Ms < budgetMs * RECOVER_FRACTION) {
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
 * Try WebGPU. Returns `null` for every kind of "no" there is — unsupported,
 * adapter refused, `initAsync` threw — because the caller's response to all of
 * them is the same and a player must not be shown the difference.
 */
async function tryWebGPU(canvas: HTMLCanvasElement): Promise<AbstractEngine | null> {
  try {
    const { WebGPUEngine } = await import('@babylonjs/core/Engines/webgpuEngine')
    if (!(await WebGPUEngine.IsSupportedAsync)) return null
    // `preserveDrawingBuffer` is deliberately not forwarded: it is a WebGL
    // concept, and the one thing that reads the canvas back — the reference
    // screenshot — pins itself to WebGL precisely so the committed image does
    // not depend on which backend the machine happened to offer.
    const engine = new WebGPUEngine(canvas, {
      antialias: true,
      stencil: false,
      audioEngine: false,
      powerPreference: 'high-performance',
      adaptToDeviceRatio: false,
    })
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
