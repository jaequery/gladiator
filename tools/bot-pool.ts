/**
 * A pool of processes playing matches. GLAD-6BIYFQ.
 *
 * The ticket's constraint is that five hundred headless matches run in
 * CI-acceptable time, and a match is about a tenth of a second of pure
 * arithmetic — no renderer, no clock, no sockets. Fifteen hundred of them is
 * therefore about three minutes on one core and about twenty seconds on eight,
 * and the difference is the whole reason this file exists.
 *
 * ## Processes rather than worker threads
 *
 * `node:worker_threads` would be the obvious choice and it does not work here:
 * this repository's TypeScript is run through `tsx`, whose ESM hooks are
 * registered per thread, and a worker started from a `tsx` parent cannot load a
 * `.ts` file. `child_process.fork` takes `execArgv`, so the child gets its own
 * `--import tsx` and resolves exactly what the parent does.
 *
 * The cost is that nothing is shared, so each worker loads the arena for itself
 * — which is why they are long-lived. A sweep asks for hundreds of evaluations
 * and pays that once.
 *
 * ## The split cannot change the answer
 *
 * Every chunk carries the index of its first match, because the seat swap is
 * `index % 2` (`bot-bands.ts`). Hand a chunk the wrong offset and it plays the
 * swap the other way round, the un-swap puts the wrong bot in `slots[0]`, and
 * the ladder rows quietly become a measurement of seat zero. So the chunking is
 * arithmetic on indices and nothing else, and a pooled run of a seed is the same
 * run as a single-process one.
 */

import { fork } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { availableParallelism } from 'node:os'

import type { TuningSource } from '@gladiator/bot'

import { LADDER_EXPERT, LADDER_NOVICE, addSample, createSampleTally } from './bot-bands.ts'
import type { BandSamples, SampleTally } from './bot-bands.ts'
import type { BandJob, BandResult } from './bot-bands-worker.ts'

/** How many workers to run: every core but two, and at least one. */
export function poolSize(): number {
  const cores = availableParallelism()
  return cores > 3 ? cores - 2 : 1
}

/** The most matches one job is worth. Small enough that the tail is not one worker. */
const CHUNK = 8

export type BandPool = {
  /** Play all three samples of one candidate and return them. */
  run(request: BandRunRequest): Promise<BandSamples>
  close(): void
}

export type BandRunRequest = {
  /** The blob to derive skills from, or `null` for the committed one. */
  readonly tuning: TuningSource | null
  /** The dial for the bot under test. */
  readonly skill: number
  readonly matches: number
  readonly ladderMatches: number
  readonly seed: number
  readonly onProgress?: (done: number, of: number) => void
}

type Pending = {
  readonly job: BandJob
  readonly into: SampleTally
  readonly resolve: () => void
  readonly reject: (error: Error) => void
}

/**
 * Fork `size` workers and keep them.
 *
 * The returned pool must be `close`d; `run` may be called as many times as a
 * sweep needs, and each call queues its own chunks behind whatever is already in
 * flight.
 */
export function createBandPool(size: number = poolSize()): BandPool {
  const workers: ChildProcess[] = []
  const idle: ChildProcess[] = []
  const queue: Pending[] = []
  /** What each worker is currently doing, so a crash can fail the right chunk. */
  const running = new Map<ChildProcess, Pending>()
  let nextId = 0
  let closed = false

  const pump = (): void => {
    while (idle.length > 0 && queue.length > 0) {
      const worker = idle.pop()
      const pending = queue.shift()
      if (worker === undefined || pending === undefined) return
      running.set(worker, pending)
      worker.send(pending.job)
    }
  }

  for (let i = 0; i < size; i += 1) {
    const worker = fork(new URL('./bot-bands-worker.ts', import.meta.url), {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    })
    workers.push(worker)

    worker.on('message', (message: BandResult) => {
      // A worker's first message is its "I am up" beat, with no tally on it.
      if (message.id < 0) {
        idle.push(worker)
        pump()
        return
      }
      const pending = running.get(worker)
      running.delete(worker)
      idle.push(worker)
      if (pending !== undefined) {
        addSample(pending.into, message.tally)
        pending.resolve()
      }
      pump()
    })

    worker.on('error', (error) => {
      const pending = running.get(worker)
      running.delete(worker)
      pending?.reject(error)
    })

    worker.on('exit', (code) => {
      const pending = running.get(worker)
      running.delete(worker)
      if (pending !== undefined && !closed) {
        pending.reject(new Error(`bot-pool: a worker exited with ${code} mid-chunk`))
      }
    })
  }

  const submit = (job: BandJob, into: SampleTally): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      queue.push({ job, into, resolve, reject })
      pump()
    })

  return {
    async run(request: BandRunRequest): Promise<BandSamples> {
      if (closed) throw new Error('bot-pool: the pool is closed')

      const samples: BandSamples = {
        mirror: createSampleTally(),
        novice: createSampleTally(),
        expert: createSampleTally(),
      }

      const plans: { into: SampleTally; against: number; matches: number; seed: number }[] = [
        { into: samples.mirror, against: request.skill, matches: request.matches, seed: request.seed },
        {
          into: samples.novice,
          against: LADDER_NOVICE,
          matches: request.ladderMatches,
          seed: request.seed + 500_000,
        },
        {
          into: samples.expert,
          against: LADDER_EXPERT,
          matches: request.ladderMatches,
          seed: request.seed + 1_000_000,
        },
      ]

      const waiting: Promise<void>[] = []
      let total = 0
      let done = 0
      for (const plan of plans) {
        for (let from = 0; from < plan.matches; from += CHUNK) {
          const matches = Math.min(CHUNK, plan.matches - from)
          total += matches
          const job: BandJob = {
            id: nextId,
            tuning: request.tuning,
            skill: request.skill,
            against: plan.against,
            seed: plan.seed,
            from,
            matches,
          }
          nextId += 1
          waiting.push(
            submit(job, plan.into).then(() => {
              done += matches
              request.onProgress?.(done, total)
            }),
          )
        }
      }

      await Promise.all(waiting)
      return samples
    },

    close(): void {
      closed = true
      for (const worker of workers) worker.kill()
    },
  }
}
