/**
 * The host's half of lag compensation: a second of the world's recent past, and
 * the rewind that puts a shooter's target back into it.
 *
 * The arithmetic — how far back a given round trip sees, and why — is
 * `sim/src/lagcomp.ts`, so the client and the server cannot hold two different
 * opinions about it. This file is the buffer and the seam: it records where
 * every player was at the end of every sub-step, and it hands `tick()` a
 * {@link HitscanRewind} that moves them there for the length of one hitscan
 * trace and puts them back.
 *
 * ## The ring is preallocated, and indexed by tick
 *
 * {@link HISTORY_TICKS} entries, which is one second at 125 Hz — comfortably
 * more than `MAX_REWIND_MS` can ever ask for, so a legal rewind always lands
 * inside real data rather than silently clamping to the oldest sample. The
 * storage is three `Float64Array`s' worth of origins and a `Int32Array` of tick
 * numbers, allocated once per room: a room records 125 times a second for the
 * length of a match, and a fresh object per sub-step would make this the only
 * thing on the authoritative side producing garbage.
 *
 * A slot's sample for tick *t* lives at `t % capacity`, and is valid only if the
 * tick recorded there is still *t*. That is the whole of the bookkeeping — no
 * head pointer, no wraparound arithmetic, and an overwritten entry invalidates
 * itself.
 *
 * ## The sample is interpolated, not snapped
 *
 * `rewindTicksFor` is deliberately fractional, and this reads between the two
 * samples either side of it. Snapping to the nearest recorded tick would throw
 * away up to half a sub-step of the target's motion — 1.28 units at run speed,
 * more than twice that on a strafe jump — for a lerp that costs nothing when
 * both samples are already in the buffer.
 *
 * ## Only the target moves, and it always moves back
 *
 * The shooter is predicting themselves and is effectively in the present, so
 * they are skipped. Everyone else is moved, the trace runs, and they are
 * restored **in a `finally`** — the one detail in here that is not a
 * performance note. An exception escaping mid-trace and leaving a player 200 ms
 * in the past would not crash anything: it would quietly play the rest of the
 * match with one body in the wrong place, which is a spectacular bug and a very
 * confusing one.
 *
 * Only `origin` is touched. Health, velocity and the damage a hit deals are
 * effects of the shot and belong to the present; putting them back would be
 * undoing the shot itself.
 *
 * ## The round trip is ours
 *
 * {@link LagCompOptions.rttMsForSlot} reads the measurement the room made from a
 * ping it minted itself (`clockSync.ts`). There is deliberately no path in here
 * for a number a client sent: a client that could report its own round trip
 * could report a bigger one, be rewound further, and win duels by shooting at
 * where you used to be.
 */
import {
  DUEL_SLOTS,
  EntityKind,
  rewindTicksFor,
  type EntityState,
  type GameState,
  type HitscanRewind,
} from '@gladiator/sim'

/**
 * How many sub-steps of history a room keeps. **125** — one second.
 *
 * More than three times `MAX_REWIND_MS`, so the clamp in `sim/src/lagcomp.ts`
 * is the only thing that ever bounds a rewind and this buffer never has to be
 * the one to say no. Under-sizing it would be invisible: every rewind past the
 * end would quietly resolve to the oldest sample it holds, which is a shot
 * judged against a moment nobody asked for.
 */
export const HISTORY_TICKS = 125

/** No sample has ever been written at this ring index. */
const EMPTY = -1

export type LagCompStats = {
  /** Hitscan shots judged through a rewind. */
  readonly shots: number
  /** Player-rewinds performed, summed over those shots. */
  readonly rewound: number
  /** Shots where some player had no sample to rewind to and was left alone. */
  readonly missed: number
  /** The furthest back any shot was judged, in sub-steps. */
  readonly deepestTicks: number
}

export type LagCompensation = {
  /**
   * Take the world's positions as they are now.
   *
   * Called once per sub-step, **after** `tick()`, so the entry recorded under
   * tick *t* is where everybody was at the end of tick *t* — which is the same
   * moment the snapshot for tick *t* describes, and therefore the same moment
   * the shooter was drawing.
   */
  record(state: GameState): void
  /** The seam `tick()` takes. See {@link HitscanRewind}. */
  readonly rewind: HitscanRewind
  /**
   * Where slot `slot` was at the (fractional) tick `at`, written into `out`.
   *
   * `false` when the history holds nothing for that slot at all. Exposed for
   * the tests and for a diagnostics view of a disputed shot.
   */
  sample(slot: number, at: number, out: [number, number, number]): boolean
  readonly stats: LagCompStats
}

export type LagCompOptions = {
  /**
   * The round trip to the peer steering `slot`, in whole milliseconds, as *this
   * server* measured it — or a negative sentinel before one has completed.
   *
   * A function rather than a number because it changes every few seconds and a
   * room is the thing that knows it (`room.ts`).
   */
  readonly rttMsForSlot: (slot: number) => number
  readonly capacity?: number
}

export function createLagCompensation(options: LagCompOptions): LagCompensation {
  const capacity = options.capacity ?? HISTORY_TICKS
  const slots = DUEL_SLOTS.length

  // Which tick each ring index holds, shared by every slot because every slot
  // is written by the same `record` call.
  const ticks = new Int32Array(capacity).fill(EMPTY)
  // `[index][slot][axis]`, flattened. One allocation for the life of the room.
  const origins = new Float64Array(capacity * slots * 3)
  // Whether that slot had a player entity in the world at that tick at all.
  const present = new Uint8Array(capacity * slots)

  let newestTick = EMPTY

  // Saved during a rewind and restored after it. Preallocated for the same
  // reason the ring is, and sized to the number of bodies a duel can hold.
  const savedEntities: (EntityState | null)[] = DUEL_SLOTS.map(() => null)
  const savedOrigins = new Float64Array(slots * 3)
  const sampled: [number, number, number] = [0, 0, 0]
  /** The far end of an interpolated sample. Scratch; see the ring above. */
  const lerpEnd: [number, number, number] = [0, 0, 0]

  const stats = { shots: 0, rewound: 0, missed: 0, deepestTicks: 0 }

  /** Read one recorded tick for one slot. `false` if that entry is not it. */
  const read = (slot: number, tick: number, out: [number, number, number]): boolean => {
    if (tick < 0) return false
    const index = tick % capacity
    if (ticks[index] !== tick) return false
    const at = (index * slots + slot) * 3
    if (present[index * slots + slot] !== 1) return false
    out[0] = origins[at] as number
    out[1] = origins[at + 1] as number
    out[2] = origins[at + 2] as number
    return true
  }

  const sample = (slot: number, at: number, out: [number, number, number]): boolean => {
    if (slot < 0 || slot >= slots) return false
    if (newestTick === EMPTY) return false

    // Held to what the buffer can actually answer. A rewind is clamped to
    // `MAX_REWIND_MS` long before it gets here, so in a real session this only
    // bites for the first second of a match, when there is no deeper past — and
    // the floor is zero rather than the ring's span, because the world has no
    // ticks before its first one and asking for one would read an entry that
    // was never written.
    let want = at
    if (want > newestTick) want = newestTick
    const ringOldest = newestTick - capacity + 1
    const oldest = ringOldest > 0 ? ringOldest : 0
    if (want < oldest) want = oldest

    const before = Math.floor(want)
    const alpha = want - before

    const haveBefore = read(slot, before, out)
    if (alpha === 0) return haveBefore

    const haveAfter = read(slot, before + 1, lerpEnd)
    if (!haveBefore) {
      if (!haveAfter) return false
      out[0] = lerpEnd[0]
      out[1] = lerpEnd[1]
      out[2] = lerpEnd[2]
      return true
    }
    if (!haveAfter) return true

    out[0] += (lerpEnd[0] - out[0]) * alpha
    out[1] += (lerpEnd[1] - out[1]) * alpha
    out[2] += (lerpEnd[2] - out[2]) * alpha
    return true
  }

  const rewind: HitscanRewind = (state, shooter, shoot) => {
    const rewindTicks = rewindTicksFor(options.rttMsForSlot(shooter.slot))
    const viewTick = state.tick - rewindTicks

    stats.shots += 1
    if (rewindTicks > stats.deepestTicks) stats.deepestTicks = rewindTicks

    let moved = 0
    for (const entity of state.entities) {
      if (entity.kind !== EntityKind.Player) continue
      if (entity.id === shooter.id) continue
      if (!sample(entity.slot, viewTick, sampled)) {
        // No history for this body — the first sub-steps of a match, or a
        // player who has only just been given a slot. Left where they are,
        // which is the same answer a server with no compensation would give.
        stats.missed += 1
        continue
      }

      const at = moved * 3
      savedEntities[moved] = entity
      savedOrigins[at] = entity.origin[0]
      savedOrigins[at + 1] = entity.origin[1]
      savedOrigins[at + 2] = entity.origin[2]
      entity.origin[0] = sampled[0]
      entity.origin[1] = sampled[1]
      entity.origin[2] = sampled[2]
      moved += 1
    }
    stats.rewound += moved

    try {
      shoot()
    } finally {
      // Unconditionally, and before anything else can observe the world. This
      // is the `finally` the seam's shape exists to force.
      for (let i = 0; i < moved; i += 1) {
        const entity = savedEntities[i]
        if (entity === undefined || entity === null) continue
        const at = i * 3
        entity.origin[0] = savedOrigins[at] as number
        entity.origin[1] = savedOrigins[at + 1] as number
        entity.origin[2] = savedOrigins[at + 2] as number
        savedEntities[i] = null
      }
    }
  }

  return {
    record(state: GameState) {
      const tick = state.tick
      if (tick < 0) return
      const index = tick % capacity
      ticks[index] = tick
      if (tick > newestTick) newestTick = tick

      for (const slot of DUEL_SLOTS) present[index * slots + slot] = 0

      for (const entity of state.entities) {
        if (entity.kind !== EntityKind.Player) continue
        if (entity.slot < 0 || entity.slot >= slots) continue
        const at = (index * slots + entity.slot) * 3
        origins[at] = entity.origin[0]
        origins[at + 1] = entity.origin[1]
        origins[at + 2] = entity.origin[2]
        present[index * slots + entity.slot] = 1
      }
    },

    rewind,
    sample,

    get stats(): LagCompStats {
      return { ...stats }
    },
  }
}
