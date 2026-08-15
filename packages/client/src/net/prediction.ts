/**
 * Client-side prediction: the world this tab believes in, and the input it has
 * not been told about yet.
 *
 * The client runs the *same* `tick()` the host runs, over its own commands, the
 * instant they are sampled. That is the whole trick, and it is the reason the
 * simulation boundary in `AGENTS.md` is enforced three ways: prediction is only
 * ever right if the two ends are bit-identical, and a client that is
 * almost-identical produces movement that is almost right, which looks like a
 * network problem and is not one.
 *
 * ## What it owns
 *
 * The predicted `GameState`, and a ring buffer of the commands that have gone
 * out but have not come back acknowledged. When a snapshot lands, `reconcile.ts`
 * adopts the authoritative world and replays exactly the commands after the ack
 * — so the answer to "what did the server not know when it wrote this" is
 * always a lookup rather than a guess.
 *
 * ## Why the previous origin and not a previous state
 *
 * Rendering interpolates between the last two ticks, which used to mean a
 * `cloneGameState` every tick — sixty-odd clones a second of a world nobody
 * reads more than one field of. All the frame loop actually needs is where the
 * eye was, so that is what is kept: one vector, copied before the tick that
 * invalidates it.
 *
 * It also has to *move with a correction*. When reconciliation shifts the
 * player, the previous origin is shifted by the same amount, so the frame's
 * interpolation carries exactly the motion it would have carried anyway and the
 * whole of the discontinuity is left for the render offset to absorb
 * (`render/renderOffset.ts`). Leaving it alone would draw the correction as a
 * frame of very fast travel, which is the artefact the offset exists to prevent
 * — moved one level down and made harder to see.
 */
import {
  EntityKind,
  findPlayer,
  hashState,
  tick as simTick,
  type CollisionWorld,
  type GameState,
  type ServerSnapshot,
  type UserCmd,
  type Vec3,
} from '@gladiator/sim'

import {
  createMispredictLedger,
  vitalsOf,
  type MispredictLedger,
} from './mispredict.ts'
import {
  CorrectionBand,
  type Correction,
  type PendingCommand,
  reconcile,
} from './reconcile.ts'

/**
 * How many unacknowledged commands the ring holds.
 *
 * 1024 ticks is 8.2 seconds of input, which is an order of magnitude more than
 * any round trip a playable session has. It is a bound rather than a target: a
 * client whose acknowledgements have stopped for eight seconds has a dead
 * connection, and the connection lifecycle (GLAD-DVDV6P) is the layer that gets
 * to say so. What this number guarantees is that the buffer cannot grow while
 * nobody is looking.
 */
export const PENDING_CAPACITY = 1024

/**
 * The size of correction the acceptance check counts, in units.
 *
 * One unit is about a thirtieth of the player box and a millisecond of running.
 * Corrections under it are the ordinary business of a networked simulation;
 * corrections over it, happening often, are a prediction that is not tracking.
 * The check is that they occur on under 5% of ticks at 80 ms.
 */
export const NOTICEABLE_CORRECTION_UNITS = 1

export type PredictionStats = {
  /** Ticks this client has predicted. */
  readonly predicted: number
  /** Snapshots adopted. */
  readonly reconciled: number
  /** Commands replayed on top of a snapshot, over the session. */
  readonly replayed: number
  /** Corrections below the noise floor in `reconcile.ts`. */
  readonly ignored: number
  readonly soft: number
  readonly loud: number
  /** Hard snaps. The acceptance check wants this at zero on a working link. */
  readonly snaps: number
  /** Corrections over {@link NOTICEABLE_CORRECTION_UNITS}. */
  readonly noticeable: number
  /** The worst correction of the session, in units. */
  readonly worstUnits: number
  /** The most recent one, in units. What a live readout shows. */
  readonly lastUnits: number
  /** Snapshots this build could not read. A version skew, never a network fault. */
  readonly rejected: number
  /** Commands the ring dropped because nothing was acknowledged for 8 seconds. */
  readonly overflowed: number
}

export type Predictor = {
  /** The predicted world. Advanced in place; never replaced. */
  readonly state: GameState
  /** Where the eye was one tick ago, for render interpolation. */
  readonly previousOrigin: Vec3
  readonly tick: number
  /** Commands sent and not yet acknowledged. */
  readonly pending: number
  readonly stats: PredictionStats
  /**
   * The self-splash mispredict counter. `net/mispredict.ts`.
   *
   * Owned here because it is fed from both halves of prediction — the live
   * ticks and the replayed ones — and a counter assembled from two call sites
   * outside this module would be a counter that misses whichever one somebody
   * forgets. The host feeds it the sim's `onSelfSplash` events.
   */
  readonly mispredicts: MispredictLedger
  /**
   * Advance one tick with `cmd` and remember it. Returns the state hash, which
   * is what the hash echo compares against (`net/client.ts`).
   *
   * `label` is the tick number this command goes out on the wire under, and it
   * defaults to the predicted world's own tick. **The two are not the same
   * number and the difference is load-bearing** (GLAD-FHKBN8). The predicted
   * world's tick is the *server's*, because a snapshot overwrites it sixty
   * times a second and the hash echo compares against the server's numbering.
   * A command's label is the client's, it is free-running, and the frame loop
   * runs it a few percent fast or slow to hold the lead the host's jitter
   * buffer is expecting (`net/clockSync.ts`).
   *
   * Passing no label is the right thing for a caller with no clock estimate —
   * a test, a replay — and it is exactly the old behaviour.
   */
  predict(cmd: UserCmd, label?: number): number
  /**
   * Adopt an authoritative snapshot and replay what it has not seen.
   *
   * Returns what the correction was worth, or `null` for a frame this build
   * could not read.
   */
  accept(snapshot: ServerSnapshot): Correction | null
}

export type PredictorOptions = {
  /**
   * The world to predict into. Taken by reference and advanced in place, which
   * is how `main.ts` keeps handing the same object to the HUD and the renderer.
   */
  readonly state: GameState
  readonly world: CollisionWorld
  /** The player slot this client steers. */
  readonly slot: number
  readonly capacity?: number
}

export function createPredictor(options: PredictorOptions): Predictor {
  const { state, world, slot } = options
  const capacity = options.capacity ?? PENDING_CAPACITY

  // A plain array used as a queue rather than an index-wrapped ring. The
  // acknowledged prefix is spliced off the front, which is O(n) in a handful of
  // entries and costs nothing — and in exchange the array *is* the argument
  // `reconcile` takes, so a snapshot allocates nothing to be reconciled with.
  const pending: PendingCommand[] = []

  const previousOrigin: [number, number, number] = originOf(state, slot) ?? [0, 0, 0]
  const mispredicts = createMispredictLedger(slot)

  const stats = {
    predicted: 0,
    reconciled: 0,
    replayed: 0,
    ignored: 0,
    soft: 0,
    loud: 0,
    snaps: 0,
    noticeable: 0,
    worstUnits: 0,
    lastUnits: 0,
    rejected: 0,
    overflowed: 0,
  }

  // A fresh one-element array per tick. `tick()` reads it and keeps no
  // reference, so this could be a reused scratch; it is not, because the
  // allocation is a single nursery object per 8 ms and the alternative is one
  // place the live tick and a replay could both write to.
  const inputsFor = (cmd: UserCmd): (UserCmd | null)[] => {
    const inputs: (UserCmd | null)[] = []
    inputs[slot] = cmd
    return inputs
  }

  return {
    state,
    previousOrigin,
    mispredicts,

    get tick() {
      return state.tick
    },

    get pending() {
      return pending.length
    },

    get stats(): PredictionStats {
      return { ...stats }
    },

    predict(cmd: UserCmd, label?: number): number {
      const before = originOf(state, slot)
      if (before !== null) {
        previousOrigin[0] = before[0]
        previousOrigin[1] = before[1]
        previousOrigin[2] = before[2]
      }

      simTick(state, inputsFor(cmd), world)
      stats.predicted += 1
      mispredicts.predicted(state.tick, vitalsOf(state, slot))

      if (pending.length >= capacity) {
        pending.shift()
        stats.overflowed += 1
      }
      pending.push({ tick: label ?? state.tick, cmd })

      return hashState(state)
    },

    accept(snapshot: ServerSnapshot): Correction | null {
      // Dropped before the replay rather than skipped during it: the ack is
      // monotonic, so anything at or below it is never needed again, and a
      // queue that is trimmed on arrival is a queue whose length means
      // something to the diagnostics panel.
      let acked = 0
      while (acked < pending.length && (pending[acked] as PendingCommand).tick <= snapshot.ack) {
        acked += 1
      }
      if (acked > 0) pending.splice(0, acked)

      const correction = reconcile({
        state,
        world,
        slot,
        snapshot,
        pending,
        // The server's answer for this tick, readable for exactly as long as it
        // takes the replay below to overwrite it. `net/mispredict.ts`.
        onAdopt: (adopted) => mispredicts.authoritative(adopted.tick, vitalsOf(adopted, slot)),
        onReplayTick: (replayed) =>
          mispredicts.predicted(replayed.tick, vitalsOf(replayed, slot)),
      })
      if (correction === null) {
        stats.rejected += 1
        return null
      }

      stats.reconciled += 1
      stats.replayed += correction.replayed
      stats.lastUnits = correction.distance
      if (correction.distance > stats.worstUnits) stats.worstUnits = correction.distance
      if (correction.distance > NOTICEABLE_CORRECTION_UNITS) stats.noticeable += 1

      if (correction.band === CorrectionBand.None) stats.ignored += 1
      else if (correction.band === CorrectionBand.Soft) stats.soft += 1
      else if (correction.band === CorrectionBand.Loud) stats.loud += 1
      else stats.snaps += 1

      if (correction.band === CorrectionBand.Snap) {
        // Nothing to interpolate across: the player is somewhere else, and
        // pretending otherwise would draw a very fast journey to it.
        const settled = originOf(state, slot)
        if (settled !== null) {
          previousOrigin[0] = settled[0]
          previousOrigin[1] = settled[1]
          previousOrigin[2] = settled[2]
        }
      } else {
        // The whole of the discontinuity goes to the render offset; the frame's
        // interpolation carries the same motion it would have carried anyway.
        previousOrigin[0] -= correction.offset[0]
        previousOrigin[1] -= correction.offset[1]
        previousOrigin[2] -= correction.offset[2]
      }

      return correction
    },
  }
}

/** The local player's origin, copied. `null` if this world has no such player. */
function originOf(state: GameState, slot: number): [number, number, number] | null {
  const player = findPlayer(state, slot)
  if (player === null || player.kind !== EntityKind.Player) return null
  return [player.origin[0], player.origin[1], player.origin[2]]
}
