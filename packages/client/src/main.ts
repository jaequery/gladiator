/**
 * The client's entry point.
 *
 * One frame does, in order:
 *
 *   1. read the clock once, and turn elapsed wall-clock into whole ticks
 *   2. for each tick: sample input, `pmove`, hash, queue the command
 *   3. flush the queued commands as one frame to the server
 *   4. draw the interpolated result
 *
 * The order is the point. The simulation never sees a clock; the renderer never
 * decides where anything is; the network never advances the world. Everything
 * this project adds later — prediction, lag compensation, a bot — hangs off
 * this shape.
 *
 * The clock is read **once**, here, and the elapsed interval is passed to
 * everything that needs it. A renderer that read `performance.now()` itself
 * would be a second opinion about what a frame is.
 */
import {
  SPAWN_STATE,
  TICK_RATE,
  hashPlayerState,
  mapGeometry,
  type Vec3,
  pmove,
} from '@gladiator/sim'

import { createHud } from './hud.ts'
import { createInputController } from './input/controller.ts'
import { advance, alphaOf } from './loop.ts'
import { CLIENT_MAP, CLIENT_MAP_HASH } from './map.ts'
import { createNetClient, mustHoldStill, resolveServerUrl } from './net.ts'
import { FRAME_BUDGET_MS, type FrameVerdict } from './render/frameStats.ts'
import { type Renderer, createRenderer } from './render/renderer.ts'
import { REFERENCE_VIEW, interpolateOrigin } from './render/view.ts'

const BUILD = import.meta.env.VITE_BUILD ?? 'dev'

/**
 * How often the readout is refreshed, in milliseconds.
 *
 * Ten times a second, not once a frame, and the reason is measured rather than
 * assumed: writing the panel's dozen `textContent`s every frame dirties the
 * overlay, and a dirty overlay makes the browser recomposite the whole page on
 * top of the canvas. At 320x200 in headless Chromium that alone took the loop
 * from a flat 16.7 ms to a mean of 18 ms with a 50 ms 99th percentile — a
 * stutter caused entirely by *displaying* the frame rate.
 *
 * Ten hertz also happens to be the fastest a number is worth reading. The real
 * HUD is GLAD-BHNPOE; this constant is the constraint it inherits.
 */
const HUD_INTERVAL_MS = 100

/** What the renderer is doing, for the HUD and the browser smoke test. */
export type RenderSnapshot = {
  /** `webgpu`, `webgl2` or `webgl1` — which context actually came up. */
  readonly backend: string
  readonly description: string
  /** `scene.isReady(true)` has resolved: every shader compiled, every texture in. */
  readonly ready: boolean
  readonly frames: number
  readonly pixelRatio: number
  readonly triangles: number
  readonly meanMs: number
  readonly medianMs: number
  readonly p99Ms: number
  readonly worstMs: number
}

/**
 * A read-only view of the running client, for the browser smoke test.
 *
 * `scripts/e2e.mjs` drives a real headless browser and has to be able to answer
 * "did the box actually move", "do the hashes agree" and "is the frame pacing
 * within budget" without scraping pixels or parsing the HUD's prose.
 * Deliberately a snapshot function rather than live references: nothing outside
 * can reach in and change the simulation.
 */
export type DebugSnapshot = {
  readonly build: string
  readonly mapName: string
  readonly mapHash: string
  readonly tick: number
  readonly origin: Vec3
  readonly velocity: Vec3
  readonly onGround: boolean
  readonly clientHash: number
  readonly locked: boolean
  readonly raw: boolean
  readonly render: RenderSnapshot
  readonly net: ReturnType<ReturnType<typeof createNetClient>['snapshot']>
}

declare global {
  interface Window {
    __gladiator?: {
      snapshot(): DebugSnapshot
      /** Judge the frames since {@link resetFrameStats} against a budget. */
      frameVerdict(budgetMs: number): FrameVerdict
      resetFrameStats(): void
      /** The last frame, scaled — for the reference-screenshot comparison. */
      capture(width: number, height: number): ImageData
      /** The same frame as a `data:image/png` URL, for re-shooting it. */
      captureDataUrl(width: number, height: number): string
    }
  }
}

/** `?protocol=99` forces a version mismatch, to prove the message shows. */
function protocolOverride(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('protocol')
  if (raw === null) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) ? parsed : undefined
}

/** `?map=deadbeef` forces a map mismatch, the same way `?protocol=` does. */
function mapHashOverride(search: string): string | undefined {
  const raw = new URLSearchParams(search).get('map')
  return raw !== null && /^[0-9a-f]{8}$/.test(raw) ? raw : undefined
}

/**
 * `?shot=1` — the reference-screenshot mode.
 *
 * A page with nothing moving in it: no socket, no simulation, no HUD, no
 * adaptive quality, one device pixel per CSS pixel, and the camera pinned to
 * {@link REFERENCE_VIEW}. A reference screenshot of a page that is doing
 * anything at all is a reference to nothing.
 *
 * It also pins the backend to WebGL, so the committed image does not depend on
 * whether the machine that took it happened to offer WebGPU.
 */
function shotMode(search: string): boolean {
  return new URLSearchParams(search).get('shot') !== null
}

async function boot(): Promise<void> {
  const app = document.querySelector<HTMLElement>('#app')
  if (app === null) throw new Error('no #app element to mount into')

  const canvas = document.createElement('canvas')
  canvas.id = 'stage'
  const overlay = document.createElement('div')
  overlay.id = 'overlay'
  app.append(canvas, overlay)

  const hud = createHud(overlay)
  const shot = shotMode(window.location.search)
  if (shot) overlay.hidden = true

  let renderer: Renderer
  try {
    renderer = await createRenderer({
      canvas,
      map: CLIENT_MAP.source,
      // Derived from the collision brushes, never authored beside them:
      // `packages/sim/src/map/geometry.ts`.
      geometry: mapGeometry(CLIENT_MAP.source),
      ...(shot
        ? { adaptQuality: false, pixelRatio: 1, preserveDrawingBuffer: true, forceWebGL: true }
        : {}),
    })
  } catch (cause) {
    // A blank page with a console error is the worst possible outcome of a
    // deploy. Say what happened, on the page.
    hud.fail(
      `could not start the renderer: ${String(cause)}. Neither WebGPU nor WebGL2 is available here.`,
    )
    return
  }

  const input = createInputController(canvas)
  if (!shot) canvas.addEventListener('click', () => input.requestLock())
  window.addEventListener('resize', () => renderer.resize())

  const override = protocolOverride(window.location.search)
  const mapOverride = mapHashOverride(window.location.search)
  const net = createNetClient({
    url: resolveServerUrl(import.meta.env.VITE_SERVER_URL, window.location),
    build: BUILD,
    mapHash: CLIENT_MAP_HASH,
    ...(override === undefined ? {} : { protocolOverride: override }),
    ...(mapOverride === undefined ? {} : { mapHashOverride: mapOverride }),
  })
  if (!shot) net.connect()

  // The walking skeleton's world: one player on a flat plane. Where a round
  // actually starts a player is GLAD-AKODBZ's, and the client and the server
  // have to agree on it to the bit — so it stays `SPAWN_STATE` until the ticket
  // that owns it moves both ends at once.
  let state = SPAWN_STATE
  let previous = SPAWN_STATE
  let tick = 0
  let clientHash = hashPlayerState(tick, state)
  let accumulatorMs = 0
  let lastFrameMs = performance.now()

  const renderSnapshot = (): RenderSnapshot => {
    const stats = renderer.frameStats()
    return {
      backend: renderer.backend,
      description: renderer.description,
      ready: renderer.ready,
      frames: renderer.frames,
      pixelRatio: renderer.pixelRatio,
      triangles: renderer.triangles,
      meanMs: stats.meanMs,
      medianMs: stats.medianMs,
      p99Ms: stats.p99Ms,
      worstMs: stats.worstMs,
    }
  }

  window.__gladiator = {
    snapshot: () => ({
      build: BUILD,
      mapName: CLIENT_MAP.source.name,
      mapHash: CLIENT_MAP_HASH,
      tick,
      origin: state.origin,
      velocity: state.velocity,
      onGround: state.onGround,
      clientHash,
      locked: input.locked,
      raw: input.raw,
      render: renderSnapshot(),
      net: net.snapshot(),
    }),
    frameVerdict: (budgetMs: number) => renderer.verdict(budgetMs),
    resetFrameStats: () => renderer.resetFrameStats(),
    capture: (width: number, height: number) => {
      const shotCanvas = renderer.capture(width, height)
      const context = shotCanvas.getContext('2d')
      if (context === null) throw new Error('no 2d context to read back')
      return context.getImageData(0, 0, width, height)
    },
    captureDataUrl: (width: number, height: number) =>
      renderer.capture(width, height).toDataURL('image/png'),
  }

  // A rolling estimate, so the HUD reads a rate rather than one frame's noise.
  let fps = 0
  let hudP99Ms = 0
  let hudDueMs = 0

  const frame = (nowMs: number) => {
    const elapsedMs = nowMs - lastFrameMs
    lastFrameMs = nowMs
    fps = elapsedMs > 0 ? fps * 0.9 + (1000 / elapsedMs) * 0.1 : fps

    if (shot) {
      renderer.render(REFERENCE_VIEW, elapsedMs)
      window.requestAnimationFrame(frame)
      return
    }

    // Input is sampled once per frame, not once per tick: a browser only
    // delivers mouse and key events between frames, so a per-tick sample would
    // be the same value read several times with extra steps.
    const cmd = input.sample()
    const status = net.snapshot().status

    if (mustHoldStill(status)) {
      // Hold the world still until we know whether there is a server to agree
      // with — and stop it again if we turn out to be holding a different map
      // than the one it is authoritative over. See `mustHoldStill`.
      //
      // This is not politeness, it is the bug the walking skeleton was built to
      // catch: a socket takes a handful of frames to open, and a client that
      // simulates during them has advanced ticks whose commands nobody
      // received. The server then numbers *its* first command tick 1 while the
      // client is already at tick 40, and every hash after that is compared
      // against a different moment. It looks exactly like a broken simulation
      // and it is a broken clock.
      accumulatorMs = 0
    } else {
      const step = advance(accumulatorMs, elapsedMs)
      accumulatorMs = step.accumulatorMs
      for (let i = 0; i < step.ticks; i += 1) {
        previous = state
        state = pmove(state, cmd)
        tick += 1
        clientHash = hashPlayerState(tick, state)
        net.record(tick, clientHash)
        net.queue(tick, cmd)
      }
      net.flush()
    }

    renderer.render(
      {
        origin: interpolateOrigin(previous, state, alphaOf(accumulatorMs)),
        // The view angle is the freshest thing the frame has; interpolating it
        // would add latency to aim. `render/view.ts`.
        yawUnits: cmd.yaw,
        pitchUnits: cmd.pitch,
      },
      elapsedMs,
    )

    hudDueMs -= elapsedMs
    if (hudDueMs > 0) {
      window.requestAnimationFrame(frame)
      return
    }
    hudDueMs = HUD_INTERVAL_MS
    hudP99Ms = renderer.frameStats().p99Ms

    hud.update({
      build: BUILD,
      mapName: CLIENT_MAP.source.name,
      renderer: `${renderer.description} · ${renderer.pixelRatio}x`,
      frameBudgetMs: FRAME_BUDGET_MS,
      p99Ms: hudP99Ms,
      fps,
      tick,
      ticksPerSecond: TICK_RATE,
      clientHash,
      locked: input.locked,
      net: net.snapshot(),
    })

    window.requestAnimationFrame(frame)
  }

  window.requestAnimationFrame(frame)
}

boot().catch((cause: unknown) => {
  const app = document.querySelector<HTMLElement>('#app')
  if (app !== null) createHud(app).fail(`could not start: ${String(cause)}`)
})
