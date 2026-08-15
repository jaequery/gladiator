/**
 * The circle jump: v1's whole answer to "why is the bot slower than a player".
 *
 * ## Why not strafe-jumping
 *
 * Continuous strafe-jumping is `PM_Accelerate`'s projection gate held open every
 * sub-step of every hop (`pmove/accelerate.ts`), and holding it open requires
 * turning the view into the strafe at a rate coupled to the current speed. The view
 * is the aim controller's (GLAD-HK3ATM). **A bot that strafe-jumps cannot aim while
 * it accelerates**, which trades the thing players notice least for the thing they
 * notice most, so v1 does not do it.
 *
 * ## What it does instead, and the number it was tuned to
 *
 * One jump at the start of a straight run, and for the first
 * {@link CIRCLE_JUMP_HOLD_TICKS} sub-steps of the flight the wish direction is held
 * 45 degrees off the direction of travel. That is the same mechanic — the gate is
 * `wishspeed - dot(velocity, wishdir)`, and 45 degrees off 320 ups projects to 226,
 * so the gate is open by 94 and the 2.56 qu/s the air acceleration lands is mostly
 * perpendicular, which lengthens the vector instead of replacing it.
 *
 * Measured over one hop on `arena1`'s south lane, from a standing start spun up to
 * 320 ups:
 *
 * | Sub-steps held | Landing speed | Sideways drift |
 * | -------------- | ------------- | -------------- |
 * | 0              | 320 ups       | 0              |
 * | 10             | 338 ups       | 12 u           |
 * | 20             | 360 ups       | 24 u           |
 * | **24**         | **369 ups**   | **29 u**       |
 * | 30             | 382 ups       | 35 u           |
 * | 90 (all of it) | 392 ups       | 39 u           |
 *
 * Twenty-four sub-steps is 15% more speed for 29 units of drift, which is a third
 * of the width of the mound ring — the narrowest thing in the arena the bot walks
 * along. Holding it for the whole flight is worth another 6% and nearly a third of
 * that walkway, which is the trade this file refuses.
 *
 * ## Which way it leans, and why that is not a coin flip
 *
 * Towards wherever the route **bends next**. A circle jump in Quake is a jump
 * *into* a turn, and the bot already knows where the next turn is: {@link
 * straightRun} walks the route forward until it stops going straight, which is a
 * handful of table reads (`nav/query.ts`). So the 29 units of drift are spent
 * pre-turning a corner the route was going to take anyway.
 *
 * A random side would have been one line shorter and would have spent the drift
 * pushing the bot towards a wall half the time. A run with no bend at the end of it
 * gets no hop at all, because a hop with no lean is 0.72 seconds in the air for no
 * speed — all of the cost of the mechanic and none of it.
 *
 * ## "The start of a straight run" is measured along the route, not along the link
 *
 * A hop is 0.72 seconds and 230 units of travel; `arena1`'s links are 140 to 210
 * units long. Triggering per *link* would put the bot in the air on every one of
 * them, which is a bot bouncing rather than a bot running. So the run is
 * accumulated through the route — four nodes down a wall lane is 528 units of
 * straight line — and the hop happens once at the start of it.
 */

import type { Vec3 } from '@gladiator/sim'

import type { LoadedNav } from '../nav/load.ts'
import { hopKind, nextHop, nodeOrigin } from '../nav/query.ts'
import { NO_NODE } from '../nav/schema.ts'

/**
 * How long the offset wish is held after take-off, in sub-steps. 24 = 192 ms.
 *
 * See the table in the header: it is the entry that lands inside the ~330-400 ups
 * the ticket asks for while spending less than a third of the narrowest walkway on
 * drift.
 */
export const CIRCLE_JUMP_HOLD_TICKS = 24

/**
 * How long a straight run has to be before a hop is worth taking, in Quake units.
 *
 * 320 is a second of running, and the hop itself is 0.72 s of it. Below that the
 * bot would spend most of the link in the air, arrive with speed pointing past the
 * node, and overshoot — which costs more time than the 15% buys.
 */
export const CIRCLE_JUMP_RUN = 320

/**
 * How fast the bot has to already be going, in qu/s.
 *
 * 280 of the 320 a run reaches. The gain is a *projection* effect and it needs
 * something to project: hopping from a standing start lands at the speed it took
 * off at, having wasted three quarters of a second not accelerating on the ground.
 */
export const CIRCLE_JUMP_SPEED = 280

/** The measured landing speed the numbers above were chosen for, in qu/s. */
export const CIRCLE_JUMP_LANDING_SPEED = 369

/**
 * How closely the bot has to already be travelling the way it wants to go, as a
 * cosine.
 *
 * 0.8 is 37 degrees, and this clause is the one that was missing. Without it the
 * trigger fires on the first sub-step of a straight run, which is the sub-step
 * *after* a corner — the bot has 320 ups of speed pointing the way it came, the
 * gate is wide open because the projection on to the new direction is small, and the
 * hop launches it backwards into the wall it just turned away from. Measured over
 * six matches, four of seventeen hops landed under 210 ups because of exactly that;
 * the other thirteen landed between 319 and 412.
 *
 * The mechanic is a *lean* off velocity you already have. So having it is a
 * precondition, not an optimisation.
 */
export const CIRCLE_JUMP_ALIGN = 0.8

/**
 * Should the bot take a hop on this run?
 *
 * Every clause is a reason not to, which is deliberate — a bot that hops whenever
 * it can is a bot in the air when a rocket arrives.
 *
 * `align` is the cosine between the bot's current horizontal velocity and the
 * direction it is asking for; see {@link CIRCLE_JUMP_ALIGN}.
 */
export function wantsCircleJump(
  onGround: boolean,
  speed: number,
  align: number,
  run: number,
  used: boolean,
): boolean {
  if (used) return false
  if (!onGround) return false
  if (speed < CIRCLE_JUMP_SPEED) return false
  if (align < CIRCLE_JUMP_ALIGN) return false
  return run >= CIRCLE_JUMP_RUN
}

/**
 * How far off straight a corner has to be to count as a turn, as a sine.
 *
 * 0.2 is a little over 11 degrees. Below that the two legs are one line as far as
 * the drift is concerned — leaning into an 8-degree bend spends 29 units of
 * sideways travel to pre-turn something the quantised axes would not have noticed
 * (`movement/steer.ts` gives up to 22.5 degrees for free).
 */
export const LEAN_SINE = 0.2

/**
 * Which way a route bends at `via`: `+1` for the bot's left, `-1` for its right,
 * `0` for "it does not".
 *
 * The sign of the cross product of the two legs, in the Quake frame where `+y` is
 * left — so a positive cross is a route bending left. Normalised by the legs' own
 * lengths, which is what makes it a *shape* test rather than a distance one: the
 * same corner between two long links and two short ones is the same corner.
 */
export function leanSide(from: Vec3, via: Vec3, to: Vec3 | null): number {
  if (to === null) return 0
  const ax = via[0] - from[0]
  const ay = via[1] - from[1]
  const bx = to[0] - via[0]
  const by = to[1] - via[1]
  const scale = Math.sqrt((ax * ax + ay * ay) * (bx * bx + by * by))
  if (scale === 0) return 0
  const sine = (ax * by - ay * bx) / scale
  if (sine > LEAN_SINE) return 1
  if (sine < -LEAN_SINE) return -1
  return 0
}

/**
 * How many hops the straight-run probe looks ahead.
 *
 * Six, and it being a *constant* is the property that matters: `nav/query.ts` is
 * built so that nothing in it loops for a length that depends on the node count,
 * and `query.test.ts` proves it by counting table reads on a four-node graph and a
 * seventy-node one. A bounded lookahead is a fixed number of reads, so it is on the
 * right side of that line. Six links on `arena1` is a thousand units, which is the
 * whole arena.
 */
export const RUN_LOOKAHEAD = 6

/** What the straight-run probe found. */
export type StraightRun = {
  /** How far the straight part of the route goes, in Quake units. */
  length: number
  /** The node it ends at, or {@link NO_NODE}. */
  end: number
  /** Which way the route bends there — see {@link leanSide}. */
  lean: number
}

export function createStraightRun(): StraightRun {
  return { length: 0, end: NO_NODE, lean: 0 }
}

/* Scratch. Single-threaded and synchronous; see `perception/sight.ts`. */
const a: [number, number, number] = [0, 0, 0]
const b: [number, number, number] = [0, 0, 0]
const c: [number, number, number] = [0, 0, 0]

/**
 * Walk the route from `at` towards `goalNode` for as long as it goes straight, and
 * report how far that is and which way it bends at the end.
 *
 * The run stops at the first of: a corner that bends (that is the turn to lean
 * into), a link that is not a `walk` (a jump or a drop is not part of a run), the
 * goal, or {@link RUN_LOOKAHEAD} hops.
 *
 * `origin` is where the bot actually is, so the length is the run *remaining*
 * rather than the run as authored — which is what makes the trigger "at the start
 * of a straight run" rather than "anywhere along one".
 */
export function straightRun(
  nav: LoadedNav,
  origin: Vec3,
  at: number,
  goalNode: number,
  out: StraightRun,
): StraightRun {
  out.length = 0
  out.end = at
  out.lean = 0
  if (at === NO_NODE || goalNode === NO_NODE || at === goalNode) return out

  a[0] = origin[0]
  a[1] = origin[1]
  a[2] = origin[2]
  let from = at

  for (let hop = 0; hop < RUN_LOOKAHEAD; hop += 1) {
    const next = nextHop(nav, from, goalNode)
    if (next === NO_NODE) return out
    if (hopKind(nav, from, next) !== 'walk') return out

    nodeOrigin(nav, next, b)
    const dx = b[0] - a[0]
    const dy = b[1] - a[1]
    out.length += Math.sqrt(dx * dx + dy * dy)
    out.end = next

    if (next === goalNode) return out

    const after = nextHop(nav, next, goalNode)
    if (after === NO_NODE) return out
    nodeOrigin(nav, after, c)
    const lean = leanSide(a, b, c)
    if (lean !== 0) {
      out.lean = lean
      return out
    }

    a[0] = b[0]
    a[1] = b[1]
    a[2] = b[2]
    from = next
  }

  return out
}
