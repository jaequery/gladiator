/**
 * The audio engine: one `AudioContext`, every sound decoded before the match,
 * and two buses out of it.
 *
 * ## Why this is ours and not Howler's
 *
 * Howler.js is the obvious import and it is the wrong one here. Its architecture
 * is organised around an HTML5 `<audio>` fallback path — the thing you want for
 * background music that must survive a decade of browser quirks, and precisely
 * the thing you do not want for a shooter, where every millisecond between the
 * click and the sound is a millisecond of felt input lag. It also owns the
 * `AudioContext`, which means it decides the `latencyHint` and the sample rate,
 * and those two decisions are most of what makes game audio feel immediate.
 *
 * So the context is ours:
 *
 *   - **`latencyHint: 'interactive'`** asks the browser for the smallest buffer
 *     it is willing to give. On a typical desktop that is a `baseLatency` around
 *     2–5 ms instead of the ~20 ms 'playback' would hand out.
 *   - **No `sampleRate` option.** Passing one makes the browser resample every
 *     buffer the context renders into the device's rate, in the audio thread,
 *     forever. The device's own rate costs nothing. The files are 22 050 Hz and
 *     are resampled *once*, at decode, which is the trade this whole file is
 *     arranged around.
 *
 * ## Everything is decoded before the match, and nothing after it
 *
 * `decodeAudioData` is asynchronous, allocates, and on a large file can take
 * tens of milliseconds. Doing it when a rocket is fired is a hitch at the exact
 * moment the player is paying most attention — and the sound arrives late
 * anyway. {@link AudioEngine.load} fetches and decodes the whole catalogue up
 * front; {@link AudioEngine.playFeedback} and {@link AudioEngine.playWorld} do a
 * `Map` lookup and nothing else. There is deliberately no lazy path: a sound
 * that has not been decoded does not play, and says so in the snapshot, rather
 * than quietly teaching the engine to decode mid-match.
 *
 * {@link AudioSnapshot.decodesAfterLoad} makes that a *measurement* rather than
 * a claim — `scripts/audio-check.mjs` reads it after playing every sound in a
 * real browser, and the unit tests read it off a fake context.
 *
 * ## Scheduling is against `currentTime`, never `setTimeout`
 *
 * `AudioContext.currentTime` is the audio clock. A timer is the main thread's
 * clock, which is the one that stutters when a garbage collection lands, and
 * routing sound through it converts a frame hitch into an audible one. Every
 * voice here starts at `context.currentTime` (or at a caller-supplied time on
 * the same clock), so "as soon as possible" means the next audio quantum rather
 * than the next time the browser gets around to us.
 */

import type { Vec3 } from '@gladiator/sim'

import { createFeedbackBus, type FeedbackBus } from './feedback.ts'
import {
  applyListenerPose,
  createWorldBus,
  type ListenerPose,
  type WorldBus,
} from './positional.ts'
import { ALL_SOUNDS, Bus, SOUNDS, type SoundId, allowedOn, soundUrl } from './sounds.ts'

/* --------------------------------------------------------------------------
 * The slice of Web Audio this engine uses
 *
 * Structural, and minimal on purpose. A real `AudioContext` satisfies it
 * because it has everything below and more; a test satisfies it with sixty
 * lines of fake, and that fake is then *exact* rather than a cast — a mistyped
 * node is a type error rather than a green test.
 * ----------------------------------------------------------------------- */

/** An `AudioParam`, as far as anything here is concerned. */
export type AudioParamLike = { value: number }

/** Anything that can be connected into the graph. */
export type AudioNodeLike = {
  connect(destination: AudioNodeLike): unknown
  disconnect(): void
}

export type GainLike = AudioNodeLike & { readonly gain: AudioParamLike }

export type AudioBufferLike = {
  readonly duration: number
  readonly sampleRate: number
  readonly numberOfChannels: number
}

export type BufferSourceLike = AudioNodeLike & {
  buffer: AudioBufferLike | null
  readonly playbackRate: AudioParamLike
  start(when?: number): void
  stop(when?: number): void
  addEventListener(type: string, listener: () => void): void
}

export type PannerLike = AudioNodeLike & {
  panningModel: string
  distanceModel: string
  refDistance: number
  maxDistance: number
  rolloffFactor: number
  readonly positionX?: AudioParamLike
  readonly positionY?: AudioParamLike
  readonly positionZ?: AudioParamLike
  setPosition?(x: number, y: number, z: number): void
}

export type ListenerLike = {
  readonly positionX?: AudioParamLike
  readonly positionY?: AudioParamLike
  readonly positionZ?: AudioParamLike
  readonly forwardX?: AudioParamLike
  readonly forwardY?: AudioParamLike
  readonly forwardZ?: AudioParamLike
  readonly upX?: AudioParamLike
  readonly upY?: AudioParamLike
  readonly upZ?: AudioParamLike
  setPosition?(x: number, y: number, z: number): void
  setOrientation?(x: number, y: number, z: number, upX: number, upY: number, upZ: number): void
}

/** The context itself. `AudioContext` satisfies this. */
export type AudioHost = {
  readonly currentTime: number
  readonly sampleRate: number
  readonly state: string
  readonly destination: AudioNodeLike
  readonly listener: ListenerLike
  /** Present on `AudioContext`, absent on `OfflineAudioContext`. */
  readonly baseLatency?: number
  readonly outputLatency?: number
  createGain(): GainLike
  createBufferSource(): BufferSourceLike
  createPanner(): PannerLike
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>
  resume(): unknown
  /**
   * Present on `AudioContext`; the debug surface uses it. The parameter is
   * `OfflineAudioContext`'s — its `suspend` takes the time to stop at — and is
   * declared only so that both kinds of context satisfy this type.
   */
  suspend?(when?: number): unknown
  close?(): unknown
}

/* --------------------------------------------------------------------------
 * The engine
 * ----------------------------------------------------------------------- */

/**
 * How many voices may be alive at once.
 *
 * A duel is two players, so this is generous — and it is a cap on the *world*
 * bus only. Feedback never queues behind anything: hearing your own shot is not
 * allowed to depend on how much is going on elsewhere in the arena.
 */
export const MAX_WORLD_VOICES = 24

/** What one playback exposes. Enough to stop it, and to know when it started. */
export type Voice = {
  readonly sound: SoundId
  readonly bus: Bus
  /** The `AudioContext.currentTime` it was scheduled to start at. */
  readonly when: number
  stop(): void
}

export type PlayOptions = {
  /** Multiplies {@link SoundSpec.gain}. */
  readonly gain?: number
  /** Playback rate, for cheap variation. 1 is the recorded pitch. */
  readonly rate?: number
  /** Audio-clock time to start at. Defaults to now — see the header. */
  readonly when?: number
}

export type AudioSnapshot = {
  /** `false` when audio could not be created at all. The game still runs. */
  readonly available: boolean
  readonly state: string
  readonly loaded: boolean
  /** Sounds decoded and ready. */
  readonly sounds: number
  /** `decodeAudioData` calls made, ever. */
  readonly decodes: number
  /**
   * `decodeAudioData` calls made *after* loading finished.
   *
   * The acceptance check, as a number. Anything but zero means something is
   * decoding during a match.
   */
  readonly decodesAfterLoad: number
  readonly sampleRate: number
  readonly baseLatencyMs: number
  readonly outputLatencyMs: number
  /** Voices currently playing. */
  readonly voices: number
  readonly played: number
  /** Playbacks refused: unknown sound, wrong bus, or the voice cap. */
  readonly dropped: number
  /**
   * How far ahead of the audio clock the last playback was scheduled, in ms.
   *
   * Zero by construction — every `play` uses `currentTime`. It is reported
   * because "we schedule at `currentTime`" is the kind of claim that stays true
   * only while someone can see it.
   */
  readonly lastScheduleLeadMs: number
  /** Main-thread cost of the last `play` call, in ms. */
  readonly lastPlayCostMs: number
}

export type AudioEngine = {
  readonly context: AudioHost
  readonly loaded: boolean
  /** Fetch and decode every sound. Idempotent; safe to call twice. */
  load(): Promise<void>
  /**
   * Resume the context. Must be called from a user gesture the first time —
   * `gesture.ts` is what guarantees it shares one with the pointer lock.
   */
  resume(): void
  /** Your own actions: dry, centred, no panner. */
  playFeedback(sound: SoundId, options?: PlayOptions): Voice | null
  /** Something that happened out there, at `origin` in the Quake frame. */
  playWorld(sound: SoundId, origin: Vec3, options?: PlayOptions): Voice | null
  /** Where the player's head is and which way it is facing. */
  listen(pose: ListenerPose): void
  /**
   * The decoded buffer for a sound, or `null` if it never loaded.
   *
   * The one read-only door into the buffer table, for `probe.ts` — which
   * renders the *real* asset through an offline context rather than a tone,
   * because a spatialisation measured on a sine says nothing about the file the
   * game actually plays.
   */
  buffer(sound: SoundId): AudioBufferLike | null
  /** Stop every voice — a round ending, a disconnection, a tab going away. */
  silence(): void
  snapshot(): AudioSnapshot
  dispose(): void
}

export type EngineOptions = {
  readonly context: AudioHost
  /** Overall level. The settings screen (GLAD-NPCTU8) will own this. */
  readonly masterGain?: number
  /** Where the files live. Overridden by the browser check. */
  readonly base?: string
  /** How a URL becomes bytes. Injected so a test never touches the network. */
  readonly fetchAsset?: (url: string) => Promise<ArrayBuffer>
  /** Called with anything that went wrong loading. Defaults to a console warn. */
  readonly onError?: (message: string) => void
}

/** The default asset loader: `fetch`, and no cache-busting. */
async function fetchAsset(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  return response.arrayBuffer()
}

/**
 * The browser's context, created the way this game needs it.
 *
 * Separate from {@link createAudioEngine} so the engine can be handed an
 * `OfflineAudioContext` — which is how `scripts/audio-check.mjs` renders the
 * HRTF probe through the exact graph the game plays through.
 */
export function createBrowserAudioContext(): AudioContext {
  // No `sampleRate`: the device's own rate, so nothing is resampled per render
  // quantum. See the header.
  return new AudioContext({ latencyHint: 'interactive' })
}

/** Milliseconds, from a `performance.now()` pair. */
function since(startMs: number): number {
  return performance.now() - startMs
}

export function createAudioEngine(options: EngineOptions): AudioEngine {
  const context = options.context
  const load = options.fetchAsset ?? fetchAsset
  const onError =
    options.onError ??
    ((message: string) => {
      console.warn(`gladiator: audio: ${message}`)
    })

  const buffers = new Map<SoundId, AudioBufferLike>()

  const master = context.createGain()
  master.gain.value = options.masterGain ?? 0.85
  master.connect(context.destination)

  const feedback: FeedbackBus = createFeedbackBus(context, master)
  const world: WorldBus = createWorldBus(context, master)

  const live = new Set<Voice>()
  let worldVoices = 0
  let decodes = 0
  let decodesAtLoad = 0
  let loaded = false
  let loading: Promise<void> | null = null
  let played = 0
  let dropped = 0
  let lastScheduleLeadMs = 0
  let lastPlayCostMs = 0
  let disposed = false

  /**
   * One playback, wired and started.
   *
   * The two buses differ only in what sits between the source and the master
   * gain, so the bookkeeping — voice set, cap, `ended` cleanup — is written once
   * here rather than twice in `feedback.ts` and `positional.ts`.
   */
  const start = (
    sound: SoundId,
    bus: Bus,
    play: (buffer: AudioBufferLike, when: number, gain: number, rate: number) => Voice,
    play_options: PlayOptions,
  ): Voice | null => {
    if (disposed) return null
    const spec = SOUNDS[sound]
    if (!allowedOn(spec, bus)) {
      dropped += 1
      onError(`${sound} is not allowed on the ${bus} bus`)
      return null
    }
    const buffer = buffers.get(sound)
    if (buffer === undefined) {
      // Deliberately not "decode it now": see the header. A missing buffer is a
      // loading bug, and the honest response is silence plus a counter.
      dropped += 1
      return null
    }
    if (bus === Bus.World && worldVoices >= MAX_WORLD_VOICES) {
      dropped += 1
      return null
    }

    const startedMs = performance.now()
    const when = play_options.when ?? context.currentTime
    const voice = play(buffer, when, spec.gain * (play_options.gain ?? 1), play_options.rate ?? 1)

    live.add(voice)
    if (bus === Bus.World) worldVoices += 1
    played += 1
    lastScheduleLeadMs = (when - context.currentTime) * 1000
    lastPlayCostMs = since(startedMs)
    return voice
  }

  /** Called by both buses when a source reports `ended`. */
  const retire = (voice: Voice) => {
    if (!live.delete(voice)) return
    if (voice.bus === Bus.World) worldVoices -= 1
  }

  return {
    context,

    get loaded() {
      return loaded
    },

    load() {
      if (loading !== null) return loading
      loading = (async () => {
        await Promise.all(
          ALL_SOUNDS.map(async (spec) => {
            try {
              const bytes = await load(soundUrl(spec, options.base))
              decodes += 1
              buffers.set(spec.id, await context.decodeAudioData(bytes))
            } catch (cause) {
              // One sound failing must not take the rest of the game's audio
              // with it. The snapshot's `sounds` count is what notices.
              onError(`could not load ${spec.file}: ${String(cause)}`)
            }
          }),
        )
        decodesAtLoad = decodes
        loaded = true
      })()
      return loading
    },

    resume() {
      if (context.state === 'running') return
      try {
        const result = context.resume()
        if (result instanceof Promise) result.catch(() => undefined)
      } catch {
        // A context that refuses to resume is a context the browser is not
        // giving us yet. The next gesture tries again.
      }
    },

    playFeedback(sound, play_options = {}) {
      return start(
        sound,
        Bus.Feedback,
        (buffer, when, gain, rate) =>
          feedback.play({ sound, buffer, when, gain, rate, onEnded: retire }),
        play_options,
      )
    },

    playWorld(sound, origin, play_options = {}) {
      const spec = SOUNDS[sound]
      return start(
        sound,
        Bus.World,
        (buffer, when, gain, rate) =>
          world.play({
            sound,
            buffer,
            when,
            gain,
            rate,
            origin,
            distance: spec.distance,
            onEnded: retire,
          }),
        play_options,
      )
    },

    listen(pose) {
      applyListenerPose(context, pose)
    },

    buffer(sound) {
      return buffers.get(sound) ?? null
    },

    silence() {
      for (const voice of [...live]) voice.stop()
      live.clear()
      worldVoices = 0
    },

    snapshot() {
      return {
        available: true,
        state: context.state,
        loaded,
        sounds: buffers.size,
        decodes,
        decodesAfterLoad: loaded ? decodes - decodesAtLoad : 0,
        sampleRate: context.sampleRate,
        baseLatencyMs: (context.baseLatency ?? 0) * 1000,
        outputLatencyMs: (context.outputLatency ?? 0) * 1000,
        voices: live.size,
        played,
        dropped,
        lastScheduleLeadMs,
        lastPlayCostMs,
      }
    },

    dispose() {
      disposed = true
      for (const voice of [...live]) voice.stop()
      live.clear()
      worldVoices = 0
      master.disconnect()
      context.close?.()
    },
  }
}

/** The snapshot a page with no audio at all reports. */
export const NO_AUDIO: AudioSnapshot = {
  available: false,
  state: 'none',
  loaded: false,
  sounds: 0,
  decodes: 0,
  decodesAfterLoad: 0,
  sampleRate: 0,
  baseLatencyMs: 0,
  outputLatencyMs: 0,
  voices: 0,
  played: 0,
  dropped: 0,
  lastScheduleLeadMs: 0,
  lastPlayCostMs: 0,
}
