/**
 * The client's entry point.
 *
 * One frame does, in order:
 *
 *   1. read the clock once, and turn elapsed wall-clock into whole ticks
 *   2. for each tick: sample input, predict, hash, queue the command
 *   3. flush the queued commands as one frame to the server
 *   4. draw the local player interpolated, and everyone else 80 ms in the past
 *
 * The order is the point. The simulation never sees a clock; the renderer never
 * decides where anything is; the network never advances the world. Everything
 * this project adds later — lag compensation, a bot — hangs off this shape.
 *
 * Snapshots do not arrive on this path at all. They land on the socket, are
 * adopted by `net/prediction.ts` the moment they do, and the frame loop reads
 * the result — which is why there is no "apply the network" step in the list
 * above, and why a snapshot that lands mid-frame cannot half-apply.
 *
 * The clock is read **once**, here, and the elapsed interval is passed to
 * everything that needs it. A renderer that read `performance.now()` itself
 * would be a second opinion about what a frame is.
 */
import {
  ANGLE_UNITS_PER_DEGREE,
  EntityFlag,
  EntityKind,
  MatchPhase,
  SKELETON_SEED,
  TICK_INTERVAL_MS,
  TICK_RATE,
  createMapState,
  countSimEvents,
  createTrace,
  encodeDemo,
  type EntityState,
  findPlayer,
  type GameState,
  hashState,
  mapGeometry,
  projectilePosition,
  traceRay,
  type Transport,
  type Vec3,
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
import { armGesture, runGesture } from './audio/gesture.ts'
import { type OfflineHost, renderHrtfProbe, renderOnset } from './audio/probe.ts'
import { ALL_SOUNDS, SoundId } from './audio/sounds.ts'
import { createCreditsScreen, creditsRequested } from './credits.ts'
import { dummyMode, dummyOpponent } from './dummyOpponent.ts'
import { createHud } from './hud.ts'
import { createInputController } from './input/controller.ts'
import type { RawInput } from './input/pointerLock.ts'
import { advance, alphaOf } from './loop.ts'
import { shouldSnap, slewMs } from './net/clockSync.ts'
import { CLIENT_MAP, CLIENT_MAP_HASH } from './map.ts'
import { CLIENT_NAV } from './nav.ts'
import {
  NO_SESSION,
  type NetClient,
  createNetClient,
  isFatal,
  joinUrl,
  mustHoldStill,
  quickMatchRequested,
  rejoinUrl,
  resolveServerUrl,
  type RedialContext,
} from './net/client.ts'
import { createEntityBuffer, createInterpolationClock } from './net/interpolate.ts'
import { createBotPeer } from './net/botPeer.ts'
import { type ListenServer, createListenServer } from './net/listenServer.ts'
import { createPredictor } from './net/prediction.ts'
import { CorrectionBand, decayMsFor } from './net/reconcile.ts'
import { createRocketPredictor } from './net/rocketPredict.ts'
import { websocketTransport } from './net/websocketTransport.ts'
import { type PlayerNetState, playerNetState } from './render/animState.ts'
import {
  type FxMemory,
  type FxTraceHit,
  INITIAL_FX,
  type RocketView,
  advanceFx,
} from './render/fx.ts'
import { FRAME_BUDGET_MS, type FrameVerdict } from './render/frameStats.ts'
import { createRenderOffset, withRenderOffset } from './render/renderOffset.ts'
import { type Renderer, createRenderer } from './render/renderer.ts'
import { REFERENCE_VIEW, interpolateNetState, interpolateOrigin } from './render/view.ts'
import { browserCopyEnv } from './ui/clipboard.ts'
import { demoMode, demoModel } from './ui/demo.ts'
import { createDevHud, devMode, type DevHudModel } from './ui/devHud.ts'
import { createFeedbackTracker } from './ui/feedback.ts'
import { createMatchHud } from './ui/hud.ts'
import { type HudModel, hudModel } from './ui/hudModel.ts'
import { type MenuScreen, createMenu } from './ui/menu.ts'
import { createQueuePanel, queueReadout } from './ui/queue.ts'
import { matchIntent, roomUrl, shareLink } from './ui/roomFlow.ts'
import {
  type Settings,
  browserStorage,
  createSettingsStore,
  degreesPerCount,
  verticalFovRadians,
} from './ui/settings.ts'
import { bounceReason, createBouncePage, probeDevice } from './ui/unsupported.ts'

const BUILD = import.meta.env.VITE_BUILD ?? 'dev'

/**
 * How often the **diagnostics** readout is refreshed, in milliseconds.
 *
 * Ten times a second, not once a frame, and the reason is measured rather than
 * assumed: writing the panel's dozen `textContent`s every frame dirties the
 * overlay, and a dirty overlay makes the browser recomposite the whole page on
 * top of the canvas. At 320x200 in headless Chromium that alone took the loop
 * from a flat 16.7 ms to a mean of 18 ms with a 50 ms 99th percentile — a
 * stutter caused entirely by *displaying* the frame rate.
 *
 * Ten hertz also happens to be the fastest a number is worth reading, and
 * everything on that panel — the frame rate, the tick, the hash — changes every
 * single frame, so throttling it is the only way to make it cheap.
 *
 * The in-match HUD does **not** inherit the throttle, only the constraint
 * behind it: it runs at frame rate and writes nothing when nothing changed,
 * which is nearly every frame, because health does not change 60 times a
 * second. `ui/hud.ts` argues that at length.
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
  /** Live particles, beams and marks. `render/fx.ts`. */
  readonly particles: number
  readonly beams: number
  readonly marks: number
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
  /** The raw-input verdict with its uncertainty intact. `input/pointerLock.ts`. */
  readonly rawInput: RawInput
  /** Which menu screen is up, or `hidden`. `ui/menu.ts`. */
  readonly menu: MenuScreen
  /** What this browser has stored. Presentation only — the server never sees it. */
  readonly settings: Settings
  readonly render: RenderSnapshot
  readonly audio: AudioSnapshot
  readonly net: ReturnType<NetClient['snapshot']>
  /**
   * The in-match readout, projected **fresh at the moment of the call** rather
   * than the copy the HUD last drew from.
   *
   * That is the whole point of it: comparing the DOM against a model taken now
   * is how `scripts/e2e.mjs` catches a HUD that is a frame or ten behind the
   * world. Handing back the object the view was written from would compare a
   * value with itself and pass no matter how stale the screen was.
   */
  readonly hud: HudModel
  /**
   * How many times the in-match HUD has been drawn. Beside `render.frames`,
   * this is what says it runs at frame rate rather than on a timer.
   */
  readonly hudFrames: number
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
      /**
       * The frame intervals in the window, for `pnpm latency --samples`.
       *
       * The distribution rather than a summary: input-to-photon latency is a
       * function of the frame-time *tail*, and a percentile cannot be
       * un-summarised. `docs/latency.md` §3.2.
       */
      frameIntervals(): readonly number[]
      resetFrameStats(): void
      /** The last frame, scaled — for the reference-screenshot comparison. */
      capture(width: number, height: number): ImageData
      /** The same frame as a `data:image/png` URL, for re-shooting it. */
      captureDataUrl(width: number, height: number): string
      /**
       * The match this tab has hosted, as demo JSON, or `null`.
       *
       * Only `?local=1&dev=1`: a demo is the command stream the *host*
       * executed, and a client talking to Fly is not the host. This is the
       * bug-report path for single-player — `sim/src/demo.ts` replays whatever
       * comes out of here into the same world, tick for tick.
       */
      demo(): string | null
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

/**
 * The slot this client steers.
 *
 * One player predicted, because prediction needs input this tab knows the
 * future of. A room seats two and the other one is drawn from real data, 80 ms
 * in the past (`net/interpolate.ts`).
 *
 * **Mutable, and the host is what decides it.** Zero is the opening assumption
 * and it is right for single-player and for whoever opened the room; a player
 * who *joined* one is seated in slot 1, learns so from the welcome
 * (`ServerWelcome.slot`, protocol 10) and adopts it here. Before that field
 * existed this was a constant, and the second seat was quietly unplayable: the
 * guest predicted the host's body from its own input, drew its own body as the
 * opponent, and disagreed with the server about every tick it hashed.
 *
 * Nothing is simulated before the welcome lands — `mustHoldStill` holds the
 * world through `connecting` — so the value is settled before the first tick,
 * and {@link adoptSlot} exists for the one case where it is not: a resume into
 * the other seat.
 */
let localSlot = 0

/** `[0, 0, 0]` if the player has somehow gone missing, rather than throwing in a frame. */
const NOWHERE: Vec3 = [0, 0, 0]

function originOf(state: GameState): Vec3 {
  const player = findPlayer(state, localSlot)
  return player === null ? NOWHERE : [player.origin[0], player.origin[1], player.origin[2]]
}

function velocityOf(state: GameState): Vec3 {
  const player = findPlayer(state, localSlot)
  return player === null ? NOWHERE : [player.velocity[0], player.velocity[1], player.velocity[2]]
}

function onGroundIn(state: GameState): boolean {
  const player = findPlayer(state, localSlot)
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
 * Deliberately the same path a real snapshot pair takes: two `EntityState`s a
 * tick apart, through `playerNetState` and `interpolateNetState`. Real
 * snapshots arrive now and `net/interpolate.ts` draws them; this is only
 * reached when the buffer has nobody in it, which is a room whose second seat
 * is still empty — a match nobody has joined yet, or single-player before there
 * is a bot to put in it.
 */
function dummyAt(tick: number, alpha: number): PlayerNetState {
  return interpolateNetState(
    playerNetState(dummyOpponent(tick - 1, DUMMY_CENTRE)),
    playerNetState(dummyOpponent(tick, DUMMY_CENTRE)),
    alpha,
  )
}

/**
 * The rockets in the air, at a fractional tick.
 *
 * A rocket is a *trajectory* in the simulation — `trBase`, `trDelta` and a
 * spawn tick, evaluated in closed form — so there is nothing to interpolate
 * between: the position at `tick + alpha` is the same expression the sim
 * evaluates at a whole tick, asked a fraction later. That is why rockets are
 * smooth at any frame rate for free, and why this reads the trajectory rather
 * than remembering where the rocket was last frame.
 */
function rocketsIn(state: GameState, at: number, into: RocketView[]): readonly RocketView[] {
  into.length = 0
  for (const entity of state.entities) {
    if (entity.kind !== EntityKind.Projectile) continue
    const where = projectilePosition([0, 0, 0], entity, at)
    into.push({ id: entity.id, origin: [where[0], where[1], where[2]] })
  }
  return into
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

  const shot = shotMode(window.location.search)
  // What this URL is asking for: the menu, a room, single-player, or a match
  // opened without a menu in front of it. `ui/roomFlow.ts`.
  const intent = matchIntent(window.location.search)

  // Before the renderer, before the socket, and before anything asks for a
  // pointer lock: a room code is a link sent through a chat app, and a chat app
  // is mostly read on a phone. What that player must not get is the game trying
  // anyway. `ui/unsupported.ts` argues the detection at length.
  const bounce = shot ? null : bounceReason(probeDevice())
  if (bounce !== null) {
    canvas.remove()
    const code = intent.kind === 'join' ? intent.code : null
    createBouncePage(overlay, {
      reason: bounce,
      code,
      // Their own address bar, so the link they are handed is the one they
      // arrived on — including the room, if there is one.
      link: window.location.href,
      copy: browserCopyEnv(),
    })
    return
  }

  const hud = createHud(overlay)
  // The in-match readout, alongside the diagnostics panel rather than instead
  // of it: that panel is the netcode's instrument and the browser test's, and
  // it is now a setting (`ui/settings.ts`) rather than furniture nobody asked
  // for. The two are laid out so as not to collide, which `scripts/e2e.mjs`
  // checks at three aspect ratios.
  const matchHud = createMatchHud(overlay)
  // Where a player waiting for a stranger finds out that they are waiting.
  // Mounted whatever this page is doing and shown only when the host has
  // something to say about a queue, which for a room-code match is never —
  // `ui/queue.ts`.
  const queuePanel = createQueuePanel(overlay)
  const feedback = createFeedbackTracker()
  if (shot) overlay.hidden = true
  // Nothing sends snapshots yet, so there is otherwise no opponent to draw.
  // `dummyOpponent.ts` says why this exists and why it stays out of the
  // simulation. Never in shot mode: the reference screenshot is a picture of a
  // world with nothing moving in it.
  const dummy = !shot && dummyMode(window.location.search)
  // `?hud=demo` — the readout driven from a script instead of from the world,
  // so hit feedback can be *looked at* before there is a match to play. Same
  // reasoning as `dummyOpponent.ts`, and `ui/demo.ts` sets it out.
  const hudDemo = !shot && demoMode(window.location.search)
  // `?dev=1` — the netcode instrument, and the demo recorder that goes with it.
  // Not on a page nobody asked for it on: it is an extra panel, an extra
  // growing array, and it is not part of the layout `scripts/e2e.mjs` measures.
  // `ui/devHud.ts`.
  const dev = !shot && devMode(window.location.search)
  const devHud = dev ? createDevHud(overlay) : null

  let renderer: Renderer
  try {
    renderer = await createRenderer({
      canvas,
      map: CLIENT_MAP.source,
      // Derived from the collision brushes, never authored beside them:
      // `packages/sim/src/map/geometry.ts`.
      geometry: mapGeometry(CLIENT_MAP.source),
      // The map's own bake, written by `pnpm lightmap:bake` and compressed by
      // `pnpm assets:build`. Named after the map rather than configured, so a
      // map that ships without one 404s under its own name instead of quietly
      // borrowing another level's light.
      lightmapUrl: `/textures/${CLIENT_MAP.source.name}_lightmap.ktx2`,
      ...(shot
        ? { adaptQuality: false, pixelRatio: 1, preserveDrawingBuffer: true, forceWebGL: true }
        : {}),
    })
  } catch (cause) {
    // A blank page with a console error is the worst possible outcome of a
    // deploy. Say what happened, on the page.
    //
    // What it says is what happened, and deliberately not why. This used to end
    // "Neither WebGPU nor WebGL2 is available here" — a guess at one cause,
    // printed as a finding, for a failure with many. In GLAD-ZCEQMN it was
    // false in the most expensive way available: WebGPU *was* there, which is
    // precisely why the renderer had fallen over, and the sentence sent the
    // diagnosis looking for a missing context for a while. Babylon's own
    // "WebGL not supported" already arrives in `cause` when that is genuinely
    // the problem.
    hud.fail(`could not start the renderer: ${String(cause)}`)
    return
  }

  // What the player has set, out of this browser's own storage.
  //
  // Read before the input controller and the first frame, because both are
  // written from it: a sensitivity that arrived a frame late would be a flick
  // taken at the default. Nothing in here ever reaches the server —
  // `ui/settings.ts` says why that is a rule rather than an accident.
  const settings = createSettingsStore(browserStorage())

  const input = createInputController(canvas, {
    degreesPerCount: degreesPerCount(settings.value),
  })

  const applySettings = (value: Settings) => {
    input.setDegreesPerCount(degreesPerCount(value))
    renderer.setFov(verticalFovRadians(value.fovDegrees))
    hud.setVisible(value.diagnostics)
  }
  // Never in shot mode. A reference screenshot has to be a picture of the same
  // page on every machine, and a stored field of view is the one setting that
  // would quietly change what is in frame.
  if (!shot) {
    settings.onChange(applySettings)
    applySettings(settings.value)
  }

  // The effects fold, and the one thing it cannot derive: where a shot landed.
  // It is handed the simulation's own hitscan over the map the client is
  // ticking, so a rail beam stops at the wall the shot stopped at rather than
  // at a wall the renderer guessed. `render/fx.ts`.
  let fxMemory: FxMemory = INITIAL_FX
  const fxRockets: RocketView[] = []
  const fxTrace = createTrace()
  const traceForFx = (from: Vec3, to: Vec3): FxTraceHit => {
    traceRay(fxTrace, CLIENT_MAP.world, from, to)
    return {
      point: [fxTrace.endpos[0], fxTrace.endpos[1], fxTrace.endpos[2]],
      normal: [fxTrace.planeNormal[0], fxTrace.planeNormal[1], fxTrace.planeNormal[2]],
      hit: fxTrace.fraction !== 1,
    }
  }

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
  // `C` only while the pointer is unlocked and no menu is up: a screen that can
  // open mid-duel is a duel someone loses to a mistyped key, and a `C` typed
  // into the room-code box is a room code, not a shortcut.
  const credits = createCreditsScreen(overlay)

  const override = protocolOverride(window.location.search)
  const mapOverride = mapHashOverride(window.location.search)

  // The world, and the world drawn, are now the same list of brushes.
  //
  // `arena.ts` kept the simulation on its own hard-coded box while the renderer
  // still drew one, and said out loud that moving the sim onto a map nothing
  // drew would trade a cosmetic gap for invisible walls. The map ticket is what
  // makes that condition false: the renderer draws `testbed`'s brushes, so the
  // simulation traces against `testbed`'s brushes, and the server does the same
  // from the same artifact. `SKELETON_ARENA` stays as the sim's own default and
  // as the golden replay's world.
  //
  // It is created before the socket because prediction owns it and the socket
  // hands prediction its corrections: a snapshot can land on the very first
  // frame, and a world that did not exist yet would be a world that quietly
  // dropped one.
  const state = createMapState(CLIENT_MAP.source, SKELETON_SEED)

  // The three techniques that make an authoritative server feel local, and the
  // one value that keeps the third of them out of the simulation.
  //
  // `prediction.ts` advances `state` from this tab's own input and replays it on
  // top of every snapshot; `interpolate.ts` draws everyone else 80 ms in the
  // past from real data, on a clock of its own; `renderOffset.ts` holds whatever
  // a correction moved and gives it back over a tenth of a second, *outside* the
  // state, because a world left half-corrected is the world the next replay
  // starts from. The 80 ms is bought back by lag compensation on the host, and
  // `rocketPredict.ts` below is the one thing this tab is allowed to predict
  // *about* it (GLAD-5QGO11).
  let opponentHistory = createEntityBuffer({ localSlot })
  const opponentClock = createInterpolationClock()

  /**
   * Everywhere an opponent might be, as far as this tab can tell.
   *
   * Both ends of the uncertainty the self-splash predicate guards: where the
   * newest authoritative state has them, and where they are being *drawn*, 80 ms
   * further back. Refilled once a frame from the sample the renderer is about to
   * use, so the predicate — which is asked per rocket per sub-step — is reading
   * an array rather than re-running an interpolation. One frame of staleness on
   * a deliberately conservative test is nothing.
   */
  const opponentOrigins: [number, number, number][] = []
  const readOpponents = (drawn: readonly EntityState[]): void => {
    opponentOrigins.length = 0
    for (const entity of state.entities) {
      if (entity.kind !== EntityKind.Player) continue
      if (entity.slot === localSlot) continue
      opponentOrigins.push([entity.origin[0], entity.origin[1], entity.origin[2]])
    }
    for (const entity of drawn) {
      if (entity.kind !== EntityKind.Player) continue
      opponentOrigins.push([entity.origin[0], entity.origin[1], entity.origin[2]])
    }
  }

  // Which of our own rockets we are willing to be thrown by before the host has
  // confirmed it. `net/rocketPredict.ts` argues the predicate; the client's
  // whole share of `TickHooks` is this one answer.
  let selfSplash = createRocketPredictor({
    slot: localSlot,
    opponents: () => opponentOrigins,
    log: (line) => {
      console.warn(line)
    },
  })

  let predictor = createPredictor({
    state,
    world: CLIENT_MAP.world,
    slot: localSlot,
    hooks: { selfSplash },
  })

  /**
   * Take the seat the host put us in.
   *
   * Three objects are built *around* a slot rather than parameterised by one —
   * prediction advances that body from local input, the entity buffer decides
   * who is drawn 80 ms in the past instead, and the self-splash predicate
   * decides whose rockets are ours — so adopting a new slot means building them
   * again. That is cheap and it happens at most once a session: the welcome
   * arrives while `mustHoldStill` is still holding the world, so nothing has
   * been predicted yet and there is no history to lose.
   *
   * Returns whether anything changed, because the caller has one more thing to
   * do when it did.
   */
  const adoptSlot = (seat: number): boolean => {
    if (seat === localSlot) return false
    localSlot = seat
    opponentHistory = createEntityBuffer({ localSlot })
    selfSplash = createRocketPredictor({
      slot: localSlot,
      opponents: () => opponentOrigins,
      log: (line) => {
        console.warn(line)
      },
    })
    predictor = createPredictor({
      state,
      world: CLIENT_MAP.world,
      slot: localSlot,
      hooks: { selfSplash },
    })
    // The spawn's authored facing, for the body we have just found out is ours.
    // Same instruction as at boot, and for the same reason: without it the first
    // command this player sends spins them off their spawn's yaw.
    const body = findPlayer(state, localSlot)
    if (body !== null) input.angles.yawDegrees = body.angles[1] / ANGLE_UNITS_PER_DEGREE
    return true
  }

  const renderOffset = createRenderOffset()
  /** Set by a hard snap; the frame loop throws the queued ticks away and clears it. */
  let snapped = false

  // Which pipe, and nothing else. Everything below this line cannot tell a
  // socket to Fly from a `Room` running in this tab — which is the claim the
  // listen-server pattern makes, and the reason there is no offline branch
  // anywhere in the frame loop.
  //
  // Shot mode gets neither: a reference screenshot is a picture of a page with
  // nothing happening on it, and a page that opened a socket would be one where
  // something was.
  const serverUrl = resolveServerUrl(import.meta.env.VITE_SERVER_URL, window.location)

  /**
   * A match: the pipe to a host, and the host itself when it is in this tab.
   *
   * `null` until the player picks something, which is the state a page now
   * opens in. That is the whole shape change this ticket made here — the socket
   * used to be opened at boot from whatever was in the query string, and a menu
   * is exactly the thing that cannot work that way.
   */
  type Session = {
    readonly net: NetClient
    /** The host in this tab, for single-player. `null` over a socket. */
    readonly listen: ListenServer | null
    /** Whether the room code this session ends up in is one a friend can join. */
    readonly shareable: boolean
  }
  let session: Session | null = null

  /**
   * @param redial How to get a *new* pipe to the same seat, or `null` when there
   * is no wire to break. A listen server deliberately passes `null`: the host is
   * an object in this tab, so a closed loopback means the tab is going away and
   * there is nothing on the other side to reconnect to.
   */
  const openSession = (
    transport: Transport | null,
    endpoint: string,
    redial: ((context: RedialContext) => Transport | null) | null = null,
  ): NetClient =>
    createNetClient({
      transport,
      endpoint,
      build: BUILD,
      mapHash: CLIENT_MAP_HASH,
      onSnapshot: (snapshot) => {
        // The history first. `accept` overwrites the world with this state and
        // then replays our unacknowledged commands on top of it, so the
        // authoritative entities the interpolator wants are gone by the time it
        // returns.
        opponentHistory.push(snapshot.state)

        const correction = predictor.accept(snapshot)
        if (correction === null) return

        if (correction.band === CorrectionBand.Snap) {
          // Past a splash radius there is nothing honest left to smooth: the
          // player is somewhere else, and carrying 200 units of offset would
          // draw them somewhere they demonstrably are not.
          renderOffset.clear()
          snapped = true
          console.warn(
            `gladiator: hard snap of ${correction.distance.toFixed(0)} qu at tick ${correction.tick}`,
          )
          return
        }

        renderOffset.push(correction.offset, decayMsFor(correction.band))
        if (correction.band === CorrectionBand.Loud) {
          // Logged rather than silently smoothed. Thirty units is past what a
          // couple of unpredicted ticks can account for, so it is worth knowing
          // that it happened even though the player will not see it.
          console.warn(
            `gladiator: correction of ${correction.distance.toFixed(1)} qu at tick ${correction.tick}`,
          )
        }
      },
      ...(redial === null ? {} : { redial }),
      // A reconnect lands in a match that carried on without this tab: the body
      // was standing still, rockets were fired at it, rounds may have been
      // decided. So everything this client believed on its own is dropped — the
      // unacknowledged commands, the correction it was smoothing, and the
      // opponent's history it was drawing from — and the next snapshot is taken
      // whole. Replaying input across a gap that long draws a journey nobody made.
      onResume: () => {
        const thrown = predictor.discard()
        renderOffset.clear()
        opponentHistory.clear()
        opponentClock.reset()
        snapped = true
        console.warn(`gladiator: reconnected, dropped ${thrown} unacknowledged commands`)
      },
      ...(override === undefined ? {} : { protocolOverride: override }),
      ...(mapOverride === undefined ? {} : { mapHashOverride: mapOverride }),
    })

  /**
   * Single-player: the authoritative host, in this tab.
   *
   * The same code path a duel on Fly takes — same handshake, same map hash
   * check, same framing, same hash echo — over a loopback instead of a socket.
   * The bot is dueled through it: it takes the room's second seat as a peer in
   * its own right (`net/botPeer.ts`), so "play the bot" and "play a stranger"
   * differ in who is holding the other end and in nothing else.
   * `net/listenServer.ts`; `?local=1` boots straight into it.
   */
  const startBotMatch = (): void => {
    if (session !== null || shot) return
    // `record: dev` is `?dev=1`: the host in this tab keeps the command stream
    // so that `window.__gladiator.demo()` has something to hand back. Off
    // otherwise — a recorder nobody asked for is a cost every player pays.
    const listen = createListenServer({
      map: CLIENT_MAP,
      build: BUILD,
      record: dev,
      opponent: (room) =>
        createBotPeer({ room, map: CLIENT_MAP, nav: CLIENT_NAV, build: BUILD }),
    })
    session = {
      listen,
      // No redial: a closed loopback means the tab is going away, and there is
      // nothing on the other side of it to reconnect to.
      net: openSession(listen.transport, 'the host in this tab'),
      // A tab's room has no registry behind it and no socket in front of it, so
      // its code names nothing anybody else can reach.
      shareable: false,
    }
    session.net.connect()
  }

  /**
   * A match on the host: `code` joins that room, `null` asks for a new one, and
   * `queue` asks to be put in line with whoever else is waiting.
   *
   * All three are one function because they are one thing over the wire — the
   * only difference is a query parameter — and because "create", "join" and
   * "find me an opponent" are the same button as far as everything downstream
   * is concerned. A code beats the queue, in `joinUrl` rather than here.
   */
  const startRemoteMatch = (code: string | null, queue = false): void => {
    if (session !== null || shot) return
    if (serverUrl === null) {
      // Built with no host to talk to. `createNetClient` says so on the page
      // rather than failing to dial something that was never configured.
      session = { listen: null, net: openSession(null, 'nowhere'), shareable: false }
      session.net.connect()
      return
    }
    const url = joinUrl(serverUrl, code, queue)
    // The same URL with the seat's token on it, which is what turns a redial
    // into a *reconnect* rather than a stranger arriving at a full room
    // (GLAD-DVDV6P). Built from the URL this session actually dialled — which is
    // what carries the code, or the queue, through a socket that died before the
    // welcome ever arrived. `rejoinUrl` argues both halves.
    const redial = (context: RedialContext): Transport | null =>
      websocketTransport(rejoinUrl(url, context))
    session = {
      listen: null,
      net: openSession(websocketTransport(url), url, redial),
      shareable: true,
    }
    session.net.connect()
  }

  /**
   * Whether there is a menu on this page at all.
   *
   * The two URLs that are pictures rather than games do not get one: `?shot=1`
   * is a reference screenshot of a world with nothing happening in it, and
   * `?hud=demo` is the in-match readout being *looked at* — a menu over either
   * would be a menu in the photograph.
   */
  const menuAllowed = !shot && !hudDemo

  // The two things a browser will only do inside a user gesture, together. Held
  // as one value because they have to be one click: `audio/gesture.ts`.
  const gesture = {
    resume: () => audio?.resume(),
    requestLock: () => input.requestLock(),
  }

  const menu = createMenu(overlay, {
    settings,
    copy: browserCopyEnv(),
    // Built from this page's own address, so a link handed out on a preview
    // deploy points at the preview and one handed out on the real origin points
    // at the real origin. `ui/roomFlow.ts` throws the query string away first.
    shareLink: (code) => shareLink(window.location.href, code),
    openCredits: () => credits.open(),
    startBot: () => {
      startBotMatch()
      // The click that chose single-player is a perfectly good gesture, and
      // making the player produce a second one to get into a game they already
      // asked for is the friction this ticket is about.
      runGesture(gesture)
    },
    createRoom: () => {
      startRemoteMatch(null)
      menu.setRoom(null)
      menu.setStatus('opening a room…')
      menu.show('room')
    },
    joinRoom: (code) => {
      startRemoteMatch(code)
      menu.setRoom(code)
      menu.setTypedCode(code)
      menu.setStatus('joining…')
      menu.show('room')
    },
    enterArena: () => runGesture(gesture),
    back: () => menu.show(session === null ? 'main' : 'paused'),
    // A reload rather than a teardown: it drops the socket, the room in the
    // address bar and every scrap of match state in one move, and lands on
    // exactly the page a stranger gets.
    leave: () => {
      window.location.href = window.location.pathname
    },
  })

  // The pointer lock is what says whether the player is *in* the match, so it is
  // what opens and closes the pause screen. Escape is the browser's, not ours:
  // it drops the lock, this notices, and the menu comes up over a match that is
  // still running. Nothing is torn down, which is why resuming is one click.
  input.onLockChange((locked) => {
    if (locked) {
      menu.setLockDenied(null)
      menu.show('hidden')
    } else if (menuAllowed && session !== null) {
      menu.show('paused')
    }
  })
  // Every browser refuses to re-lock for a moment after the player released the
  // lock themselves. The cure is another gesture and never a timer, so this
  // says so on screen and waits to be clicked again. `input/pointerLock.ts`.
  input.onLockDenied((reason) => {
    if (input.locked) return
    menu.setLockDenied(reason)
    if (menuAllowed && session !== null) menu.show('paused')
  })

  if (!shot) {
    window.addEventListener('keydown', (event) => {
      if (event.repeat) return
      if (event.code === 'Escape') {
        if (credits.isOpen) credits.close()
        // Inside the menu, escape steps back. It never *opens* the pause
        // screen: the browser does that by taking the lock away, and a second
        // path to the same state is a state machine with two owners.
        else if (menu.screen === 'settings' || menu.screen === 'join' || menu.screen === 'room') {
          menu.show(session === null ? 'main' : 'paused')
        }
        return
      }
      if (event.code === 'KeyC' && !input.locked && !menu.isOpen) credits.toggle()
    })
    if (creditsRequested(window.location.search)) credits.open()
  }

  // What the URL asked for, acted on. Every branch here is reachable from the
  // menu as well — the URL is a shortcut into the same three calls, never a
  // second way of doing them.
  if (menuAllowed) {
    menu.setRawInput(input.rawInput)
    if (intent.kind === 'bot') startBotMatch()
    else if (intent.kind === 'create') startRemoteMatch(null)
    else if (intent.kind === 'join') {
      // The whole point of the room-code flow: a player who was sent a link
      // lands here already connecting, with the code in the box, and the only
      // thing left is the click the browser demands before it will lock a
      // pointer. Nothing is typed twice.
      startRemoteMatch(intent.code)
      menu.setRoom(intent.code)
      menu.setTypedCode(intent.code)
      menu.setStatus('joining…')
      menu.show('room')
    } else if (intent.kind === 'join-typo') {
      // Something arrived in `?room=` that is not a code — a chat client ate a
      // character, or it was read out over a bad line. The join box, open, with
      // their attempt still in it.
      menu.setTypedCode(intent.typed)
      menu.show('join')
    } else if (quickMatchRequested(window.location.search)) {
      // `?queue=1` (GLAD-ZHRFBK), and it skips the menu the way its three
      // siblings do — deliberately showing no screen at all, because the wait
      // is already drawn by `queuePanel` below and a menu over it would hide
      // the one thing this URL exists to show. When the wait times out the host
      // hands back a room code, which reaches the address bar and the room
      // screen by the same path every other code does.
      //
      // Reached only from the `menu` intent, so a page carrying both a code and
      // `?queue=1` joins the code. That is the same precedence `joinUrl`
      // applies on the wire, and the same one the host reads them in.
      startRemoteMatch(null, true)
    } else {
      menu.show('main')
    }
  } else if (!shot) {
    // No menu on this page, so the URL is the only thing that can start a
    // match, and `?hud=demo` deliberately starts none.
    if (intent.kind === 'bot') startBotMatch()
  }

  /** The room already written into the address bar, so it is written once. */
  let addressedRoom: string | null = intent.kind === 'join' ? intent.code : null
  /** Whether a real opponent has been in a snapshot, for the room's status. */
  let opponentSeen = false

  /** What the room screen says under the code. */
  const roomStatus = (net: ReturnType<NetClient['snapshot']>): string => {
    if (net.status === 'connecting' || net.status === 'idle') return 'connecting to the host…'
    if (net.status !== 'live') return net.message
    if (opponentSeen) return 'your opponent is here — good luck'
    return 'waiting for your friend. Send them the link; they land straight in this match.'
  }

  /**
   * The menu, told what the session is doing. Ten times a second, with the
   * diagnostics panel, because none of it changes faster than that.
   */
  const syncMenu = (): void => {
    if (!menuAllowed) return
    menu.setRawInput(input.rawInput)
    if (session === null) return
    const net = session.net.snapshot()
    if (session.shareable && net.room !== null && net.room !== addressedRoom) {
      // The host minted a code and this is the first we have heard of it. Into
      // the address bar it goes, so that a reload rejoins this match rather
      // than opening a second empty one — and so that the browser's own share
      // button hands out something that works.
      addressedRoom = net.room
      menu.setRoom(net.room)
      window.history.replaceState(null, '', roomUrl(net.room, window.location.search))
    }
    menu.setStatus(roomStatus(net))
  }

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
  const spawned = findPlayer(state, localSlot)
  if (spawned !== null) input.angles.yawDegrees = spawned.angles[1] / ANGLE_UNITS_PER_DEGREE

  // Where the eye was one tick ago lives in the predictor, which keeps one
  // vector rather than a cloned world — and, crucially, *moves* it when a
  // correction lands, so the frame's interpolation carries the motion it would
  // have carried anyway and the whole discontinuity is the render offset's.
  let clientHash = hashState(state)
  let accumulatorMs = 0
  /**
   * The tick label the next command goes out under.
   *
   * Free-running and slewed, and deliberately *not* `state.tick`: a snapshot
   * overwrites the predicted world's tick sixty times a second, so a counter
   * that lived there could not also be the thing the lead is steered on. See
   * the frame loop.
   */
  let commandTick = 0
  let lastFrameMs = performance.now()

  // The two things the simulation notices and cannot report, tallied in one
  // place (`sim/src/counters.ts`). Both should stay at zero for a whole
  // session: the §2.6 speed rail firing means something upstream handed the
  // movement a velocity movement cannot produce, and a self-splash reaching the
  // ledger below is how the client finds out its prediction *predicate* was
  // wrong rather than merely a fraction of a unit out.
  const counters = countSimEvents({
    onSpeedClamp: (speed) => {
      console.warn(`gladiator: clamped a velocity of ${speed.toFixed(0)} qu/s`)
    },
    onSelfSplash: (splash) => predictor.mispredicts.splash(splash),
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
      particles: renderer.effects.particles,
      beams: renderer.effects.beams,
      marks: renderer.effects.marks,
      meanMs: stats.meanMs,
      medianMs: stats.medianMs,
      p99Ms: stats.p99Ms,
      worstMs: stats.worstMs,
    }
  }

  /**
   * The netcode instrument's readings, gathered from things already computed.
   *
   * Every field is a counter somebody else was keeping or a number the frame
   * loop already had. Nothing in here measures anything, and in particular
   * nothing in here asks the GPU a question — `ui/devHud.ts` sets out why that
   * is the constraint rather than a preference.
   */
  const devHudModel = (
    netNow: ReturnType<NetClient['snapshot']>,
    p99Ms: number,
  ): DevHudModel => ({
    tick: state.tick,
    commandTick,
    rttMs: netNow.rttMs,
    pending: predictor.pending,
    errorUnits: predictor.stats.lastUnits,
    worstErrorUnits: predictor.stats.worstUnits,
    snapshots: netNow.snapshots,
    snapshotBytesPerSecond: netNow.snapshotBytesPerSecond,
    fps,
    p99Ms,
    frameBudgetMs: FRAME_BUDGET_MS,
    speedClamps: counters.speedClamps,
    worstClampedSpeed: counters.worstClampedSpeed,
    selfSplashMispredicts: predictor.mispredicts.stats.selfSplash,
    selfSplashes: predictor.mispredicts.stats.predictedSplashes,
    snaps: predictor.stats.snaps,
    recordedFrames: session?.listen?.recordedFrames ?? null,
  })

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
      rawInput: input.rawInput,
      menu: menu.screen,
      settings: settings.value,
      render: renderSnapshot(),
      audio: audio?.snapshot() ?? NO_AUDIO,
      net: session?.net.snapshot() ?? NO_SESSION,
      hud: hudModel(state, localSlot),
      hudFrames: matchHud.frames,
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
    frameIntervals: () => renderer.frameIntervals(),
    resetFrameStats: () => renderer.resetFrameStats(),
    capture: (width: number, height: number) => {
      const shotCanvas = renderer.capture(width, height)
      const context = shotCanvas.getContext('2d')
      if (context === null) throw new Error('no 2d context to read back')
      return context.getImageData(0, 0, width, height)
    },
    captureDataUrl: (width: number, height: number) =>
      renderer.capture(width, height).toDataURL('image/png'),
    demo: () => {
      const recording = session?.listen?.demo() ?? null
      return recording === null ? null : encodeDemo(recording)
    },
  }

  // A rolling estimate, so the HUD reads a rate rather than one frame's noise.
  let fps = 0
  let hudDueMs = 0

  // The demo's own clock. It needs one because the page it is reviewed on has
  // no server to agree with, so `mustHoldStill` keeps `state.tick` at zero and
  // a script keyed off that would never start. Real elapsed time in sub-steps,
  // which is what the script is written in.
  let demoTicks = 0

  const frame = (nowMs: number) => {
    const elapsedMs = nowMs - lastFrameMs
    lastFrameMs = nowMs
    fps = elapsedMs > 0 ? fps * 0.9 + (1000 / elapsedMs) * 0.1 : fps

    if (shot) {
      renderer.render(REFERENCE_VIEW, elapsedMs)
      window.requestAnimationFrame(frame)
      return
    }

    // A host in this tab has no timer of its own — no `Room` anywhere does —
    // so the animation frame is its beat: it folds the wall-clock since the
    // last frame into whole 8 ms sub-steps, runs them, and does the
    // housekeeping the clock-sync conversation rides on. On Fly the same two
    // calls are made by `scheduler.ts`; here they are made by the display.
    session?.listen?.beat(nowMs)

    // Input is sampled once per frame, not once per tick: a browser only
    // delivers mouse and key events between frames, so a per-tick sample would
    // be the same value read several times with extra steps.
    const cmd = input.sample()
    // `idle` before a match has been picked, which is also what
    // `mustHoldStill` wants to hear: a page sitting on the menu has no host to
    // agree with, so its world does not advance. See `NO_SESSION`.
    const net = session?.net ?? null
    // Whether a dropped connection's backoff has run out. Outside the branch
    // below on purpose: while a reconnect is pending the world is held still, so
    // nothing in there runs — including the flush that would otherwise have been
    // the natural place for this (`net/client.ts`). A page with no session yet
    // has no backoff to run out, which is the same reason it has no world.
    net?.poll()
    const netState = net?.snapshot() ?? NO_SESSION
    const status = netState.status

    // Which body is ours. Read every frame and acted on when it changes, which
    // in practice is the one frame after the welcome lands — and always before
    // the branch below, so no tick is ever simulated against the wrong slot.
    if (netState.slot !== null) adoptSlot(netState.slot)

    if (net === null || mustHoldStill(status)) {
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
      if (snapped) {
        // A hard snap landed since the last frame. The ticks the accumulator
        // had queued behind it were queued against a world that turned out to
        // be wrong, so they are thrown away rather than simulated forward from
        // a position nobody was ever in. `net/reconcile.ts`.
        accumulatorMs = 0
        snapped = false
      }
      // The lead. The host drains one command per player per sub-step on its
      // own clock (`@gladiator/server/inputQueue.ts`), so a client running in
      // phase with it has every command arrive one one-way trip after the
      // sub-step that wanted it — and the host spends the match on the
      // missing-command fallback. Running the *command* clock a few percent
      // fast closes that, and `net/clockSync.ts` argues why it is a rate change
      // rather than a jump.
      //
      // What is steered is `commandTick` and not `state.tick`. The predicted
      // world's tick is the *server's* — a snapshot overwrites it sixty times a
      // second, which is what makes the hash echo comparable — so steering on
      // it would be steering on a number the host keeps resetting, and the two
      // controllers would fight until every command went out under a label the
      // host had already executed.
      const errorTicks = net.clock.errorTicks(commandTick, nowMs)
      if (shouldSnap(errorTicks)) {
        // Past a quarter of a second of error there is no smooth path: a tab
        // that was in the background, or a session that reconnected. Jumping a
        // *label* costs nothing — the host admits any increasing tick — where
        // jumping a simulated clock would be a lurch the player sees.
        commandTick = net.clock.targetTick(nowMs) ?? commandTick
      }
      const step = advance(accumulatorMs, elapsedMs + slewMs(errorTicks, elapsedMs))
      accumulatorMs = step.accumulatorMs
      for (let i = 0; i < step.ticks; i += 1) {
        commandTick += 1
        clientHash = predictor.predict(cmd, commandTick)
        net.record(state.tick, clientHash)
        net.queue(commandTick, cmd)
      }
      net.flush()
    }

    // Two clocks that are not the simulation's, advanced once a frame: the one
    // that gives a correction back to the camera, and the one that decides how
    // far in the past everyone else is drawn.
    renderOffset.advance(elapsedMs)
    opponentClock.advance(elapsedMs, opponentHistory.newestTick)

    const alpha = alphaOf(accumulatorMs)
    // The viewmodel needs the local player's weapon and last shot, and nothing
    // about its position: it hangs off the camera, which is interpolated
    // already. So this is the newest netstate rather than an interpolated one.
    const self = netStateOf(state, localSlot)

    // Everyone else, from real data, on the interpolation clock — never
    // predicted, because this client has no knowledge of their future input.
    //
    // Players only: the buffer holds every entity that is not ours, a rocket we
    // fired included, and a rocket in flight is not a reason to stop drawing
    // the scripted stand-in. That stand-in is reached when nobody else is in
    // the snapshots at all, which is a page with no opponent on the other end
    // of it.
    const drawn = opponentHistory.sample(opponentClock.renderTick).entities

    // The self-splash predicate reads this on the *next* frame's ticks. Filled
    // from the sample the picture is about to be drawn from, so "where they are
    // drawn" means literally that rather than a second interpolation that could
    // disagree with the first.
    readOpponents(drawn)

    const drawnPlayers = drawn.flatMap((entity) =>
      entity.kind === EntityKind.Player ? [playerNetState(entity)] : [],
    )
    const opponents: PlayerNetState[] =
      drawnPlayers.length > 0 ? drawnPlayers : dummy ? [dummyAt(state.tick, alpha)] : []
    // Sticky, because the room screen's line is about whether anybody ever
    // turned up rather than about whether they are in this frame's snapshot: a
    // dropped packet is not your friend leaving.
    if (drawnPlayers.length > 0) opponentSeen = true

    // The eye, interpolated once and used twice: the camera is put here and so
    // is the listener. Literally the same vector, because ears half a tick from
    // the picture would put every sound at a slightly different angle than the
    // thing making it.
    //
    // The render offset is added *after* the interpolation and never anywhere
    // else. It is what a correction owes the camera, and it is deliberately not
    // in the simulation: see `render/renderOffset.ts`.
    const eye = withRenderOffset(
      interpolateOrigin(
        { origin: predictor.previousOrigin },
        { origin: originOf(state) },
        alpha,
      ),
      renderOffset.value,
    )

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

    // The effects, folded from the same netstates the renderer is about to draw
    // and the same rockets. A sibling of `playCues` above rather than something
    // downstream of it: both read one source, which is what keeps a dropped
    // snapshot from making the picture and the sound disagree about what
    // happened.
    const rockets = rocketsIn(state, state.tick + alpha, fxRockets)
    const fold = advanceFx(fxMemory, {
      self,
      others: opponents,
      rockets,
      trace: traceForFx,
    })
    fxMemory = fold.memory

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
        ...(rockets.length > 0 ? { rockets } : {}),
        ...(fold.events.length > 0 ? { fx: fold.events } : {}),
      },
      elapsedMs,
    )

    // The in-match readout, every frame and outside the throttle below.
    //
    // Two things have to be true for a HUD to be worth reading in a duel: it
    // says what the world says *now*, and hit confirmation lands on the frame
    // the state does. Both are the same requirement — draw from a model
    // projected this frame — and the cost of it is paid in `ui/hud.ts`, which
    // compares before it writes and so touches nothing on a frame where
    // nothing happened.
    demoTicks += elapsedMs / TICK_INTERVAL_MS
    const readout = hudDemo
      ? demoModel(Math.floor(demoTicks), localSlot, cmd.yaw)
      : hudModel(state, localSlot)
    matchHud.update(readout, feedback.observe(readout))
    // Off the screen entirely when the session is unrecoverable — the panel is
    // already saying "reload", and a round score in front of it is furniture —
    // and before there is a match at all, where a full health bar over the main
    // menu would be a readout of nothing. The demo is the exception, because
    // being looked at with no match on is the whole point of it.
    matchHud.setVisible(!isFatal(status) && (session !== null || hudDemo))

    hudDueMs -= elapsedMs
    if (hudDueMs > 0) {
      window.requestAnimationFrame(frame)
      return
    }
    hudDueMs = HUD_INTERVAL_MS
    // The menu's own reading of the session: the room code, whether the friend
    // arrived, and what the browser did with the pointer lock. Ten times a
    // second, with everything else that changes slowly.
    syncMenu()
    // A percentile costs a sort of the whole window, so it is computed here,
    // ten times a second, rather than once a frame. Measuring frame pacing is
    // not allowed to be the thing that costs a frame.
    const p99Ms = renderer.frameStats().p99Ms

    const netNow = net?.snapshot() ?? NO_SESSION
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
      // "Click to play" is for a page with nothing in front of it. The menu
      // has a button that says the same thing with a room code above it.
      prompt: !input.locked && !menu.isOpen,
      net: netNow,
      corrected: predictor.stats.soft + predictor.stats.loud + predictor.stats.snaps,
      pending: predictor.pending,
      // The two halves, from the two things that can each only know one of
      // them: the predicate says how often it declined to predict a launch, and
      // the ledger says how often a launch it *did* predict turned out to be
      // one the host disagreed with.
      selfSplash: {
        deferred: selfSplash.stats.suppressed,
        mispredicted: predictor.mispredicts.stats.selfSplash,
      },
      // Whether the hash echo is still a verdict. It stops being one the moment
      // there is a body this client is deliberately not predicting — see
      // `hud.ts`, `HudModel.duelling`.
      duelling: findPlayer(state, localSlot === 0 ? 1 : 0) !== null,
    })

    // The quick-match panel, on the same beat: a wait is quoted in whole
    // seconds, so ten reads of it a second is nine more than it can show.
    // It comes off the screen the moment there is a match to play — which is
    // not the same event as being matched, because a player whose wait timed
    // out can still be joined by a friend with the code minutes later.
    queuePanel.update(
      queueReadout(netNow.queue, readout.match.phase !== MatchPhase.Warmup),
    )

    // On the same 10 Hz beat as the panel above and for the same measured
    // reason: every value on it changes every frame, so throttling the *write*
    // is the only way to make displaying it cheap. Nothing in `devHudModel`
    // asks the GPU anything — `ui/devHud.ts` argues why that is a rule.
    devHud?.update(devHudModel(netNow, p99Ms))

    window.requestAnimationFrame(frame)
  }

  window.requestAnimationFrame(frame)
}

boot().catch((cause: unknown) => {
  const app = document.querySelector<HTMLElement>('#app')
  if (app !== null) createHud(app).fail(`could not start: ${String(cause)}`)
})
