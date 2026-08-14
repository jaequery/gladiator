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
 * Gameplay. The step below moves players and expires entities, and that is all.
 * Weapons (GLAD-0QWRYK) and round rules (GLAD-L4SYN9) add phases; a real map
 * (GLAD-G2M8QQ, GLAD-B8DI4J) replaces the `CollisionWorld` the kernel is handed
 * rather than any code in here. The phase order below is the contract those
 * tickets build against, and each of them will move the golden trace — which is
 * what the golden trace is for.
 *
 * The constants come from `tick.ts` and `pmove/` rather than being restated
 * here. Two names for one number is the drift this repo is built to prevent.
 */

import { SKELETON_ARENA } from './arena.ts'
import { PLAYER_MAXS, PLAYER_MINS } from './bbox.ts'
import type { CollisionWorld } from './collide.ts'
import { copyVec3 } from './math.ts'
import { GRAVITY, createPmoveBody, pmove } from './pmove/index.ts'
import type { PmoveBody } from './pmove/index.ts'
import { advanceRng } from './rng.ts'
import { EntityFlag, EntityKind } from './state.ts'
import type { EntityState, GameState } from './state.ts'
import { MAX_HOST_FRAME_MS, TICK_DT, TICK_INTERVAL_MS } from './tick.ts'
import { NULL_CMD } from './usercmd.ts'
import type { UserCmd } from './usercmd.ts'

/**
 * The commands for one sub-step, indexed by player slot.
 *
 * A `null` or missing entry means that slot sent nothing and is treated as
 * `NULL_CMD` — the world advances regardless, or two peers would end up having
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
   * The geometry this world's bodies collide with.
   *
   * Level data, loaded once and never mutated by a sub-step, which is why it
   * sits beside the state rather than inside it: it does not need cloning for
   * reconciliation, snapshotting or hashing, and two peers agreeing about the
   * map is a question the lobby settles before the first tick.
   */
  world: CollisionWorld
  /**
   * Wall-clock milliseconds accumulated but not yet worth a sub-step.
   *
   * Always in `[0, TICK_INTERVAL_MS)`. Exactly, not approximately: `TICK_INTERVAL_MS` is 8, a
   * power of two, so `r / 8`, `Math.floor(r / 8)` and `steps * 8` are all
   * exact in IEEE 754 and the subtraction below introduces no error at all.
   */
  remainderMs: number
  /** Sub-steps run since the kernel was created. Diagnostics; not simulated. */
  steps: number
}

export function createKernel(
  state: GameState,
  world: CollisionWorld = SKELETON_ARENA,
): Kernel {
  return { state, world, remainderMs: 0, steps: 0 }
}

/* --------------------------------------------------------------------------
 * The host frame
 * ----------------------------------------------------------------------- */

/**
 * Clamp a wall-clock delta to something worth simulating through.
 *
 * A scheduler should run its measured delta through this before calling
 * `advanceHost`. `advanceHost` deliberately does not do it itself: its whole
 * contract is "exactly `floor(accumulated / TICK_INTERVAL_MS)` sub-steps", and a hidden
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
 * Runs exactly `floor((remainderMs + dtMs) / TICK_INTERVAL_MS)` sub-steps and carries
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
  const steps = Math.floor(accumulated / TICK_INTERVAL_MS)
  kernel.remainderMs = accumulated - steps * TICK_INTERVAL_MS

  for (let i = 0; i < steps; i++) {
    tick(kernel.state, commands(kernel.state.tick + 1), kernel.world)
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
export function tick(
  state: GameState,
  inputs: TickInputs,
  world: CollisionWorld = SKELETON_ARENA,
): void {
  state.tick += 1

  // The stream advances once per sub-step whether or not anything drew from
  // it, so its position is a function of the tick number alone. Gameplay draws
  // (`rngUint32` and friends) happen on top of that and move it further. The
  // unconditional beat is what makes the seed visible in the hash trace from
  // the first tick, rather than only once some code happens to roll a die.
  advanceRng(state)

  movePlayers(state, inputs, world)
  integrate(state)
  expire(state)
}

/**
 * Run `pmove` for every player entity.
 *
 * The kernel's whole share of movement is marshalling: it copies an entity into
 * the shape the collision layer moves, hands it to `pmove`, and copies the
 * result back. Every decision about *how* a player moves lives in `pmove/`, and
 * that separation is deliberate — the bot (GLAD-TSED8V) and client prediction
 * (GLAD-6RT64L) both need to run the movement over a body that is not an entity
 * in this state.
 *
 * A player with no command this sub-step is moved with `NULL_CMD` rather than
 * skipped. Gravity, friction and the ground trace all still have to run, or a
 * dropped packet would leave a player hanging in the air.
 */
function movePlayers(state: GameState, inputs: TickInputs, world: CollisionWorld): void {
  for (const entity of state.entities) {
    if (entity.kind !== EntityKind.Player) continue

    const cmd = (entity.slot < 0 ? null : inputs[entity.slot]) ?? NULL_CMD

    // Angle units in, angle units stored. `sanitizeUserCmd` has already wrapped
    // yaw and clamped pitch, so there is nothing to normalise here — which is
    // the point of quantising angles at the door rather than in the sim.
    entity.angles[0] = cmd.pitch
    entity.angles[1] = cmd.yaw
    entity.angles[2] = 0

    loadBody(scratchBody, entity)
    pmove(world, scratchBody, cmd, TICK_DT)
    storeBody(entity, scratchBody)
  }
}

/** Copy an entity into the movement body. */
function loadBody(body: PmoveBody, entity: EntityState): void {
  copyVec3(body.origin, entity.origin)
  copyVec3(body.velocity, entity.velocity)
  body.knockbackTicks = entity.knockbackTicks
  body.jumpHeld = (entity.flags & EntityFlag.JumpHeld) !== 0

  // Recomputed by `pmove`'s own ground trace before anything reads them; reset
  // here so one player cannot inherit the previous player's ground plane.
  body.groundPlane = false
  body.walking = false
  body.groundNormal[0] = 0
  body.groundNormal[1] = 0
  body.groundNormal[2] = 0
}

/** Copy the moved body back onto the entity. */
function storeBody(entity: EntityState, body: PmoveBody): void {
  copyVec3(entity.origin, body.origin)
  copyVec3(entity.velocity, body.velocity)
  entity.knockbackTicks = body.knockbackTicks

  // `OnGround` is `walking`, not `groundPlane`: a body resting against a slope
  // too steep to stand on is touching geometry, not standing on it.
  if (body.walking) entity.flags |= EntityFlag.OnGround
  else entity.flags &= ~EntityFlag.OnGround

  if (body.jumpHeld) entity.flags |= EntityFlag.JumpHeld
  else entity.flags &= ~EntityFlag.JumpHeld
}

/**
 * Gravity and Euler integration for everything that is not a player.
 *
 * Which today is nothing: the only non-player entity kind is `Projectile`, and
 * rockets are GLAD-0QWRYK's — they will want a trace and an explosion, not
 * this. It is kept as the one line of behaviour a spawned entity has so that
 * "an entity exists and the world advances" stays testable in the meantime.
 */
function integrate(state: GameState): void {
  for (const entity of state.entities) {
    if (entity.kind === EntityKind.None) continue
    if (entity.kind === EntityKind.Player) continue

    if ((entity.flags & EntityFlag.OnGround) === 0) {
      entity.velocity[2] -= GRAVITY * TICK_DT
    }

    entity.origin[0] += entity.velocity[0] * TICK_DT
    entity.origin[1] += entity.velocity[1] * TICK_DT
    entity.origin[2] += entity.velocity[2] * TICK_DT
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

/**
 * The one body every player is moved through, reused.
 *
 * Module scope so the tick loop allocates nothing, and safe for the same reason
 * the scratch writer in `state.ts` is: the simulation is single-threaded and
 * synchronous, which `await` being a lint error inside this package is there to
 * guarantee. `loadBody` overwrites every field before `pmove` reads one.
 */
const scratchBody: PmoveBody = createPmoveBody(PLAYER_MINS, PLAYER_MAXS)

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
    tick(kernel.state, commands(kernel.state.tick + 1), kernel.world)
    if (onTick !== undefined) onTick(kernel.state)
  }
  kernel.steps += count
}
