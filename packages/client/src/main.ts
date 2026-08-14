/**
 * The walking skeleton's entry point.
 *
 * One frame does, in order:
 *
 *   1. read the clock once, and turn elapsed wall-clock into whole ticks
 *   2. for each tick: sample input, `tick()`, hash, queue the command
 *   3. flush the queued commands as one frame to the server
 *   4. draw the interpolated result
 *
 * The order is the point. The simulation never sees a clock; the renderer never
 * decides where anything is; the network never advances the world. Everything
 * this project adds later — prediction, lag compensation, a bot — hangs off
 * this shape.
 */
import {
  EntityFlag,
  SKELETON_ARENA,
  TICK_RATE,
  angleUnitsToRadians,
  cloneGameState,
  createSkeletonState,
  findPlayer,
  hashState,
  onSpeedClamp,
  type GameState,
  type Vec3,
  tick as simTick,
} from '@gladiator/sim'

import { createHud } from './hud.ts'
import { createInputController } from './input.ts'
import { advance, alphaOf } from './loop.ts'
import { createNetClient, resolveServerUrl } from './net.ts'
import { createRenderer, type Renderer } from './render.ts'

const BUILD = import.meta.env.VITE_BUILD ?? 'dev'

/**
 * A read-only view of the running client, for the browser smoke test.
 *
 * `scripts/e2e.mjs` drives a real headless browser and has to be able to answer
 * "did the box actually move" and "do the hashes agree" without scraping pixels
 * or parsing the HUD's prose. Deliberately a snapshot function rather than live
 * references: nothing outside can reach in and change the simulation.
 */
export type DebugSnapshot = {
  readonly build: string
  readonly tick: number
  readonly origin: Vec3
  readonly velocity: Vec3
  readonly onGround: boolean
  readonly clientHash: number
  readonly locked: boolean
  readonly net: ReturnType<ReturnType<typeof createNetClient>['snapshot']>
}

declare global {
  interface Window {
    __gladiator?: { snapshot(): DebugSnapshot }
  }
}

/** `?protocol=99` forces a version mismatch, to prove the message shows. */
function protocolOverride(search: string): number | undefined {
  const raw = new URLSearchParams(search).get('protocol')
  if (raw === null) return undefined
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) ? parsed : undefined
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** The one player this client simulates. Two players is GLAD-FHKBN8. */
const LOCAL_SLOT = 0

/** `[0, 0, 0]` if the player has somehow gone missing, rather than throwing in a frame. */
const NOWHERE: Vec3 = [0, 0, 0]

function originOf(state: GameState): Vec3 {
  const player = findPlayer(state, LOCAL_SLOT)
  return player === null ? NOWHERE : [player.origin[0], player.origin[1], player.origin[2]]
}

function velocityOf(state: GameState): Vec3 {
  const player = findPlayer(state, LOCAL_SLOT)
  return player === null
    ? NOWHERE
    : [player.velocity[0], player.velocity[1], player.velocity[2]]
}

function onGroundIn(state: GameState): boolean {
  const player = findPlayer(state, LOCAL_SLOT)
  return player !== null && (player.flags & EntityFlag.OnGround) !== 0
}

function interpolate(previous: GameState, current: GameState, alpha: number): Vec3 {
  const from = originOf(previous)
  const to = originOf(current)
  return [
    lerp(from[0], to[0], alpha),
    lerp(from[1], to[1], alpha),
    lerp(from[2], to[2], alpha),
  ]
}

function boot(): void {
  const app = document.querySelector<HTMLElement>('#app')
  if (app === null) throw new Error('no #app element to mount into')

  const canvas = document.createElement('canvas')
  canvas.id = 'stage'
  const overlay = document.createElement('div')
  overlay.id = 'overlay'
  app.append(canvas, overlay)

  const hud = createHud(overlay)

  let renderer: Renderer
  try {
    renderer = createRenderer(canvas)
  } catch (cause) {
    // A blank page with a console error is the worst possible outcome of a
    // deploy. Say what happened, on the page.
    hud.fail(`could not start the renderer: ${String(cause)}. WebGL2 may be unavailable here.`)
    return
  }

  const input = createInputController(canvas)
  canvas.addEventListener('click', () => input.requestLock())
  window.addEventListener('resize', () => renderer.resize())

  const override = protocolOverride(window.location.search)
  const net = createNetClient({
    url: resolveServerUrl(import.meta.env.VITE_SERVER_URL, window.location),
    build: BUILD,
    ...(override === undefined ? {} : { protocolOverride: override }),
  })
  net.connect()

  const state = createSkeletonState()
  // `tick()` advances the world in place, so the frame before is a *copy* —
  // `AGENTS.md` says this out loud because holding a reference instead is a bug
  // that only shows up as a rendering stutter.
  let previous = cloneGameState(state)
  let clientHash = hashState(state)
  let accumulatorMs = 0
  let lastFrameMs = performance.now()

  // The sim has no `console`, so the §2.6 safety rail reports through a seam.
  // If this ever prints, something upstream handed the simulation a velocity no
  // amount of movement could produce.
  onSpeedClamp((speed) => {
    console.warn(`gladiator: clamped a velocity of ${speed.toFixed(0)} qu/s`)
  })

  window.__gladiator = {
    snapshot: () => ({
      build: BUILD,
      tick: state.tick,
      origin: originOf(state),
      velocity: velocityOf(state),
      onGround: onGroundIn(state),
      clientHash,
      locked: input.locked,
      net: net.snapshot(),
    }),
  }

  // A rolling estimate, so the HUD reads a rate rather than one frame's noise.
  let fps = 0

  const frame = (nowMs: number) => {
    const elapsedMs = nowMs - lastFrameMs
    lastFrameMs = nowMs
    fps = elapsedMs > 0 ? fps * 0.9 + (1000 / elapsedMs) * 0.1 : fps

    // Input is sampled once per frame, not once per tick: a browser only
    // delivers mouse and key events between frames, so a per-tick sample would
    // be the same value read several times with extra steps.
    const cmd = input.sample()
    const status = net.snapshot().status

    if (status === 'idle' || status === 'connecting') {
      // Hold the world still until we know whether there is a server to agree
      // with.
      //
      // This is not politeness, it is the bug this ticket was built to catch:
      // a socket takes a handful of frames to open, and a client that
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
        previous = cloneGameState(state)
        simTick(state, [cmd], SKELETON_ARENA)
        clientHash = hashState(state)
        net.record(state.tick, clientHash)
        net.queue(state.tick, cmd)
      }
      net.flush()
    }

    renderer.render({
      origin: interpolate(previous, state, alphaOf(accumulatorMs)),
      yawRadians: angleUnitsToRadians(cmd.yaw),
      pitchRadians: angleUnitsToRadians(cmd.pitch),
    })

    hud.update({
      build: BUILD,
      renderer: renderer.description,
      fps,
      tick: state.tick,
      ticksPerSecond: TICK_RATE,
      clientHash,
      locked: input.locked,
      net: net.snapshot(),
    })

    window.requestAnimationFrame(frame)
  }

  window.requestAnimationFrame(frame)
}

boot()
