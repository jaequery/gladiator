/**
 * The latency budget, as a gate.
 *
 * `pnpm latency` prints the number and `pnpm run ci` runs it, which is what
 * makes it CI-visible. This is the same measurement asserted from the suite, so
 * a change that adds a stage to the pipeline fails `pnpm test` too — the gate
 * somebody is definitely running.
 *
 * The Monte Carlo is seeded, so a failure here is a profile and a seed rather
 * than an anecdote (the same rule `laggedTransport.ts` is written to).
 */
import { TICK_INTERVAL_MS } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  CONTROLLED_BUDGET_MS,
  DISPLAY_RESPONSE_MS,
  INPUT_TRANSPORT_MS,
  PIPELINE_BUDGET_MS,
  PROFILES,
  REFERENCE_PROFILE,
  RENDER_LAG_MS,
  main,
  measureProfile,
  percentiles,
  presentMsFor,
  referenceProfile,
  reportJson,
  samplingWaits,
  scheduleFor,
} from './latency-harness.ts'

describe('the budget', () => {
  it('is met on the reference profile', () => {
    const report = measureProfile(referenceProfile())

    expect(report.controlled.p99).toBeLessThanOrEqual(CONTROLLED_BUDGET_MS)
    expect(report.pipeline.p99).toBeLessThanOrEqual(PIPELINE_BUDGET_MS)
    expect(report.withinControlledBudget).toBe(true)
    expect(report.withinPipelineBudget).toBe(true)
  })

  it('is met on every profile, and a faster display is better rather than worse', () => {
    const reports = PROFILES.map((profile) => measureProfile(profile, { frames: 4000 }))
    for (const report of reports) {
      expect(report.withinPipelineBudget).toBe(true)
    }
    const by = new Map(reports.map((report) => [report.profile, report.pipeline.p99]))
    expect(by.get('144hz') ?? 0).toBeLessThan(by.get('120hz') ?? 0)
    expect(by.get('120hz') ?? 0).toBeLessThan(by.get('60hz') ?? 0)
  })

  it('is stated against the profile that is actually gated', () => {
    expect(referenceProfile().name).toBe(REFERENCE_PROFILE)
    // The floor: a whole refresh of sampling wait, one sub-step of render lag,
    // and the frame the renderer is separately gated to build inside. The
    // budget has to be above it or the gate is unpassable, and near it or the
    // gate is decorative.
    const profile = referenceProfile()
    const floor = profile.frameMs + RENDER_LAG_MS + profile.frameBuildP99Ms
    expect(CONTROLLED_BUDGET_MS).toBeGreaterThan(floor)
    expect(CONTROLLED_BUDGET_MS).toBeLessThan(floor * 1.5)
  })

  it('accounts for the whole chain and nothing twice', () => {
    const profile = referenceProfile()
    const report = measureProfile(profile)
    const declared = INPUT_TRANSPORT_MS + presentMsFor(profile.frameMs) + DISPLAY_RESPONSE_MS
    expect(report.pipeline.p99 - report.controlled.p99).toBeCloseTo(declared, 9)

    // Every stage in the table is in one of the two totals, exactly once.
    const total = report.stages.reduce((sum, stage) => sum + stage.p99, 0)
    expect(total).toBeCloseTo(report.pipeline.p99, 9)
  })
})

describe('the measurement', () => {
  it('states the render lag as the sub-step it is, not as a number somebody picked', () => {
    expect(RENDER_LAG_MS).toBe(TICK_INTERVAL_MS)
  })

  it('is length-biased: an event lands in a long frame more often than a short one', () => {
    // Half the frames are 4 ms and half are 20 ms. Naively the mean wait is
    // half of 12; in truth an event is five times likelier to land in a long
    // frame, so the mean is much nearer half of 20. This is why the harness is
    // a Monte Carlo and why frame *pacing* is the lever, not frame rate.
    const alternating = Array.from({ length: 2000 }, (_, i) => (i % 2 === 0 ? 4 : 20))
    const waits = percentiles(samplingWaits(alternating, 7))
    expect(waits.mean).toBeGreaterThan(6)
    expect(waits.p99).toBeGreaterThan(18)
  })

  it('is reproducible from its seed', () => {
    const profile = referenceProfile()
    const a = measureProfile(profile, { frames: 3000, seed: 99 })
    const b = measureProfile(profile, { frames: 3000, seed: 99 })
    const c = measureProfile(profile, { frames: 3000, seed: 100 })
    expect(a.pipeline).toEqual(b.pipeline)
    expect(a.pipeline.p99).not.toBe(c.pipeline.p99)
  })

  it('takes real frame intervals from a device instead of a model', () => {
    // A hitchy capture: the number has to get worse, or reading a real trace
    // would be theatre.
    const modelled = measureProfile(referenceProfile(), { frames: 4000 })
    const hitchy = measureProfile(referenceProfile(), {
      intervals: Array.from({ length: 4000 }, (_, i) => (i % 20 === 0 ? 60 : 16.7)),
    })
    expect(hitchy.pipeline.p99).toBeGreaterThan(modelled.pipeline.p99)
  })

  it('does not fall over on an empty sample', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, worst: 0, mean: 0 })
  })

  it('models a display that never refreshes early', () => {
    const profile = referenceProfile()
    const intervals = scheduleFor(profile, 500, 3)
    // Jitter is one-sided, the same way network jitter is: a packet can be
    // delayed and cannot be hurried, and a display cannot refresh early.
    expect(Math.min(...intervals)).toBeGreaterThanOrEqual(profile.frameMs)
  })
})

describe('the report', () => {
  it('is one line of JSON a dashboard can plot', () => {
    const parsed: unknown = JSON.parse(reportJson([measureProfile(referenceProfile())]))
    expect(parsed).toMatchObject({
      metric: 'input_to_photon_ms',
      budgetMs: PIPELINE_BUDGET_MS,
      controlledBudgetMs: CONTROLLED_BUDGET_MS,
    })
  })

  it('exits zero for every profile and non-zero for a name it does not know', () => {
    expect(main(['--json'])).toBe(0)
    expect(main(['--profile', REFERENCE_PROFILE, '--json'])).toBe(0)
    expect(main(['--profile', '30hz', '--json'])).toBe(1)
  })
})
