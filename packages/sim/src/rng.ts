/**
 * The simulation's only source of randomness.
 *
 * mulberry32: one uint32 of state, and nothing but `Math.imul`, XOR and
 * shifts. Two properties earn it the job:
 *
 * 1. **It is integer-only.** Every step is a 32-bit operation with a result
 *    ECMAScript pins down exactly, so it produces the same stream in V8 and in
 *    JavaScriptCore. A PRNG built on floating-point multiplies would not.
 * 2. **The state is one number.** It sits in `GameState` next to `tick`, so it
 *    is carried in snapshots, hashed by `encodeExact` and rewound by
 *    reconciliation for free — no separate plumbing, and no way to forget it.
 *
 * It is not cryptographic and does not need to be. What it needs is that both
 * peers roll the same dice in the same order, which is a property of the
 * *state* being replicated, not of the generator being unpredictable.
 *
 * See `CONTEXT.md` — "Seeded PRNG", and the `Math.random()` ban in
 * `eslint.config.js`, which exists to point here.
 */

import { hashString } from './hash.ts'

/** One uint32. The whole generator. */
export type RngState = number

/** Anything carrying a PRNG stream — `GameState` is the one that matters. */
export type RngHolder = { rng: RngState }

/** mulberry32's increment: a large odd constant, so the stream never cycles early. */
const MULBERRY_INCREMENT = 0x6d2b79f5

/** 2^32, as the divisor that turns a uint32 into a double in [0, 1). Exact. */
const UINT32_SCALE = 4294967296

/** Normalise any number into the uint32 the generator is defined over. */
export function seedRng(seed: number): RngState {
  return seed >>> 0
}

/**
 * Derive a seed from a room code (or any other agreed string).
 *
 * The point is that both peers can compute the same seed from something they
 * already both know, rather than one of them having to send it.
 */
export function seedFromString(text: string): RngState {
  return hashString(text) >>> 0
}

/** Advance the stream. Pure: takes a state, returns the next one. */
export function rngNext(state: RngState): RngState {
  return (state + MULBERRY_INCREMENT) >>> 0
}

/** The uint32 output for a given state. Pure, and does not advance anything. */
export function rngValue(state: RngState): number {
  let t = Math.imul(state ^ (state >>> 15), 1 | state)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return (t ^ (t >>> 14)) >>> 0
}

/**
 * Advance the stream without reading it.
 *
 * The kernel does this once per tick so the stream position is a function of
 * the tick number alone — see the note in `kernel.ts`.
 */
export function advanceRng(holder: RngHolder): void {
  holder.rng = rngNext(holder.rng)
}

/** Draw a uint32 and advance the stream. */
export function rngUint32(holder: RngHolder): number {
  holder.rng = rngNext(holder.rng)
  return rngValue(holder.rng)
}

/**
 * Draw a double in `[0, 1)`.
 *
 * The division is by 2^32, a power of two, so it is exact — no rounding is
 * introduced between the integer stream and the float the caller sees.
 */
export function rngFloat(holder: RngHolder): number {
  return rngUint32(holder) / UINT32_SCALE
}

/** Draw a double in `[min, max)`. */
export function rngRange(holder: RngHolder, min: number, max: number): number {
  return min + (max - min) * rngFloat(holder)
}

/**
 * Draw an integer in `[0, count)`.
 *
 * Modulo would be the obvious spelling and would bias the low values; this
 * scales instead, which is unbiased to within a double's mantissa and, more
 * importantly, is the same arithmetic on every engine.
 */
export function rngInt(holder: RngHolder, count: number): number {
  if (count <= 0) return 0
  return Math.floor(rngFloat(holder) * count)
}

/** Draw `true` with the given probability. */
export function rngChance(holder: RngHolder, probability: number): boolean {
  return rngFloat(holder) < probability
}
