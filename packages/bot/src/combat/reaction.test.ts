/**
 * How long the bot takes to shoot at somebody who has just appeared.
 * GLAD-HK3ATM's first acceptance check.
 *
 * The number is measured end to end and through the real perception layer: the
 * clock starts on the sub-step `perception/sight.ts` first reports the opponent
 * visible, and stops on the sub-step the bot's `UserCmd` first carries
 * `BUTTON_ATTACK`. Nothing in between is stubbed — the servo has to have arrived,
 * the shot has to have been planned, and the self-damage guard has to have let it
 * through. Measuring `readyTick` instead would be asking the reaction model
 * whether it thinks it is working.
 *
 * ## Why the scenario is what it is
 *
 * The opponent starts sealed in the far chamber, so the bot has never seen them
 * and the reaction is a genuine acquisition rather than a re-acquisition. They
 * appear 500 units dead ahead, which is inside `ENGAGE_RANGE` (so the bot holds
 * its ground and the movement layer contributes nothing) and inside
 * `RAIL_MIN_RANGE` (so the shot is a rocket, and the rail's settle gate — a
 * separate check, `railDiscipline.test.ts` — is not in the measurement).
 *
 * They appear on the bearing the bot is already facing. That is not making it
 * easy: it is removing the *turn* from a measurement that is about the reaction,
 * since a bot that had to spin 180 degrees would be measuring
 * `MAX_TURN_UNITS` instead. The servo still has a pitch error to close and still
 * has to be inside `rocketTolerance` before the trigger will go down.
 */

import { BUTTON_ATTACK, TICK_INTERVAL_MS } from '@gladiator/sim'
import type { Vec3 } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { FLOOR, createArena, place, runBot } from '../perception/fixture.ts'
import { REACTION_MIN_MS, REACTION_SPREAD_MS } from '../aim/error.ts'

/** Sealed in the far chamber: no sight line, and standing still makes no noise. */
const HIDDEN: Vec3 = [0, 700, FLOOR]

/** Where the bot stands, facing `+y`. */
const BOT: Vec3 = [0, -600, FLOOR]

/** 500 units dead ahead of it, on the bot's own side of the divider. */
const APPEARS: Vec3 = [0, -100, FLOOR]

/** The sub-step the opponent turns up on. Far enough in for the bot to be settled. */
const REVEAL_STEP = 20

/** Long enough for the slowest reaction in the band, with room to spare. */
const STEPS = 90

/** The acceptance check's own sample size. */
const TRIALS = 1000

/**
 * One trial: the delay in sub-steps between the two events, or `-1` if either
 * never happened.
 */
function trial(seed: number): number {
  const arena = createArena({
    seed,
    botOrigin: BOT,
    botYawDegrees: 90,
    enemyOrigin: HIDDEN,
    terrain: true,
  })

  let visible = -1
  let attacked = -1
  runBot(arena, STEPS, {
    before: (a, step) => {
      if (step === REVEAL_STEP) place(a.enemy, APPEARS)
    },
    after: (a, step, cmd) => {
      if (visible < 0 && a.bot.worldModel.enemy.visible) visible = step
      if (attacked < 0 && (cmd.buttons & BUTTON_ATTACK) !== 0) attacked = step
    },
  })

  return visible < 0 || attacked < 0 ? -1 : attacked - visible
}

describe('the reaction, over a thousand acquisitions', () => {
  const delays: number[] = []
  for (let seed = 0; seed < TRIALS; seed += 1) delays.push(trial(seed) * TICK_INTERVAL_MS)

  it('shot every time, so the bounds below are about a thousand reactions', () => {
    expect(delays).toHaveLength(TRIALS)
    expect(delays.filter((ms) => ms < 0)).toHaveLength(0)
  })

  it('never reacts faster than 140 ms', () => {
    // A hard floor, in 100% of trials, rather than a percentile: a bot that beat
    // human reaction one time in a hundred would be a bot that occasionally
    // knew. `aim/error.ts` rounds the draw *up* into sub-steps for this reason,
    // so the realised floor is 144 ms rather than 136.
    expect(Math.min(...delays)).toBeGreaterThanOrEqual(REACTION_MIN_MS)
  })

  it('is competent but mortal, whatever the tuning moved the band to', () => {
    // The band itself, rather than the sample. Both ends of it moved in
    // GLAD-6BIYFQ and both may move again — what may not move is that the bot
    // never beats a person off the mark and never reads as asleep.
    //
    // Both bounds are anchored rather than chosen. **140 ms** is the
    // simple-visual-reaction floor `aim/error.ts` argues, and nothing at any
    // difficulty may go under it. **500 ms** is the slow end of Quake 3's own
    // `reactiontime` characteristic, which is the prior art this model was built
    // against; the shipped bot's mean landed at about 316 ms, which is a
    // competent player having a normal day rather than a machine.
    expect(REACTION_MIN_MS).toBeGreaterThanOrEqual(140)
    expect(REACTION_MIN_MS + REACTION_SPREAD_MS / 2).toBeLessThanOrEqual(500)
  })

  it('averages the middle of the band', () => {
    // The draw is uniform, so a thousand of them should land on the midpoint —
    // which is the claim that the *sample* is the band rather than some corner
    // of it. The tolerance is one sub-step, which is the rounding the draw does
    // on its way into whole ticks, plus a sampling allowance.
    const mean = delays.reduce((total, ms) => total + ms, 0) / delays.length
    const midpoint = REACTION_MIN_MS + REACTION_SPREAD_MS / 2
    expect(Math.abs(mean - midpoint)).toBeLessThanOrEqual(TICK_INTERVAL_MS * 1.5)
  })

  it('spans the whole band rather than sitting on one value', () => {
    // Without this the bounds above would pass on a constant. The draw is
    // uniform over `[REACTION_MIN_MS, + REACTION_SPREAD_MS)`, so the realised
    // spread should be most of it — and the ceiling is one sub-step over the top
    // of the band, because the draw is rounded *up* into whole ticks.
    const spread = Math.max(...delays) - Math.min(...delays)
    expect(spread).toBeGreaterThan(REACTION_SPREAD_MS * 0.75)
    expect(Math.max(...delays)).toBeLessThanOrEqual(
      REACTION_MIN_MS + REACTION_SPREAD_MS + TICK_INTERVAL_MS,
    )
  })
})
