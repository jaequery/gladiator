/**
 * The fixed timestep.
 *
 * 125 Hz — Quake 3's `com_maxfps 125`, the rate a generation of players tuned
 * their movement to. It is chosen here because it divides a second exactly:
 * 8 ms per tick, no repeating fraction, no accumulator that drifts by a tick
 * every few minutes because 1/60 is not representable.
 *
 * The sim has no clock. These constants exist so that the *scheduler* — the
 * client's accumulator, the server's tick loop — and the sim agree on how much
 * simulated time one tick is worth. The kernel that turns a host frame into a
 * whole number of these is `kernel.ts`; the reasoning is
 * `docs/physics-spec.md` §0.1.
 */

/** Ticks per second. */
export const TICK_RATE = 125

/**
 * Milliseconds of wall-clock one tick is worth. Exactly `1000 / TICK_RATE`.
 *
 * 8 is a power of two, and that is load-bearing rather than incidental: the
 * host accumulator does `remainder -= steps * TICK_INTERVAL_MS`, and dividing
 * and multiplying by a power of two is *exact* in IEEE 754. The carried
 * remainder is therefore the true remainder and never drifts, however many
 * frames go by. Pick 7 or 10 and that stops being true.
 */
export const TICK_INTERVAL_MS = 8

/** Seconds of simulated time one tick advances the world. */
export const TICK_DT = 0.008

/**
 * The largest host frame a scheduler should hand to `advanceHost`, in ms.
 *
 * `advanceHost` deliberately does not apply this itself — see the note on
 * `clampHostDelta` in `kernel.ts`. Deciding to *throw simulated time away*
 * after a GC pause or a backgrounded tab is policy, and policy belongs to the
 * layer that can also tell the other peer it just did so.
 *
 * 250 ms is a little over four 60 Hz frames: long enough that an ordinary
 * hitch still simulates through, short enough that a tab restored after a
 * minute does not try to catch up 7500 ticks in one frame.
 */
export const MAX_HOST_FRAME_MS = 250
