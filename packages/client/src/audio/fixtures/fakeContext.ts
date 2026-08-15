/**
 * A fake Web Audio context, for the tests.
 *
 * It exists because the interesting properties of this subsystem are *graph*
 * properties — what is connected to what, how many times something was decoded,
 * what time a source was told to start at — and those are exactly the things a
 * real `AudioContext` will not tell you. A headless browser can measure the
 * output; only a fake can assert that a feedback voice has no panner in it.
 *
 * Nothing here is a cast. Every fake satisfies the structural types in
 * `engine.ts` exactly, so a node that grows a field the engine uses is a type
 * error in this file rather than a green test against a lie. The browser half
 * of the same claims is `scripts/audio-check.mjs`.
 *
 * Only tests import it, so it never reaches a bundle.
 */

import type {
  AudioBufferLike,
  AudioHost,
  AudioNodeLike,
  BufferSourceLike,
  GainLike,
  ListenerLike,
  PannerLike,
} from '../engine.ts'

/** Everything a fake node records about how it was wired. */
export type FakeNode = AudioNodeLike & {
  readonly kind: string
  readonly outputs: AudioNodeLike[]
  disconnects: number
}

export type FakeGain = FakeNode & GainLike
export type FakePanner = FakeNode & PannerLike

export type FakeSource = FakeNode &
  BufferSourceLike & {
    /** The `when` it was started at, or `null` if it never started. */
    readonly startedAt: number | null
    readonly stopped: boolean
    /** Fire the `ended` event, the way a finished buffer would. */
    end(): void
  }

function node(kind: string): FakeNode {
  const outputs: AudioNodeLike[] = []
  return {
    kind,
    outputs,
    disconnects: 0,
    connect(destination) {
      outputs.push(destination)
      return destination
    },
    disconnect() {
      this.disconnects += 1
    },
  }
}

export function fakeGain(): FakeGain {
  return { ...node('gain'), gain: { value: 1 } }
}

export function fakePanner(): FakePanner {
  return {
    ...node('panner'),
    panningModel: 'equalpower',
    distanceModel: 'inverse',
    refDistance: 1,
    maxDistance: 10000,
    rolloffFactor: 1,
    positionX: { value: 0 },
    positionY: { value: 0 },
    positionZ: { value: 0 },
  }
}

export function fakeSource(): FakeSource {
  const listeners: Array<() => void> = []
  return {
    ...node('source'),
    buffer: null,
    playbackRate: { value: 1 },
    startedAt: null,
    stopped: false,
    start(when = 0) {
      // `startedAt` is readonly to consumers and written here on purpose: a
      // test asserting the scheduled time should not be able to set it.
      Object.assign(this, { startedAt: when })
    },
    stop() {
      Object.assign(this, { stopped: true })
    },
    addEventListener(type, listener) {
      if (type === 'ended') listeners.push(listener)
    },
    end() {
      for (const listener of listeners) listener()
    },
  }
}

export function fakeListener(): ListenerLike {
  return {
    positionX: { value: 0 },
    positionY: { value: 0 },
    positionZ: { value: 0 },
    forwardX: { value: 0 },
    forwardY: { value: 0 },
    forwardZ: { value: -1 },
    upX: { value: 0 },
    upY: { value: 1 },
    upZ: { value: 0 },
  }
}

export type FakeContext = AudioHost & {
  /** Advance the audio clock, the way a running context would. */
  advance(seconds: number): void
  setState(state: string): void
  readonly decodes: number
  readonly resumes: number
  readonly sources: FakeSource[]
  readonly panners: FakePanner[]
  readonly gains: FakeGain[]
  readonly destination: FakeNode
}

export type FakeContextOptions = {
  readonly sampleRate?: number
  readonly state?: string
  /** Reject every decode, to exercise the "one sound failed" path. */
  readonly failDecode?: boolean
}

export function fakeContext(options: FakeContextOptions = {}): FakeContext {
  const sources: FakeSource[] = []
  const panners: FakePanner[] = []
  const gains: FakeGain[] = []
  const destination = node('destination')
  const listener = fakeListener()

  let currentTime = 0
  let state = options.state ?? 'suspended'
  let decodes = 0
  let resumes = 0

  return {
    get currentTime() {
      return currentTime
    },
    sampleRate: options.sampleRate ?? 48000,
    get state() {
      return state
    },
    destination,
    listener,
    baseLatency: 0.005,
    outputLatency: 0.01,

    createGain() {
      const gain = fakeGain()
      gains.push(gain)
      return gain
    },
    createBufferSource() {
      const source = fakeSource()
      sources.push(source)
      return source
    },
    createPanner() {
      const panner = fakePanner()
      panners.push(panner)
      return panner
    },
    decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike> {
      decodes += 1
      if (options.failDecode === true) return Promise.reject(new Error('cannot decode'))
      return Promise.resolve({
        duration: data.byteLength / 44100,
        sampleRate: 22050,
        numberOfChannels: 1,
      })
    },
    resume() {
      resumes += 1
      state = 'running'
      return Promise.resolve()
    },

    advance(seconds) {
      currentTime += seconds
    },
    setState(next) {
      state = next
    },
    get decodes() {
      return decodes
    },
    get resumes() {
      return resumes
    },
    sources,
    panners,
    gains,
  }
}

/** Bytes to hand a fake decode. The length is the only thing that matters. */
export function fakeAsset(bytes = 1024): ArrayBuffer {
  return new ArrayBuffer(bytes)
}
