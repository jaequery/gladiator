/**
 * The two things the simulation notices and cannot report.
 *
 * `packages/sim` has no `console`, no counters and no clock — that is enforced,
 * not conventional — so the two events worth *counting* are exposed as
 * observation seams (`pmove/index.ts`'s `onSpeedClamp`, `damage.ts`'s
 * `onSelfSplash`) and this file is the tally a host installs on them. One
 * module, so a client and a server count the same two things the same way
 * rather than each keeping their own idea of what a clamp is.
 *
 * ## Why these two and not, say, corrections
 *
 * A correction distance is a *continuous* number and every session has plenty
 * of them; the interesting reading is a percentile, and it already has one
 * (`net/prediction.ts`). These two are different in kind — both are conditions
 * that should never happen at all, so the interesting reading is the count, and
 * any non-zero value is a sentence somebody has to explain.
 *
 * - **The speed clamp** is a 3000 qu/s safety rail on a game whose best rocket
 *   jump peaks around 1000, and Quake has no clamp at all. Ours firing means
 *   something upstream handed the movement a velocity movement cannot produce:
 *   a bad reconciliation, a hostile command stream, arithmetic that has gone
 *   wrong. `docs/physics-spec.md` §2.6.
 * - **Self-splash** is the one damage event whose prediction is a *predicate*
 *   rather than a trajectory — you either ate your own rocket or you did not.
 *   Counting them here is what lets the client compare its answer against the
 *   server's (`client/src/net/mispredict.ts`), which is a far sharper
 *   determinism canary than positional drift.
 *
 * Purely observational, in both directions: nothing here can reach the state,
 * nothing in the state consults it, and two peers counting different numbers
 * still produce the same world.
 */

import { onSelfSplash } from './damage.ts'
import type { SelfSplash } from './damage.ts'
import { onSpeedClamp } from './pmove/index.ts'

export type SimCounters = {
  /** Sub-steps in which the §2.6 speed rail fired. Should be zero, always. */
  readonly speedClamps: number
  /** The worst speed it clamped from, in qu/s, or 0 if it never fired. */
  readonly worstClampedSpeed: number
  /** Self-splash events seen. Ordinary — a rocket jump is one. */
  readonly selfSplashes: number
  /** The last one, for a readout that wants to say when. */
  readonly lastSelfSplash: SelfSplash | null
  reset(): void
  /** Take the observers back off. Both go back to `null`, not to what they were. */
  stop(): void
}

export type SimCounterHooks = {
  /** Called after the clamp is counted, with the speed it clamped *from*. */
  readonly onSpeedClamp?: (speed: number) => void
  readonly onSelfSplash?: (splash: SelfSplash) => void
}

/**
 * Install the observers and start counting.
 *
 * There is one observer slot per event, so calling this twice replaces the
 * first tally rather than adding a second — which is the right shape for a
 * process-wide instrument and the reason `hooks` exists: a caller that also
 * wants to log, or to feed a ledger, chains through here instead of fighting
 * over the slot.
 */
export function countSimEvents(hooks: SimCounterHooks = {}): SimCounters {
  let speedClamps = 0
  let worstClampedSpeed = 0
  let selfSplashes = 0
  let lastSelfSplash: SelfSplash | null = null

  onSpeedClamp((speed) => {
    speedClamps += 1
    if (speed > worstClampedSpeed) worstClampedSpeed = speed
    hooks.onSpeedClamp?.(speed)
  })

  onSelfSplash((splash) => {
    selfSplashes += 1
    lastSelfSplash = splash
    hooks.onSelfSplash?.(splash)
  })

  return {
    get speedClamps() {
      return speedClamps
    },
    get worstClampedSpeed() {
      return worstClampedSpeed
    },
    get selfSplashes() {
      return selfSplashes
    },
    get lastSelfSplash() {
      return lastSelfSplash
    },
    reset() {
      speedClamps = 0
      worstClampedSpeed = 0
      selfSplashes = 0
      lastSelfSplash = null
    },
    stop() {
      onSpeedClamp(null)
      onSelfSplash(null)
    },
  }
}
