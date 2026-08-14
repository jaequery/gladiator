/**
 * The numbers the kernel is built out of.
 *
 * Normative copy: `docs/physics-spec.md` §0.1. Movement constants (friction,
 * acceleration, air control) are §1.x and land with GLAD-0B1GDS — what lives
 * here is only what the *timestep* itself depends on.
 */

/** Simulation rate, in hertz. Quake's, kept because the feel is measured in it. */
export const TICK_HZ = 125

/**
 * One sub-step, in milliseconds. Exactly 8, and a power of two on purpose.
 *
 * The host accumulator does `remainder -= steps * TICK_MS`. Because 8 is a
 * power of two, `r / 8`, `Math.floor(r / 8)` and `steps * 8` are all *exact*
 * in IEEE 754 — no rounding anywhere in the sub-step accounting, so the
 * remainder is the true remainder and never drifts. Pick 7 or 10 and that
 * stops being true.
 */
export const TICK_MS = 8

/**
 * Seconds per sub-step: `1 / 125 === 0.008`.
 *
 * Written as a division rather than the literal `0.008` so the relationship to
 * `TICK_HZ` is in the source rather than in a comment. Both spellings produce
 * the same double — IEEE division is correctly rounded, so `1 / 125` and
 * `8 / 1000` are the same bit pattern on every engine.
 */
export const DT = 1 / TICK_HZ

/** Sub-steps in one wall-clock second. Equal to `TICK_HZ`; named for readers. */
export const TICKS_PER_SECOND = TICK_HZ

/**
 * Gravity, in Quake units per second squared.
 *
 * 800 is the authored number. The number a player *feels* is 750, because
 * `pmove` snaps velocity to integers every sub-step: 800 · 0.008 = 6.4 units
 * of velocity per tick, and rounding 6.4 to the nearest integer costs 6, not
 * 6.4 — an effective 750. See `docs/physics-spec.md` §0.1; the arithmetic is
 * asserted in `determinism.test.ts` so the two cannot drift.
 */
export const GRAVITY = 800

/**
 * Upward velocity given by a jump, in Quake units per second.
 *
 * Here rather than with the rest of `pmove` (GLAD-0B1GDS) because it is half
 * of the timestep's headline consequence: 270 against an effective gravity of
 * 750 is an apex of 270² / (2 · 750) = 48.6 units.
 */
export const JUMP_VELOCITY = 270

/**
 * The largest host frame the scheduler should hand to `advanceHost`, in ms.
 *
 * `advanceHost` deliberately does *not* apply this itself: its contract is
 * "exactly `floor(accumulated / TICK_MS)` sub-steps, remainder carried", and a
 * silent clamp inside it would make that a lie. Dropping time after a GC pause
 * or a backgrounded tab is *policy*, and policy belongs to the scheduler
 * (GLAD-FHKBN8) — which should run the delta through `clampHostDelta` first.
 *
 * 250 ms is a little over four 60 Hz frames: long enough that an ordinary
 * hitch still simulates through, short enough that a tab restored after a
 * minute does not try to catch up 7500 sub-steps in one frame.
 */
export const MAX_HOST_FRAME_MS = 250
