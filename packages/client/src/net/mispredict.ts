/**
 * The self-splash mispredict counter: the sharpest determinism canary this
 * client has.
 *
 * ## Why this and not correction distance
 *
 * A correction distance is continuous and always non-zero. Every session has
 * thousands of them, most are a fraction of a unit, and the honest reading is a
 * percentile — which `net/prediction.ts` already keeps. What a percentile cannot
 * tell you is whether the two ends *disagreed about something that happened*,
 * because a prediction that is 0.4 units out and a prediction that missed an
 * explosion look identical in a histogram of distances until the second one is
 * far enough along to be a hard snap.
 *
 * Self-splash is different in kind: it is a **predicate**. You either ate your
 * own rocket or you did not, and the answer is a discrete change to health,
 * armour and velocity. So a client that predicted one the server did not apply
 * — or missed one it did — has had a prediction fail in a way that cannot be
 * explained by a late packet or a merged command. That is a real disagreement
 * about the world, and it is worth exactly one counter.
 *
 * ## How it is measured
 *
 * The predicted world's tick is the *server's* numbering (`net/reconcile.ts`
 * adopts it on every snapshot), so both ends can be asked what the local
 * player's health and armour were at a given tick:
 *
 * - {@link MispredictLedger.predicted} is called after every sub-step this
 *   client runs — the live ones and the replayed ones — and remembers the
 *   vitals it produced for that tick.
 * - {@link MispredictLedger.authoritative} is called with the vitals in the
 *   snapshot, at the tick the snapshot is *for*, before anything is replayed on
 *   top of it.
 *
 * If the two differ, the prediction was wrong about damage. If a self-splash
 * landed in this client's own prediction within {@link SPLASH_ATTRIBUTION_TICKS}
 * of that tick, it is counted as a self-splash mispredict; otherwise it is
 * counted as a plain vitals mispredict, which is the row that says "you were
 * shot and did not know yet" and is ordinary.
 *
 * ## What it costs
 *
 * A ring of two small integers per tick, written once per sub-step. No
 * allocation in the steady state and no clock.
 */
import { MAX_REPEAT_TICKS } from '@gladiator/server/inputQueue'
import { EntityKind, findPlayer, type GameState, type SelfSplash } from '@gladiator/sim'

/**
 * How far back a self-splash may be and still explain a disagreement, in ticks.
 *
 * Half a second, taken from the bound `inputQueue.ts` puts on the
 * missing-command fallback rather than written out again — it is the same
 * quantity from the other end. Half a second is longer than the unacknowledged
 * window on any link this game targets (180 ms round trip is 22 ticks), so a
 * splash the server has not confirmed yet is still inside it, and short enough
 * that a rocket from a previous exchange cannot be blamed for this one.
 */
export const SPLASH_ATTRIBUTION_TICKS = MAX_REPEAT_TICKS

/**
 * How many ticks of predicted vitals to keep.
 *
 * 1024 is 8.2 seconds, the same bound and for the same reason as the pending
 * command ring in `prediction.ts`: a snapshot older than that is a session
 * whose acknowledgements stopped, which is the connection lifecycle's problem
 * and not this counter's.
 */
export const VITALS_HISTORY = 1024

/** What a player has left. The two numbers a hit changes. */
export type Vitals = {
  readonly health: number
  readonly armor: number
}

export type MispredictStats = {
  /** Ticks for which a prediction and an authoritative state were both known. */
  readonly compared: number
  /** Of those, the ones where health or armour disagreed. */
  readonly vitals: number
  /**
   * Of those, the ones a self-splash can account for. **This is the counter.**
   */
  readonly selfSplash: number
  /** Self-splash events this client predicted over the session. */
  readonly predictedSplashes: number
  /** The largest disagreement seen, in points of health plus armour. */
  readonly worstPoints: number
  /** The tick of the last self-splash mispredict, or -1. */
  readonly lastTick: number
}

export type MispredictLedger = {
  readonly stats: MispredictStats
  /** A self-splash the client's own simulation applied. From `onSelfSplash`. */
  splash(splash: SelfSplash): void
  /** What this client predicted for `tick`. Called after every sub-step. */
  predicted(tick: number, vitals: Vitals | null): void
  /** What the server says for `tick`. Called before the replay on top of it. */
  authoritative(tick: number, vitals: Vitals | null): void
  reset(): void
}

/** The local player's health and armour, copied. `null` if they are missing. */
export function vitalsOf(state: GameState, slot: number): Vitals | null {
  const player = findPlayer(state, slot)
  if (player === null || player.kind !== EntityKind.Player) return null
  return { health: player.health, armor: player.armor }
}

export function createMispredictLedger(slot: number, capacity = VITALS_HISTORY): MispredictLedger {
  // Parallel typed arrays rather than objects in a ring, so a session that runs
  // for an hour allocates exactly this much. `-1` is "nothing recorded here".
  const ticks = new Int32Array(capacity).fill(-1)
  const health = new Int32Array(capacity)
  const armor = new Int32Array(capacity)

  let compared = 0
  let vitals = 0
  let selfSplash = 0
  let predictedSplashes = 0
  let worstPoints = 0
  let lastTick = -1
  /** The tick of the most recent self-splash this client predicted. */
  let lastSplashTick = -1

  const indexOf = (tick: number): number => ((tick % capacity) + capacity) % capacity

  return {
    get stats(): MispredictStats {
      return { compared, vitals, selfSplash, predictedSplashes, worstPoints, lastTick }
    },

    splash(event: SelfSplash) {
      // Only ours. A room seats two and the other player's rocket landing on
      // themselves is not a statement about this client's prediction.
      if (event.slot !== slot) return
      // Counted per *tick*, not per event. A reconciliation replays the
      // commands the server has not acknowledged, so the same explosion is
      // simulated again — sometimes several times — and counting each pass
      // would make a busy link look like a player who cannot stop shooting
      // themselves.
      if (event.tick <= lastSplashTick) return
      predictedSplashes += 1
      lastSplashTick = event.tick
    },

    predicted(tick: number, seen: Vitals | null) {
      if (seen === null || tick < 0) return
      const at = indexOf(tick)
      ticks[at] = tick
      health[at] = seen.health
      armor[at] = seen.armor
    },

    authoritative(tick: number, truth: Vitals | null) {
      if (truth === null || tick < 0) return
      const at = indexOf(tick)
      if (ticks[at] !== tick) return

      compared += 1
      const dHealth = Math.abs((health[at] ?? 0) - truth.health)
      const dArmor = Math.abs((armor[at] ?? 0) - truth.armor)
      const points = dHealth + dArmor
      if (points === 0) return

      vitals += 1
      if (points > worstPoints) worstPoints = points
      // Attributed to a splash only when one is close enough to explain it.
      // Everything else is being shot at, which is not a mispredict — an
      // opponent's rocket is not something this client has any business
      // predicting (`net/prediction.ts`: the opponent is never predicted).
      if (lastSplashTick >= 0 && tick - lastSplashTick <= SPLASH_ATTRIBUTION_TICKS) {
        selfSplash += 1
        lastTick = tick
      }
    },

    reset() {
      ticks.fill(-1)
      compared = 0
      vitals = 0
      selfSplash = 0
      predictedSplashes = 0
      worstPoints = 0
      lastTick = -1
      lastSplashTick = -1
    },
  }
}
