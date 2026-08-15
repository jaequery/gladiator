/**
 * Being stuck, noticing, and getting out. GLAD-TSED8V.
 *
 * A bot that is wedged is the single most visible failure this package can have —
 * worse than bad aim, worse than a bad route — because a player watching it knows
 * immediately that there is nobody home. So it is detected on a measurement rather
 * than on a heuristic, the recovery is bounded, and the fact that it happened
 * leaves a line in the log with a position in it.
 *
 * ## The measurement
 *
 * One anchor and one clock. Every sub-step the bot is following something, the
 * distance from the anchor is checked: further than {@link STUCK_RADIUS} and the
 * anchor moves to where the bot is now and the clock restarts. So the clock counts
 * *time since the last 32 units of progress*, which is the thing being measured,
 * rather than speed (a bot sliding along a wall at 300 ups is making no progress)
 * or distance to the goal (a bot correctly walking the long way round is losing
 * ground on purpose).
 *
 * Thirty-two units is a stride and a bit — a walking player covers it in an eighth
 * of a second — and three seconds of not managing one is not a slow route, it is a
 * bot standing on something.
 *
 * ## Only while there is a path
 *
 * The gate is not decoration. A bot holding its ground in a duel is stationary on
 * purpose; so is one in an intermission, one that is dead, and one whose brain has
 * nothing to walk towards. Every one of those would trip a bare "has not moved"
 * test, and a recovery that fires while a player is lining up a rail on you is a
 * worse artefact than the one it is fixing.
 *
 * ## The recovery, and why it is two phases
 *
 * Back off, then go around. The first phase is the direction that resolves the
 * commonest wedge — a body pressed into a corner by its own wish vector, where the
 * only input that separates the two is the opposite one. The second is
 * perpendicular, with one jump in it, because what backing off does not fix is a
 * lip too tall to step and too short to see.
 *
 * The side alternates between episodes, so a bot that gets wedged on the same
 * geometry twice does not try the same escape twice. It is not drawn from the
 * bot's PRNG: a recovery has to be reproducible from the position that caused it,
 * and a draw would make it depend on however many sounds the bot happened to hear
 * on the way there.
 *
 * ## What it does not do
 *
 * It never writes a position. The temptation here is enormous and it is the whole
 * point of the ticket: nudging the body out of the wall is four lines, works every
 * time, and is a teleport — visible to the player as the one thing no human can do.
 * Recovery is a *steering* override, it goes out as `forwardMove` and `sideMove`
 * like everything else, and if it does not work the bot stays stuck and says so.
 */

import { TICK_RATE, vec3 } from '@gladiator/sim'
import type { MutVec3, Vec3 } from '@gladiator/sim'

import { NEVER_TICK } from './perception/worldModel.ts'

/**
 * How far the bot has to get from its anchor to count as making progress, in
 * Quake units.
 *
 * Thirty-two. The acceptance check names it, and it is also the number that makes
 * the test independent of the arena: a graph whose links were 24 units long would
 * make a smaller radius unable to tell "walking" from "wedged".
 */
export const STUCK_RADIUS = 32

/** How long without progress counts as stuck, in sub-steps. 375 = 3 s. */
export const STUCK_TICKS = 3 * TICK_RATE

/**
 * How long a recovery is given to work, in sub-steps. 188 = 1.5 s.
 *
 * The acceptance check's number, and it is generous by a factor of ten for the
 * common case: backing off at run speed covers {@link STUCK_RADIUS} in twelve
 * sub-steps. What the rest of it is for is the case where phase one is the wrong
 * answer and phase two has to get all the way round something.
 */
export const RECOVERY_TICKS = Math.round(1.5 * TICK_RATE)

/** How long the first phase backs off for, in sub-steps. 40 = 320 ms. */
export const RECOVERY_BACK_TICKS = 40

/**
 * How long without progress before it is worth telling somebody, in sub-steps.
 * 500 = 4 s.
 *
 * One second into a recovery that has not worked. That line — `NAV_STUCK`, with a
 * position in it — is how the one bad link in a hand-authored graph gets found, so
 * it fires while the bot is still trying rather than after it gives up: a report
 * that only arrived on failure would miss every wedge the recovery quietly papered
 * over, which is exactly the set worth fixing in the graph.
 */
export const STUCK_REPORT_TICKS = 4 * TICK_RATE

/** What a `NAV_STUCK` event carries. */
export type NavStuck = {
  /** Which seat. */
  readonly slot: number
  /** The sub-step it was reported on. */
  readonly tick: number
  /** Where the bot has been failing to leave, at the feet. */
  readonly origin: Vec3
  /** How many sub-steps it had been making no progress for. */
  readonly ticksStuck: number
}

/**
 * Called when a bot has made no progress for {@link STUCK_REPORT_TICKS}.
 *
 * A seam rather than a log call, for the same reason `pmove/index.ts`'s
 * `onSpeedClamp` is one: `packages/bot` inherits the simulation's purity through
 * its tsconfig — no `DOM` lib, no ambient types — so there is no `console` in here
 * to call. The server wires this to `log.ts` and gets `room` and `tick` on the line
 * for free; a test wires it to an array and asserts it fired.
 *
 * Purely observational. It cannot reach anything the bot decides with, so two bots
 * with different observers produce the same commands — which is what lets
 * `perception/fairness.test.ts` keep meaning what it says.
 *
 * Pass `null` to remove it.
 */
export function onNavStuck(observer: ((event: NavStuck) => void) | null): void {
  stuckObserver = observer
}

let stuckObserver: ((event: NavStuck) => void) | null = null

/** The anchor, the clock, and which way the current escape is going. */
export type StuckState = {
  /** The position progress is measured from. */
  readonly anchor: MutVec3
  /** The sub-step {@link anchor} was last moved, or {@link NEVER_TICK}. */
  anchorTick: number
  /** The sub-step the current recovery started on, or {@link NEVER_TICK}. */
  recoveryTick: number
  /** Which way the next recovery will go around: `+1` or `-1`. */
  side: number
  /** Whether this episode has already been reported. */
  reported: boolean
  /** How many recoveries this bot has started. Diagnostics. */
  episodes: number
}

export function createStuck(): StuckState {
  return {
    anchor: vec3(),
    anchorTick: NEVER_TICK,
    recoveryTick: NEVER_TICK,
    side: 1,
    reported: false,
    episodes: 0,
  }
}

/** Is a recovery running right now? */
export function isRecovering(stuck: StuckState): boolean {
  return stuck.recoveryTick !== NEVER_TICK
}

/** Forget the anchor and any recovery. A round boundary; a goal the bot dropped. */
export function resetStuck(stuck: StuckState): void {
  stuck.anchorTick = NEVER_TICK
  stuck.recoveryTick = NEVER_TICK
  stuck.reported = false
}

/**
 * Bring the tracker up to date for this sub-step, and report whether a recovery
 * should be steering.
 *
 * `active` is "there is something to walk towards". Everything else is the anchor
 * and the two clocks above.
 */
export function trackProgress(
  stuck: StuckState,
  slot: number,
  tick: number,
  origin: Vec3,
  active: boolean,
): boolean {
  if (!active) {
    resetStuck(stuck)
    return false
  }

  if (stuck.anchorTick === NEVER_TICK) {
    stuck.anchor[0] = origin[0]
    stuck.anchor[1] = origin[1]
    stuck.anchor[2] = origin[2]
    stuck.anchorTick = tick
    return false
  }

  const dx = origin[0] - stuck.anchor[0]
  const dy = origin[1] - stuck.anchor[1]
  const dz = origin[2] - stuck.anchor[2]
  // Three dimensions, not two: a bot riding a lift or falling down a shaft is
  // making progress, and a two-dimensional test would call it wedged. There is no
  // lift in `arena1`; there is a 320-unit tower to fall off.
  if (dx * dx + dy * dy + dz * dz > STUCK_RADIUS * STUCK_RADIUS) {
    stuck.anchor[0] = origin[0]
    stuck.anchor[1] = origin[1]
    stuck.anchor[2] = origin[2]
    stuck.anchorTick = tick
    stuck.recoveryTick = NEVER_TICK
    stuck.reported = false
    return false
  }

  const stalled = tick - stuck.anchorTick

  if (stalled >= STUCK_REPORT_TICKS && !stuck.reported) {
    stuck.reported = true
    if (stuckObserver !== null) {
      stuckObserver({ slot, tick, origin: [origin[0], origin[1], origin[2]], ticksStuck: stalled })
    }
  }

  if (isRecovering(stuck)) {
    // Time is up and the bot is still here. Start again on the other side rather
    // than carrying on: the acceptance check is that a recovery resolves inside
    // {@link RECOVERY_TICKS}, so one that has not is by definition the wrong
    // escape, and repeating it would burn the rest of the round.
    if (tick - stuck.recoveryTick >= RECOVERY_TICKS) {
      stuck.recoveryTick = tick
      stuck.side = -stuck.side
      stuck.episodes += 1
    }
    return true
  }

  if (stalled > STUCK_TICKS) {
    stuck.recoveryTick = tick
    stuck.episodes += 1
    return true
  }

  return false
}

/**
 * Where a recovery steers, given the direction the follower wanted.
 *
 * Writes a horizontal unit vector into `out` and returns whether the escape wants
 * the jump button this sub-step.
 *
 * Phase one is straight back. Phase two is perpendicular, on {@link
 * StuckState.side}, and asks for a jump on its first sub-step — once, because a
 * jump that repeats is a bot bouncing on the spot, which is the second most
 * visible failure in this file.
 */
export function recoverySteer(
  stuck: StuckState,
  tick: number,
  wishX: number,
  wishY: number,
  out: MutVec3,
): boolean {
  const elapsed = tick - stuck.recoveryTick
  const length = Math.sqrt(wishX * wishX + wishY * wishY)
  // No direction to reverse — the bot is wedged with nowhere it wanted to go.
  // Fall back to `+x` so that the escape is still a function of the position that
  // caused it rather than of whatever the last non-zero wish happened to be.
  const ux = length === 0 ? 1 : wishX / length
  const uy = length === 0 ? 0 : wishY / length

  if (elapsed < RECOVERY_BACK_TICKS) {
    out[0] = -ux
    out[1] = -uy
    out[2] = 0
    return false
  }

  // Perpendicular: `(-uy, ux)` turns a quarter of a turn towards `+y`, which is
  // the bot's left, because `+y` is left in the Quake frame.
  out[0] = stuck.side >= 0 ? -uy : uy
  out[1] = stuck.side >= 0 ? ux : -ux
  out[2] = 0
  return elapsed === RECOVERY_BACK_TICKS
}
