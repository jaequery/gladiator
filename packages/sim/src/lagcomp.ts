/**
 * Lag compensation — the half of it both peers have to agree about.
 *
 * The client draws the opponent {@link INTERP_DELAY_MS} in the past, because it
 * has no knowledge of a remote player's future input and a guess about one is a
 * rubber band (`client/net/interpolate.ts`). So it shoots at where the opponent
 * *was*. Lag compensation is the other half of that bargain: before deciding
 * whether a hitscan shot connected, the host puts the target back where the
 * shooter saw it.
 *
 * ```
 * viewTime = serverNow - clamp(rtt / 2 + INTERP_DELAY_MS, 0, MAX_REWIND_MS)
 * ```
 *
 * Half the round trip is how stale the newest snapshot the shooter had was; the
 * interpolation delay is how much further back they were drawing it. Together
 * they are the age of the picture the player was aiming at, and that is what has
 * to be rewound.
 *
 * At 120 ms round trip a strafe-jumping target is 42 units — 1.4 body widths —
 * from where they are drawn. A railgun with a 1500 ms cooldown would miss purely
 * from latency, and the player would have no way to tell that from missing.
 *
 * ## Only the target moves
 *
 * The shooter is predicting themselves and is effectively in the present, so
 * rewinding them would be rewinding a body that was never late. And a rocket in
 * flight is **never** compensated: once it is airborne it collides against
 * present-tick hitboxes, or you would be hit by rockets that visibly passed
 * behind you. Lag compensation touches exactly one thing — where the other
 * player's box is for the duration of one hitscan trace.
 *
 * ## The numbers live here so that two packages cannot disagree about them
 *
 * {@link INTERP_DELAY_MS} is a number the client acts on and the server rewinds
 * by. If the client held its own copy the two could drift apart by one edit, and
 * the symptom would be rails that miss by a fixed amount nobody could account
 * for. `packages/server` may not import `packages/client`, so the one place both
 * can reach is here. The history buffer itself is the host's
 * (`server/src/lagcomp.ts`) — this file is the arithmetic and the seam.
 *
 * ## The round trip is the server's measurement, always
 *
 * Nothing here takes a number a client sent. `ClientPong` deliberately carries
 * no timestamp (`protocol.ts`), because a client that could report its own round
 * trip could report a bigger one and be handed extra rewind — it would shoot at
 * where you *were*, further back, and win duels it did not win.
 */

import type { EntityState, GameState } from './state.ts'
import { TICK_INTERVAL_MS } from './tick.ts'

/**
 * How far behind the newest snapshot a client draws everyone else, in ms.
 *
 * Ten ticks: enough to hold the pair of states an interpolation needs through
 * the jitter of a real link, and little enough that the host has a small window
 * to rewind. Quake 3 shipped 50 ms and Source ships 100; this sits between them
 * because the tick rate is 125 Hz rather than 20, so a given millisecond of
 * buffer buys more states.
 *
 * Read by `client/net/interpolate.ts` to decide how far back to draw, and by
 * `server/src/lagcomp.ts` to decide how far back to rewind. One number.
 */
export const INTERP_DELAY_MS = 80

/** {@link INTERP_DELAY_MS} in sub-steps. Exact: 8 divides 80. */
export const INTERP_DELAY_TICKS = INTERP_DELAY_MS / TICK_INTERVAL_MS

/**
 * The furthest into the past a shot may ever be judged, in milliseconds.
 *
 * Three hundred is a hard ceiling on the whole mechanism rather than a tuning
 * knob. Two things are behind it:
 *
 * - **It bounds the unfairness.** Every millisecond of rewind is a millisecond
 *   during which the player being shot at has already moved and cannot do
 *   anything about it. Past about a third of a second, "I was behind cover" and
 *   "I was shot" stop being distinguishable to the person who was hit.
 * - **It bounds the buffer.** The history is one second deep
 *   (`server/src/lagcomp.ts`), so a rewind that could exceed it would silently
 *   fall back to the oldest sample and be wrong in a way no test would notice.
 *
 * A round trip of 440 ms saturates it. That is a session that is barely
 * playable for other reasons, and the honest answer there is that the shooter
 * stops being fully compensated rather than that everybody else stops being
 * safe behind a wall.
 */
export const MAX_REWIND_MS = 300

/**
 * How far back a shooter with this round trip sees, in milliseconds.
 *
 * `rttMs` is the host's own measurement, or a negative sentinel (`UNKNOWN_RTT`,
 * `protocol.ts`) before one has completed. An unmeasured link still
 * rewinds by the interpolation delay, because a client is drawing the opponent
 * in the past from its very first snapshot whether or not a ping has come back
 * yet — rewinding zero for the first second of a session would mean rails that
 * mysteriously miss until clock sync warms up.
 */
export function rewindMsFor(rttMs: number): number {
  const half = Number.isFinite(rttMs) && rttMs > 0 ? rttMs * 0.5 : 0
  const wanted = half + INTERP_DELAY_MS
  return wanted > MAX_REWIND_MS ? MAX_REWIND_MS : wanted
}

/**
 * The same, in sub-steps, and deliberately **fractional**.
 *
 * Shots do not land on tick boundaries. Rounding to the nearest recorded tick
 * costs up to half a sub-step of the target's motion, which at run speed
 * (320 qu/s) is 1.28 units and at strafe-jump speed more than twice that — a
 * fifth of a body width thrown away for nothing, when the two samples either
 * side are already in the buffer and interpolating between them is one lerp.
 */
export function rewindTicksFor(rttMs: number): number {
  return rewindMsFor(rttMs) / TICK_INTERVAL_MS
}

/**
 * The seam `tick()` takes so that a hitscan shot can be judged against a world
 * that has been put back the way the shooter saw it.
 *
 * A function rather than a `begin`/`end` pair, and that shape is the point:
 * whoever implements it owns the `finally`, so there is exactly one place a
 * rewind can be left half-undone. An exception escaping mid-trace and leaving a
 * player 200 ms in the past for the rest of the match is a spectacular bug and a
 * very confusing one, and the type is what makes it impossible to write by
 * accident.
 *
 * `shoot` is called exactly once, synchronously. The implementation may move any
 * player except `shooter`, and must have restored every one of them by the time
 * it returns — whether `shoot` returned or threw.
 *
 * Absent on a client, which predicts its own shots against the world it has and
 * takes the authoritative answer from the next snapshot.
 */
export type HitscanRewind = (
  state: GameState,
  shooter: EntityState,
  shoot: () => void,
) => void
