/**
 * The determinism suite.
 *
 * Four properties, in the order they matter:
 *
 * 1. **The golden replay.** A committed input stream produces a committed hash
 *    trace. Sampled every half second, compared sample by sample, and a
 *    failure names the exact half-second where the two first disagreed.
 * 2. **Host independence.** The same seed and the same inputs produce the same
 *    world whether the host wakes up at 8 ms, at 60 Hz, or at a jittering
 *    interval that never divides evenly into a sub-step.
 * 3. **Seed sensitivity.** Two seeds one apart produce different worlds — the
 *    proof that the PRNG is genuinely wired through the state and not sitting
 *    beside it.
 * 4. **Sub-step accounting.** `advanceHost` runs exactly
 *    `floor(accumulated / 8 ms)` sub-steps and carries the remainder, exactly.
 *
 * ## Regenerating the golden trace
 *
 * When a ticket legitimately changes the physics, this suite fails and prints
 * the new trace as a ready-to-paste literal. Copy it over `GOLDEN_TRACE` in
 * `fixtures/golden-replay.ts` and say in the commit message why the world
 * moved. There is no bake script: `packages/sim` has no filesystem, by
 * construction.
 */

import { describe, expect, it } from 'vitest'

import { GOLDEN_REPLAY, GOLDEN_TRACE } from './fixtures/golden-replay.ts'
import { formatHash } from './hash.ts'
import { NO_INPUTS, advanceHost, clampHostDelta, createKernel, tick } from './kernel.ts'
import { GRAVITY, JUMP_VELOCITY } from './pmove/index.ts'
import {
  commandSourceFor,
  createReplayState,
  firstDivergence,
  formatTraceLiteral,
  runReplay,
  runReplayHosted,
  sampleTicks,
} from './replay.ts'
import type { TraceDivergence, TraceSample } from './replay.ts'
import { rngFloat, rngNext, seedRng } from './rng.ts'
import type { RngHolder } from './rng.ts'
import {
  EntityKind,
  NEVER_EXPIRES,
  cloneGameState,
  createGameState,
  encodeExact,
  hashState,
  removeEntity,
  spawnEntity,
} from './state.ts'
import { MAX_HOST_FRAME_MS, TICK_DT, TICK_INTERVAL_MS, TICK_RATE } from './tick.ts'

const noCommands = () => NO_INPUTS

function describeDivergence(
  divergence: TraceDivergence | null,
  actual: readonly TraceSample[],
): string {
  if (divergence === null) return ''
  const seconds = (divergence.timeMs / 1000).toFixed(1)
  return [
    `The golden replay diverged at sample ${divergence.index} — t=${seconds}s, tick ${divergence.tick}.`,
    `  committed: ${divergence.expected}`,
    `  produced:  ${divergence.actual}`,
    '',
    'If the physics changed on purpose, paste this over GOLDEN_TRACE in',
    'fixtures/golden-replay.ts and say why in the commit message:',
    '',
    formatTraceLiteral(actual),
  ].join('\n')
}

describe('golden replay', () => {
  it('produces the committed hash trace', () => {
    const trace = runReplay(GOLDEN_REPLAY)
    const divergence = firstDivergence(GOLDEN_TRACE, trace)
    expect(divergence, describeDivergence(divergence, trace)).toBeNull()
  })

  it('is sampled at tick 0 and every half second after it', () => {
    const ticks = sampleTicks(GOLDEN_REPLAY.durationTicks)

    expect(ticks[0]).toBe(0)
    expect(ticks.at(-1)).toBe(GOLDEN_REPLAY.durationTicks)
    // 62.5 ticks is half a second at 125 Hz, and is not a tick; the schedule
    // rounds each multiple, so consecutive gaps alternate 63, 62, 63, 62.
    for (let i = 1; i < ticks.length; i++) {
      const gap = (ticks[i] ?? 0) - (ticks[i - 1] ?? 0)
      expect(gap === 62 || gap === 63).toBe(true)
    }
    expect(GOLDEN_TRACE.map((sample) => sample.tick)).toEqual(ticks)
  })

  it('fires rockets and rail shots, so the trace covers the weapons phases', () => {
    // A fixture that stopped shooting would still pass every other assertion
    // in this file, and would quietly stop guarding the phases that spawn and
    // remove entities mid-match — which is where two peers are most likely to
    // come apart.
    const state = createReplayState(GOLDEN_REPLAY)
    const kernel = createKernel(state)
    const commands = commandSourceFor(GOLDEN_REPLAY)

    // Counted from the id counter rather than from the entity list: two of the
    // three rockets are rocket jumps, and a rocket jump detonates on the tick
    // it is fired, so it is never in the list when a tick ends.
    const firstId = state.nextEntityId
    let seen = 0
    for (let i = 0; i < GOLDEN_REPLAY.durationTicks; i++) {
      tick(kernel.state, commands(kernel.state.tick + 1))
      if (state.entities.some((e) => e.kind === EntityKind.Projectile)) seen += 1
    }

    expect(state.nextEntityId - firstId).toBe(3)
    // In the air for a decent slice of the ten seconds, not a single tick.
    expect(seen).toBeGreaterThan(100)
    // And both players paid for their own rocket jump and lived through it.
    expect(state.entities.filter((e) => e.kind === EntityKind.Player).map((e) => e.health)).toEqual([
      51, 51,
    ])
  })

  it('leaves both players somewhere other than where they started', () => {
    // A trace of a world where nothing happens would pass every assertion in
    // this file and prove nothing at all.
    const state = createReplayState(GOLDEN_REPLAY)
    const before = state.entities.map((entity) => [...entity.origin])
    const kernel = createKernel(state)
    const commands = commandSourceFor(GOLDEN_REPLAY)

    for (let i = 0; i < GOLDEN_REPLAY.durationTicks; i++) {
      tick(kernel.state, commands(kernel.state.tick + 1))
    }

    expect(state.entities.length).toBe(2)
    state.entities.forEach((entity, index) => {
      const start = before[index] ?? [0, 0, 0]
      const dx = entity.origin[0] - (start[0] ?? 0)
      const dy = entity.origin[1] - (start[1] ?? 0)
      expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThan(100)
    })
  })
})

describe('host independence', () => {
  const reference = runReplay(GOLDEN_REPLAY)

  const schedules: readonly (readonly [string, number | ((frame: number) => number)])[] = [
    ['one sub-step per frame (8 ms)', TICK_INTERVAL_MS],
    ['60 Hz (16.666… ms)', 1000 / 60],
    ['30 Hz (33.333… ms)', 1000 / 30],
    ['144 Hz (6.944… ms — slower than the sim)', 1000 / 144],
    ['a prime-ish delta that never lines up (7.13 ms)', 7.13],
    [
      'jitter: alternating hitches and short frames',
      (frame: number) => (frame % 17 === 0 ? 41.7 : frame % 3 === 0 ? 4.2 : 16.7),
    ],
  ]

  for (const [name, frameMs] of schedules) {
    it(`matches the reference trace under ${name}`, () => {
      const trace = runReplayHosted(GOLDEN_REPLAY, frameMs)
      const divergence = firstDivergence(reference, trace)
      expect(divergence, describeDivergence(divergence, trace)).toBeNull()
    })
  }

  it('two fresh sims with the same seed and inputs agree hash for hash', () => {
    const a = runReplay(GOLDEN_REPLAY)
    const b = runReplay(GOLDEN_REPLAY)
    expect(firstDivergence(a, b)).toBeNull()
    expect(a.at(-1)?.hash).toBe(b.at(-1)?.hash)
  })
})

describe('seed sensitivity', () => {
  const base = runReplay(GOLDEN_REPLAY)
  const offByOne = runReplay({ ...GOLDEN_REPLAY, seed: GOLDEN_REPLAY.seed + 1 })

  it('two seeds one apart produce different hashes', () => {
    expect(offByOne.length).toBe(base.length)
    for (let i = 0; i < base.length; i++) {
      expect(base[i]?.hash).not.toBe(offByOne[i]?.hash)
    }
  })

  it('the stream advances exactly once per sub-step', () => {
    // Not just "the seed reaches the hash" — that would be true if `rng` were
    // an inert field nobody advanced. This pins the rate.
    const state = createGameState(GOLDEN_REPLAY.seed)
    let expected = seedRng(GOLDEN_REPLAY.seed)

    for (let i = 0; i < 500; i++) {
      tick(state, NO_INPUTS)
      expected = rngNext(expected)
      expect(state.rng).toBe(expected)
    }
    expect(state.tick).toBe(500)
  })

  it('a seed of 0 is a real seed, not a missing one', () => {
    const zero = runReplay({ ...GOLDEN_REPLAY, seed: 0 })
    const one = runReplay({ ...GOLDEN_REPLAY, seed: 1 })
    expect(zero.at(-1)?.hash).not.toBe(one.at(-1)?.hash)
  })
})

describe('sub-step accounting', () => {
  function freshKernel() {
    return createKernel(createGameState(1))
  }

  it('runs floor(accumulated / 8 ms) sub-steps and carries the remainder', () => {
    const cases: readonly (readonly [number, number, number, number])[] = [
      // [remainder before, dtMs, expected steps, expected remainder after]
      [0, 0, 0, 0],
      [0, 7.999, 0, 7.999],
      [0, 8, 1, 0],
      [0, 8.001, 1, 0.001],
      [0, 16, 2, 0],
      [0, 100, 12, 4],
      [4, 4, 1, 0],
      [7, 1, 1, 0],
      [7.5, 0.4, 0, 7.9],
    ]

    for (const [before, dtMs, steps, after] of cases) {
      const kernel = freshKernel()
      kernel.remainderMs = before
      expect(advanceHost(kernel, dtMs, noCommands)).toBe(steps)
      expect(kernel.remainderMs).toBeCloseTo(after, 9)
      expect(kernel.state.tick).toBe(steps)
    }
  })

  it('keeps the remainder in [0, 8) and never loses a millisecond', () => {
    // Deltas drawn from the sim's own PRNG, because `Math.random` is banned in
    // this package — which is the point of it being banned.
    const holder: RngHolder = { rng: seedRng(0xc0ffee) }
    const kernel = freshKernel()
    let supplied = 0

    for (let frame = 0; frame < 4000; frame++) {
      const dtMs = rngFloat(holder) * 40
      const before = kernel.remainderMs
      const accumulated = before + dtMs

      const steps = advanceHost(kernel, dtMs, noCommands)
      supplied += dtMs

      expect(steps).toBe(Math.floor(accumulated / TICK_INTERVAL_MS))
      expect(kernel.remainderMs).toBeGreaterThanOrEqual(0)
      expect(kernel.remainderMs).toBeLessThan(TICK_INTERVAL_MS)
      // `TICK_INTERVAL_MS` is a power of two, so this accounting is exact, not close.
      expect(steps * TICK_INTERVAL_MS + kernel.remainderMs).toBe(accumulated)
    }

    expect(kernel.state.tick).toBe(kernel.steps)
    expect(kernel.steps * TICK_INTERVAL_MS + kernel.remainderMs).toBeCloseTo(supplied, 3)
  })

  it('simulates one second of wall clock as exactly 125 sub-steps', () => {
    const kernel = freshKernel()
    for (let frame = 0; frame < 60; frame++) advanceHost(kernel, 1000 / 60, noCommands)
    expect(kernel.state.tick).toBe(TICK_RATE)
    expect(kernel.remainderMs).toBeCloseTo(0, 9)
  })

  it('refuses a delta that is negative or not a number', () => {
    const kernel = freshKernel()
    expect(() => advanceHost(kernel, -1, noCommands)).toThrow(RangeError)
    expect(() => advanceHost(kernel, Number.NaN, noCommands)).toThrow(RangeError)
    expect(() => advanceHost(kernel, Number.POSITIVE_INFINITY, noCommands)).toThrow(RangeError)
    expect(kernel.state.tick).toBe(0)
  })

  it('does not clamp on its own — clamping is scheduler policy', () => {
    const kernel = freshKernel()
    expect(advanceHost(kernel, 4000, noCommands)).toBe(500)

    expect(clampHostDelta(4000)).toBe(MAX_HOST_FRAME_MS)
    expect(clampHostDelta(16.7)).toBe(16.7)
    expect(clampHostDelta(-1)).toBe(0)
    expect(clampHostDelta(Number.NaN)).toBe(0)
  })

  it('asks for each sub-step by its own tick number', () => {
    const asked: number[] = []
    const kernel = freshKernel()
    advanceHost(kernel, 8 * 5, (at) => {
      asked.push(at)
      return NO_INPUTS
    })
    expect(asked).toEqual([1, 2, 3, 4, 5])
  })

  it('observes every sub-step, not every host frame', () => {
    const seen: number[] = []
    const kernel = freshKernel()
    // Three 20 ms frames: 2 sub-steps, then 3, then 2. A per-frame observer
    // would see three ticks and miss four.
    for (let frame = 0; frame < 3; frame++) {
      advanceHost(kernel, 20, noCommands, (state) => seen.push(state.tick))
    }
    expect(seen).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})

describe('the state hash', () => {
  function stateWithOrigin(x: number, y: number, z: number) {
    const state = createGameState(7)
    spawnEntity(state, { kind: EntityKind.Player, slot: 0, origin: [x, y, z], health: 100 })
    return state
  }

  it('does not care about the sign of zero', () => {
    // `Math.round(-0.4)` is `-0`, and a state that is numerically identical
    // must hash identically or every peer standing still reports a desync.
    const positive = stateWithOrigin(0, 0, 0)
    const negative = stateWithOrigin(-0, -0, -0)

    expect(Object.is(negative.entities[0]?.origin[0], -0)).toBe(true)
    expect(encodeExact(positive)).toEqual(encodeExact(negative))
    expect(hashState(positive)).toBe(hashState(negative))
  })

  it('hashes raw bit patterns, so one ULP of drift shows', () => {
    // The next double above 128 is 128 * (1 + 2^-52). Rounding the state to
    // anything coarser than that — a quantised "close enough" hash — would let
    // a real divergence agree for a few seconds before it became visible,
    // which is the one failure mode a desync canary must not have.
    const oneUlpAbove128 = 128 + Number.EPSILON * 128
    const exact = stateWithOrigin(128, 0, 0)
    const drifted = stateWithOrigin(oneUlpAbove128, 0, 0)

    expect(oneUlpAbove128).not.toBe(128)
    expect(oneUlpAbove128 - 128).toBeLessThan(1e-12)
    expect(hashState(exact)).not.toBe(hashState(drifted))
  })

  it('gives every NaN one bit pattern', () => {
    const a = stateWithOrigin(Number.NaN, 0, 0)
    const b = stateWithOrigin(0 / 0, 0, 0)
    const c = stateWithOrigin(Number.POSITIVE_INFINITY - Number.POSITIVE_INFINITY, 0, 0)

    expect(hashState(a)).toBe(hashState(b))
    expect(hashState(b)).toBe(hashState(c))
  })

  it('covers the tick, the PRNG and the entity list', () => {
    const base = createGameState(7)
    const baseline = hashState(base)

    const laterTick = cloneGameState(base)
    laterTick.tick += 1
    expect(hashState(laterTick)).not.toBe(baseline)

    const rolled = cloneGameState(base)
    rolled.rng = rngNext(rolled.rng)
    expect(hashState(rolled)).not.toBe(baseline)

    const populated = cloneGameState(base)
    spawnEntity(populated, { kind: EntityKind.Player, slot: 0 })
    expect(hashState(populated)).not.toBe(baseline)
  })

  it('is stable across a clone and formats as fixed-width hex', () => {
    const state = runReplayState()
    expect(hashState(cloneGameState(state))).toBe(hashState(state))
    expect(formatHash(hashState(state))).toMatch(/^[0-9a-f]{8}$/)
    expect(formatHash(0)).toBe('00000000')
  })

  function runReplayState() {
    const state = createReplayState(GOLDEN_REPLAY)
    const commands = commandSourceFor(GOLDEN_REPLAY)
    for (let i = 0; i < 200; i++) tick(state, commands(state.tick + 1))
    return state
  }
})

describe('tick() mutates in place', () => {
  it('keeps the same state and entity objects', () => {
    // Stated in AGENTS.md, asserted here: a caller that needs the old state
    // clones first, and nothing downstream may assume it got a new object.
    const state = createReplayState(GOLDEN_REPLAY)
    const entity = state.entities[0]
    const origin = entity?.origin

    tick(state, commandSourceFor(GOLDEN_REPLAY)(1))

    expect(state.entities[0]).toBe(entity)
    expect(state.entities[0]?.origin).toBe(origin)
  })

  it('cloneGameState is deep enough to survive a tick', () => {
    const state = createReplayState(GOLDEN_REPLAY)
    const commands = commandSourceFor(GOLDEN_REPLAY)
    for (let i = 0; i < 50; i++) tick(state, commands(state.tick + 1))

    const snapshot = cloneGameState(state)
    const snapshotHash = hashState(snapshot)

    for (let i = 0; i < 50; i++) tick(state, commands(state.tick + 1))

    expect(hashState(snapshot)).toBe(snapshotHash)
    expect(hashState(state)).not.toBe(snapshotHash)
  })
})

describe('the entity list stays canonical', () => {
  it('expires entities on their tick and keeps the rest in id order', () => {
    const state = createGameState(3)
    spawnEntity(state, { kind: EntityKind.Player, slot: 0 })
    spawnEntity(state, { kind: EntityKind.Projectile, expireTick: 2 })
    spawnEntity(state, { kind: EntityKind.Projectile, expireTick: 4 })
    spawnEntity(state, { kind: EntityKind.Projectile, expireTick: NEVER_EXPIRES })

    tick(state, NO_INPUTS)
    expect(state.entities.map((entity) => entity.id)).toEqual([1, 2, 3, 4])

    tick(state, NO_INPUTS)
    expect(state.entities.map((entity) => entity.id)).toEqual([1, 3, 4])

    tick(state, NO_INPUTS)
    tick(state, NO_INPUTS)
    expect(state.entities.map((entity) => entity.id)).toEqual([1, 4])
  })

  it('hashes the same however the removals were ordered', () => {
    // The reason `removeEntity` splices instead of swap-removing. A
    // swap-remove is faster and makes the array order a function of removal
    // *history*, so two peers that removed the same entities in a different
    // order would report a desync that is not one.
    function withRemovals(order: readonly number[]) {
      const state = createGameState(3)
      for (let i = 0; i < 5; i++) spawnEntity(state, { kind: EntityKind.Projectile })
      for (const id of order) removeEntity(state, id)
      return state
    }

    expect(hashState(withRemovals([2, 4]))).toBe(hashState(withRemovals([4, 2])))
    expect(hashState(withRemovals([2, 4]))).not.toBe(hashState(withRemovals([2, 3])))
  })
})

describe('the 8 ms sub-step, and what it buys', () => {
  // docs/physics-spec.md §0.1. These are arithmetic identities, not
  // measurements — they exist so that changing a constant fails a test rather
  // than quietly changing every jump in the game.

  it('is exactly 8 ms, exactly 125 Hz, and exact in floating point', () => {
    expect(TICK_INTERVAL_MS).toBe(8)
    expect(TICK_RATE).toBe(125)
    expect(TICK_DT).toBe(1 / 125)
    expect(TICK_DT).toBe(8 / 1000)
    // A power of two, which is what makes the host accumulator exact.
    expect(Math.log2(TICK_INTERVAL_MS) % 1).toBe(0)
  })

  it('turns gravity 800 into an effective 750 under integer velocity snapping', () => {
    // `pmove` snaps velocity to whole units every sub-step (GLAD-0B1GDS).
    // Gravity costs 6.4 units of velocity per sub-step; rounded to the nearest
    // integer that is 6, every time, in both directions.
    const perStep = GRAVITY * TICK_DT
    expect(perStep).toBeCloseTo(6.4, 12)

    let velocity = JUMP_VELOCITY
    const decrements = new Set<number>()
    for (let i = 0; i < 60; i++) {
      const next = Math.round(velocity - perStep)
      decrements.add(velocity - next)
      velocity = next
    }

    expect([...decrements]).toEqual([6])
    expect(6 / TICK_DT).toBe(750)
  })

  it('puts the jump apex at 48.6 units', () => {
    const effectiveGravity = 750
    const apex = (JUMP_VELOCITY * JUMP_VELOCITY) / (2 * effectiveGravity)
    expect(apex).toBeCloseTo(48.6, 9)
  })
})
