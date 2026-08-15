/**
 * Getting out of the way. GLAD-HK3ATM.
 *
 * ## The bot must perceive the rocket first, and that is not this file's doing
 *
 * Dodging a rocket fired from behind is the most infuriating cheat in the genre,
 * and the reason it is so common is that the naive implementation is two lines:
 * walk the entity list, find the projectiles, evade. This file cannot do that —
 * `eslint.config.js`'s `GROUND_TRUTH_BANS` refuses `.entities` here — so it reads
 * {@link WorldModel.threats}, which `perception/perceive.ts` has already gated on
 * the same cone, range and line-of-sight tests a body goes through. A rocket
 * launched outside the bot's field of view is simply not in the list, and the
 * acceptance check for that is a *scenario* rather than an assertion about a
 * flag, because the guarantee is structural.
 *
 * ## What counts as needing a dodge
 *
 * The closest approach of the rocket's line to the bot's own body, over the next
 * {@link DODGE_HORIZON_SECONDS}. Not "is it pointing at me" — a rocket aimed at
 * the wall beside you is the one that actually kills you, because splash does
 * not need to touch you. So the test is a distance, {@link DODGE_DANGER}, and it
 * is a splash radius plus a margin rather than a body width.
 *
 * A rocket whose closest approach has already happened is ignored outright: it
 * is behind the bot and moving away, and the only thing left to do about it is
 * whatever the explosion does.
 *
 * ## Perpendicular first, and never into a wall
 *
 * **Prefer perpendicular escape over retreating along the rocket's axis.**
 * Backing away from a 900 qu/s rocket buys almost nothing — it closes anyway,
 * and it closes on a bot that has spent its speed going the one direction that
 * does not increase the miss distance. A step sideways moves the whole body out
 * of the line for the price of the same step.
 *
 * And **never into a wall**: a rocket that lands on the wall you just backed
 * into does *more* damage than one landing where you were, because splash is
 * measured to the nearest point on your box and you have just made that point
 * the wall. So every candidate direction is traced with the real player box
 * first, and a blocked one is not offered.
 *
 * The order is therefore: the perpendicular that increases the miss distance,
 * the other perpendicular, then the two diagonals that lean away. There is
 * deliberately nothing that runs straight back down the rocket's axis.
 */

import {
  DAMAGE_ORIGIN_HEIGHT,
  PLAYER_MAXS,
  PLAYER_MINS,
  createTrace,
  traceBox,
  vec3,
} from '@gladiator/sim'
import type { CollisionWorld, MutVec3, TraceResult, Vec3 } from '@gladiator/sim'

import type { ThreatContact, WorldModel } from '../perception/worldModel.ts'
import { SPLASH_RADIUS } from './damage.ts'

/**
 * How far ahead a rocket is worried about, in seconds.
 *
 * Seven hundred milliseconds is 630 units of rocket. Longer and the bot dodges
 * things that will be stopped by geometry it has not modelled; shorter and it
 * starts moving too late for the movement to have taken it anywhere — the body
 * accelerates over about a fifth of a second, so a dodge needs several of those
 * to be worth starting.
 */
export const DODGE_HORIZON_SECONDS = 0.7

/**
 * The closest approach that counts as dangerous, in units.
 *
 * A splash radius plus a body's width. The radius is what the explosion reaches;
 * the margin is because the closest approach is measured to a point and the
 * thing being missed is a box.
 */
export const DODGE_DANGER = SPLASH_RADIUS + 30

/**
 * How much room a dodge needs, in units.
 *
 * Ninety-six is three body widths, and it is what the bot would cover in about a
 * third of a second from a standing start. A direction with less than
 * {@link DODGE_CLEAR} of it available is a direction into a wall.
 */
export const DODGE_PROBE = 96

/** The share of {@link DODGE_PROBE} that has to be clear for a direction to count. */
export const DODGE_CLEAR = 0.5

/* Scratch. Single-threaded and synchronous; see `perception/sight.ts`. */
const centre: MutVec3 = vec3()
const perpendicular: MutVec3 = vec3()
const away: MutVec3 = vec3()
const candidate: MutVec3 = vec3()
const probeTo: MutVec3 = vec3()
const probe: TraceResult = createTrace()

/**
 * The rocket the bot most needs to be somewhere else about, or `null`.
 *
 * Its own rockets are skipped: knowing where you aimed is not a reason to run
 * from it, and a rocket jump would otherwise make the bot flee its own launch.
 */
export function nearestThreat(model: WorldModel): ThreatContact | null {
  centre[0] = model.self.origin[0]
  centre[1] = model.self.origin[1]
  centre[2] = model.self.origin[2] + DAMAGE_ORIGIN_HEIGHT

  let worst: ThreatContact | null = null
  let soonest = DODGE_HORIZON_SECONDS

  for (const threat of model.threats) {
    if (threat.own) continue

    const vx = threat.velocity[0]
    const vy = threat.velocity[1]
    const vz = threat.velocity[2]
    const speedSquared = vx * vx + vy * vy + vz * vz
    if (speedSquared === 0) continue

    const rx = centre[0] - threat.origin[0]
    const ry = centre[1] - threat.origin[1]
    const rz = centre[2] - threat.origin[2]

    // Time of closest approach of the rocket's line to the bot's centre. At or
    // before zero the rocket is already past, and nothing about moving now
    // changes where it lands.
    const at = (rx * vx + ry * vy + rz * vz) / speedSquared
    if (at <= 0 || at >= soonest) continue

    const mx = rx - vx * at
    const my = ry - vy * at
    const mz = rz - vz * at
    if (mx * mx + my * my + mz * mz >= DODGE_DANGER * DODGE_DANGER) continue

    soonest = at
    worst = threat
  }

  return worst
}

/**
 * Write the direction to dodge `threat` in into `out`, and return whether there
 * is one.
 *
 * A horizontal unit vector, which is what the movement layer consumes — the feet
 * are two axes and a yaw (`movement/steer.ts`), so an escape with a vertical
 * component in it would be an escape the bot cannot ask for.
 *
 * `false` means every way out is a wall, and that is a real answer and the
 * honest one: a bot cornered by a rocket should take the hit standing where it
 * is rather than press itself into the geometry that will amplify it.
 *
 * The threat is chosen by {@link nearestThreat} and passed in rather than looked
 * up here, because the caller charges it a reaction time and therefore has to
 * know *which* rocket it is reacting to (`combat/fire.ts`).
 */
export function planDodge(
  out: MutVec3,
  world: CollisionWorld,
  model: WorldModel,
  threat: ThreatContact,
): boolean {
  const origin = model.self.origin
  const vx = threat.velocity[0]
  const vy = threat.velocity[1]
  const flat = Math.sqrt(vx * vx + vy * vy)

  // Away from where the rocket is *now*, horizontally. It is the fallback lean
  // and, for a rocket coming near-vertically down, the only axis there is.
  const ax = origin[0] - threat.origin[0]
  const ay = origin[1] - threat.origin[1]
  const awayLength = Math.sqrt(ax * ax + ay * ay)
  away[0] = awayLength === 0 ? 1 : ax / awayLength
  away[1] = awayLength === 0 ? 0 : ay / awayLength

  if (flat === 0) {
    // Straight down: there is no line to step out of, only a point to leave.
    return offer(out, world, origin, away[0], away[1])
  }

  perpendicular[0] = -vy / flat
  perpendicular[1] = vx / flat

  // Which side of the rocket's line the bot is already on. Escaping that way
  // increases the miss distance; the other way crosses in front of it first.
  const side = away[0] * perpendicular[0] + away[1] * perpendicular[1]
  const sign = side >= 0 ? 1 : -1

  if (offer(out, world, origin, perpendicular[0] * sign, perpendicular[1] * sign)) return true
  if (offer(out, world, origin, -perpendicular[0] * sign, -perpendicular[1] * sign)) return true

  // The diagonals: still mostly across the rocket, with enough retreat in them
  // to find a way out of a corner. Nothing here runs straight back down the
  // axis — see the header.
  const s = Math.SQRT1_2
  for (const turn of [sign, -sign]) {
    candidate[0] = (perpendicular[0] * turn + away[0]) * s
    candidate[1] = (perpendicular[1] * turn + away[1]) * s
    if (offer(out, world, origin, candidate[0], candidate[1])) return true
  }

  return false
}

/**
 * Take `(x, y)` if the body can actually go that way, writing it into `out`.
 *
 * The real player box, swept, because the question is whether the *body* fits —
 * which is the opposite of the ledge guard's question and takes the opposite
 * instrument (`movement/ledge.ts` argues for the point trace it uses). A trace
 * that starts solid is a bot already inside geometry, and that is `stuck.ts`'s
 * problem rather than a direction to offer.
 */
function offer(
  out: MutVec3,
  world: CollisionWorld,
  origin: Vec3,
  x: number,
  y: number,
): boolean {
  const length = Math.sqrt(x * x + y * y)
  if (length === 0) return false
  const ux = x / length
  const uy = y / length

  probeTo[0] = origin[0] + ux * DODGE_PROBE
  probeTo[1] = origin[1] + uy * DODGE_PROBE
  probeTo[2] = origin[2]

  traceBox(probe, world, origin, probeTo, PLAYER_MINS, PLAYER_MAXS)
  if (probe.startsolid || probe.fraction < DODGE_CLEAR) return false

  out[0] = ux
  out[1] = uy
  out[2] = 0
  return true
}
