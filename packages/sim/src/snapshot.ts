/**
 * `Snapshot` — the slice of the world the server sends a client, as a frame.
 *
 * A snapshot is *state*, not an event: it says what is true at a tick, and a
 * client that misses one and receives the next has lost nothing but a frame of
 * interpolation. That property is what lets snapshots travel over an
 * unreliable channel later — and it is exactly the property the rocket-spawn
 * message does *not* have. See the reliability contract in `transport.ts`.
 *
 * ## It is the whole state, and that is the point
 *
 * The first version of this file sent the entity list and a hash. That is
 * enough to *draw* the world and not enough to *rebuild* it: `hashState` also
 * walks the tick, the PRNG stream position, the next entity id and the match,
 * so a client that adopted only the entities would replay its commands on top
 * of a world that was almost the server's and disagree about the hash forever.
 * The comparison that would have caught a real desync would have been noise
 * from the first tick. `netstate.ts` owns the encoding and argues that at
 * length; this is the frame around it.
 */

import { encodeState } from './netstate.ts'
import type { ServerSnapshot } from './protocol.ts'
import type { GameState } from './state.ts'

/**
 * The frame for a state, acknowledging a peer's commands up to `ackTick`.
 *
 * `ackTick` is the tick label of the last command *that peer* sent which this
 * world has executed — not the world's own tick, and not in the same numbering.
 * A client counts its own predicted ticks and a host counts sub-steps on its own
 * clock; the two came apart the moment a fixed-rate scheduler started draining a
 * jitter buffer (`server/src/scheduler.ts`), and two peers in one room have one
 * world tick between them and an `ack` each.
 *
 * The state is *copied* into a flat array here. `tick()` mutates the world in
 * place, so a frame holding references would silently become a frame about the
 * present the moment the next sub-step ran.
 */
export function snapshotFrame(state: GameState, ackTick: number): ServerSnapshot {
  return { t: 'snap', ack: ackTick, state: encodeState(state) }
}
