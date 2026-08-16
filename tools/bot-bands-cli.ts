/**
 * `pnpm bot:bands` — play the sample and print the band table. GLAD-6BIYFQ.
 *
 * The full run is five hundred matches in each of the three samples, which is
 * minutes rather than seconds; `--matches` is there for the loop a person is
 * actually in while tuning. The test (`tools/bot-bands.test.ts`) runs a smaller
 * sample of the same code, so a green test and a green CLI cannot disagree about
 * what passing means — the only difference between them is `n`.
 *
 * `--skill` plays a bot at some other rung of the ladder against the same two
 * opponents, which is how the monotonicity claim was checked by hand before it
 * was a test.
 */

import process from 'node:process'

import { SHIPPED_SKILL, TUNING, deriveSkill } from '@gladiator/bot'

import {
  BAND_SEED,
  SIGHT_BEFORE_FRAG_FLOOR,
  bandTable,
  formatBands,
  formatSample,
  sightBeforeFrag,
} from './bot-bands.ts'
import { createBandPool } from './bot-pool.ts'

function flag(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`)
  if (at < 0) return null
  return process.argv[at + 1] ?? null
}

function number(name: string, fallback: number): number {
  const raw = flag(name)
  if (raw === null) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new RangeError(`--${name} must be a number, got ${raw}`)
  return value
}

const matches = number('matches', 500)
const ladderMatches = number('ladder', matches)
const seed = number('seed', BAND_SEED)
const skillDial = flag('skill')
const skill = skillDial === null ? SHIPPED_SKILL : deriveSkill(Number(skillDial))

// The arena is loaded by each pool worker rather than here — nothing in this
// process plays a match, so nothing in it needs a map.
process.stdout.write(
  `skill ${skill.skill.toFixed(3)} (shipped ${TUNING.skill}), ${matches} mirror matches, ${ladderMatches} per ladder rung, seed ${seed}\n`,
)

const started = Date.now()
// Across a pool of processes, because five hundred matches in each of three
// samples is minutes on one core and seconds on eight, and the ticket's
// constraint is that this runs in CI-acceptable time. It is the same code either
// way: `tools/bot-pool.ts` hands each chunk its own starting index so the seat
// swap keeps its parity, and a pooled run of a seed is the same run as a
// single-process one (`runBands`, which is what the test uses).
const pool = createBandPool()
let ticks = 0
const samples = await pool
  .run({
    tuning: skillDial === null ? null : TUNING,
    skill: skill.skill,
    matches,
    ladderMatches,
    seed,
    onProgress: (done, of) => {
      const step = Math.max(1, Math.round(of / 40))
      if (done - ticks >= step || done === of) {
        ticks = done
        process.stdout.write(`${done}/${of} `)
      }
    },
  })
  .finally(() => pool.close())
const elapsed = (Date.now() - started) / 1000

process.stdout.write('\n\n')
process.stdout.write(`${formatSample('mirror', samples.mirror)}\n`)
process.stdout.write(`${formatSample('vs 0.45', samples.novice)}\n`)
process.stdout.write(`${formatSample('vs 0.80', samples.expert)}\n\n`)

const rows = bandTable(samples)
process.stdout.write(`${formatBands(rows)}\n`)

const sight = sightBeforeFrag(samples.mirror)
const sightPass = sight !== null && sight >= SIGHT_BEFORE_FRAG_FLOOR
process.stdout.write(
  `${sightPass ? 'pass' : 'FAIL'}  frags with a second of sight first         ${sight === null ? '-' : `${(sight * 100).toFixed(1)}%`}  want >=${(SIGHT_BEFORE_FRAG_FLOOR * 100).toFixed(0)}%\n`,
)

const failed = rows.filter((row) => !row.pass).length + (sightPass ? 0 : 1)
process.stdout.write(`\n${failed} of ${rows.length + 1} checks outside their band, in ${elapsed.toFixed(1)} s\n`)
process.exitCode = failed === 0 ? 0 : 1
