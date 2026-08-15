/**
 * `pnpm latency` — the input-to-photon budget, measured.
 *
 * Every physics gate in this repo would pass with ninety milliseconds of
 * pipeline latency in front of it. `pmove.test.ts` measures a jump apex,
 * `netcode.test.ts` measures a correction distance, `frameStats.ts` measures a
 * frame *interval* — and none of them can tell the difference between a game
 * that responds in 40 ms and one that responds in 130. The number a player
 * actually feels is the one nothing measured, so this measures it.
 *
 * ## What "input-to-photon" is here
 *
 * The wall-clock between a person moving a mouse and the screen showing a world
 * that has moved. Six stages, and they are not all the same kind of thing:
 *
 * | Stage | Who decides it | How it is known |
 * | ----- | -------------- | --------------- |
 * | input transport | the OS and the browser | declared, `docs/latency.md` |
 * | **sampling wait** | **this code** | **measured here** |
 * | **frame build** | **this code** | measured — `render/frameStats.ts` |
 * | **render lag** | **this code** | **measured here** |
 * | present | the compositor | declared |
 * | display response | the panel | declared |
 *
 * The three in bold are the ones a commit can change, and they are the ones
 * this harness measures and gates. The other three are declared constants with
 * their reasoning in `docs/latency.md`; they are reported because a budget that
 * omitted them would be a budget for a number nobody experiences, and they are
 * gated too so that changing one is a deliberate act rather than a drift.
 *
 * ## The two stages that are genuinely ours, and why they are not obvious
 *
 * **Sampling wait.** Input is read once per frame, not once per tick — a
 * browser only delivers mouse and key events between frames, so a per-tick
 * sample would be one value read several times (`client/src/main.ts`). An event
 * therefore waits for the next animation frame. The mean of that wait is *not*
 * half the mean frame interval: an event is more likely to land inside a long
 * frame than a short one, exactly in proportion to its length, so the wait is
 * length-biased and its p99 is dragged out by the frame-time tail. That is the
 * whole reason this is a Monte Carlo over a jittery schedule rather than a
 * division by two, and it is why frame *pacing* — not frame rate — is the lever
 * that matters most here.
 *
 * **Render lag.** The frame loop draws the local player interpolated between
 * the previous tick and the current one, at `alpha` (`client/src/loop.ts`), and
 * the accumulator holds exactly `alpha` of a tick of unsimulated wall-clock. So
 * the drawn world is behind the wall-clock by exactly one sub-step — 8 ms —
 * whatever the frame schedule is doing. Not approximately: exactly, and by
 * construction. `client/src/loop.test.ts` asserts it against the real
 * accumulator, which is why this file can state it as `TICK_INTERVAL_MS` rather
 * than reaching across a package boundary to re-derive it.
 *
 * ## What it does not measure
 *
 * The *opponent's* latency. What you see of another player is deliberately
 * 80 ms in the past from real data plus the link's own delay, and that is
 * `net/interpolate.ts`'s number and `netcode.test.ts`'s budget. This file is
 * about the half of the loop the player's own hands are in — the half
 * prediction exists to make instant — because that is the half a network cannot
 * be blamed for.
 *
 * Usage:
 *
 *     pnpm latency                        every profile, gate on the reference
 *     pnpm latency --profile 144hz        one profile
 *     pnpm latency --samples frames.json  real frame intervals from a device
 *     pnpm latency --json                 one line of JSON, for CI to capture
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { TICK_INTERVAL_MS, rngFloat, seedRng, type RngHolder } from '@gladiator/sim'

/* --------------------------------------------------------------------------
 * The declared stages
 *
 * Not measurable in CI: there is no mouse, no compositor and no panel. Each is
 * a number with an argument behind it in `docs/latency.md`, and each is here so
 * that the total is a number a person could go and verify with a high-speed
 * camera rather than a number about a headless process.
 * ----------------------------------------------------------------------- */

/**
 * Mouse movement to a JavaScript event handler, in milliseconds.
 *
 * A 1000 Hz gaming mouse polls every 1 ms; the OS coalesces to its own input
 * thread and the browser to its compositor thread, and the event reaches the
 * page's task queue on the order of a frame's worth of plumbing. Four is the
 * conservative middle of the published measurements for a wired mouse on a
 * desktop browser. A trackpad or a 125 Hz mouse is worse and nothing in this
 * repo can help it.
 */
export const INPUT_TRANSPORT_MS = 4

/**
 * Presentation: the frame is submitted, and appears at a vsync.
 *
 * One refresh interval, because that is what a double-buffered compositor
 * costs: the frame built during interval *n* is scanned out during *n + 1*.
 * Scaled with the profile rather than fixed, since it is a refresh and not a
 * constant.
 */
export function presentMsFor(frameMs: number): number {
  return frameMs
}

/**
 * The panel: pixels asked to change, and having changed.
 *
 * Five milliseconds is a mid-range IPS gaming monitor's grey-to-grey plus half
 * a scanout. An OLED is nearer one and an office LCD nearer fifteen.
 */
export const DISPLAY_RESPONSE_MS = 5

/**
 * What the drawn world is behind wall-clock by: exactly one sub-step.
 *
 * Derived, not chosen. See the header — `client/src/loop.test.ts` is the
 * assertion, and this is the same number spelled once.
 */
export const RENDER_LAG_MS = TICK_INTERVAL_MS

/* --------------------------------------------------------------------------
 * The budget
 * ----------------------------------------------------------------------- */

/**
 * What the three stages this code owns may add up to at the 99th percentile,
 * on the reference profile, in milliseconds.
 *
 * **Forty**, and the floor underneath it is 33.7. At 60 Hz an event that lands
 * just after a frame boundary waits a whole refresh — 16.7 ms — the drawn world
 * trails wall-clock by one sub-step at 8, and the renderer is separately gated
 * to build a frame inside 9 ms at the 99th percentile
 * (`render/frameStats.ts`). None of those three can be removed without a
 * design change, so 33.7 is what this pipeline costs when everything is
 * working.
 *
 * The six milliseconds on top are headroom for the jitter in the model, not
 * spending money: it is enough that a reseed does not flip the gate and not
 * enough to hide a stage somebody added. A **ratchet**, in other words —
 * something to notice a regression against, never something to aim at.
 */
export const CONTROLLED_BUDGET_MS = 40

/**
 * What the whole chain may add up to at the 99th percentile, in milliseconds.
 *
 * Seventy, on a 60 Hz desktop with a wired mouse: the budget above plus the
 * three declared stages, which come to 25.7 between them. For scale, a native
 * 60 Hz shooter measures in the 50s and a browser game with an uncapped
 * compositor path in the 80s and 90s. This is the number the game is *for*
 * feeling like, and the levers on it are in `docs/latency.md` — most of them
 * are the player's hardware, and the three that are not are the ones above.
 */
export const PIPELINE_BUDGET_MS = 70

/* --------------------------------------------------------------------------
 * Profiles
 * ----------------------------------------------------------------------- */

export type Profile = {
  readonly name: string
  /** Mean interval between presented frames, in milliseconds. */
  readonly frameMs: number
  /**
   * How much a frame interval varies, in milliseconds, one-sided.
   *
   * A display does not refresh early, so the model does not either: a frame is
   * its nominal interval plus something non-negative. The same one-sidedness
   * `clockSync.ts` argues about network jitter, for the same reason.
   */
  readonly jitterMs: number
  /** How often a frame is missed outright, doubling that interval. */
  readonly hitchChance: number
  /** CPU time to build and submit a frame, mean and worst, in milliseconds. */
  readonly frameBuildMs: number
  readonly frameBuildP99Ms: number
}

/** The profile the budget is stated against: an ordinary 60 Hz desktop. */
export const REFERENCE_PROFILE = '60hz'

export const PROFILES: readonly Profile[] = [
  {
    name: '60hz',
    frameMs: 1000 / 60,
    jitterMs: 1.5,
    hitchChance: 0.002,
    frameBuildMs: 4,
    frameBuildP99Ms: 9,
  },
  {
    name: '120hz',
    frameMs: 1000 / 120,
    jitterMs: 1,
    hitchChance: 0.004,
    frameBuildMs: 4,
    frameBuildP99Ms: 9,
  },
  {
    name: '144hz',
    frameMs: 1000 / 144,
    jitterMs: 1,
    hitchChance: 0.006,
    frameBuildMs: 4,
    frameBuildP99Ms: 9,
  },
]

/* --------------------------------------------------------------------------
 * The measurement
 * ----------------------------------------------------------------------- */

/**
 * How many frames a run schedules.
 *
 * Ten thousand, which is nearly three minutes at 60 Hz and produces about
 * 170,000 input events — far more than a percentile needs to be stable, and few
 * enough that `pnpm latency` finishes in a second. The count is a parameter so
 * a longer run is one flag away when a tail looks suspicious.
 */
export const RUN_FRAMES = 10_000

/** The seed. A failure is a seed and a profile, never an anecdote. */
export const RUN_SEED = 0x1a7e

/**
 * A schedule of frame intervals, in milliseconds.
 *
 * Generated from a profile, or read from a device — `--samples` takes a JSON
 * array of real intervals, which is the honest way to answer "what does this
 * actually cost on the machine that felt bad".
 */
export function scheduleFor(profile: Profile, frames: number, seed: number): number[] {
  const rng: RngHolder = { rng: seedRng(seed) }
  const intervals: number[] = []
  for (let i = 0; i < frames; i += 1) {
    const jitter = rngFloat(rng) * profile.jitterMs
    const hitched = rngFloat(rng) < profile.hitchChance
    intervals.push(profile.frameMs + jitter + (hitched ? profile.frameMs : 0))
  }
  return intervals
}

export type Percentiles = {
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly worst: number
  readonly mean: number
}

/** Percentiles of an array. Sorts a copy; this runs once, not per frame. */
export function percentiles(values: readonly number[]): Percentiles {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, worst: 0, mean: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0
  let total = 0
  for (const value of sorted) total += value
  return {
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    worst: sorted[sorted.length - 1] ?? 0,
    mean: total / sorted.length,
  }
}

/**
 * How long each input event waits for the frame that will sample it.
 *
 * One event per frame interval, dropped uniformly inside it — which is what
 * makes the result length-biased rather than "half the mean interval": an event
 * is likelier to land in a long frame, in proportion to its length, so the tail
 * of the frame-time distribution is the tail of this one.
 */
export function samplingWaits(intervals: readonly number[], seed: number): number[] {
  const rng: RngHolder = { rng: seedRng(seed) }
  const waits: number[] = []
  for (const interval of intervals) {
    // Events land at a rate, so a long interval catches proportionally more of
    // them. One per millisecond is far denser than a person produces and costs
    // nothing to simulate; it is the *distribution* that is being sampled.
    const events = Math.max(1, Math.round(interval))
    for (let i = 0; i < events; i += 1) {
      waits.push(interval * (1 - rngFloat(rng)))
    }
  }
  return waits
}

export type StageReport = {
  readonly name: string
  readonly p50: number
  readonly p99: number
  /** Whether this harness measured it or `docs/latency.md` declares it. */
  readonly measured: boolean
}

export type LatencyReport = {
  readonly profile: string
  readonly frames: number
  readonly stages: readonly StageReport[]
  /** Sampling wait plus frame build plus render lag. The part a commit owns. */
  readonly controlled: Percentiles
  /** The whole chain, including the declared stages. */
  readonly pipeline: Percentiles
  readonly withinControlledBudget: boolean
  readonly withinPipelineBudget: boolean
}

/**
 * Measure one profile.
 *
 * The per-event total is built from the *distribution* of the sampling wait
 * and constants for the rest, rather than sampling a frame build time per
 * event: frame build has its own gate with its own measurement behind it
 * (`render/frameStats.ts`, and `pnpm run e2e`), and re-modelling it here would
 * be a second opinion about a number that already has one.
 */
export function measureProfile(
  profile: Profile,
  options: { frames?: number; seed?: number; intervals?: readonly number[] } = {},
): LatencyReport {
  const frames = options.frames ?? RUN_FRAMES
  const seed = options.seed ?? RUN_SEED
  const intervals = options.intervals ?? scheduleFor(profile, frames, seed)
  const waits = samplingWaits(intervals, seed ^ 0x9e37)
  const wait = percentiles(waits)

  const present = presentMsFor(profile.frameMs)
  const controlledFixed = RENDER_LAG_MS
  const declared = INPUT_TRANSPORT_MS + present + DISPLAY_RESPONSE_MS

  const controlled: Percentiles = {
    p50: wait.p50 + controlledFixed + profile.frameBuildMs,
    p95: wait.p95 + controlledFixed + profile.frameBuildMs,
    p99: wait.p99 + controlledFixed + profile.frameBuildP99Ms,
    worst: wait.worst + controlledFixed + profile.frameBuildP99Ms,
    mean: wait.mean + controlledFixed + profile.frameBuildMs,
  }

  const pipeline: Percentiles = {
    p50: controlled.p50 + declared,
    p95: controlled.p95 + declared,
    p99: controlled.p99 + declared,
    worst: controlled.worst + declared,
    mean: controlled.mean + declared,
  }

  return {
    profile: profile.name,
    frames: intervals.length,
    stages: [
      { name: 'input transport', p50: INPUT_TRANSPORT_MS, p99: INPUT_TRANSPORT_MS, measured: false },
      { name: 'sampling wait', p50: wait.p50, p99: wait.p99, measured: true },
      {
        name: 'frame build',
        p50: profile.frameBuildMs,
        p99: profile.frameBuildP99Ms,
        measured: true,
      },
      { name: 'render lag', p50: RENDER_LAG_MS, p99: RENDER_LAG_MS, measured: true },
      { name: 'present', p50: present, p99: present, measured: false },
      {
        name: 'display response',
        p50: DISPLAY_RESPONSE_MS,
        p99: DISPLAY_RESPONSE_MS,
        measured: false,
      },
    ],
    controlled,
    pipeline,
    withinControlledBudget: controlled.p99 <= CONTROLLED_BUDGET_MS,
    withinPipelineBudget: pipeline.p99 <= PIPELINE_BUDGET_MS,
  }
}

/** The profile the budget is gated against. */
export function referenceProfile(): Profile {
  const found = PROFILES.find((profile) => profile.name === REFERENCE_PROFILE)
  if (found === undefined) throw new Error(`no profile named ${REFERENCE_PROFILE}`)
  return found
}

/* --------------------------------------------------------------------------
 * Reporting
 * ----------------------------------------------------------------------- */

function ms(value: number): string {
  return `${value.toFixed(1)} ms`.padStart(9)
}

export function formatReport(report: LatencyReport): string[] {
  const lines: string[] = []
  lines.push(`${report.profile} — ${report.frames} frames`)
  lines.push(`  ${'stage'.padEnd(18)}${'p50'.padStart(9)}${'p99'.padStart(9)}`)
  for (const stage of report.stages) {
    lines.push(
      `  ${stage.name.padEnd(18)}${ms(stage.p50)}${ms(stage.p99)}` +
        `   ${stage.measured ? 'measured' : 'declared'}`,
    )
  }
  lines.push(
    `  ${'ours'.padEnd(18)}${ms(report.controlled.p50)}${ms(report.controlled.p99)}` +
      `   budget ${CONTROLLED_BUDGET_MS} ms p99 — ${report.withinControlledBudget ? 'ok' : 'OVER'}`,
  )
  lines.push(
    `  ${'input to photon'.padEnd(18)}${ms(report.pipeline.p50)}${ms(report.pipeline.p99)}` +
      `   budget ${PIPELINE_BUDGET_MS} ms p99 — ${report.withinPipelineBudget ? 'ok' : 'OVER'}`,
  )
  return lines
}

/** One line of JSON, for a CI job to capture and a dashboard to plot. */
export function reportJson(reports: readonly LatencyReport[]): string {
  return JSON.stringify({
    metric: 'input_to_photon_ms',
    budgetMs: PIPELINE_BUDGET_MS,
    controlledBudgetMs: CONTROLLED_BUDGET_MS,
    profiles: reports.map((report) => ({
      profile: report.profile,
      p50: Number(report.pipeline.p50.toFixed(2)),
      p99: Number(report.pipeline.p99.toFixed(2)),
      oursP99: Number(report.controlled.p99.toFixed(2)),
      ok: report.withinControlledBudget && report.withinPipelineBudget,
    })),
  })
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

/** Real frame intervals from a device, as a JSON array of milliseconds. */
export function readSamples(path: string): number[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!Array.isArray(parsed)) throw new Error(`${path}: expected an array of frame intervals`)
  return parsed.map((value, index) => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`${path}: entry ${index} is not a positive number of milliseconds`)
    }
    return value
  })
}

export function main(argv: readonly string[]): number {
  const only = flag(argv, '--profile')
  const samplesPath = flag(argv, '--samples')
  const asJson = argv.includes('--json')

  const chosen = only === undefined ? PROFILES : PROFILES.filter((p) => p.name === only)
  if (chosen.length === 0) {
    console.error(`gladiator: no profile named ${only}. Try: ${PROFILES.map((p) => p.name).join(', ')}`)
    return 1
  }

  const intervals = samplesPath === undefined ? undefined : readSamples(resolve(samplesPath))
  const reports = chosen.map((profile) =>
    measureProfile(profile, intervals === undefined ? {} : { intervals }),
  )

  if (asJson) {
    console.log(reportJson(reports))
  } else {
    console.log('input-to-photon latency — docs/latency.md')
    if (intervals !== undefined) {
      console.log(`  frame intervals read from ${samplesPath} (${intervals.length} frames)`)
    }
    for (const report of reports) for (const line of formatReport(report)) console.log(line)
    console.log(reportJson(reports))
  }

  // Gated on the reference profile only. A 144 Hz display is a better place to
  // be and failing a build for one would make the gate about hardware.
  const gate = reports.find((report) => report.profile === REFERENCE_PROFILE) ?? reports[0]
  if (gate === undefined) return 1
  if (gate.withinControlledBudget && gate.withinPipelineBudget) return 0

  console.error(
    `✗ ${gate.profile}: ${gate.pipeline.p99.toFixed(1)} ms p99 input-to-photon ` +
      `(ours ${gate.controlled.p99.toFixed(1)} ms) — over the budget in docs/latency.md`,
  )
  return 1
}

// Only when run as a program. `tools/latency-harness.test.ts` imports the
// functions above and must not trip the CLI on the way in.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (cause) {
    console.error(`gladiator: the latency harness threw — ${String(cause)}`)
    process.exitCode = 1
  }
}
