import { describe, expect, it } from 'vitest'

import {
  type AudioEngine,
  MAX_WORLD_VOICES,
  NO_AUDIO,
  createAudioEngine,
} from './engine.ts'
import { type FakeContext, fakeAsset, fakeContext } from './fixtures/fakeContext.ts'
import { ALL_SOUNDS, SoundId } from './sounds.ts'

/** An engine over a fake context, with the network replaced by a constant. */
function engineOver(context: FakeContext, options: { failFetch?: boolean } = {}) {
  const requested: string[] = []
  const engine = createAudioEngine({
    context,
    fetchAsset: (url) => {
      requested.push(url)
      return options.failFetch === true
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(fakeAsset())
    },
    onError: () => undefined,
  })
  return { engine, requested }
}

async function loaded(context: FakeContext): Promise<AudioEngine> {
  const { engine } = engineOver(context)
  await engine.load()
  return engine
}

describe('load', () => {
  it('fetches and decodes every sound in the catalogue exactly once', async () => {
    const context = fakeContext()
    const { engine, requested } = engineOver(context)
    await engine.load()

    expect(requested).toHaveLength(ALL_SOUNDS.length)
    expect(context.decodes).toBe(ALL_SOUNDS.length)
    expect(engine.snapshot().sounds).toBe(ALL_SOUNDS.length)
    expect(engine.loaded).toBe(true)
  })

  it('fetches from public/audio, by the catalogue filename', async () => {
    const { engine, requested } = engineOver(fakeContext())
    await engine.load()
    expect(requested).toContain('/audio/rocket-fire.wav')
    expect(requested).toContain('/audio/explosion.wav')
  })

  it('is idempotent — a second call does not decode again', async () => {
    const context = fakeContext()
    const { engine } = engineOver(context)
    await engine.load()
    await engine.load()
    expect(context.decodes).toBe(ALL_SOUNDS.length)
  })

  it('survives one sound failing to load', async () => {
    const context = fakeContext()
    const { engine } = engineOver(context, { failFetch: true })
    await engine.load()
    expect(engine.loaded).toBe(true)
    expect(engine.snapshot().sounds).toBe(0)
    // And playing one is silence plus a counter, never an exception.
    expect(engine.playFeedback(SoundId.Hit)).toBeNull()
    expect(engine.snapshot().dropped).toBe(1)
  })
})

/**
 * The acceptance check, as a test: *no* `decodeAudioData` call happens during a
 * match. It is asserted on the count rather than on the code because the way
 * this regresses is somebody adding a convenient lazy path, and a lazy path
 * looks perfectly reasonable until you meet it mid-duel.
 */
describe('nothing decodes during a match', () => {
  it('plays every sound on every bus without decoding again', async () => {
    const context = fakeContext()
    const engine = await loaded(context)
    const afterLoad = context.decodes

    for (const spec of ALL_SOUNDS) {
      engine.playFeedback(spec.id)
      engine.playWorld(spec.id, [128, 64, 32])
    }

    expect(context.decodes).toBe(afterLoad)
    expect(engine.snapshot().decodesAfterLoad).toBe(0)
  })

  it('refuses a sound that never loaded rather than decoding one', async () => {
    const context = fakeContext()
    const { engine } = engineOver(context, { failFetch: true })
    await engine.load()
    const before = context.decodes
    expect(engine.playWorld(SoundId.RocketFire, [0, 0, 0])).toBeNull()
    expect(context.decodes).toBe(before)
  })
})

describe('scheduling', () => {
  it('starts a voice at currentTime — no lookahead, no timer', async () => {
    const context = fakeContext()
    const engine = await loaded(context)
    context.advance(12.5)

    const voice = engine.playFeedback(SoundId.RocketFire)
    expect(voice?.when).toBe(12.5)
    expect(context.sources.at(-1)?.startedAt).toBe(12.5)
    expect(engine.snapshot().lastScheduleLeadMs).toBe(0)
  })

  it('honours an explicit audio-clock time', async () => {
    const context = fakeContext()
    const engine = await loaded(context)
    context.advance(2)
    const voice = engine.playFeedback(SoundId.Hit, { when: 2.25 })
    expect(voice?.when).toBe(2.25)
    expect(engine.snapshot().lastScheduleLeadMs).toBeCloseTo(250, 6)
  })

  it('applies the catalogue gain, multiplied by the caller"s', async () => {
    const context = fakeContext()
    const engine = await loaded(context)
    engine.playFeedback(SoundId.Explosion, { gain: 0.5 })
    // The last gain node created is the voice's; the buses are made at startup.
    expect(context.gains.at(-1)?.gain.value).toBeCloseTo(0.5, 6)
  })
})

describe('buses', () => {
  it('refuses a feedback-only sound on the world bus', async () => {
    const engine = await loaded(fakeContext())
    expect(engine.playWorld(SoundId.Hit, [100, 0, 0])).toBeNull()
    expect(engine.snapshot().dropped).toBe(1)
  })

  it('refuses a world-only sound on the feedback bus', async () => {
    const engine = await loaded(fakeContext())
    expect(engine.playFeedback(SoundId.FootstepA)).toBeNull()
  })

  it('puts a panner on world voices and none on feedback voices', async () => {
    const context = fakeContext()
    const engine = await loaded(context)

    engine.playFeedback(SoundId.RocketFire)
    expect(context.panners).toHaveLength(0)

    engine.playWorld(SoundId.RocketFire, [0, 0, 0])
    expect(context.panners).toHaveLength(1)
  })
})

describe('voices', () => {
  it('caps the world bus and never the feedback bus', async () => {
    const context = fakeContext()
    const engine = await loaded(context)

    for (let i = 0; i < MAX_WORLD_VOICES + 8; i += 1) {
      engine.playWorld(SoundId.RocketFire, [i * 10, 0, 0])
    }
    expect(engine.snapshot().voices).toBe(MAX_WORLD_VOICES)
    expect(engine.snapshot().dropped).toBe(8)

    // Feedback still gets through with the world bus saturated: your own shot
    // is not allowed to queue behind the arena.
    expect(engine.playFeedback(SoundId.RocketFire)).not.toBeNull()
    expect(engine.snapshot().voices).toBe(MAX_WORLD_VOICES + 1)
  })

  it('retires a voice when the source ends, and frees its slot', async () => {
    const context = fakeContext()
    const engine = await loaded(context)
    engine.playWorld(SoundId.RocketFire, [0, 0, 0])
    expect(engine.snapshot().voices).toBe(1)

    context.sources[0]?.end()
    expect(engine.snapshot().voices).toBe(0)
    // Everything it built is unwired: source, gain and panner.
    expect(context.sources[0]?.disconnects).toBe(1)
    expect(context.panners[0]?.disconnects).toBe(1)
  })

  it('silence() stops everything that is playing', async () => {
    const context = fakeContext()
    const engine = await loaded(context)
    engine.playWorld(SoundId.RocketFire, [0, 0, 0])
    engine.playFeedback(SoundId.Hit)

    engine.silence()
    expect(engine.snapshot().voices).toBe(0)
    expect(context.sources.every((source) => source.stopped)).toBe(true)
  })
})

describe('resume', () => {
  it('resumes a suspended context and leaves a running one alone', async () => {
    const context = fakeContext({ state: 'suspended' })
    const engine = await loaded(context)

    engine.resume()
    expect(context.resumes).toBe(1)
    expect(engine.snapshot().state).toBe('running')

    engine.resume()
    expect(context.resumes).toBe(1)
  })
})

describe('the snapshot', () => {
  it('reports latency in milliseconds, from the context', async () => {
    const engine = await loaded(fakeContext({ sampleRate: 44100 }))
    const snapshot = engine.snapshot()
    expect(snapshot.sampleRate).toBe(44100)
    expect(snapshot.baseLatencyMs).toBeCloseTo(5, 6)
    expect(snapshot.outputLatencyMs).toBeCloseTo(10, 6)
    expect(snapshot.available).toBe(true)
  })

  it('has a shape a page with no audio can still report', () => {
    expect(NO_AUDIO.available).toBe(false)
    expect(NO_AUDIO.decodesAfterLoad).toBe(0)
  })
})
