/**
 * The fixed-timestep kernel: a 125 Hz simulation sub-stepped inside a ~60 Hz
 * host frame.
 *
 * ## Why sub-stepping rather than a 125 Hz loop
 *
 * The 8 ms step is not a performance target, it is a *feel* constant. Quake's
 * movement snaps velocity to integers every step, so the step length decides
 * how much of gravity survives the rounding: at exactly 8 ms, gravity 800
 * loses 0.4 units of velocity per step to the snap and behaves like 750, which
 * is the number a jump arc is actually measured against. Change the step and
 * every jump in the game changes height. See `docs/physics-spec.md` §0.1.
 *
 * Running 125 timer wakeups per second per room would be a different way to
 * get that, and a worse one. Node's timers have millisecond granularity and a
 * shared Fly vCPU has real steal, so the wakeups arrive late, in bursts, and
 * the sim would have to correct for a scheduler it cannot control. Instead the
 * host wakes up whenever it likes, reports how much wall-clock has passed, and
 * the kernel converts that into a whole number of exact 8.000 ms sub-steps and
 * carries the remainder to the next frame. Quake's own `Pmove()` does the same
 * thing for the same reason.
 *
 * ## `tick()` mutates in place
 *
 * `tick(state, inputs)` advances `state` by one sub-step and returns nothing.
 * It allocates nothing in the steady state. A caller that needs the previous
 * state — a client keeping a pre-prediction copy, a test diffing two runs —
 * calls `cloneGameState` first. This is stated in `AGENTS.md` because it is
 * the one surprising thing about the API and the cost of getting it wrong is a
 * bug that only shows up under packet loss.
 *
 * ## What is *not* here yet
 *
 * Gameplay. The step below applies input, gravity and a flat floor, and that
 * is on purpose — this ticket is the engine, not the game. `pmove` proper
 * (GLAD-0B1GDS) replaces `applyCommands`; swept-AABB tracing (GLAD-3SCN0U)
 * replaces the floor plane in `integrate`; weapons (GLAD-0QWRYK) and round
 * rules (GLAD-L4SYN9) add phases. The phase order below is the contract those
 * tickets build against, and each of them will move the golden trace — which
 * is what the golden trace is for.
 */

import { DT, GRAVITY, JUMP_VELOCITY, MAX_HOST_FRAME_MS, TICK_MS } from './constants.ts'
import { angleVectors, vec3, wrapAngle } from './math.ts'
import type { MutVec3 } from './math.ts'
import { Button, IDLE_CMD, MOVE_AXIS_MAX, isPressed } from './proto/usercmd.ts'
import type { UserCmd } from './proto/usercmd.ts'
import { advanceRng } from './rng.ts'
import { EntityFlag, EntityKind } from './state.ts'
import type { GameState } from './state.ts'

/**
 * The commands for one sub-step, indexed by player slot.
 *
 * A `null` or missing entry means that slot sent nothing and is treated as
 * `IDLE_CMD` — the world advances regardless, or two peers would end up having
 * simulated different numbers of ticks.
 */
export type TickInputs = readonly (UserCmd | null | undefined)[]

/** No player sent anything this sub-step. */
export const NO_INPUTS: TickInputs = []

/**
 * Where the commands for a sub-step come from.
 *
 * A function rather than a queue so the kernel never owns buffering policy.
 * The server closes over its per-client input buffers (GLAD-5995PA), the
 * client over its own predicted commands, a replay test over a fixed script.
 */
export type CommandSource = (tick: number) => TickInputs

/** Called after every sub-step. See `advanceHost`. */
export type TickObserver = (state: GameState) => void

export type Kernel = {
  state: GameState
  /**
   * Wall-clock milliseconds accumulated but not yet worth a sub-step.
   *
   * Always in `[0, TICK_MS)`. Exactly, not approximately: `TICK_MS` is 8, a
   * power of two, so `r / 8`, `Math.floor(r / 8)` and `steps * 8` are all
   * exact in IEEE 754 and the subtraction below introduces no error at all.
   */
  remainderMs: number
  /** Sub-steps run since the kernel was created. Diagnostics; not simulated. */
  steps: number
}

export function createKernel(state: GameState): Kernel {
  return { state, remainderMs: 0, steps: 0 }
}

/* --------------------------------------------------------------------------
 * The host frame
 * ----------------------------------------------------------------------- */

/**
 * Clamp a wall-clock delta to something worth simulating through.
 *
 * A scheduler should run its measured delta through this before calling
 * `advanceHost`. `advanceHost` deliberately does not do it itself: its whole
 * contract is "exactly `floor(accumulated / TICK_MS)` sub-steps", and a hidden
 * clamp would make that contract a lie in exactly the situation — a long
 * hitch — where someone is trying to work out why the two peers disagree.
 *
 * Deciding to *throw time away* is policy, and policy belongs to the
 * scheduler (GLAD-FHKBN8), which is also the only layer that can tell the
 * other peer it just did so.
 */
export function clampHostDelta(dtMs: number): number {
  if (!Number.isFinite(dtMs) || dtMs < 0) return 0
  return dtMs > MAX_HOST_FRAME_MS ? MAX_HOST_FRAME_MS : dtMs
}

/**
 * Advance the world by `dtMs` of host time.
 *
 * Runs exactly `floor((remainderMs + dtMs) / TICK_MS)` sub-steps and carries
 * what is left over into the next call. Returns the number of sub-steps run.
 *
 * `onTick` is called after each sub-step, not once per host frame. The server
 * needs that: a snapshot or a state hash sampled per frame would silently skip
 * whichever ticks happened to share a frame, and "we compared hashes and they
 * matched" would stop meaning anything.
 *
 * Throws on a negative or non-finite `dtMs`. A clock that went backwards is a
 * bug in the caller, and swallowing it here would turn it into a desync
 * somewhere else.
 */
export function advanceHost(
  kernel: Kernel,
  dtMs: number,
  commands: CommandSource,
  onTick?: TickObserver,
): number {
  if (!Number.isFinite(dtMs) || dtMs < 0) {
    throw new RangeError(`advanceHost: dtMs must be finite and >= 0, got ${dtMs}`)
  }

  const accumulated = kernel.remainderMs + dtMs
  const steps = Math.floor(accumulated / TICK_MS)
  kernel.remainderMs = accumulated - steps * TICK_MS

  for (let i = 0; i < steps; i++) {
    tick(kernel.state, commands(kernel.state.tick + 1))
    if (onTick !== undefined) onTick(kernel.state)
  }

  kernel.steps += steps
  return steps
}

/* --------------------------------------------------------------------------
 * One sub-step
 * ----------------------------------------------------------------------- */

/**
 * Advance `state` by one 8 ms sub-step. Mutates in place; returns nothing.
 *
 * The phase order is the contract. It is fixed, and it is the reason two peers
 * running different builds of the *renderer* still agree about the world.
 */
export function tick(state: GameState, inputs: TickInputs): void {
  state.tick += 1

  // The stream advances once per sub-step whether or not anything drew from
  // it, so its position is a function of the tick number alone. Gameplay draws
  // (`rngUint32` and friends) happen on top of that and move it further. The
  // unconditional beat is what makes the seed visible in the hash trace from
  // the first tick, rather than only once some code happens to roll a die.
  advanceRng(state)

  applyCommands(state, inputs)
  integrate(state)
  expire(state)
}

/**
 * Turn `UserCmd`s into intent on the controlling entity.
 *
 * **Placeholder.** Real `pmove` — friction, `Accelerate`, air control, the
 * strafe-jump projection, integer velocity snapping — is GLAD-0B1GDS and
 * replaces the body of this function. What is here sets angles and drives the
 * player around at a flat speed, which is enough to make the golden trace
 * depend on every field of a command that matters.
 */
function applyCommands(state: GameState, inputs: TickInputs): void {
  for (const entity of state.entities) {
    if (entity.kind !== EntityKind.Player) continue
    if (entity.slot < 0) continue

    const cmd = inputs[entity.slot] ?? IDLE_CMD

    entity.angles[0] = wrapAngle(cmd.pitch)
    entity.angles[1] = wrapAngle(cmd.yaw)
    entity.angles[2] = wrapAngle(cmd.roll)

    // Movement is horizontal, so the wish direction is taken from yaw alone —
    // looking at the floor must not slow you down. `pmove` does the same.
    angleVectors(0, entity.angles[1], 0, scratchForward, scratchRight, null)

    const forwardAxis = cmd.forwardMove / MOVE_AXIS_MAX
    const rightAxis = cmd.rightMove / MOVE_AXIS_MAX

    let wishX = scratchForward[0] * forwardAxis + scratchRight[0] * rightAxis
    let wishY = scratchForward[1] * forwardAxis + scratchRight[1] * rightAxis

    // Normalise so diagonals are not faster, but only past unit length: a
    // half-pressed stick should still be half speed.
    const wishLength = Math.sqrt(wishX * wishX + wishY * wishY)
    if (wishLength > 1) {
      wishX /= wishLength
      wishY /= wishLength
    }

    const onGround = (entity.flags & EntityFlag.OnGround) !== 0

    if (onGround) {
      // No acceleration curve, no friction, no air control. All of that is the
      // point of GLAD-0B1GDS; none of it belongs in the kernel.
      entity.velocity[0] = wishX * PLACEHOLDER_SPEED
      entity.velocity[1] = wishY * PLACEHOLDER_SPEED

      if (isPressed(cmd, Button.Jump)) {
        entity.velocity[2] = JUMP_VELOCITY
        entity.flags &= ~EntityFlag.OnGround
      }
    }
  }
}

/**
 * Gravity, Euler integration, and a floor.
 *
 * **Placeholder floor.** `FLOOR_Z` stands in for the world until swept-AABB
 * tracing lands (GLAD-3SCN0U), at which point the clamp below becomes a
 * `StepSlideMove` against real geometry.
 */
function integrate(state: GameState): void {
  for (const entity of state.entities) {
    if (entity.kind === EntityKind.None) continue

    if ((entity.flags & EntityFlag.OnGround) === 0) {
      entity.velocity[2] -= GRAVITY * DT
    }

    entity.origin[0] += entity.velocity[0] * DT
    entity.origin[1] += entity.velocity[1] * DT
    entity.origin[2] += entity.velocity[2] * DT

    if (entity.kind === EntityKind.Player && entity.origin[2] <= FLOOR_Z) {
      entity.origin[2] = FLOOR_Z
      if (entity.velocity[2] < 0) entity.velocity[2] = 0
      entity.flags |= EntityFlag.OnGround
    } else {
      entity.flags &= ~EntityFlag.OnGround
    }
  }
}

/**
 * Remove entities whose lifetime has run out.
 *
 * Iterated backwards so the splice does not move an element the loop has yet
 * to visit. Ordering by `id` is preserved, which the state hash depends on —
 * see the note on `GameState.entities`.
 */
function expire(state: GameState): void {
  for (let i = state.entities.length - 1; i >= 0; i--) {
    const entity = state.entities[i]
    if (entity === undefined) continue
    if (entity.expireTick >= 0 && entity.expireTick <= state.tick) {
      state.entities.splice(i, 1)
    }
  }
}

/* --------------------------------------------------------------------------
 * Placeholder constants
 *
 * Kept here rather than in `constants.ts` so nothing mistakes them for the
 * authored physics numbers. They exist only to give the kernel something to
 * simulate before GLAD-0B1GDS and GLAD-3SCN0U land, and they will be deleted
 * with the functions above.
 * ----------------------------------------------------------------------- */

/** Flat ground speed, Quake units per second. */
const PLACEHOLDER_SPEED = 320

/** The height of the stand-in floor plane, in Quake units. */
const FLOOR_Z = 0

/**
 * Scratch vectors for `angleVectors`.
 *
 * Module scope so the tick loop allocates nothing. Safe for the same reason
 * the scratch writer in `state.ts` is: the simulation is single-threaded and
 * synchronous, which `await` being a lint error inside this package is there
 * to guarantee.
 */
const scratchForward: MutVec3 = vec3()
const scratchRight: MutVec3 = vec3()

/**
 * Advance an existing kernel by a whole number of sub-steps, ignoring the host
 * clock entirely.
 *
 * For replays, reconciliation and tests — anywhere the caller already knows
 * how many ticks it wants and a wall-clock delta would only be a way of
 * spelling that number badly.
 */
export function advanceTicks(
  kernel: Kernel,
  count: number,
  commands: CommandSource,
  onTick?: TickObserver,
): void {
  for (let i = 0; i < count; i++) {
    tick(kernel.state, commands(kernel.state.tick + 1))
    if (onTick !== undefined) onTick(kernel.state)
  }
  kernel.steps += count
}
