import { describe, expect, it } from 'vitest'

import { createFeedbackBus } from './feedback.ts'
import { fakeContext } from './fixtures/fakeContext.ts'
import { SoundId } from './sounds.ts'

const BUFFER = { duration: 0.11, sampleRate: 22050, numberOfChannels: 1 }

function play(context: ReturnType<typeof fakeContext>, when = 0) {
  const bus = createFeedbackBus(context, context.destination)
  const retired: string[] = []
  const voice = bus.play({
    sound: SoundId.Hit,
    buffer: BUFFER,
    when,
    gain: 0.4,
    rate: 1,
    onEnded: (ended) => retired.push(ended.sound),
  })
  return { bus, voice, retired }
}

describe('the feedback bus', () => {
  /**
   * The property the whole bus exists for. A panner is a pair of convolutions
   * and, worse, a *position* — and your own weapon does not have one. If a
   * panner ever appears on this path, hit confirmation starts being quieter
   * from some directions than others, which is the bug the split prevents.
   */
  it('creates no panner, ever', () => {
    const context = fakeContext()
    play(context)
    expect(context.panners).toHaveLength(0)
  })

  it('wires source -> gain -> bus -> output', () => {
    const context = fakeContext()
    play(context)
    // The bus's own gain is the first one made; the voice's is the last.
    const busInput = context.gains[0]
    const voiceGain = context.gains.at(-1)
    expect(context.sources[0]?.outputs[0]).toBe(voiceGain)
    expect(voiceGain?.outputs[0]).toBe(busInput)
    expect(busInput?.outputs[0]).toBe(context.destination)
  })

  it('starts the source at the time it was given, on the audio clock', () => {
    const context = fakeContext()
    const { voice } = play(context, 3.5)
    expect(context.sources[0]?.startedAt).toBe(3.5)
    expect(voice.when).toBe(3.5)
    expect(voice.bus).toBe('feedback')
  })

  it('applies the gain it was handed', () => {
    const context = fakeContext()
    play(context)
    expect(context.gains.at(-1)?.gain.value).toBeCloseTo(0.4, 6)
  })

  it('unwires itself when the source ends', () => {
    const context = fakeContext()
    const { retired } = play(context)
    context.sources[0]?.end()
    expect(retired).toEqual([SoundId.Hit])
    expect(context.sources[0]?.disconnects).toBe(1)
  })

  it('stops cleanly, and only retires once', () => {
    const context = fakeContext()
    const { voice, retired } = play(context)
    voice.stop()
    voice.stop()
    expect(context.sources[0]?.stopped).toBe(true)
    expect(retired).toEqual([SoundId.Hit])
  })
})
