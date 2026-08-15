/**
 * `pnpm bot:sweep` — coordinate descent over `packages/bot/src/tuning.json`.
 * GLAD-6BIYFQ.
 *
 * The ticket is explicit that this is a parameter search rather than a coding
 * task, and that **hitting a target distribution has no upper bound on
 * iterations**, so the deliverable constraint is the time box rather than the
 * result. That shapes everything here:
 *
 * - `--minutes` is the *contract*. When it expires the sweep stops mid-axis,
 *   writes the best configuration it found, and says so. It never runs to
 *   convergence, because convergence is not a thing that was promised.
 * - It is monotone in the score by construction: a move is only kept if the
 *   table got closer, so the file on disk at the end is at least as good as the
 *   file at the start. A sweep that ran out of time early is a sweep that made
 *   fewer improvements, not one that made things worse.
 *
 * ## Coordinate descent, and why not something cleverer
 *
 * One parameter at a time, try it up and try it down, keep the better of the
 * three, move on; shrink the steps and go round again. It is the simplest thing
 * that works on a noisy objective, it needs no gradient — there is none — and
 * every step it takes is a sentence a person can read: "reaction floor 190 to
 * 175, table error 2.4 to 1.9".
 *
 * The objective is noisy, which is the one thing to be careful about. A hundred
 * matches gives a win rate with about five points of standard error, and a move
 * of half a point is indistinguishable from luck. Two defences: every candidate
 * plays *the same seeds* (so two candidates differ by the parameter and not by
 * the matches), and a move has to beat the incumbent by {@link MIN_GAIN} rather
 * than merely beat it.
 *
 * ## What it may move, and what it may not
 *
 * Everything in `tuning.json` except the turn rate and the aim acceleration.
 * Those two are the *arm* rather than the skill, they are consumed by a
 * module-level servo rather than carried per bot (`aim/controller.ts`), and a
 * sweep that could raise the turn rate would be a sweep that could tune the bot
 * into a turret.
 *
 * Perception is not in the file at all, which is the stronger version of the
 * same fence: there is no value of any knob here that lets the bot see further.
 */

import { writeFileSync } from 'node:fs'
import process from 'node:process'

import { TUNING } from '@gladiator/bot'
import type { TuningSource } from '@gladiator/bot'

import { BAND_SEED, bandTable, formatBands, tableError } from './bot-bands.ts'
import { createBandPool } from './bot-pool.ts'
import type { BandPool } from './bot-pool.ts'

/* --------------------------------------------------------------------------
 * The search space
 * ----------------------------------------------------------------------- */

/** One knob: where it lives in the blob, how far to move it, and how far it may go. */
export type Knob = {
  /** `skill`, `axis.<name>.<end>` or `fixed.<name>`. */
  readonly path: string
  /** The first step size. Halved each round. */
  readonly step: number
  readonly min: number
  readonly max: number
}

/**
 * The knobs, in the order they are visited.
 *
 * Ordered by how much they move the table, loosely, so that a sweep cut short by
 * the time box has spent it on the parameters that matter. The tremor is first
 * because it is the only thing that moves the railgun rows at all, and the
 * railgun rows were the two furthest out when this was written.
 */
export const KNOBS: readonly Knob[] = [
  { path: 'fixed.engageRange', step: 50, min: 150, max: 1200 },
  { path: 'fixed.railMinRange', step: 80, min: 300, max: 2000 },
  { path: 'axis.tremorUnits.expert', step: 60, min: 0, max: 4000 },
  { path: 'axis.tremorUnits.novice', step: 120, min: 0, max: 6000 },
  { path: 'fixed.leadMaxSeconds', step: 0.1, min: 0.1, max: 1.5 },
  { path: 'axis.leadStraightness.expert', step: 0.06, min: 0, max: 1 },
  { path: 'axis.leadStraightness.novice', step: 0.08, min: 0, max: 1 },
  { path: 'fixed.selfSplashAllowance', step: 6, min: 0, max: 60 },
  { path: 'axis.dodgeHorizonSeconds.expert', step: 0.1, min: 0.1, max: 2 },
  { path: 'axis.dodgeHorizonSeconds.novice', step: 0.08, min: 0.05, max: 2 },
  { path: 'fixed.dodgeDangerMargin', step: 12, min: 0, max: 120 },
  { path: 'axis.aimErrorFraction.expert', step: 0.04, min: 0, max: 1 },
  { path: 'axis.aimErrorFraction.novice', step: 0.06, min: 0, max: 1.5 },
  { path: 'axis.reactionMinMs.expert', step: 15, min: 140, max: 400 },
  { path: 'axis.reactionMinMs.novice', step: 20, min: 140, max: 600 },
  { path: 'axis.reactionSpreadMs.expert', step: 15, min: 20, max: 400 },
  { path: 'axis.reactionSpreadMs.novice', step: 20, min: 20, max: 600 },
  { path: 'axis.railSettleUnits.expert', step: 12, min: 5, max: 400 },
  { path: 'axis.railSettleUnits.novice', step: 20, min: 5, max: 600 },
  { path: 'axis.railSettleRate.expert', step: 12, min: 5, max: 400 },
  { path: 'axis.railSettleRate.novice', step: 20, min: 5, max: 600 },
  { path: 'axis.motorError.expert', step: 0.05, min: 0, max: 0.9 },
  { path: 'axis.motorError.novice', step: 0.06, min: 0, max: 0.9 },
  { path: 'fixed.maxAimError', step: 16, min: 0, max: 400 },
  { path: 'fixed.rocketToleranceMaxDegrees', step: 1.5, min: 1, max: 30 },
  { path: 'skill', step: 0.03, min: 0.1, max: 0.95 },
]

/**
 * How much better a move has to be before it is believed.
 *
 * Larger than it looks like it should be, and the reason is the win-rate rows: a
 * ninety-match ladder sample has about five points of standard error, its band is
 * fourteen points wide, so a row that has not moved at all still wobbles by
 * around a third of a band width between evaluations. A threshold under that is
 * a sweep that spends its box chasing noise and reports moves it cannot
 * reproduce.
 */
export const MIN_GAIN = 0.06

/** How many times the step sizes are halved before the sweep gives up on its own. */
export const ROUNDS = 3

/* --------------------------------------------------------------------------
 * Reading and writing a knob
 * ----------------------------------------------------------------------- */

type Blob = Record<string, unknown>

function read(source: TuningSource, path: string): number {
  let node: unknown = source
  for (const key of path.split('.')) {
    node = (node as Blob)[key]
  }
  if (typeof node !== 'number') throw new TypeError(`bot-sweep: ${path} is not a number`)
  return node
}

/** A copy of `source` with `path` set to `value`. Structural, so nothing is shared. */
function withValue(source: TuningSource, path: string, value: number): TuningSource {
  const copy = JSON.parse(JSON.stringify(source)) as Blob
  const keys = path.split('.')
  let node = copy
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i]
    if (key === undefined) break
    node = node[key] as Blob
  }
  const last = keys[keys.length - 1]
  if (last !== undefined) node[last] = value
  return copy as unknown as TuningSource
}

/* --------------------------------------------------------------------------
 * The loop
 * ----------------------------------------------------------------------- */

export type SweepOptions = {
  readonly pool: BandPool
  readonly matches: number
  readonly ladderMatches: number
  readonly seed: number
  /** The time box, in milliseconds. The contract; see the header. */
  readonly budgetMs: number
  readonly startedAt: number
  readonly log: (line: string) => void
}

async function score(options: SweepOptions, tuning: TuningSource): Promise<number> {
  const samples = await options.pool.run({
    tuning,
    skill: tuning.skill,
    matches: options.matches,
    ladderMatches: options.ladderMatches,
    seed: options.seed,
  })
  return tableError(bandTable(samples))
}

function expired(options: SweepOptions): boolean {
  return Date.now() - options.startedAt >= options.budgetMs
}

/**
 * Descend, one knob at a time, until the table stops improving or the box runs
 * out. Returns the best configuration found and its score.
 */
export async function sweep(
  options: SweepOptions,
  start: TuningSource,
): Promise<{ best: TuningSource; error: number; evaluations: number }> {
  let best = start
  let error = await score(options, best)
  let evaluations = 1
  options.log(`start: table error ${error.toFixed(3)}`)

  for (let pass = 0; pass < ROUNDS; pass += 1) {
    const shrink = 1 / 2 ** pass
    let improved = false

    for (const knob of KNOBS) {
      if (expired(options)) {
        options.log(`the box expired mid-round ${pass + 1}; keeping the best so far`)
        return { best, error, evaluations }
      }

      const current = read(best, knob.path)
      const step = knob.step * shrink

      for (const candidate of [current + step, current - step]) {
        if (candidate < knob.min || candidate > knob.max) continue
        const trial = withValue(best, knob.path, tidy(candidate))
        const trialError = await score(options, trial)
        evaluations += 1
        if (trialError < error - MIN_GAIN) {
          options.log(
            `${knob.path}: ${current} -> ${tidy(candidate)}, table error ${error.toFixed(3)} -> ${trialError.toFixed(3)}`,
          )
          best = trial
          error = trialError
          improved = true
          break
        }
      }
    }

    if (!improved) {
      options.log(`round ${pass + 1} moved nothing; the steps are as small as they usefully get`)
      break
    }
  }

  return { best, error, evaluations }
}

/** Six decimal places, so the committed file is readable rather than a float dump. */
function tidy(value: number): number {
  return Math.round(value * 1e6) / 1e6
}

/* --------------------------------------------------------------------------
 * The CLI
 * ----------------------------------------------------------------------- */

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

const TUNING_PATH = 'packages/bot/src/tuning.json'

async function main(): Promise<void> {
  const matches = number('matches', 120)
  const ladderMatches = number('ladder', 90)
  const seed = number('seed', BAND_SEED + 7919)
  const minutes = number('minutes', 20)
  const write = process.argv.includes('--write')

  const pool = createBandPool()
  const startedAt = Date.now()
  const options: SweepOptions = {
    pool,
    matches,
    ladderMatches,
    seed,
    budgetMs: minutes * 60_000,
    startedAt,
    log: (line) => process.stdout.write(`${line}\n`),
  }

  process.stdout.write(
    `sweeping ${KNOBS.length} knobs, ${matches} mirror + ${ladderMatches} per rung an evaluation, ${minutes} minute box\n` +
      `the sweep's own seed is ${seed}, deliberately not the committed ${BAND_SEED} — tuning against the seed the\n` +
      `acceptance check is measured on would be fitting the sample rather than the bot\n\n`,
  )

  try {
    const { best, error, evaluations } = await sweep(options, TUNING)
    const elapsed = (Date.now() - startedAt) / 60_000

    process.stdout.write(`\n${evaluations} evaluations in ${elapsed.toFixed(1)} minutes\n`)
    process.stdout.write(`best table error ${error.toFixed(3)}\n\n`)
    process.stdout.write(`${JSON.stringify(best, null, 2)}\n\n`)

    // Confirm the winner on the committed seed, which is the one the acceptance
    // check uses and the one the sweep was deliberately not allowed to see.
    const confirm = await pool.run({
      tuning: best,
      skill: best.skill,
      matches: matches * 2,
      ladderMatches: ladderMatches * 2,
      seed: BAND_SEED,
    })
    process.stdout.write(`on the committed seed ${BAND_SEED}:\n${formatBands(bandTable(confirm))}\n`)

    if (write) {
      writeFileSync(TUNING_PATH, `${JSON.stringify(best, null, 2)}\n`)
      process.stdout.write(`\nwritten to ${TUNING_PATH}\n`)
    } else {
      process.stdout.write(`\n(--write to save it to ${TUNING_PATH})\n`)
    }
  } finally {
    pool.close()
  }
}

await main()
