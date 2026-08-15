/**
 * The ledge guard: the first of this ticket's three runtime guards.
 *
 * **Before committing forward movement, trace down at the projected position. If
 * there is nothing there and the current link is not a `drop` or a `jump`,
 * re-steer.**
 *
 * ## Why a graph is not enough
 *
 * Every link in `maps/*.nav.ts` is validated against the real movement
 * (`nav/validate.ts`), so a bot that only ever walked the middle of a validated
 * link would never need this. Four things put it somewhere else:
 *
 * 1. **The goal is not always a node.** The last leg of any route is a walk from
 *    the node the bot is standing at to the point it actually wants — the
 *    opponent's believed position, which can be across a 48-unit drop.
 * 2. **Stuck recovery steers backwards** (`stuck.ts`), and the direction that
 *    unwedges a bot from a wall is often the direction off the walkway behind it.
 * 3. **A rocket moves the bot.** Knockback lands it somewhere the route did not
 *    plan for, at a speed the route did not plan for.
 * 4. **The axes are quantised.** {@link axisDirection} can be up to 24.5 degrees
 *    off the direction the controller asked for (`movement/steer.ts`), and 24.5
 *    degrees across a 96-unit walkway is the edge.
 *
 * ## What it probes, and what counts as floor
 *
 * A **point** trace, not the player box, and downward from a step above the
 * projected position to a step below it. The point matters for the same reason it
 * does in `nav/validate.ts`: the 30-unit player box bridges a narrow slot and
 * reports floor over a hole it is merely straddling, which is true of a player and
 * useless for finding the hole.
 *
 * "A step below" is {@link NAV_MAX_STEP}, and it is the same number a `walk` link
 * is defined by rather than a tuning knob. A walk link's rises are at most a step
 * (`nav/schema.ts`), so its descents are too — which makes "further down than a
 * step" and "not the surface this walk is on" the same statement.
 *
 * ## The lookahead is a stopping distance, not a constant
 *
 * A bot travelling at 380 ups after a circle jump covers three units a sub-step,
 * and releasing the stick does not stop it — ground friction and reverse
 * acceleration do, over about a sixth of a second. So the probe is placed at the
 * leading face of the player box plus what the current speed carries in
 * {@link LEDGE_LOOKAHEAD_SECONDS}. At rest that is the box's own width, which is
 * what "is there floor under my next footfall" means when there is no momentum.
 */

import {
  PLAYER_HALF_WIDTH,
  POINT_MAXS,
  POINT_MINS,
  createTrace,
  traceBox,
  vec3,
} from '@gladiator/sim'
import type { CollisionWorld, MutVec3, Vec3 } from '@gladiator/sim'

import { NAV_MAX_STEP } from '../nav/schema.ts'
import { axisDirection, rotate45, steerAxes } from './steer.ts'
import type { Axes } from './steer.ts'

/**
 * How far ahead of the player box the probe is placed, per unit of speed, in
 * seconds.
 *
 * 0.12 is fifteen sub-steps, which is about what it takes ground friction plus a
 * reversed stick to kill 320 ups. Longer and the bot refuses directions it would
 * comfortably have stopped short of, which reads as timidity; shorter and it
 * commits to a stride it cannot cancel.
 */
export const LEDGE_LOOKAHEAD_SECONDS = 0.12

/**
 * How far the probe may fall before the ground under it stops counting, in Quake
 * units.
 *
 * {@link NAV_MAX_STEP}, imported rather than restated — see the header.
 */
export const LEDGE_DROP = NAV_MAX_STEP

/* Scratch. Single-threaded and synchronous; see `perception/sight.ts`. */
const trace = createTrace()
const probeFrom: MutVec3 = vec3()
const probeTo: MutVec3 = vec3()
const rotated: MutVec3 = vec3()
const asked: MutVec3 = vec3()

/**
 * Is there floor under the point the bot's next stride lands on?
 *
 * `speed` is the horizontal speed in qu/s; pass zero for "wherever I would be if
 * I took one step".
 */
export function ledgeSafe(
  world: CollisionWorld,
  origin: Vec3,
  dirX: number,
  dirY: number,
  speed: number,
): boolean {
  const length = Math.sqrt(dirX * dirX + dirY * dirY)
  if (length === 0) return true

  const reach = PLAYER_HALF_WIDTH + speed * LEDGE_LOOKAHEAD_SECONDS
  const x = origin[0] + (dirX / length) * reach
  const y = origin[1] + (dirY / length) * reach

  probeFrom[0] = x
  probeFrom[1] = y
  probeFrom[2] = origin[2] + NAV_MAX_STEP
  probeTo[0] = x
  probeTo[1] = y
  probeTo[2] = origin[2] - LEDGE_DROP

  traceBox(trace, world, probeFrom, probeTo, POINT_MINS, POINT_MAXS)
  // `startsolid` is a probe that began inside geometry — a riser, or a wall the
  // bot is up against. That is not a ledge, and refusing it would stop the bot
  // walking up its own staircase.
  return trace.startsolid || trace.fraction < 1
}

/**
 * The candidate rotations, in the order they are tried, as multiples of 45
 * degrees away from the direction the controller asked for.
 *
 * Zero first, because the overwhelmingly common answer is "yes, go where you were
 * going". Then a quarter turn either side, then a half turn either side: a bot
 * that has to give up 90 degrees is following a wall, which is what following a
 * wall looks like. There is deliberately nothing past 90 — a direction more than
 * a right angle away from the target is not a way of getting there, and the
 * honest answer at that point is the brake below.
 */
const ROTATIONS: readonly number[] = [0, 1, -1, 2, -2]

/** Rotate `(x, y)` by `turns` eighths of a turn, into `out`. */
function turnBy(x: number, y: number, turns: number, out: MutVec3): MutVec3 {
  out[0] = x
  out[1] = y
  out[2] = 0
  const steps = turns < 0 ? -turns : turns
  for (let i = 0; i < steps; i += 1) rotate45(out[0], out[1], turns, out)
  return out
}

/**
 * Choose the axes to send, given the direction a travel controller asked for.
 *
 * Writes into `out` and returns whether the direction had to be changed — which
 * is what the caller logs and what a test asserts on.
 *
 * The search is over the **quantised** directions rather than the asked-for one,
 * because the quantised direction is the one the body will travel along. Rotating
 * an asked-for direction by 45 degrees and then quantising it can land on the same
 * two axes it started with, and a guard that "re-steered" to the identical stick
 * position would be a guard that did nothing.
 *
 * The last resort is a **brake**: the axes that point against the current
 * velocity. That is not a fallback direction, it is the only input a player has
 * that slows a body down, and it is the correct answer to "every way forward is a
 * hole" — stop, and let `stuck.ts` decide what to do about standing still.
 */
export function guardedAxes(
  world: CollisionWorld,
  origin: Vec3,
  velocity: Vec3,
  yaw: number,
  dirX: number,
  dirY: number,
  side: number,
  out: Axes,
): boolean {
  const speed = Math.sqrt(velocity[0] * velocity[0] + velocity[1] * velocity[1])

  for (const turns of ROTATIONS) {
    // `side` is which way the route is bending, so the guard tries the inside of
    // the corner first. Nothing about the geometry says that is likelier to be
    // clear; it says that when both are clear, the one that makes progress wins.
    turnBy(dirX, dirY, side >= 0 ? turns : -turns, rotated)

    steerAxes(yaw, rotated[0], rotated[1], out)
    if (out.forwardMove === 0 && out.sideMove === 0) continue
    axisDirection(yaw, out.forwardMove, out.sideMove, asked)
    if (ledgeSafe(world, origin, asked[0], asked[1], speed)) return turns !== 0
  }

  steerAxes(yaw, -velocity[0], -velocity[1], out)
  return true
}
