/**
 * The scripted readout.
 *
 * A demo exists to be *looked at*, so what is worth asserting is that one turn
 * of the loop actually reaches everything a reviewer is supposed to review. A
 * script that quietly stopped producing a critical-health frame, or stopped
 * landing a hit, would still look fine on screen and would silently remove the
 * thing the acceptance check asks a person to sign off on. `dummyOpponent.ts`
 * is tested for exactly the same reason.
 */
import { MatchPhase, TICK_INTERVAL_MS, Weapon, weaponDef } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { INITIAL_FEEDBACK, advanceFeedback } from './feedback.ts'
import { DEMO_CYCLE_TICKS, demoMode, demoModel, demoPhaseAt } from './demo.ts'
import { healthTier, matchAnnouncement } from './hudModel.ts'

/** One full turn of the loop, one frame per two sub-steps — a 60 Hz page. */
function cycle(step = 2) {
  const frames = []
  for (let tick = 0; tick < DEMO_CYCLE_TICKS; tick += step) {
    frames.push(demoModel(tick, 0, 0))
  }
  return frames
}

describe('the flag', () => {
  it('is `?hud=demo` and nothing else', () => {
    expect(demoMode('?hud=demo')).toBe(true)
    expect(demoMode('?hud=1')).toBe(false)
    expect(demoMode('?dummy=1')).toBe(false)
    expect(demoMode('')).toBe(false)
  })
})

describe('one turn of the loop', () => {
  const frames = cycle()

  it('reaches every phase of a match', () => {
    const phases = new Set(frames.map((frame) => frame.match.phase))
    expect(phases).toContain(MatchPhase.Live)
    expect(phases).toContain(MatchPhase.Intermission)
    expect(phases).toContain(MatchPhase.Over)
  })

  it('shows both crosshairs and both refire intervals', () => {
    const weapons = new Set(frames.map((frame) => frame.self.weapon))
    expect(weapons).toContain(Weapon.RocketLauncher)
    expect(weapons).toContain(Weapon.Railgun)

    // The rail's stated 1500 ms is 187.5 sub-steps and the simulation rounds
    // it up, so the wait a player actually sees is 188 of them. The HUD shows
    // what the world does, not what the table says.
    const longest = Math.max(...frames.map((frame) => frame.self.cooldownMs))
    expect(longest).toBeCloseTo(weaponDef(Weapon.Railgun).refireTicks * TICK_INTERVAL_MS, 6)
  })

  it('spends the armour and then takes the player critical, without killing them', () => {
    const tiers = new Set(frames.map((frame) => healthTier(frame.self)))
    expect(tiers).toContain('ok')
    expect(tiers).toContain('low')
    expect(tiers).toContain('critical')
    expect(tiers).not.toContain('dead')
    expect(Math.min(...frames.map((frame) => frame.self.armor))).toBe(0)
  })

  it('kills the opponent, twice, and puts the result on the banner', () => {
    expect(Math.min(...frames.map((frame) => frame.opponent.health))).toBe(0)
    const banners = new Set(frames.map((frame) => matchAnnouncement(frame)).filter(Boolean))
    expect(banners).toContain('round won')
    expect(banners).toContain('match won')
  })

  it('counts the score up in the viewer’s own slot', () => {
    const asFirst = demoModel(5900, 0, 0)
    const asSecond = demoModel(5900, 1, 0)
    expect(asFirst.match.wins[0]).toBe(asFirst.match.roundsToWin)
    expect(asFirst.match.wins[1]).toBe(0)
    expect(asSecond.match.wins[1]).toBe(asSecond.match.roundsToWin)
    expect(asSecond.match.wins[0]).toBe(0)
  })

  it('runs the clock down inside every timed phase', () => {
    for (const frame of frames) {
      if (frame.match.phase === MatchPhase.Over) {
        expect(frame.match.remainingMs).toBeNull()
      } else {
        expect(frame.match.remainingMs).toBeGreaterThan(0)
      }
    }
  })

  it('is a pure function of its arguments', () => {
    expect(demoModel(700, 0, 4096)).toEqual(demoModel(700, 0, 4096))
    expect(demoPhaseAt(700)).toEqual(demoPhaseAt(700 + DEMO_CYCLE_TICKS))
  })
})

describe('what the fold makes of it', () => {
  /**
   * The whole reason the script exists: a reviewer has to be able to *see* a
   * hit confirmation and a damage arc. If the demo drives the fold to neither,
   * there is nothing on screen to review.
   */
  it('drives real hit confirmations and real damage arcs through the fold', () => {
    let memory = INITIAL_FEEDBACK
    const hits: number[] = []
    const angles: number[] = []

    for (let tick = 0; tick < 2600; tick += 2) {
      const result = advanceFeedback(memory, demoModel(tick, 0, 0))
      memory = result.memory
      if (result.state.hit === 1) hits.push(tick)
      if (result.state.damage === 1 && result.state.damageAngle !== null) {
        angles.push(Math.round((result.state.damageAngle * 180) / Math.PI))
      }
    }

    // Three shots land in a round, and four blows arrive from four bearings.
    expect(hits.length).toBeGreaterThanOrEqual(3)
    expect(new Set(angles).size).toBeGreaterThanOrEqual(4)
  })

  it('holds the shove long enough that a 60 Hz page cannot step over it', () => {
    // A frame at 60 Hz spans two sub-steps, and a slow one spans more. Sample
    // at four and the arc must still point somewhere, or the indicator is a
    // coin toss on a busy machine.
    let memory = INITIAL_FEEDBACK
    let pointed = 0
    for (let tick = 0; tick < 1000; tick += 4) {
      const result = advanceFeedback(memory, demoModel(tick, 0, 0))
      memory = result.memory
      if (result.state.damage === 1 && result.state.damageAngle !== null) pointed += 1
    }
    expect(pointed).toBeGreaterThanOrEqual(4)
  })
})

describe('the cooldown it draws', () => {
  it('is the real interval of the weapon that fired, counted in real time', () => {
    // Straight after the first rail shot at tick 470.
    const model = demoModel(470, 0, 0)
    expect(model.self.weapon).toBe(Weapon.Railgun)
    expect(model.self.cooldownMs).toBeCloseTo(
      weaponDef(Weapon.Railgun).refireTicks * TICK_INTERVAL_MS,
      6,
    )
    expect(model.self.cooldownFraction).toBe(1)
  })
})
