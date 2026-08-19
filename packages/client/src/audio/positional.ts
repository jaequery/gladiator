/**
 * The world bus: everything that happens *out there*, panned with HRTF.
 *
 * Source → per-voice gain → panner → bus gain → master.
 *
 * ## Why HRTF and not `equalpower`
 *
 * `equalpower` is a volume knob per ear. It can tell you left from right and it
 * can tell you nothing else: a rocket launcher fired directly behind you renders
 * *bit-identically* to one fired directly in front, because both are at azimuth
 * zero and equal-power panning is a function of azimuth alone. In a duel that is
 * the difference between turning around and dying.
 *
 * `HRTF` convolves each voice with a measured head-related impulse response, so
 * the output carries the interaural time difference and the spectral shaping a
 * real head and pinna apply. Front and back stop being the same sound, and
 * elevation becomes audible — which matters in an arena where the answer to
 * "where are they" is frequently "above you, about to rocket-jump".
 *
 * `scripts/audio-check.mjs` proves exactly that claim by rendering the same
 * buffer in front and behind through both models and comparing: identical under
 * `equalpower`, materially different under `HRTF`.
 *
 * It costs a pair of convolutions per voice. A 1v1 duel with a hard cap of
 * {@link MAX_WORLD_VOICES} voices can afford that; a 32-player deathmatch could
 * not, and Gladiator is not one.
 *
 * ## Coordinates: Web Audio already speaks the engine frame
 *
 * Web Audio's space is right-handed with `+x` right, `+y` up and `-z` forward —
 * which is exactly the *engine frame* (`docs/physics-spec.md` §0.3). So the
 * conversion from the simulation's Quake frame is the same `QUAKE_TO_ENGINE`
 * matrix the camera uses, applied here and nowhere else in this directory. The
 * naive alternative — feeding Quake coordinates straight in because both are
 * right-handed — mirrors the arena and puts every sound on the wrong side of
 * the player's head.
 */

import { PLAYER_VIEW_HEIGHT, type Vec3, angleUnitsToRadians, quakeToEngine } from '@gladiator/sim'

import { viewForwardQuake } from '../render/view.ts'
import type {
  AudioParamLike,
  AudioHost,
  AudioNodeLike,
  ListenerLike,
  PannerLike,
  Voice,
} from './engine.ts'
import type { PlayRequest } from './feedback.ts'
import { Bus, type Distance } from './sounds.ts'

/** The one that can tell front from back. See the header. */
export const PANNING_MODEL = 'HRTF'

/**
 * `inverse`, Web Audio's model of the physical inverse-distance law.
 *
 * `linear` reaches exact silence at `maxDistance`, which sounds like a sound
 * being switched off; `exponential` needs a per-sound exponent to behave. The
 * inverse law is what the world does.
 */
export const DISTANCE_MODEL = 'inverse'

/** Where the player's head is and which way it is pointing. */
export type ListenerPose = {
  /** The player's **feet**, Quake frame — the same origin the camera takes. */
  readonly origin: Vec3
  /** View yaw in angle units. */
  readonly yawUnits: number
  /** View pitch in angle units, positive downward as in Quake. */
  readonly pitchUnits: number
}

/** A listener's position and basis, in the engine frame Web Audio wants. */
export type ListenerVectors = {
  readonly position: Vec3
  readonly forward: Vec3
  readonly up: Vec3
}

/**
 * The listener's vectors for a pose. Pure, so the frame conversion is testable
 * without an audio context.
 *
 * The ears are at the eyes — `PLAYER_VIEW_HEIGHT` above the feet, the same
 * offset `cameraPose` applies — because a listener at ankle height hears a
 * different arena than the one on screen.
 *
 * Pitch is included in the forward vector, and that is a choice. Quake's own
 * sound system ignored it; with HRTF, including it means looking up at a player
 * on a ledge moves their rocket from "above" to "in front", which is what your
 * ears would do if you tilted your head, and it is the cue that makes vertical
 * threats locatable at all.
 */
export function listenerVectors(pose: ListenerPose): ListenerVectors {
  // The same definition of "forward" the camera uses, imported rather than
  // restated: two spellings of a basis vector is exactly the drift `AGENTS.md`
  // is about, and this one would put the sound field a few degrees off the
  // picture in a way nobody could see.
  const forwardQuake = viewForwardQuake(
    angleUnitsToRadians(pose.yawUnits),
    angleUnitsToRadians(pose.pitchUnits),
  )
  return {
    position: quakeToEngine([
      pose.origin[0],
      pose.origin[1],
      pose.origin[2] + PLAYER_VIEW_HEIGHT,
    ]),
    forward: quakeToEngine(forwardQuake),
    // Up is the world's up, not the view's: the head never rolls (`view.ts`),
    // and a listener whose up vector tilted with pitch would rotate the whole
    // soundfield around the view axis.
    up: quakeToEngine([0, 0, 1]),
  }
}

/** Write a vector into three `AudioParam`s, or fall back to the old setter. */
function writeVector(
  x: AudioParamLike | undefined,
  y: AudioParamLike | undefined,
  z: AudioParamLike | undefined,
  value: Vec3,
  legacy: ((x: number, y: number, z: number) => void) | undefined,
): void {
  if (x !== undefined && y !== undefined && z !== undefined) {
    x.value = value[0]
    y.value = value[1]
    z.value = value[2]
    return
  }
  legacy?.(value[0], value[1], value[2])
}

/**
 * Point the listener.
 *
 * Two spellings, because the API changed and both are still in the wild:
 * `AudioListener.positionX` and friends are `AudioParam`s in every current
 * browser, and `setPosition`/`setOrientation` are the deprecated methods older
 * Safari still needs. Feature-detected rather than sniffed.
 */
export function applyListenerPose(context: AudioHost, pose: ListenerPose): void {
  const listener: ListenerLike = context.listener
  const vectors = listenerVectors(pose)

  writeVector(
    listener.positionX,
    listener.positionY,
    listener.positionZ,
    vectors.position,
    listener.setPosition?.bind(listener),
  )

  if (
    listener.forwardX !== undefined &&
    listener.forwardY !== undefined &&
    listener.forwardZ !== undefined &&
    listener.upX !== undefined &&
    listener.upY !== undefined &&
    listener.upZ !== undefined
  ) {
    listener.forwardX.value = vectors.forward[0]
    listener.forwardY.value = vectors.forward[1]
    listener.forwardZ.value = vectors.forward[2]
    listener.upX.value = vectors.up[0]
    listener.upY.value = vectors.up[1]
    listener.upZ.value = vectors.up[2]
    return
  }

  listener.setOrientation?.(
    vectors.forward[0],
    vectors.forward[1],
    vectors.forward[2],
    vectors.up[0],
    vectors.up[1],
    vectors.up[2],
  )
}

/**
 * Configure a panner the way every world voice is configured.
 *
 * `model` exists for exactly one caller: `probe.ts`, which renders a control
 * pass through `equalpower` to prove that the front/back difference the game
 * gets comes from HRTF and not from arithmetic. Nothing that plays into
 * speakers ever passes it.
 */
export function configurePanner(
  panner: PannerLike,
  distance: Distance,
  origin: Vec3,
  model: string = PANNING_MODEL,
): void {
  panner.panningModel = model
  panner.distanceModel = DISTANCE_MODEL
  panner.refDistance = distance.refDistance
  panner.maxDistance = distance.maxDistance
  panner.rolloffFactor = distance.rolloff

  const position = quakeToEngine(origin)
  writeVector(
    panner.positionX,
    panner.positionY,
    panner.positionZ,
    position,
    panner.setPosition?.bind(panner),
  )
}

export type WorldPlayRequest = PlayRequest & {
  /** Where the sound happened, Quake frame. */
  readonly origin: Vec3
  readonly distance: Distance
}

export type WorldBus = {
  readonly input: AudioNodeLike
  play(request: WorldPlayRequest): Voice
}

export function createWorldBus(
  context: AudioHost,
  output: AudioNodeLike,
  model: string = PANNING_MODEL,
): WorldBus {
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

      const panner = context.createPanner()
      configurePanner(panner, request.distance, request.origin, model)

      source.connect(gain)
      gain.connect(panner)
      panner.connect(input)

      // Set by whichever happens first — the source finishing, or a caller
      // stopping it — so a voice is retired exactly once either way.
      let finished = false
      const voice: Voice = {
        sound: request.sound,
        bus: Bus.World,
        when: request.when,
        stop() {
          if (finished) return
          finished = true
          try {
            source.stop()
          } catch {
            /* already finished */
          }
          source.disconnect()
          gain.disconnect()
          panner.disconnect()
          request.onEnded(voice)
        },
      }

      source.addEventListener('ended', () => {
        if (finished) return
        finished = true
        source.disconnect()
        gain.disconnect()
        panner.disconnect()
        request.onEnded(voice)
      })

      source.start(request.when)
      return voice
    },
  }
}
