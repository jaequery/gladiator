/**
 * `Snapshot` — the slice of the world the server sends a client each tick.
 *
 * A snapshot is *state*, not an event: it says what is true at a tick, and a
 * client that misses one and receives the next has lost nothing but a frame of
 * interpolation. That property is what lets snapshots travel over an
 * unreliable channel later — and it is exactly the property the rocket-spawn
 * message does *not* have. See the reliability contract in `transport.ts`.
 */

import { cloneEntity } from './state.ts'
import type { EntityState, GameState } from './state.ts'
import { hashState } from './state.ts'

export type Snapshot = {
  /** The sub-step this is the state at. */
  readonly tick: number
  /**
   * The last `UserCmd.seq` the server had consumed from *this* client when it
   * built the snapshot. Reconciliation replays everything after it
   * (GLAD-6RT64L).
   */
  readonly ackSeq: number
  /**
   * `hashState()` at `tick`.
   *
   * The desync canary: a client that predicted the same tick compares its own
   * hash and knows immediately, rather than discovering it a few seconds later
   * as a rocket that hit on one machine and missed on the other.
   */
  readonly hash: number
  readonly entities: readonly EntityState[]
}

/**
 * Take a snapshot of a state.
 *
 * Entities are *copied*. `tick()` mutates the world in place, so a snapshot
 * holding references would silently become a snapshot of the present the
 * moment the next sub-step ran.
 */
export function snapshotOf(state: GameState, ackSeq: number): Snapshot {
  return {
    tick: state.tick,
    ackSeq,
    hash: hashState(state),
    entities: state.entities.map(cloneEntity),
  }
}
