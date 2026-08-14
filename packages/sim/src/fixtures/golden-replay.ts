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
 * what a sub-step *does* — `pmove` (GLAD-0B1GDS), tracing (GLAD-3SCN0U),
 * weapons (GLAD-0QWRYK) — moves this trace, deliberately, and re-baking it is
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
  { tick: 0, timeMs: 0, hash: '4acb9129' },
  { tick: 63, timeMs: 504, hash: 'd4109112' },
  { tick: 125, timeMs: 1000, hash: 'c0a7e919' },
  { tick: 188, timeMs: 1504, hash: 'bda631c5' },
  { tick: 250, timeMs: 2000, hash: '64296d40' },
  { tick: 313, timeMs: 2504, hash: 'de6ccca0' },
  { tick: 375, timeMs: 3000, hash: 'ae60e27c' },
  { tick: 438, timeMs: 3504, hash: '6fe41e31' },
  { tick: 500, timeMs: 4000, hash: '21e452f5' },
  { tick: 563, timeMs: 4504, hash: '2601926c' },
  { tick: 625, timeMs: 5000, hash: '92d7bc57' },
  { tick: 688, timeMs: 5504, hash: '4897ace4' },
  { tick: 750, timeMs: 6000, hash: '2db12b5b' },
  { tick: 813, timeMs: 6504, hash: '75042616' },
  { tick: 875, timeMs: 7000, hash: '7f03cc38' },
  { tick: 938, timeMs: 7504, hash: 'e071145e' },
  { tick: 1000, timeMs: 8000, hash: '3f56325c' },
  { tick: 1063, timeMs: 8504, hash: '9e386b57' },
  { tick: 1125, timeMs: 9000, hash: '9550fabe' },
  { tick: 1188, timeMs: 9504, hash: 'bddbcb99' },
  { tick: 1250, timeMs: 10000, hash: 'f160fc94' },
]
