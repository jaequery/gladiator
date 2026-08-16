/**
 * The band table, as a test. GLAD-6BIYFQ.
 *
 * ## Why this is in `tools/` rather than `packages/bot/test/`
 *
 * Two fences, and both point the same way. Measuring a hit needs ground truth,
 * and `eslint.config.js`'s `GROUND_TRUTH_BANS` refuses `GameState` and
 * `EntityState` anywhere in `packages/bot` outside `perception/` — a harness is
 * *allowed* to be omniscient, because it is the thing checking on the bot, and
 * the place for an omniscient program is on the far side of the fence
 * (`tools/bot-arena.ts` makes the same argument). And `vitest.config.ts` only
 * collects `packages/<name>/src/**`, so a file under `packages/bot/test/` would not
 * have run at all.
 *
 * ## The sample size, and the one place this test is deliberately weaker than
 *   the ticket
 *
 * The acceptance check is the whole table over **five hundred matches**. That is
 * about a minute and a half of wall clock even across a process pool, which is a
 * thing to run from `pnpm bot:bands` and not a thing to put in front of every
 * commit. So this file runs a smaller sample of *exactly the same code*, and the
 * only difference is `n`.
 *
 * Which matters for four of the ten rows and not for the other six. The rows
 * counting rockets have twenty thousand shots behind them even in a small
 * sample and are as tight here as in the full run. The other four are the ones
 * whose denominator is not the rocket count:
 *
 * | Row | Denominator at n=100 | Why the band is unassertable there |
 * | --- | --- | --- |
 * | `vs skill 0.45`, `vs skill 0.80` | 80 matches | ~5.5 points of standard error against a 14-point band |
 * | `railgun accuracy beyond 900 u` | ~40 rails | ~8 points of standard error against a 12-point band |
 * | `mean time to kill` | ~415 rounds | an average sitting a tenth of a second above its floor |
 *
 * A test that fails on the seed is worse than no test — it teaches people to
 * re-run rather than to look. The last two joined this list in GLAD-KN4QRJ,
 * which measured one tuning passing both and failing both on two seeds at this
 * size; they were previously masked by the `SHORTFALL` slack that ticket removed.
 *
 * So at the default size the ladder rows are asserted as what the acceptance
 * check actually claims about them — **the difficulty axis is monotone** — and
 * the other two as an envelope wide enough to catch a railgun that has stopped
 * working or a round that never ends. Set `GLADIATOR_BANDS_MATCHES=500` and
 * every row is asserted against its exact band instead; that is the run the
 * ticket was signed off on, and it is what `pnpm bot:bands` does.
 *
 * ## It plays the matches across a process pool, and falls back if it cannot
 *
 * Two hundred and sixty matches is about a minute inside vitest's transform
 * pipeline and about eight seconds across `tools/bot-pool.ts`, whose children
 * run the same code untransformed. That is the difference between a file
 * somebody runs before every commit and a file somebody starts skipping.
 *
 * The fallback is not defensive programming for its own sake: the pool forks
 * `tsx`, and a sandbox that refuses to fork should get a slow green suite rather
 * than a red one. Either path is the same `sampleBands` over the same seeds —
 * every chunk carries its own starting index, so the seat swap keeps its parity
 * and a pooled run of a seed is the same run as a single-process one.
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { loadMap } from '@gladiator/sim'
import { SHIPPED_SKILL, TUNING, deriveSkill, loadNav } from '@gladiator/bot'
import { describe, expect, it } from 'vitest'

import {
  BAND_SEED,
  LADDER_EXPERT,
  LADDER_NOVICE,
  SIGHT_BEFORE_FRAG_FLOOR,
  bandTable,
  formatBands,
  runBands,
  sightBeforeFrag,
  winRate,
} from './bot-bands.ts'
import type { BandRow, BandSamples } from './bot-bands.ts'
import { createBandPool } from './bot-pool.ts'

/** The mirror sample. Every per-shot row comes out of this one. */
const MATCHES = Number(process.env['GLADIATOR_BANDS_MATCHES'] ?? 100)

/** Each ladder rung. Smaller, because the ladder rows are the cheap ones to be sure of. */
const LADDER = Math.max(20, Math.round(MATCHES * 0.8))

/** Whether the sample is big enough for the win-rate bands to mean anything. */
const FULL = MATCHES >= 400

const map = loadMap(JSON.parse(readFileSync('maps/baked/arena1.json', 'utf8')))
const nav = loadNav(JSON.parse(readFileSync('maps/baked/arena1.nav.json', 'utf8')), map.hash)

async function play(): Promise<BandSamples> {
  const pool = createBandPool()
  try {
    return await pool.run({
      tuning: null,
      skill: TUNING.skill,
      matches: MATCHES,
      ladderMatches: LADDER,
      seed: BAND_SEED,
    })
  } catch {
    return runBands({ map, nav, matches: MATCHES, ladderMatches: LADDER, seed: BAND_SEED })
  } finally {
    pool.close()
  }
}

const samples = await play()
const rows = bandTable(samples)

/** A row by name, so a failing assertion says which one and what it measured. */
function row(name: string): BandRow {
  const found = rows.find((candidate) => candidate.name.startsWith(name))
  if (found === undefined) throw new Error(`no band row starting "${name}"\n${formatBands(rows)}`)
  return found
}

/** The failure message: the whole table, so one broken row shows its neighbours. */
function table(): string {
  return `\n${formatBands(rows)}\n`
}

/**
 * Assert a row is inside its band, printing the whole table if it is not.
 *
 * Every row is asserted against the band the ticket states, with no slack. There
 * was a `SHORTFALL` table here until GLAD-KN4QRJ — three rows that GLAD-6BIYFQ's
 * time box expired one point under, carried as a regression floor rather than as
 * a widened band. All three are inside now, so it is gone: a slack of zero is
 * the ticket's own band, and an exception nobody needs is an exception that
 * quietly becomes the contract.
 */
function inBand(name: string): void {
  const found = row(name)
  const ok = found.value !== null && found.value >= found.low && found.value <= found.high
  expect(
    ok,
    `${found.name} measured ${found.value} over n=${found.sample}, want ${found.low}-${found.high}${table()}`,
  ).toBe(true)
}

/**
 * Assert a row is inside a deliberately looser envelope, for the rows whose
 * denominator is small at the default sample size.
 *
 * The same argument the two ladder rows have always been asserted under, applied
 * to the two rows that turned out to share their problem. `railgun accuracy
 * beyond 900 u` counts only the rails taken past that range — forty of them at a
 * hundred matches, which is eight points of standard error against a twelve-point
 * band — and `mean time to kill` is an average over four hundred rounds sitting a
 * tenth of a second above its floor. Both are measured on the same tuning to pass
 * on one seed and fail on the next at this size, and a test that fails on the
 * seed teaches people to re-run rather than to look.
 *
 * So the exact bands are asserted in the full run (`GLADIATOR_BANDS_MATCHES=500`,
 * which is what `pnpm bot:bands` does and what the acceptance check is), and this
 * is what the small run can actually resolve: a railgun that has stopped working
 * and a round that is over instantly or never.
 */
function nearBand(name: string, low: number, high: number): void {
  const found = row(name)
  const ok = found.value !== null && found.value >= low && found.value <= high
  expect(
    ok,
    `${found.name} measured ${found.value} over n=${found.sample}, want ${low}-${high} at this ` +
      `sample size (its band is ${found.low}-${found.high}, asserted at n>=400)${table()}`,
  ).toBe(true)
}

describe('the sample is worth asserting on', () => {
  it('played every match to a decision', () => {
    for (const sample of [samples.mirror, samples.novice, samples.expert]) {
      expect(sample.unfinished).toBe(0)
      expect(sample.matches).toBeGreaterThan(0)
    }
  })

  it('has enough shots behind the per-shot rows for them to be measurements', () => {
    expect(row('railgun accuracy, all').sample).toBeGreaterThan(80)
    expect(row('rocket direct').sample).toBeGreaterThan(500)
    expect(row('rockets meaningfully dodged').sample).toBeGreaterThan(300)
  })

  it('could attribute all but a handful of explosions to one launch', () => {
    // Two of one shooter's rockets bursting on the same sub-step are counted and
    // excluded rather than guessed at (`bot-bands.ts`). If that were common the
    // dodge row would be a sample of the easy cases.
    expect(samples.mirror.ambiguous).toBeLessThan(samples.mirror.rounds * 0.1)
  })
})

describe('the band table', () => {
  it('spawns and sides are fair', () => {
    // 50% by symmetry — two identical bots on a symmetric map cannot produce
    // anything else, and the ticket says so. It is retained under this name
    // because it is the one thing it does test: if seat 0 were a better place to
    // start than seat 1, this is where that shows up.
    const seat = winRate(samples.mirror)
    expect(seat).not.toBeNull()
    const tolerance = FULL ? 0.04 : 0.1
    expect(Math.abs((seat ?? 0) - 0.5)).toBeLessThanOrEqual(tolerance)
  })

  it.runIf(FULL)('kills in nine to sixteen seconds', () => inBand('mean time to kill'))
  it.skipIf(FULL)('kills in a time that is neither instant nor never', () =>
    nearBand('mean time to kill', 7, 18))

  it('lands 36 to 48% of its rails', () => inBand('railgun accuracy, all'))
  it.runIf(FULL)('lands 28 to 40% of the rails it takes beyond 900 units', () =>
    inBand('railgun accuracy beyond'))
  it.skipIf(FULL)('still lands a plausible share of its long rails', () =>
    nearBand('railgun accuracy beyond', 0.18, 0.52))
  it('puts 14 to 24% of its rockets straight into somebody', () => inBand('rocket direct'))
  it('puts 44 to 58% of them close enough to hurt', () => inBand('rocket splash'))
  it('changes its mind 0.6 to 2.2 times a second', () => inBand('L3 action'))
  it('gets out of the way of 55 to 75% of the rockets that would have hit it', () =>
    inBand('rockets meaningfully dodged'))
})

describe('the difficulty axis is wired to something real', () => {
  const novice = winRate(samples.novice)
  const expert = winRate(samples.expert)

  it('beats the novice rung and loses to the expert one', () => {
    // The claim the acceptance check actually makes, and the one that survives a
    // small sample: `skill` is monotone. The margins are wide enough that the
    // sampling error at the default size cannot produce them by accident and
    // narrow enough that a broken axis cannot pass.
    expect(novice).not.toBeNull()
    expect(expert).not.toBeNull()
    expect(novice ?? 0).toBeGreaterThan(0.55)
    expect(expert ?? 1).toBeLessThan(0.45)
  })

  it('beats the novice rung by more than it beats the expert one', () => {
    expect(novice ?? 0).toBeGreaterThan(expert ?? 1)
  })

  it.runIf(FULL)('wins 68 to 82% against skill 0.45', () => inBand('vs skill 0.45'))
  it.runIf(FULL)('wins 18 to 32% against skill 0.80', () => inBand('vs skill 0.80'))

  it('the rungs are two different bots, not one number in a file', () => {
    // Cheap, and it is what would catch a `deriveSkill` that stopped reading the
    // dial — which would make every row above pass by symmetry and mean nothing.
    const low = deriveSkill(LADDER_NOVICE)
    const high = deriveSkill(LADDER_EXPERT)
    // The floor is *higher* for the better bot on purpose: an expectation is
    // already a function of how good the bot is, so one floor in absolute points
    // refuses most of a novice's rockets and almost none of an expert's, and
    // amplifies the difference between the rungs instead of measuring it.
    // `combat/rocketDiscipline.ts`.
    expect(high.rocketDamageFloor).toBeGreaterThan(low.rocketDamageFloor)
    expect(high.reactionMinMs).toBeLessThan(low.reactionMinMs)
    expect(high.tremorUnits).toBeLessThan(low.tremorUnits)
    expect(high.aimErrorFraction).toBeLessThan(low.aimErrorFraction)
    expect(high.dodgeHorizonSeconds).toBeGreaterThan(low.dodgeHorizonSeconds)
    expect(high.leadStraightness).toBeLessThan(low.leadStraightness)
  })

  it('ships one difficulty, and it is between the two rungs', () => {
    expect(SHIPPED_SKILL.skill).toBe(TUNING.skill)
    expect(TUNING.skill).toBeGreaterThan(LADDER_NOVICE)
    expect(TUNING.skill).toBeLessThan(LADDER_EXPERT)
  })
})

describe('the bot only kills people it could see', () => {
  it('had a second of line of sight before at least 85% of its frags', () => {
    // The fourth acceptance check, and the one that is not a band: it is looking
    // for a perception leak, and there is no such thing as too many fair kills.
    // Traced against the map rather than read off the `WorldModel`, because a
    // leak would be invisible to a check that asked the perception layer.
    const share = sightBeforeFrag(samples.mirror)
    expect(share).not.toBeNull()
    expect(share ?? 0).toBeGreaterThanOrEqual(SIGHT_BEFORE_FRAG_FLOOR)
  })
})
