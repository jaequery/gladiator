/**
 * The HRTF probe: rendering the game's own panner offline, so "an opponent
 * behind you sounds behind you" is a measurement instead of a belief.
 *
 * Everything here runs through {@link createWorldBus} — the same bus, the same
 * distance model, the same `configurePanner` — into an `OfflineAudioContext`
 * rather than the speakers. What comes back is the stereo the player would have
 * heard, which can then be measured (`scripts/audio-check.mjs`) or listened to
 * (the WAV that script writes).
 *
 * ## The control is the point
 *
 * Measuring only the HRTF render proves very little: any panner produces *some*
 * stereo, and a sceptical reader is right to ask whether the number came from
 * spatialisation or from arithmetic noise. So the probe renders the same source
 * twice more with `panningModel = 'equalpower'`, which is a function of azimuth
 * alone and therefore **cannot** distinguish front from behind. The claim it
 * supports is sharp:
 *
 *   - under `equalpower`, front and behind are bit-identical
 *   - under `HRTF`, they are not
 *
 * The difference between those two sentences is the entire reason this game
 * pays for a pair of convolutions per voice.
 *
 * It ships in the production bundle on purpose, hung off `window.__gladiator`
 * next to the frame capture. HRTF quality is a property of the *browser's*
 * impulse-response database, so being able to run this on the machine that
 * sounds wrong is worth more than a number measured once in CI.
 */

import type { Vec3 } from '@gladiator/sim'

import { createFeedbackBus } from './feedback.ts'
import type { AudioBufferLike, AudioHost } from './engine.ts'
import { PANNING_MODEL, createWorldBus } from './positional.ts'
import { SOUNDS, SoundId } from './sounds.ts'

/** A rendered buffer: an `AudioBuffer` with its samples readable. */
export type RenderedBuffer = AudioBufferLike & {
  readonly length: number
  getChannelData(channel: number): Float32Array
}

/** An `OfflineAudioContext`, as far as the probe is concerned. */
export type OfflineHost = AudioHost & {
  startRendering(): Promise<RenderedBuffer>
}

/** Where the probe puts the source, in the Quake frame, listener at the origin. */
export const PROBE_POSITIONS: readonly { readonly name: string; readonly origin: Vec3 }[] = [
  // `+x` is forward and `+y` is *left* in the Quake frame — right carries the
  // minus sign. Getting that backwards is the mirrored-arena bug, and it would
  // show up here as "right" measuring louder in the left ear.
  { name: 'front', origin: [400, 0, 50] },
  { name: 'behind', origin: [-400, 0, 50] },
  { name: 'left', origin: [0, 400, 50] },
  { name: 'right', origin: [0, -400, 50] },
  { name: 'above', origin: [0, 0, 450] },
]

/** Extra seconds rendered past the source, for the convolution's tail. */
const TAIL_SECONDS = 0.06

export type ChannelMetrics = {
  readonly leftRms: number
  readonly rightRms: number
  /**
   * Right minus left, in decibels: the interaural level difference.
   *
   * Positive means the sound is to the player's right. It is the crudest of the
   * spatial cues and the one that would survive any panner, which is why the
   * front/back numbers below matter more.
   */
  readonly ildDb: number
  /**
   * Energy above roughly 4 kHz as a fraction of the total.
   *
   * A first difference is a +6 dB/octave high-pass — no FFT needed for a
   * ratio. Front and behind differ here because the pinna filters what arrives
   * from behind, and that spectral notch is what a head hears as "behind".
   */
  readonly highRatio: number
  /**
   * The interaural time difference, in milliseconds. Positive means the right
   * ear hears it first, so the source is on the player's right.
   *
   * This is the cue that survives everything. Level differences are small at
   * the frequencies a rocket launcher is made of — a wavelength longer than a
   * head diffracts around it rather than being shadowed by it — so a bass-heavy
   * sound 90 degrees to one side may only be a decibel or two louder in the near
   * ear while arriving most of a millisecond earlier. `equalpower` produces a
   * level difference and *no* time difference at all; only a head-related
   * transfer function has the delay in it.
   */
  readonly itdMs: number
  /** Present when the caller asked for the audio itself. */
  readonly samples?: { readonly left: readonly number[]; readonly right: readonly number[] }
}

export type ProbePosition = ChannelMetrics & { readonly name: string }

export type HrtfProbe = {
  readonly model: string
  readonly sampleRate: number
  readonly seconds: number
  readonly positions: readonly ProbePosition[]
  /**
   * RMS of (front − behind), per model.
   *
   * `equalpower` is expected to be exactly zero and `HRTF` clearly above it.
   * See the header.
   */
  readonly frontBackDifference: number
  readonly equalpowerFrontBackDifference: number
}

/** What {@link renderOnset} measured. */
export type OnsetProbe = {
  /** Milliseconds from the scheduled start to the first audible sample. */
  readonly onsetMs: number
  /** Peak of the whole render, so a silent one is obvious rather than fast. */
  readonly peak: number
  /** The threshold "audible" was measured against, in dBFS. */
  readonly thresholdDb: number
}

/** −40 dBFS: quiet enough to be the onset, loud enough not to be dither. */
const ONSET_THRESHOLD_DB = -40

/**
 * How long after a feedback voice is scheduled the first audible sample is.
 *
 * The acceptance check says a fired weapon has to produce audible output within
 * one frame, and this is the half of it that lives in the *asset*: a sound with
 * a 30 ms fade-in is late however fast the engine is. It renders through the
 * real {@link createFeedbackBus}, so the graph measured is the graph played.
 *
 * The other half — that the voice is scheduled at `currentTime` and the device
 * adds only its `baseLatency` — is read off the snapshot by
 * `scripts/audio-check.mjs`, which adds the two together.
 */
export async function renderOnset(options: {
  readonly buffer: AudioBufferLike
  readonly sampleRate: number
  readonly seconds?: number
  readonly createContext: (channels: number, length: number, sampleRate: number) => OfflineHost
}): Promise<OnsetProbe> {
  const seconds = options.seconds ?? 0.05
  const context = options.createContext(2, Math.ceil(seconds * options.sampleRate), options.sampleRate)
  const bus = createFeedbackBus(context, context.destination)

  bus.play({
    sound: SoundId.RocketFire,
    buffer: options.buffer,
    when: 0,
    gain: 1,
    rate: 1,
    onEnded: () => undefined,
  })

  const rendered = await context.startRendering()
  const samples = rendered.getChannelData(0)
  const threshold = 10 ** (ONSET_THRESHOLD_DB / 20)

  let peak = 0
  let onset = -1
  for (let i = 0; i < samples.length; i += 1) {
    const magnitude = Math.abs(samples[i] ?? 0)
    if (magnitude > peak) peak = magnitude
    if (onset < 0 && magnitude >= threshold) onset = i
  }

  return {
    onsetMs: onset < 0 ? Number.POSITIVE_INFINITY : (onset / options.sampleRate) * 1000,
    peak,
    thresholdDb: ONSET_THRESHOLD_DB,
  }
}

/** RMS of a channel. */
function rms(samples: Float32Array): number {
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / Math.max(1, samples.length))
}

/** RMS of the sample-to-sample difference: a cheap high-frequency energy. */
function highRms(samples: Float32Array): number {
  let sum = 0
  for (let i = 1; i < samples.length; i += 1) {
    const delta = (samples[i] ?? 0) - (samples[i - 1] ?? 0)
    sum += delta * delta
  }
  return Math.sqrt(sum / Math.max(1, samples.length - 1))
}

/** RMS of the difference between two renders, over both channels. */
function differenceRms(a: RenderedBuffer, b: RenderedBuffer): number {
  let sum = 0
  let count = 0
  for (let channel = 0; channel < 2; channel += 1) {
    const left = a.getChannelData(channel)
    const right = b.getChannelData(channel)
    const length = Math.min(left.length, right.length)
    for (let i = 0; i < length; i += 1) {
      const delta = (left[i] ?? 0) - (right[i] ?? 0)
      sum += delta * delta
    }
    count += length
  }
  return Math.sqrt(sum / Math.max(1, count))
}

/**
 * The lag, in samples, at which the two channels correlate best.
 *
 * Positive means `right` leads `left` — the source is on the right. Searched
 * over ±1 ms, which is comfortably wider than a human head: the widest real
 * interaural delay is about 0.7 ms, so anything outside this window would be a
 * measurement error rather than a direction.
 */
function interauralLag(left: Float32Array, right: Float32Array, sampleRate: number): number {
  const maxLag = Math.round(sampleRate / 1000)
  const length = Math.min(left.length, right.length)
  let best = 0
  let bestScore = -Infinity
  for (let lag = -maxLag; lag <= maxLag; lag += 1) {
    let score = 0
    const from = Math.max(0, -lag)
    const to = Math.min(length, length - lag)
    for (let i = from; i < to; i += 1) score += (left[i + lag] ?? 0) * (right[i] ?? 0)
    if (score > bestScore) {
      bestScore = score
      best = lag
    }
  }
  return best
}

function measure(rendered: RenderedBuffer, capture: boolean): ChannelMetrics {
  const left = rendered.getChannelData(0)
  const right = rendered.getChannelData(1)
  const leftRms = rms(left)
  const rightRms = rms(right)
  const total = leftRms + rightRms
  const high = highRms(left) + highRms(right)
  return {
    leftRms,
    rightRms,
    // `+1e-12` so a silent render reports 0 dB rather than NaN.
    ildDb: 20 * Math.log10((rightRms + 1e-12) / (leftRms + 1e-12)),
    highRatio: total === 0 ? 0 : high / total,
    itdMs: (interauralLag(left, right, rendered.sampleRate) / rendered.sampleRate) * 1000,
    ...(capture
      ? { samples: { left: Array.from(left), right: Array.from(right) } }
      : {}),
  }
}

export type ProbeOptions = {
  /** The decoded sound to place. The probe uses the real asset, not a tone. */
  readonly buffer: AudioBufferLike
  /** Which sound it is, so the world bus applies its real distance model. */
  readonly sound?: SoundId
  /** Must match the buffer's context rate: an offline context resamples too. */
  readonly sampleRate: number
  readonly createContext: (channels: number, length: number, sampleRate: number) => OfflineHost
  /** `HRTF` unless a control render is being made. */
  readonly model?: string
  /** Return the rendered samples as well as the numbers. */
  readonly capture?: boolean
}

/** Render one source position, offline, through the real world bus. */
async function renderAt(options: ProbeOptions, origin: Vec3, length: number): Promise<RenderedBuffer> {
  const context = options.createContext(2, length, options.sampleRate)
  const bus = createWorldBus(context, context.destination, options.model ?? PANNING_MODEL)
  const spec = SOUNDS[options.sound ?? SoundId.RocketFire]

  bus.play({
    sound: spec.id,
    buffer: options.buffer,
    when: 0,
    gain: 1,
    rate: 1,
    origin,
    distance: spec.distance,
    onEnded: () => undefined,
  })

  return context.startRendering()
}

/**
 * Render every {@link PROBE_POSITIONS} entry, plus the `equalpower` control.
 *
 * Returns numbers a script can assert on, and — with `capture` — the audio a
 * person can listen to, which is the only test that ever really settles a
 * question about sound.
 */
export async function renderHrtfProbe(options: ProbeOptions): Promise<HrtfProbe> {
  const seconds = options.buffer.duration + TAIL_SECONDS
  const length = Math.ceil(seconds * options.sampleRate)

  const positions: ProbePosition[] = []
  const rendered = new Map<string, RenderedBuffer>()
  for (const position of PROBE_POSITIONS) {
    const buffer = await renderAt(options, position.origin, length)
    rendered.set(position.name, buffer)
    positions.push({ name: position.name, ...measure(buffer, options.capture === true) })
  }

  const front = rendered.get('front')
  const behind = rendered.get('behind')

  // The control: the same two positions, through a panner that only knows
  // azimuth. If this comes back as anything but zero, the comparison above is
  // measuring something other than head-related filtering.
  const control = { ...options, model: 'equalpower', capture: false }
  const controlFront = await renderAt(control, [400, 0, 50], length)
  const controlBehind = await renderAt(control, [-400, 0, 50], length)

  return {
    model: options.model ?? PANNING_MODEL,
    sampleRate: options.sampleRate,
    seconds,
    positions,
    frontBackDifference:
      front === undefined || behind === undefined ? 0 : differenceRms(front, behind),
    equalpowerFrontBackDifference: differenceRms(controlFront, controlBehind),
  }
}
