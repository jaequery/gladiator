/**
 * The golden replay: a committed input stream and the hash trace it produces.
 *
 * Ten seconds — 1250 sub-steps — of two players moving, turning, jumping and
 * holding buttons, sampled every half second. Between them the keyframes below
 * touch every field of a `UserCmd` the kernel reads, cross a yaw wrap in both
 * directions, spend time airborne and time at rest, and leave both players
 * somewhere other than where they started.
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
 * ## What this fixture does not prove
 *
 * It was baked on V8. `angleVectors` calls `Math.sin`/`Math.cos`, which
 * ECMA-262 leaves implementation-approximated, so a hypothetical
 * JavaScriptCore CI could legitimately produce a different trace. That is a
 * known, accepted, warning-level risk — see the seam note in `math.ts`. The
 * assertions that matter for cross-peer determinism (same seed, same inputs,
 * different host frame patterns) compare two runs *in the same engine* and are
 * unaffected by it.
 */

import { Button, Weapon } from '../proto/usercmd.ts'
import type { Replay, TraceSample } from '../replay.ts'

export const GOLDEN_REPLAY: Replay = {
  name: 'two-players-10s',
  /** Arbitrary, and fixed forever. The seed-sensitivity test uses this ± 1. */
  seed: 0x5eed1337,
  durationTicks: 1250,

  spawns: [
    { slot: 0, origin: [-320, 0, 0], angles: [0, 0, 0], health: 100 },
    { slot: 1, origin: [320, 0, 0], angles: [0, 180, 0], health: 100 },
  ],

  /**
   * Each frame holds until the next frame for the same slot. The single-tick
   * gaps after a jump (t=40 then t=41) are deliberate: a jump that stays held
   * would be a different test, and holding it is not how anyone plays.
   */
  script: [
    /* ---- slot 0 ---- */
    { tick: 1, slot: 0, forwardMove: 127, rightMove: 0, upMove: 0, pitch: 0, yaw: 0, buttons: 0, weapon: Weapon.RocketLauncher },
    { tick: 40, slot: 0, forwardMove: 127, rightMove: 127, upMove: 0, pitch: 0, yaw: 0, buttons: Button.Jump, weapon: Weapon.RocketLauncher },
    { tick: 41, slot: 0, forwardMove: 127, rightMove: 127, upMove: 0, pitch: 0, yaw: 0, buttons: 0, weapon: Weapon.RocketLauncher },
    { tick: 120, slot: 0, forwardMove: 127, rightMove: 127, upMove: 0, pitch: 0, yaw: 45, buttons: 0, weapon: Weapon.RocketLauncher },
    { tick: 200, slot: 0, forwardMove: 0, rightMove: -127, upMove: 0, pitch: -12, yaw: 90, buttons: Button.Attack, weapon: Weapon.RocketLauncher },
    { tick: 300, slot: 0, forwardMove: -127, rightMove: 0, upMove: 0, pitch: -20, yaw: 135, buttons: 0, weapon: Weapon.RocketLauncher },
    { tick: 400, slot: 0, forwardMove: 127, rightMove: 0, upMove: 0, pitch: 0, yaw: 200, buttons: Button.Jump, weapon: Weapon.RocketLauncher },
    { tick: 401, slot: 0, forwardMove: 127, rightMove: 0, upMove: 0, pitch: 0, yaw: 200, buttons: 0, weapon: Weapon.RocketLauncher },
    { tick: 600, slot: 0, forwardMove: 0, rightMove: 0, upMove: 0, pitch: 0, yaw: 200, buttons: 0, weapon: Weapon.RocketLauncher },
    { tick: 700, slot: 0, forwardMove: 127, rightMove: 64, upMove: 0, pitch: 8, yaw: 320, buttons: Button.Zoom, weapon: Weapon.Railgun },
    { tick: 900, slot: 0, forwardMove: 127, rightMove: -64, upMove: 0, pitch: 0, yaw: 15, buttons: Button.Jump, weapon: Weapon.Railgun },
    { tick: 901, slot: 0, forwardMove: 127, rightMove: -64, upMove: 0, pitch: 0, yaw: 15, buttons: 0, weapon: Weapon.Railgun },
    { tick: 1100, slot: 0, forwardMove: 0, rightMove: 0, upMove: 0, pitch: 0, yaw: 15, buttons: 0, weapon: Weapon.Railgun },

    /* ---- slot 1 ---- */
    { tick: 1, slot: 1, forwardMove: 127, rightMove: 0, upMove: 0, pitch: 0, yaw: 180, buttons: 0, weapon: Weapon.RocketLauncher },
    { tick: 60, slot: 1, forwardMove: 127, rightMove: -127, upMove: 0, pitch: 0, yaw: 180, buttons: Button.Jump, weapon: Weapon.RocketLauncher },
    { tick: 61, slot: 1, forwardMove: 127, rightMove: -127, upMove: 0, pitch: 0, yaw: 180, buttons: 0, weapon: Weapon.RocketLauncher },
    { tick: 150, slot: 1, forwardMove: 127, rightMove: -127, upMove: 0, pitch: 0, yaw: 250, buttons: 0, weapon: Weapon.RocketLauncher },
    { tick: 250, slot: 1, forwardMove: -64, rightMove: 127, upMove: 0, pitch: 25, yaw: 300, buttons: Button.Attack, weapon: Weapon.RocketLauncher },
    { tick: 350, slot: 1, forwardMove: 127, rightMove: 0, upMove: 0, pitch: 15, yaw: 0, buttons: 0, weapon: Weapon.RocketLauncher },
    { tick: 500, slot: 1, forwardMove: 127, rightMove: 0, upMove: 0, pitch: 0, yaw: 0, buttons: Button.Jump, weapon: Weapon.RocketLauncher },
    { tick: 501, slot: 1, forwardMove: 127, rightMove: 0, upMove: 0, pitch: 0, yaw: 0, buttons: 0, weapon: Weapon.RocketLauncher },
    { tick: 800, slot: 1, forwardMove: 0, rightMove: 127, upMove: 0, pitch: 0, yaw: 90, buttons: 0, weapon: Weapon.Railgun },
    { tick: 1000, slot: 1, forwardMove: 127, rightMove: 127, upMove: 0, pitch: -30, yaw: -120, buttons: Button.Jump, weapon: Weapon.Railgun },
    { tick: 1001, slot: 1, forwardMove: 127, rightMove: 127, upMove: 0, pitch: -30, yaw: -120, buttons: 0, weapon: Weapon.Railgun },
  ],
}

/**
 * The committed trace. Sampled at tick 0 and every half second thereafter —
 * 62.5 ticks, rounded to the nearest tick. See `sampleTicks`.
 */
export const GOLDEN_TRACE: readonly TraceSample[] = [
  { tick: 0, timeMs: 0, hash: 'a90ce277' },
  { tick: 63, timeMs: 504, hash: '0cd36507' },
  { tick: 125, timeMs: 1000, hash: 'c7fbc8ce' },
  { tick: 188, timeMs: 1504, hash: 'acdf106c' },
  { tick: 250, timeMs: 2000, hash: 'baf1fbc7' },
  { tick: 313, timeMs: 2504, hash: '00eab484' },
  { tick: 375, timeMs: 3000, hash: '1dfb109d' },
  { tick: 438, timeMs: 3504, hash: 'b82999b4' },
  { tick: 500, timeMs: 4000, hash: '9d64df34' },
  { tick: 563, timeMs: 4504, hash: '11274398' },
  { tick: 625, timeMs: 5000, hash: '5b742cdc' },
  { tick: 688, timeMs: 5504, hash: '88c061e8' },
  { tick: 750, timeMs: 6000, hash: '5233928e' },
  { tick: 813, timeMs: 6504, hash: '3f64f880' },
  { tick: 875, timeMs: 7000, hash: 'f3609d05' },
  { tick: 938, timeMs: 7504, hash: 'f4d6ff2e' },
  { tick: 1000, timeMs: 8000, hash: 'cd2babfb' },
  { tick: 1063, timeMs: 8504, hash: 'd44c53b3' },
  { tick: 1125, timeMs: 9000, hash: '2e9c90de' },
  { tick: 1188, timeMs: 9504, hash: '0f0c51c0' },
  { tick: 1250, timeMs: 10000, hash: '6d6b29e7' },
]
