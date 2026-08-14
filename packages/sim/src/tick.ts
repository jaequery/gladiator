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
 * simulated time one tick is worth. Sub-stepping within a tick is GLAD-OOELC5.
 */

/** Ticks per second. */
export const TICK_RATE = 125

/** Milliseconds of wall-clock one tick is worth. Exactly `1000 / TICK_RATE`. */
export const TICK_INTERVAL_MS = 8

/** Seconds of simulated time one tick advances the world. */
export const TICK_DT = 0.008
