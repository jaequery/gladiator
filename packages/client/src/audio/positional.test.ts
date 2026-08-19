import { PLAYER_VIEW_HEIGHT, type Vec3, yawUnitsFromDegrees, pitchUnitsFromDegrees } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  DISTANCE_MODEL,
  PANNING_MODEL,
  applyListenerPose,
  configurePanner,
  createWorldBus,
  listenerVectors,
} from './positional.ts'
import { fakeContext, fakePanner } from './fixtures/fakeContext.ts'
import { SOUNDS, SoundId } from './sounds.ts'

const AT_ORIGIN = { origin: [0, 0, 0] as Vec3, yawUnits: 0, pitchUnits: 0 }

function closeTo(actual: Vec3, expected: Vec3): void {
  expect(actual[0]).toBeCloseTo(expected[0], 6)
  expect(actual[1]).toBeCloseTo(expected[1], 6)
  expect(actual[2]).toBeCloseTo(expected[2], 6)
}

/**
 * The whole of the front/back bug, caught here rather than by ear.
 *
 * Web Audio's space is the engine frame — `+x` right, `+y` up, `-z` forward —
 * so a listener at yaw zero must face `-z`, and a sound the simulation puts at
 * `+x` (in front, Quake frame) must land at negative `z`. Feeding Quake
 * coordinates in unconverted also "works": every sound plays, and every one of
 * them is 90 degrees from where it should be.
 */
describe('listenerVectors', () => {
  it('faces -z at yaw zero, which is forward in the engine frame', () => {
    closeTo(listenerVectors(AT_ORIGIN).forward, [0, 0, -1])
  })

  it('turns left when yaw increases, as Quake does', () => {
    // Quake yaw 90 faces +y, which is *left*, which is -x in the engine frame.
    const left = listenerVectors({ ...AT_ORIGIN, yawUnits: yawUnitsFromDegrees(90) })
    closeTo(left.forward, [-1, 0, 0])
  })

  it('tilts the forward vector with pitch, so elevation is audible', () => {
    const up = listenerVectors({ ...AT_ORIGIN, pitchUnits: pitchUnitsFromDegrees(-90) })
    // Straight up is `+y` in the engine frame. Not exactly 1, and the shortfall
    // is the interesting part: `pitchUnitsFromDegrees` clamps at 89 degrees, so
    // negative Quake pitch looks as far up as the simulation lets a player
    // look, and the remaining degree leans forward at `-z`.
    expect(up.forward[1]).toBeCloseTo(Math.sin((89 * Math.PI) / 180), 3)
    expect(up.forward[0]).toBeCloseTo(0, 6)
    expect(up.forward[2]).toBeLessThan(0)
  })

  it('keeps up pointing at the sky whatever the view is doing', () => {
    const tilted = listenerVectors({
      ...AT_ORIGIN,
      yawUnits: yawUnitsFromDegrees(37),
      pitchUnits: pitchUnitsFromDegrees(-52),
    })
    closeTo(tilted.up, [0, 1, 0])
  })

  it('puts the ears at the eyes, not at the feet', () => {
    const pose = listenerVectors({ ...AT_ORIGIN, origin: [64, 0, 16] })
    // (qx, qy, qz) -> (-qy, qz, -qx)
    closeTo(pose.position, [0, 16 + PLAYER_VIEW_HEIGHT, -64])
  })
})

describe('applyListenerPose', () => {
  it('writes position and orientation into the listener params', () => {
    const context = fakeContext()
    applyListenerPose(context, { origin: [128, 0, 0], yawUnits: 0, pitchUnits: 0 })

    expect(context.listener.positionZ?.value).toBeCloseTo(-128, 6)
    expect(context.listener.positionY?.value).toBeCloseTo(PLAYER_VIEW_HEIGHT, 6)
    expect(context.listener.forwardZ?.value).toBeCloseTo(-1, 6)
    expect(context.listener.upY?.value).toBeCloseTo(1, 6)
  })
})

describe('configurePanner', () => {
  it('is HRTF, always — the thing that can tell front from behind', () => {
    const panner = fakePanner()
    configurePanner(panner, SOUNDS[SoundId.RocketFire].distance, [0, 0, 0])
    expect(panner.panningModel).toBe(PANNING_MODEL)
    expect(PANNING_MODEL).toBe('HRTF')
    expect(panner.distanceModel).toBe(DISTANCE_MODEL)
  })

  it('takes the distance model from the catalogue, in Quake units', () => {
    const panner = fakePanner()
    const distance = SOUNDS[SoundId.Explosion].distance
    configurePanner(panner, distance, [0, 0, 0])
    expect(panner.refDistance).toBe(distance.refDistance)
    expect(panner.maxDistance).toBe(distance.maxDistance)
    expect(panner.rolloffFactor).toBe(distance.rolloff)
  })

  it('places a sound in front of the player at negative z', () => {
    const panner = fakePanner()
    configurePanner(panner, SOUNDS[SoundId.RocketFire].distance, [400, 0, 50])
    expect(panner.positionZ?.value).toBeCloseTo(-400, 6)
  })

  it('places a sound on the player"s right at positive x', () => {
    // `+y` is *left* in the Quake frame, so right is -y.
    const panner = fakePanner()
    configurePanner(panner, SOUNDS[SoundId.RocketFire].distance, [0, -400, 50])
    expect(panner.positionX?.value).toBeCloseTo(400, 6)
  })

  it('only ever uses another model when the probe asks for one', () => {
    const panner = fakePanner()
    configurePanner(panner, SOUNDS[SoundId.RocketFire].distance, [0, 0, 0], 'equalpower')
    expect(panner.panningModel).toBe('equalpower')
  })
})

describe('the world bus', () => {
  it('wires source -> gain -> panner -> bus -> output', () => {
    const context = fakeContext()
    const output = context.createGain()
    createWorldBus(context, output).play({
      sound: SoundId.RocketFire,
      buffer: { duration: 0.5, sampleRate: 22050, numberOfChannels: 1 },
      when: 0,
      gain: 0.5,
      rate: 1,
      origin: [0, 0, 0],
      distance: SOUNDS[SoundId.RocketFire].distance,
      onEnded: () => undefined,
    })

    const panner = context.panners[0]
    // `output` is the first gain made, the bus's own input the second, and the
    // voice's the last.
    const busInput = context.gains[1]
    const voiceGain = context.gains.at(-1)
    expect(context.sources[0]?.outputs[0]).toBe(voiceGain)
    expect(voiceGain?.outputs[0]).toBe(panner)
    expect(panner?.outputs[0]).toBe(busInput)
    expect(busInput?.outputs[0]).toBe(output)
  })

  it('reports the voice on the world bus and retires it when it ends', () => {
    const context = fakeContext()
    const bus = createWorldBus(context, context.destination)
    let ended = 0

    const voice = bus.play({
      sound: SoundId.Explosion,
      buffer: { duration: 1.3, sampleRate: 22050, numberOfChannels: 1 },
      when: 4,
      gain: 1,
      rate: 1,
      origin: [10, 20, 30],
      distance: SOUNDS[SoundId.Explosion].distance,
      onEnded: () => {
        ended += 1
      },
    })

    expect(voice.bus).toBe('world')
    expect(voice.when).toBe(4)
    context.sources[0]?.end()
    expect(ended).toBe(1)
    // Stopping an already-finished voice is not a second retirement — the
    // engine's voice count depends on that being true exactly once.
    voice.stop()
    expect(ended).toBe(1)
  })
})
