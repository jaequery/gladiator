/**
 * The golden replay: a committed input stream and the hash trace it produces.
 *
 * Ten seconds — 1250 sub-steps — of two players moving, turning, jumping and
 * shooting, sampled every half second. Between them the keyframes below touch
 * every field of a `UserCmd` the kernel reads, cross a yaw wrap in both
 * directions, spend time airborne and time at rest, and leave both players
 * somewhere other than where they started.
 *
 * They also fire. Three rockets and two rail shots, including a rocket jump
 * each, so the trace covers the phases weapons added to a sub-step: a
 * projectile spawning, flying, detonating and being removed, and splash
 * rewriting a player's velocity. Entities appearing and disappearing mid-match
 * is exactly the kind of thing two peers can come to disagree about, and it is
 * cheap to have the determinism gate watch it.
 *
 * They stand up at 100 health and 100 armour, the way a round starts them, and
 * each pays for one rocket jump out of the health — so the trace covers the
 * damage path and the default `health_only` self-damage rule as well as the
 * splash that drives them (`match/selfDamage.ts`). Both survive the ten seconds
 * on purpose, because a fixture whose players are dead halfway through stops
 * exercising anything, and one jump apiece is the most that leaves them
 * standing under that rule.
 *
 * The match itself stays in warmup. This is a fixture about a *sub-step*, and
 * running rounds through it would mean re-baking the trace every time the round
 * rules moved; `match/round.test.ts` is where a whole match is driven.
 *
 * ## What a failure here means
 *
 * The trace changed. That is not automatically a bug: any ticket that changes
 * what a sub-step *does* — `pmove`, tracing, weapons, round rules — moves this
 * trace, deliberately, and re-baking it is part of that work. What the test buys is that the change is *noticed*, and
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
import { BUTTON_ATTACK, BUTTON_JUMP } from '../usercmd.ts'
import { Weapon } from '../weapon.ts'

export const GOLDEN_REPLAY: Replay = {
  name: 'two-players-10s',
  /** Arbitrary, and fixed forever. The seed-sensitivity test uses this ± 1. */
  seed: 0x5eed1337,
  durationTicks: 1250,

  spawns: [
    { slot: 0, origin: [-320, 0, 0], yawDeg: 0, health: 100, armor: 100 },
    { slot: 1, origin: [320, 0, 0], yawDeg: 180, health: 100, armor: 100 },
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
    // Out in the open and level: the rocket crosses the arena and detonates on
    // a far wall a second later, so the fixture covers a whole flight rather
    // than just a muzzle flash. Aimed up it would leave over the walls, which
    // have no ceiling on them, and still be in the air at the last sample.
    { tick: 300, slot: 0, forwardMove: -1, sideMove: 0, yawDeg: 135, pitchDeg: 0, buttons: BUTTON_ATTACK },
    // A rocket jump: the jump and the shot on the same tick, looking at the
    // floor. The tick after releases both, or the refire would fire again.
    { tick: 400, slot: 0, forwardMove: 1, sideMove: 0, yawDeg: 200, pitchDeg: 89, buttons: BUTTON_JUMP | BUTTON_ATTACK },
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
    { tick: 500, slot: 1, forwardMove: 1, sideMove: 0, yawDeg: 0, pitchDeg: 89, buttons: BUTTON_JUMP | BUTTON_ATTACK },
    { tick: 501, slot: 1, forwardMove: 1, sideMove: 0, yawDeg: 0, pitchDeg: 0, buttons: 0 },
    // The railgun, held: hitscan, a 1500 ms refire, and 500 qu/s of knockback
    // on anything it finds. Aimed over the arena rather than at slot 0, so the
    // fixture keeps two live players for the whole ten seconds.
    { tick: 800, slot: 1, forwardMove: 0, sideMove: 1, yawDeg: 90, pitchDeg: -20, buttons: BUTTON_ATTACK, weapon: Weapon.Railgun },
    { tick: 1000, slot: 1, forwardMove: 1, sideMove: 1, yawDeg: -120, pitchDeg: -30, buttons: BUTTON_JUMP },
    { tick: 1001, slot: 1, forwardMove: 1, sideMove: 1, yawDeg: -120, pitchDeg: -30, buttons: 0 },
  ],
}

/**
 * The committed trace. Sampled at tick 0 and every half second thereafter —
 * 62.5 ticks, rounded to the nearest tick. See `sampleTicks`.
 */
export const GOLDEN_TRACE: readonly TraceSample[] = [
  { tick: 0, timeMs: 0, hash: '33276984' },
  { tick: 63, timeMs: 504, hash: '57419449' },
  { tick: 125, timeMs: 1000, hash: 'ee08c754' },
  { tick: 188, timeMs: 1504, hash: 'a3ab167a' },
  { tick: 250, timeMs: 2000, hash: '3ef70d8c' },
  { tick: 313, timeMs: 2504, hash: '7ce75941' },
  { tick: 375, timeMs: 3000, hash: 'c42840d2' },
  { tick: 438, timeMs: 3504, hash: '6682fe69' },
  { tick: 500, timeMs: 4000, hash: '87bfa1de' },
  { tick: 563, timeMs: 4504, hash: '60f2e182' },
  { tick: 625, timeMs: 5000, hash: '61d6febd' },
  { tick: 688, timeMs: 5504, hash: '788ba16f' },
  { tick: 750, timeMs: 6000, hash: '0ea2b9df' },
  { tick: 813, timeMs: 6504, hash: '7f74ec25' },
  { tick: 875, timeMs: 7000, hash: 'e89b7a74' },
  { tick: 938, timeMs: 7504, hash: '2e423ef1' },
  { tick: 1000, timeMs: 8000, hash: '69c5a211' },
  { tick: 1063, timeMs: 8504, hash: '24a7aae7' },
  { tick: 1125, timeMs: 9000, hash: 'add7d07f' },
  { tick: 1188, timeMs: 9504, hash: '809863b7' },
  { tick: 1250, timeMs: 10000, hash: '774ba543' },
]
