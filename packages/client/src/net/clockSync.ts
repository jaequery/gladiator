/**
 * The client's half of clock sync: which server tick is it right now, which
 * tick should this client be predicting into, and how to move between two
 * answers without the player seeing it happen.
 *
 * Everything the whole design rests on is a shared tick number. The client
 * simulates ahead of the server so that its commands arrive *just* before the
 * server needs them; the server rewinds by the same measure to decide whether a
 * railgun shot connected (GLAD-5QGO11). Both numbers are useless if the two
 * ends disagree about what tick it is, and nothing about a browser tab's clock
 * says anything about a server's.
 *
 * ## Three quantities, and only one of them is measured here
 *
 * - **The round trip** is measured by the *server* and arrives in the ping. It
 *   is never computed here, and there is deliberately no timestamp in the pong
 *   for this module to fill in — `sim/src/protocol.ts` explains what a client
 *   that could report its own RTT would be able to buy with it.
 * - **The offset** — how far the server's tick counter is ahead of this tab's
 *   `performance.now()` — is estimated here, from the pings.
 * - **The lead** — how far ahead of the server this client simulates — is
 *   derived from the round trip and the jitter buffer's target depth.
 *
 * ## The offset filter is a maximum, for the same reason the server's is a
 * minimum
 *
 * A ping can be delayed and cannot be hurried. A delayed ping makes the server
 * look *behind* where it really is, so every offset sample is the truth minus
 * something non-negative and the **largest** sample in a window is the least
 * contaminated one. It is the same argument as the server's min-filtered RTT
 * (`server/clockSync.ts`), pointed the other way, and averaging would again be
 * dragged around by exactly the outliers worth ignoring.
 *
 * ## The estimate floors, it does not round
 *
 * A server's tick counter is a *step function* of its wall clock: it is tick 40
 * for a whole 8 ms and then it is tick 41. The estimate is the same step
 * function fitted to the samples, so it floors. Rounding would put the estimate
 * half a tick ahead of the truth half the time — for free, and in the direction
 * that quietly hands the client extra lead it did not measure.
 *
 * ## One controller, not two
 *
 * The server also corrects drift: it drains two commands in a tick when its
 * buffer is too deep and falls back when it is empty (`server/inputQueue.ts`).
 * This module therefore does **not** also steer on the reported buffer depth.
 * Two controllers closing the same loop with a round trip of dead time between
 * them is the textbook recipe for oscillation — the client speeds up, the
 * server drains two, the depth collapses, the client slows down, and the player
 * feels every swing of it. So the lead here is *feed-forward* — a function of
 * the measured round trip and nothing else — and {@link ClientClockSync.queued}
 * is exposed to be looked at, not to be steered on.
 *
 * ## Correcting the clock without a hitch
 *
 * When the estimate moves, the client's tick counter is wrong by some number of
 * ticks and has to be made right. Jumping it means simulating several ticks in
 * one frame, and the camera is written from simulation state every frame
 * (`render/view.ts`), so that jump is a jump the player *sees* — the whole
 * screen lurches forward by however far they travelled in 24 ms.
 *
 * So the correction is a **slew**: {@link slewMs} hands the frame accumulator a
 * few extra (or a few fewer) milliseconds, bounded to {@link MAX_SLEW} of the
 * frame. The clock runs 12.5% fast for a fifth of a second instead of teleporting,
 * which is a rate change rather than a discontinuity and is not something an eye
 * has any way to pick out.
 *
 * A slew cannot fix everything. A tab that was in the background for a minute,
 * or a session that reconnected, is thousands of ticks out, and 12.5% of a frame
 * would take an hour to close it. Past {@link SNAP_TICKS} the honest thing is to
 * snap and let the frame lurch, because there is no smooth path from there —
 * {@link shouldSnap} is where that line is drawn, once.
 */
import { TICK_INTERVAL_MS, UNKNOWN_RTT, type ServerPing } from '@gladiator/sim'
import { JITTER_BUFFER_TICKS } from '@gladiator/server/inputQueue'

/**
 * How many offset samples the maximum is taken over.
 *
 * Twelve, at the server's 200 ms ping interval, is 2.4 seconds of memory — long
 * enough that the best sample in the window really is a near-undelayed ping
 * even on a link with tens of milliseconds of jitter, short enough that a route
 * that genuinely moved is followed rather than remembered.
 */
export const SAMPLE_WINDOW = 12

/**
 * The most of a frame a slew may add or remove, as a fraction.
 *
 * An eighth: one millisecond per 8 ms tick. A three-tick correction — the
 * biggest ordinary drift, and the one the acceptance check names — closes in
 * about 190 ms, during which the world runs 12.5% fast. That is far below what
 * anyone can see in a first-person view, and far above what it would take to
 * chase ordinary jitter.
 */
export const MAX_SLEW = 0.125

/**
 * Past this much error, stop slewing and jump.
 *
 * 30 ticks is 240 ms, which is more drift than a working connection produces —
 * it means a backgrounded tab, a suspended laptop or a reconnection. Slewing
 * that at {@link MAX_SLEW} would take two full seconds of a visibly fast world,
 * which is a worse artefact than the single lurch of admitting it.
 */
export const SNAP_TICKS = 30

export type ClientClockSync = {
  /** Fold in a ping received at `atMs` on this tab's clock. */
  observe(ping: ServerPing, atMs: number): void
  /** The tick the server is on at `atMs`, or `null` before the first ping. */
  serverTick(atMs: number): number | null
  /** The tick this client should be simulating into at `atMs`. */
  targetTick(atMs: number): number | null
  /**
   * How far `localTick` is behind where it should be at `atMs`. Positive means
   * the client is behind and has to speed up. Zero before the first ping, so a
   * caller needs no null check on the hot path.
   */
  errorTicks(localTick: number, atMs: number): number
  /** Ticks the server's counter is ahead of `atMs / TICK_INTERVAL_MS`. */
  readonly offsetTicks: number | null
  /** The server's measurement, or {@link UNKNOWN_RTT}. Never ours. */
  readonly rttMs: number
  /** Ticks this client runs ahead of the server. */
  readonly leadTicks: number
  /** Our commands the server is holding, as of the last ping. Diagnostics. */
  readonly queued: number
  readonly samples: number
}

export type ClockSyncOptions = {
  readonly window?: number
  /** The jitter buffer the client aims to keep full at the server. */
  readonly bufferTicks?: number
}

/**
 * The lead for a round trip: half of it, rounded up, plus the buffer depth the
 * server wants to be holding.
 *
 * Rounded **up** because arriving a fraction of a tick early costs a fraction of
 * a tick of latency and arriving late costs a fallback command. And the buffer
 * target is imported rather than restated: it is the same number the server
 * drains against, and two names for it is the drift this repo is built to
 * prevent.
 */
export function leadTicksFor(rttMs: number, bufferTicks = JITTER_BUFFER_TICKS): number {
  if (rttMs <= 0) return bufferTicks
  return Math.ceil(rttMs / 2 / TICK_INTERVAL_MS) + bufferTicks
}

/**
 * Milliseconds to add to this frame's elapsed time to close `errorTicks`.
 *
 * Positive speeds the client up. Bounded by {@link MAX_SLEW} of the frame, and
 * never by more than the error itself — overshooting would turn one correction
 * into a permanent oscillation between two wrong answers.
 */
export function slewMs(errorTicks: number, elapsedMs: number): number {
  const wantedMs = errorTicks * TICK_INTERVAL_MS
  const limitMs = MAX_SLEW * (elapsedMs > 0 ? elapsedMs : 0)
  if (wantedMs > limitMs) return limitMs
  if (wantedMs < -limitMs) return -limitMs
  return wantedMs
}

/** Whether `errorTicks` is too big to slew away. See {@link SNAP_TICKS}. */
export function shouldSnap(errorTicks: number): boolean {
  return errorTicks > SNAP_TICKS || errorTicks < -SNAP_TICKS
}

export function createClockSync(options: ClockSyncOptions = {}): ClientClockSync {
  const window = options.window ?? SAMPLE_WINDOW
  const bufferTicks = options.bufferTicks ?? JITTER_BUFFER_TICKS

  const offsets: number[] = []
  let rttMs = UNKNOWN_RTT
  let queued = 0

  const offsetTicks = (): number | null => {
    if (offsets.length === 0) return null
    let largest = Number.NEGATIVE_INFINITY
    for (const sample of offsets) if (sample > largest) largest = sample
    return largest
  }

  const serverTickAt = (atMs: number): number | null => {
    const offset = offsetTicks()
    return offset === null ? null : Math.floor(offset + atMs / TICK_INTERVAL_MS)
  }

  // A free function rather than a method, so nothing here reads `this` and a
  // caller may destructure the returned object without losing its meaning.
  const targetTickAt = (atMs: number): number | null => {
    const server = serverTickAt(atMs)
    return server === null ? null : server + leadTicksFor(rttMs, bufferTicks)
  }

  return {
    observe(ping: ServerPing, atMs: number) {
      rttMs = ping.rttMs
      queued = ping.queued

      // Half the round trip is how long this frame has been in the air, so the
      // server has moved on by that much since it wrote its tick number. An
      // unmeasured trip contributes nothing rather than a guess: the first
      // couple of pings put the estimate a shade behind, and the second the
      // server has a measurement it corrects itself.
      const halfTripTicks = rttMs > 0 ? rttMs / 2 / TICK_INTERVAL_MS : 0
      offsets.push(ping.tick + halfTripTicks - atMs / TICK_INTERVAL_MS)
      while (offsets.length > window) offsets.shift()
    },

    serverTick: serverTickAt,

    targetTick: targetTickAt,

    errorTicks(localTick: number, atMs: number): number {
      const target = targetTickAt(atMs)
      return target === null ? 0 : target - localTick
    },

    get offsetTicks() {
      return offsetTicks()
    },

    get rttMs() {
      return rttMs
    },

    get leadTicks() {
      return leadTicksFor(rttMs, bufferTicks)
    },

    get queued() {
      return queued
    },

    get samples() {
      return offsets.length
    },
  }
}
