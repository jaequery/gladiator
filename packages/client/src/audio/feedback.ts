/**
 * The feedback bus: your own actions, straight to the speakers.
 *
 * Source → per-voice gain → bus gain → master. No panner, no distance model, no
 * convolution, nothing between the buffer and the output that has to think.
 *
 * That is a *design* decision rather than an optimisation. Your own rocket
 * launcher is not an object in the world you are locating; it is the
 * confirmation that the button worked, and it should sound the same whichever
 * way you happen to be facing. A hit confirmation is the strongest case: it has
 * to be instant and unmissable, and a panned, distance-attenuated hit
 * confirmation is quietest exactly when the shot was hardest — across the arena,
 * at the moment you most needed to know you landed it.
 *
 * The cost side is real too. An `HRTF` panner is a pair of convolutions per
 * voice; a gain node is a multiply. Sounds that gain nothing from being placed
 * do not pay for it.
 */

import type { AudioBufferLike, AudioHost, AudioNodeLike, Voice } from './engine.ts'
import { Bus, type SoundId } from './sounds.ts'

/** One playback request, as the engine hands it over. */
export type PlayRequest = {
  readonly sound: SoundId
  readonly buffer: AudioBufferLike
  /** Audio-clock time to start at. */
  readonly when: number
  /** Linear gain, already multiplied by the sound's own level. */
  readonly gain: number
  readonly rate: number
  /** Called when the source reports `ended`, so the engine can drop the voice. */
  readonly onEnded: (voice: Voice) => void
}

export type FeedbackBus = {
  /** The node everything on this bus flows into. */
  readonly input: AudioNodeLike
  play(request: PlayRequest): Voice
}

export function createFeedbackBus(context: AudioHost, output: AudioNodeLike): FeedbackBus {
  const input = context.createGain()
  input.gain.value = 1
  input.connect(output)

  return {
    input,

    play(request) {
      const source = context.createBufferSource()
      source.buffer = request.buffer
      source.playbackRate.value = request.rate

      const gain = context.createGain()
      gain.gain.value = request.gain

      source.connect(gain)
      gain.connect(input)

      // Set by whichever happens first — the source finishing, or a caller
      // stopping it — so a voice is retired exactly once either way.
      let finished = false
      const voice: Voice = {
        sound: request.sound,
        bus: Bus.Feedback,
        when: request.when,
        stop() {
          if (finished) return
          finished = true
          // A source that has not started yet throws on `stop` in some
          // browsers and a stopped source throws in others. Neither is
          // interesting enough to take a frame down for.
          try {
            source.stop()
          } catch {
            /* already finished */
          }
          source.disconnect()
          gain.disconnect()
          request.onEnded(voice)
        },
      }

      source.addEventListener('ended', () => {
        if (finished) return
        finished = true
        source.disconnect()
        gain.disconnect()
        request.onEnded(voice)
      })

      source.start(request.when)
      return voice
    },
  }
}
