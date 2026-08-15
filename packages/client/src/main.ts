/**
 * The client's entry point.
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
 *
 * The clock is read **once**, here, and the elapsed interval is passed to
 * everything that needs it. A renderer that read `performance.now()` itself
 * would be a second opinion about what a frame is.
 */
import {
  ANGLE_UNITS_PER_DEGREE,
  EntityFlag,
  SKELETON_SEED,
  TICK_RATE,
  cloneGameState,
  createMapState,
  findPlayer,
  type GameState,
  hashState,
  mapGeometry,
  onSpeedClamp,
  type Vec3,
  tick as simTick,
} from '@gladiator/sim'

import {
  type AudioBufferLike,
  type AudioEngine,
  type AudioSnapshot,
  NO_AUDIO,
  createAudioEngine,
  createBrowserAudioContext,
} from './audio/engine.ts'
import { createCueTracker, playCues } from './audio/cues.ts'
import { armGesture } from './audio/gesture.ts'
import { type OfflineHost, renderHrtfProbe, renderOnset } from './audio/probe.ts'
import { ALL_SOUNDS, SoundId } from './audio/sounds.ts'
import { createCreditsScreen, creditsRequested } from './credits.ts'
import { dummyMode, dummyOpponent } from './dummyOpponent.ts'
import { createHud } from './hud.ts'
import { createInputController } from './input/controller.ts'
import { advance, alphaOf } from './loop.ts'
import { CLIENT_MAP, CLIENT_MAP_HASH } from './map.ts'
import { createNetClient, mustHoldStill, resolveServerUrl } from './net.ts'
import { type PlayerNetState, playerNetState } from './render/animState.ts'
import { FRAME_BUDGET_MS, type FrameVerdict } from './render/frameStats.ts'
import { type Renderer, createRenderer } from './render/renderer.ts'
import { REFERENCE_VIEW, interpolateNetState, interpolateOrigin } from './render/view.ts'

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
  /** Opponent rigs currently in the scene. GLAD-PWCON8. */
  readonly drawnPlayers: number
  /** `Weapon` the first-person viewmodel is showing; 0 is no hands. */
  readonly viewmodelWeapon: number
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
  readonly audio: AudioSnapshot
  readonly net: ReturnType<ReturnType<typeof createNetClient>['snapshot']>
}

/**
 * The audio side of the debug surface.
 *
 * `scripts/audio-check.mjs` drives a real browser and has to be able to answer
 * "did anything decode after loading", "how far ahead of the audio clock did
 * that shot schedule" and "does a source behind the listener render differently
 * from one in front" — none of which can be scraped off a page.
 *
 * It ships in production for the same reason the frame capture does: audio
 * latency and HRTF quality are properties of the *device*, and the machine that
 * sounds wrong is the one the measurement needs to run on.
 */
export type AudioDebug = {
  snapshot(): AudioSnapshot
  /** Play every sound in the catalogue once. Returns how many started. */
  playAll(): number
  /** Render the HRTF probe offline. `capture` also returns the samples. */
  probe(capture?: boolean): Promise<unknown>
  /** How long after being scheduled a feedback voice becomes audible. */
  onset(): Promise<unknown>
  /**
   * Suspend the context, putting the page back in the state a browser hands it
   * to us in before any gesture. `scripts/audio-check.mjs` uses it to make the
   * gesture check mean something in a headless browser, which has no autoplay
   * policy to be held back by.
   */
  suspend(): void
}

declare global {
  interface Window {
    __gladiator?: {
      snapshot(): DebugSnapshot
      audio: AudioDebug
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
  return player === null ? NOWHERE : [player.velocity[0], player.velocity[1], player.velocity[2]]
}

function onGroundIn(state: GameState): boolean {
  const player = findPlayer(state, LOCAL_SLOT)
  return player !== null && (player.flags & EntityFlag.OnGround) !== 0
}

/**
 * The local player as the renderer reads them, or `null` if they are missing.
 *
 * A *copy* of a slice of the entity, never the entity — see `PlayerNetState`.
 * The viewmodel is drawn from it, which is what makes the hands obey the same
 * netstate an opponent's model would.
 */
function netStateOf(state: GameState, slot: number): PlayerNetState | null {
  const player = findPlayer(state, slot)
  return player === null ? null : playerNetState(player)
}

/** Where the scripted opponent runs its circle. The middle of the arena. */
const DUMMY_CENTRE: Vec3 = [0, 0, 0]

/**
 * The scripted opponent, interpolated between two ticks.
 *
 * Deliberately the same path a real snapshot pair will take: two `EntityState`s
 * a tick apart, through `playerNetState` and `interpolateNetState`. When
 * GLAD-6RT64L starts delivering real ones, what changes is where the two states
 * come from and nothing else.
 */
function dummyAt(tick: number, alpha: number): PlayerNetState {
  return interpolateNetState(
    playerNetState(dummyOpponent(tick - 1, DUMMY_CENTRE)),
    playerNetState(dummyOpponent(tick, DUMMY_CENTRE)),
    alpha,
  )
}

/**
 * The audio engine, or `null` if this browser will not give us one.
 *
 * Loading is started and deliberately not awaited: a page that cannot fetch its
 * sounds is a quiet game, not a broken one, so the failure path is a warning and
 * a counter in the snapshot rather than a `hud.fail`. Every sound is decoded
 * before it is ever played — `audio/engine.ts` explains why there is no lazy
 * path.
 */
function startAudio(): AudioEngine | null {
  try {
    const engine = createAudioEngine({ context: createBrowserAudioContext() })
    engine.load().catch((cause: unknown) => {
      console.warn(`gladiator: audio failed to load: ${String(cause)}`)
    })
    return engine
  } catch (cause) {
    // Every browser this game supports has Web Audio; a context can still be
    // refused — an exhausted context limit, a hardened privacy setting.
    console.warn(`gladiator: no audio context: ${String(cause)}`)
    return null
  }
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
  // Nothing sends snapshots yet, so there is otherwise no opponent to draw.
  // `dummyOpponent.ts` says why this exists and why it stays out of the
  // simulation. Never in shot mode: the reference screenshot is a picture of a
  // world with nothing moving in it.
  const dummy = !shot && dummyMode(window.location.search)

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

  // Audio, and the one gesture that starts it.
  //
  // The context is created now — suspended, which is what a browser gives you
  // before a gesture — and the whole catalogue is fetched and decoded straight
  // away, in the background. Nothing waits for it: a page that cannot load its
  // sounds is a quiet game, not a broken one, so the failure path is a warning
  // and a counter in the snapshot rather than a `hud.fail`.
  //
  // `armGesture` is what makes the first shot audible: it resumes the context on
  // the *same* click that takes pointer lock, rather than on some other gesture
  // a player who clicked straight into the canvas never makes. `audio/gesture.ts`
  // is the whole argument.
  const audio = shot ? null : startAudio()
  const cues = createCueTracker()

  if (!shot) {
    armGesture(canvas, {
      resume: () => audio?.resume(),
      requestLock: () => input.requestLock(),
    })
  }
  window.addEventListener('resize', () => renderer.resize())

  // The credits, rendered from the file `pnpm assets:build` generates. Mounted
  // hidden and fetched on first open, so it costs an empty `<div>` until
  // somebody asks for it — and never in shot mode, where the page is a picture
  // with nothing moving in it on purpose.
  //
  // `C` only while the pointer is unlocked: a menu that can open mid-duel is a
  // duel someone loses to a mistyped key. The real menu is GLAD-NPCTU8's.
  const credits = createCreditsScreen(overlay)
  if (!shot) {
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return
      if (event.code === 'Escape' && credits.isOpen) credits.close()
      else if (event.code === 'KeyC' && !input.locked) credits.toggle()
    })
    if (creditsRequested(window.location.search)) credits.open()
  }

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

  // The world, and the world drawn, are now the same list of brushes.
  //
  // `arena.ts` kept the simulation on its own hard-coded box while the renderer
  // still drew one, and said out loud that moving the sim onto a map nothing
  // drew would trade a cosmetic gap for invisible walls. This ticket is what
  // makes that condition false: the renderer draws `testbed`'s brushes, so the
  // simulation traces against `testbed`'s brushes, and the server does the same
  // from the same artifact. `SKELETON_ARENA` stays as the sim's own default and
  // as the golden replay's world.
  const state = createMapState(CLIENT_MAP.source, SKELETON_SEED)

  // Adopt the yaw the spawn point was authored with.
  //
  // The camera is a puppet of the simulation, but *view angles* are the one
  // piece of float state the client is authoritative over — they go into the
  // `UserCmd` the server lag-compensates against, which is why the input
  // controller owns them (`input/controller.ts`). The kernel writes an
  // entity's angles from whatever command arrives next, so a spawn's facing is
  // an instruction the state carries and the peer with a mouse on it has to
  // obey: without this line the first command a player sends spins them back
  // to due north on the frame after they spawn. Policy is `match/spawn.ts`.
  const spawned = findPlayer(state, LOCAL_SLOT)
  if (spawned !== null) input.angles.yawDegrees = spawned.angles[1] / ANGLE_UNITS_PER_DEGREE

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

  const renderSnapshot = (): RenderSnapshot => {
    const stats = renderer.frameStats()
    return {
      backend: renderer.backend,
      description: renderer.description,
      ready: renderer.ready,
      frames: renderer.frames,
      pixelRatio: renderer.pixelRatio,
      triangles: renderer.triangles,
      drawnPlayers: renderer.drawnPlayers,
      viewmodelWeapon: renderer.viewmodelWeapon,
      meanMs: stats.meanMs,
      medianMs: stats.medianMs,
      p99Ms: stats.p99Ms,
      worstMs: stats.worstMs,
    }
  }

  /**
   * Run an offline render of a decoded sound.
   *
   * The offline context has to be created at the live one's sample rate: a
   * buffer decoded for a 48 kHz device and rendered into a 44.1 kHz context is
   * resampled on the way in, and the measurement becomes partly a measurement
   * of the resampler.
   */
  const offline = <T>(
    render: (
      buffer: AudioBufferLike,
      createContext: (channels: number, length: number, sampleRate: number) => OfflineHost,
    ) => Promise<T>,
  ): Promise<T> => {
    if (audio === null) return Promise.reject(new Error('no audio context'))
    const buffer = audio.buffer(SoundId.RocketFire)
    if (buffer === null) return Promise.reject(new Error('rocket-fire is not loaded'))
    return render(
      buffer,
      (channels, length, sampleRate) => new OfflineAudioContext(channels, length, sampleRate),
    )
  }

  window.__gladiator = {
    snapshot: () => ({
      build: BUILD,
      mapName: CLIENT_MAP.source.name,
      mapHash: CLIENT_MAP_HASH,
      tick: state.tick,
      origin: originOf(state),
      velocity: velocityOf(state),
      onGround: onGroundIn(state),
      clientHash,
      locked: input.locked,
      raw: input.raw,
      render: renderSnapshot(),
      audio: audio?.snapshot() ?? NO_AUDIO,
      net: net.snapshot(),
    }),
    audio: {
      snapshot: () => audio?.snapshot() ?? NO_AUDIO,
      playAll: () => {
        if (audio === null) return 0
        // Both buses, so the check exercises the panner path as well as the
        // direct one — and `allowedOn` refuses the feedback-only sounds on the
        // world bus, which is the rule being checked rather than a special case
        // in the checker.
        let started = 0
        for (const spec of ALL_SOUNDS) {
          if (audio.playFeedback(spec.id) !== null) started += 1
          if (audio.playWorld(spec.id, [256, 0, 50]) !== null) started += 1
        }
        return started
      },
      probe: (capture = false) =>
        offline((buffer, createContext) =>
          renderHrtfProbe({
            buffer,
            sampleRate: audio?.context.sampleRate ?? 0,
            capture,
            createContext,
          }),
        ),
      onset: () =>
        offline((buffer, createContext) =>
          renderOnset({ buffer, sampleRate: audio?.context.sampleRate ?? 0, createContext }),
        ),
      suspend: () => {
        audio?.context.suspend?.()
      },
    },
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
        previous = cloneGameState(state)
        simTick(state, [cmd], CLIENT_MAP.world)
        clientHash = hashState(state)
        net.record(state.tick, clientHash)
        net.queue(state.tick, cmd)
      }
      net.flush()
    }

    const alpha = alphaOf(accumulatorMs)
    // The viewmodel needs the local player's weapon and last shot, and nothing
    // about its position: it hangs off the camera, which is interpolated
    // already. So this is the newest netstate rather than an interpolated one.
    const self = netStateOf(state, LOCAL_SLOT)
    const opponents = dummy ? [dummyAt(state.tick, alpha)] : []

    // The eye, interpolated once and used twice: the camera is put here and so
    // is the listener. Literally the same vector, because ears half a tick from
    // the picture would put every sound at a slightly different angle than the
    // thing making it.
    const eye = interpolateOrigin({ origin: originOf(previous) }, { origin: originOf(state) }, alpha)

    // Both are written from simulation state rather than read back from
    // anything (`audio/positional.ts`), and the netstates the renderer is about
    // to draw are the ones folded into sound cues. Not "the audio system
    // watches the renderer": the two are siblings reading one source, which is
    // what keeps a dropped snapshot from making the picture and the sound
    // disagree about what happened.
    if (audio !== null) {
      audio.listen({ origin: eye, yawUnits: cmd.yaw, pitchUnits: cmd.pitch })
      playCues(audio, cues.observe({ self, others: opponents }))
    }

    renderer.render(
      {
        origin: eye,
        // The view angle is the freshest thing the frame has; interpolating it
        // would add latency to aim. `render/view.ts`.
        yawUnits: cmd.yaw,
        pitchUnits: cmd.pitch,
        tick: state.tick,
        alpha,
        ...(opponents.length > 0 ? { players: opponents } : {}),
        ...(self === null ? {} : { self }),
      },
      elapsedMs,
    )

    hudDueMs -= elapsedMs
    if (hudDueMs > 0) {
      window.requestAnimationFrame(frame)
      return
    }
    hudDueMs = HUD_INTERVAL_MS
    // A percentile costs a sort of the whole window, so it is computed here,
    // ten times a second, rather than once a frame. Measuring frame pacing is
    // not allowed to be the thing that costs a frame.
    const p99Ms = renderer.frameStats().p99Ms

    hud.update({
      build: BUILD,
      mapName: CLIENT_MAP.source.name,
      renderer: `${renderer.description} · ${renderer.pixelRatio}x`,
      frameBudgetMs: FRAME_BUDGET_MS,
      p99Ms,
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

boot().catch((cause: unknown) => {
  const app = document.querySelector<HTMLElement>('#app')
  if (app !== null) createHud(app).fail(`could not start: ${String(cause)}`)
})
