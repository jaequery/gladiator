/**
 * The golden replay: a committed input stream and the hash trace it produces.
 *
 * Ten seconds — 1250 sub-steps — of two players moving, turning and jumping,
 * sampled every half second. Between them the keyframes below touch every
 * field of a `UserCmd` the kernel reads, cross a yaw wrap in both directions,
 * spend time airborne and time at rest, and leave both players somewhere other
 * than where they started.
 *
 * ## What a failure here means
 *
 * The trace changed. That is not automatically a bug: any ticket that changes
 * what a sub-step *does* — `pmove`, tracing, weapons (GLAD-0QWRYK) — moves
 * this trace, deliberately, and re-baking it is
 * part of that work. What the test buys is that the change is *noticed*, and
 * that a change nobody meant to make cannot ride along with one they did.
 *
 * ## Re-baking it
 *
 * There is no bake script. `packages/sim` has no filesystem and no `console` —
 * that is enforced, not conventional — so the regeneration path runs through
 * the test: `pnpm vitest run determinism` prints the new trace as a
 * ready-to-paste literal when it fails. Paste it over `GOLDEN_TRACE`, and say
 * in the commit message *why* the physics moved.
 *
 * ## Why these hashes are portable
 *
 * Every operation behind them is one IEEE 754 specifies exactly. The trig goes
 * through `trig.ts`, never `Math.sin` — which the specification only requires
 * to be "implementation-approximated", and which is a lint error inside this
 * package for that reason. So this trace is a claim about the simulation, not
 * about the engine that happened to bake it.
 */

import type { Replay, TraceSample } from '../replay.ts'
import { BUTTON_JUMP } from '../usercmd.ts'

export const GOLDEN_REPLAY: Replay = {
  name: 'two-players-10s',
  /** Arbitrary, and fixed forever. The seed-sensitivity test uses this ± 1. */
  seed: 0x5eed1337,
  durationTicks: 1250,

  spawns: [
    { slot: 0, origin: [-320, 0, 0], yawDeg: 0, health: 100 },
    { slot: 1, origin: [320, 0, 0], yawDeg: 180, health: 100 },
  ],

  /**
   * Each frame holds until the next frame for the same slot. The single-tick
   * gaps after a jump (t=40, then t=41) are deliberate: a jump that stays held
   * would be testing something else, and holding it is not how anyone plays.
   */
  script: [
    /* ---- slot 0 ---- */
    { tick: 1, slot: 0, forwardMove: 1, sideMove: 0, yawDeg: 0, pitchDeg: 0, buttons: 0 },
    { tick: 40, slot: 0, forwardMove: 1, sideMove: 1, yawDeg: 0, pitchDeg: 0, buttons: BUTTON_JUMP },
    { tick: 41, slot: 0, forwardMove: 1, sideMove: 1, yawDeg: 0, pitchDeg: 0, buttons: 0 },
    { tick: 120, slot: 0, forwardMove: 1, sideMove: 1, yawDeg: 45, pitchDeg: 0, buttons: 0 },
    { tick: 200, slot: 0, forwardMove: 0, sideMove: -1, yawDeg: 90, pitchDeg: -12, buttons: 0 },
    { tick: 300, slot: 0, forwardMove: -1, sideMove: 0, yawDeg: 135, pitchDeg: -20, buttons: 0 },
    { tick: 400, slot: 0, forwardMove: 1, sideMove: 0, yawDeg: 200, pitchDeg: 0, buttons: BUTTON_JUMP },
    { tick: 401, slot: 0, forwardMove: 1, sideMove: 0, yawDeg: 200, pitchDeg: 0, buttons: 0 },
    { tick: 600, slot: 0, forwardMove: 0, sideMove: 0, yawDeg: 200, pitchDeg: 0, buttons: 0 },
    { tick: 700, slot: 0, forwardMove: 1, sideMove: 1, yawDeg: 320, pitchDeg: 8, buttons: 0 },
    { tick: 900, slot: 0, forwardMove: 1, sideMove: -1, yawDeg: 15, pitchDeg: 0, buttons: BUTTON_JUMP },
    { tick: 901, slot: 0, forwardMove: 1, sideMove: -1, yawDeg: 15, pitchDeg: 0, buttons: 0 },
    { tick: 1100, slot: 0, forwardMove: 0, sideMove: 0, yawDeg: 15, pitchDeg: 0, buttons: 0 },

    /* ---- slot 1 ---- */
    { tick: 1, slot: 1, forwardMove: 1, sideMove: 0, yawDeg: 180, pitchDeg: 0, buttons: 0 },
    { tick: 60, slot: 1, forwardMove: 1, sideMove: -1, yawDeg: 180, pitchDeg: 0, buttons: BUTTON_JUMP },
    { tick: 61, slot: 1, forwardMove: 1, sideMove: -1, yawDeg: 180, pitchDeg: 0, buttons: 0 },
    { tick: 150, slot: 1, forwardMove: 1, sideMove: -1, yawDeg: 250, pitchDeg: 0, buttons: 0 },
    { tick: 250, slot: 1, forwardMove: -1, sideMove: 1, yawDeg: 300, pitchDeg: 25, buttons: 0 },
    { tick: 350, slot: 1, forwardMove: 1, sideMove: 0, yawDeg: 0, pitchDeg: 15, buttons: 0 },
    { tick: 500, slot: 1, forwardMove: 1, sideMove: 0, yawDeg: 0, pitchDeg: 0, buttons: BUTTON_JUMP },
    { tick: 501, slot: 1, forwardMove: 1, sideMove: 0, yawDeg: 0, pitchDeg: 0, buttons: 0 },
    { tick: 800, slot: 1, forwardMove: 0, sideMove: 1, yawDeg: 90, pitchDeg: 0, buttons: 0 },
    { tick: 1000, slot: 1, forwardMove: 1, sideMove: 1, yawDeg: -120, pitchDeg: -30, buttons: BUTTON_JUMP },
    { tick: 1001, slot: 1, forwardMove: 1, sideMove: 1, yawDeg: -120, pitchDeg: -30, buttons: 0 },
  ],
}

/**
 * The committed trace. Sampled at tick 0 and every half second thereafter —
 * 62.5 ticks, rounded to the nearest tick. See `sampleTicks`.
 */
export const GOLDEN_TRACE: readonly TraceSample[] = [
  { tick: 0, timeMs: 0, hash: '2a04d1eb' },
  { tick: 63, timeMs: 504, hash: 'a39e8064' },
  { tick: 125, timeMs: 1000, hash: '6c328975' },
  { tick: 188, timeMs: 1504, hash: '8af842b9' },
  { tick: 250, timeMs: 2000, hash: '23b50f53' },
  { tick: 313, timeMs: 2504, hash: 'a588e493' },
  { tick: 375, timeMs: 3000, hash: 'ca5155df' },
  { tick: 438, timeMs: 3504, hash: '874e0fa7' },
  { tick: 500, timeMs: 4000, hash: '3a84c356' },
  { tick: 563, timeMs: 4504, hash: '8ebf3eac' },
  { tick: 625, timeMs: 5000, hash: '8d8a1cf4' },
  { tick: 688, timeMs: 5504, hash: 'ea4346f2' },
  { tick: 750, timeMs: 6000, hash: '601ee83d' },
  { tick: 813, timeMs: 6504, hash: '73848aef' },
  { tick: 875, timeMs: 7000, hash: 'a09399ab' },
  { tick: 938, timeMs: 7504, hash: '5978421c' },
  { tick: 1000, timeMs: 8000, hash: '5737fd6a' },
  { tick: 1063, timeMs: 8504, hash: '365df550' },
  { tick: 1125, timeMs: 9000, hash: 'fe2ad56f' },
  { tick: 1188, timeMs: 9504, hash: 'e2485a7f' },
  { tick: 1250, timeMs: 10000, hash: '465d685d' },
]
