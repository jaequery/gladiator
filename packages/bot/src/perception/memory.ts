/**
 * Memory: what a belief does when nothing refreshes it.
 *
 * Three things happen to a contact on a tick that adds nothing to it, and all
 * three matter:
 *
 * 1. **It is dead-reckoned** along the last velocity anybody actually observed,
 *    so the bot keeps chasing a runner rather than the doorway they left
 *    through. Only sight ever supplies a velocity, so a sound or a shove
 *    produces a belief that sits still — which is honest, because a noise says
 *    nothing about which way somebody is going.
 * 2. **Its uncertainty grows**, at {@link UNCERTAINTY_GROWTH}, which is run
 *    speed. That is a *bound*, not a tuning knob: it is the fastest the truth
 *    can be somewhere the reckoning did not put it.
 * 3. **Its confidence falls linearly to exactly zero** at {@link MEMORY_TICKS},
 *    and at zero the contact is cleared outright rather than left as a stale
 *    position with a small number beside it. Linear rather than exponential for
 *    precisely that reason — an exponential decay has no last tick, and "the
 *    bot forgets" would become a threshold every decision layer picked for
 *    itself.
 *
 * This is the half of the design Quake 3 does not have. Its bots re-run
 * `BotFindEnemy` against live entity state every frame, so there is nothing to
 * decay and nothing to be wrong about: breaking line of sight buys you the time
 * it takes them to turn around.
 *
 * ## The reckoning is traced, not extrapolated
 *
 * Sliding a believed position along a velocity walks it straight through a
 * wall, and a bot aiming at a point inside solid geometry looks broken in a way
 * that reads as a pathfinding bug. So the step is a point trace and it stops at
 * the surface. The map is not privileged information — it is the one thing both
 * players have memorised.
 */

import { TICK_DT, createTrace, traceRay } from '@gladiator/sim'
import type { CollisionWorld, MutVec3, TraceResult } from '@gladiator/sim'

import {
  MEMORY_TICKS,
  UNCERTAINTY_GROWTH,
  clearContact,
  confidenceOf,
} from './worldModel.ts'
import type { EnemyContact } from './worldModel.ts'

/** Scratch. Single-threaded and synchronous; see `sight.ts`. */
const trace: TraceResult = createTrace()
const reckoned: MutVec3 = [0, 0, 0]

/**
 * Bring a contact up to date for `tick`, before any channel writes to it.
 *
 * Clears {@link EnemyContact.fresh} and {@link EnemyContact.visible} first, so
 * that a channel writing this tick is the only thing that can set either — and
 * so a tick on which nothing is perceived cannot leave last tick's `visible`
 * standing.
 */
export function ageContact(contact: EnemyContact, tick: number, world: CollisionWorld): void {
  contact.fresh = false
  contact.visible = false
  contact.visibility = 0

  if (contact.source === 'none') return

  const age = tick - contact.lastContactTick
  if (age >= MEMORY_TICKS) {
    clearContact(contact)
    return
  }
  if (age <= 0) return

  contact.confidence = confidenceOf(contact.source) * (1 - age / MEMORY_TICKS)

  const dx = contact.velocity[0] * TICK_DT
  const dy = contact.velocity[1] * TICK_DT
  const dz = contact.velocity[2] * TICK_DT
  if (dx !== 0 || dy !== 0 || dz !== 0) {
    reckoned[0] = contact.origin[0] + dx
    reckoned[1] = contact.origin[1] + dy
    reckoned[2] = contact.origin[2] + dz
    traceRay(trace, world, contact.origin, reckoned)
    contact.origin[0] = trace.endpos[0]
    contact.origin[1] = trace.endpos[1]
    contact.origin[2] = trace.endpos[2]
  }

  contact.uncertainty += UNCERTAINTY_GROWTH * TICK_DT
}
