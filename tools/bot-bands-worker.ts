/**
 * One process of a band-table run. GLAD-6BIYFQ.
 *
 * Forked by `tools/bot-pool.ts`, loads the arena once, and then answers chunk
 * requests over IPC until it is killed. Long-lived on purpose: a sweep asks for
 * hundreds of evaluations, and paying `tsx`'s start-up and the map load for each
 * one would cost more than the matches do.
 *
 * It plays *the same code* the single-process path plays — `sampleBands` from
 * `bot-bands.ts`, handed the chunk's own starting index so the seat swap keeps
 * its parity. A pooled run and a single-process run of the same seed therefore
 * produce the same numbers, and `bot-bands.test.ts` is what makes that a claim
 * rather than an intention.
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { loadMap } from '@gladiator/sim'
import { deriveSkill, loadNav } from '@gladiator/bot'
import type { TuningSource } from '@gladiator/bot'

import { sampleBands } from './bot-bands.ts'
import type { SampleTally } from './bot-bands.ts'

/** One chunk of one sample. */
export type BandJob = {
  readonly id: number
  /** The blob to derive both skills from, or `null` for the committed one. */
  readonly tuning: TuningSource | null
  /** The dial for the bot under test. */
  readonly skill: number
  /** The dial for its opponent. */
  readonly against: number
  readonly seed: number
  readonly from: number
  readonly matches: number
}

export type BandResult = {
  readonly id: number
  readonly tally: SampleTally
}

const map = loadMap(JSON.parse(readFileSync('maps/baked/arena1.json', 'utf8')))
const nav = loadNav(JSON.parse(readFileSync('maps/baked/arena1.nav.json', 'utf8')), map.hash)

process.on('message', (job: BandJob) => {
  const source = job.tuning ?? undefined
  const tally = sampleBands({
    map,
    nav,
    matches: job.matches,
    from: job.from,
    seed: job.seed,
    skills: [deriveSkill(job.skill, source), deriveSkill(job.against, source)],
  })
  process.send?.({ id: job.id, tally } satisfies BandResult)
})

// The parent holds the only reference to this process's lifetime. Without this
// the channel keeps the event loop alive, which is exactly what is wanted — the
// worker exits when the pool closes it.
process.send?.({ id: -1, tally: null } as unknown as BandResult)
