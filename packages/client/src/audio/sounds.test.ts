import { describe, expect, it } from 'vitest'

import { ALL_SOUNDS, AUDIO_BASE, Bus, SOUNDS, SoundId, allowedOn, soundUrl } from './sounds.ts'

describe('the catalogue', () => {
  it('has an entry for every id, keyed by itself', () => {
    for (const [id, spec] of Object.entries(SOUNDS)) {
      expect(spec.id).toBe(id)
    }
    expect(ALL_SOUNDS).toHaveLength(Object.keys(SoundId).length)
  })

  it('names a file that matches the id', () => {
    for (const spec of ALL_SOUNDS) {
      expect(spec.file).toBe(`${spec.id}.wav`)
    }
  })

  it('serves everything from public/audio', () => {
    expect(soundUrl(SOUNDS[SoundId.Explosion])).toBe(`${AUDIO_BASE}explosion.wav`)
  })

  it('keeps every level under one, so the mix has headroom', () => {
    for (const spec of ALL_SOUNDS) {
      expect(spec.gain).toBeGreaterThan(0)
      expect(spec.gain).toBeLessThanOrEqual(1)
    }
  })

  it('allows every sound on at least one bus', () => {
    for (const spec of ALL_SOUNDS) {
      expect(spec.buses.length).toBeGreaterThan(0)
    }
  })

  /**
   * The three that must never be positional. Each is about *you*: what you just
   * did, what was just done to you, and what the match just did. A distance
   * model on any of them makes it quieter exactly when it matters most.
   */
  it('keeps hit confirmation, damage and the round bells off the world bus', () => {
    for (const id of [SoundId.Hit, SoundId.Damage, SoundId.RoundStart, SoundId.RoundEnd]) {
      expect(allowedOn(SOUNDS[id], Bus.World)).toBe(false)
      expect(allowedOn(SOUNDS[id], Bus.Feedback)).toBe(true)
    }
  })

  it('keeps footsteps off the feedback bus — you never hear your own', () => {
    for (const id of [SoundId.FootstepA, SoundId.FootstepB]) {
      expect(allowedOn(SOUNDS[id], Bus.Feedback)).toBe(false)
      expect(allowedOn(SOUNDS[id], Bus.World)).toBe(true)
    }
  })

  it('lets the weapons and the explosion play either way', () => {
    for (const id of [SoundId.RocketFire, SoundId.RailFire, SoundId.Explosion, SoundId.Land]) {
      expect(allowedOn(SOUNDS[id], Bus.Feedback)).toBe(true)
      expect(allowedOn(SOUNDS[id], Bus.World)).toBe(true)
    }
  })

  it('carries a sane distance model in Quake units', () => {
    for (const spec of ALL_SOUNDS) {
      expect(spec.distance.refDistance).toBeGreaterThan(0)
      expect(spec.distance.maxDistance).toBeGreaterThan(spec.distance.refDistance)
      expect(spec.distance.rolloff).toBeGreaterThan(0)
    }
  })

  it('carries an explosion further than a footstep', () => {
    expect(SOUNDS[SoundId.Explosion].distance.maxDistance).toBeGreaterThan(
      SOUNDS[SoundId.FootstepA].distance.maxDistance,
    )
  })
})
