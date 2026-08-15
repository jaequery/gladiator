/**
 * What the opponent is doing, derived from what the network says they are.
 *
 * This file has no Babylon import and never will. It is the half of player
 * representation that is *decidable* — given a netstate and a tick, which
 * animation is playing — and keeping it away from the engine is what lets a
 * test drive a recorded state sequence and assert the sequence of animations it
 * produces, without a GPU, a canvas or a frame.
 *
 * ## Driven from network state, never from local guesses
 *
 * The tempting shortcut is to animate from what the renderer can see: start a
 * run cycle when the mesh moves, play a landing when it stops falling, flash a
 * muzzle when a rocket appears. Every one of those is a *guess about a
 * simulation that is authoritative somewhere else*, and each guess is wrong in
 * its own way under packet loss — the mesh stops moving because a snapshot was
 * late, not because the player stopped.
 *
 * So the input here is {@link PlayerNetState}: a copy of the fields of
 * `EntityState` the representation is allowed to read, and nothing else. Under
 * loss the animation is exactly as stale as the state it came from, which is
 * the correct amount of stale, and it snaps back the moment a snapshot lands.
 *
 * ## It is a fold, and that is deliberate
 *
 * {@link advanceAnim} takes the *previous* frame as well as the netstate. One
 * animation genuinely needs a bit of history: landing. `EntityState` says
 * whether a player is on the ground and it does not say whether they arrived
 * this tick, and it cannot be inferred from the state alone — `pmove` clips the
 * velocity against the floor plane in the same sub-step that sets `OnGround`,
 * so on the landing tick the vertical velocity is already zero. The one bit
 * that is missing is "were they airborne last time", and the fold carries it.
 *
 * That keeps the whole thing pure and replayable: same recorded sequence, same
 * animation sequence, every time, at any frame rate, with no clock read
 * anywhere. `animState.test.ts` asserts exactly that.
 *
 * ## The state list is what a duellist reads
 *
 * `idle`, `run`, `jump`, `land`, `fire-rocket`, `fire-rail`, `death`. At arena
 * distance an opponent is a few dozen pixels, and what you need off those
 * pixels is which way they are moving and which weapon just went off — so the
 * two firing poses are distinct states rather than one `fire`, and the run
 * carries a {@link MoveDirection} so a strafe reads as a strafe rather than as
 * a player who happens to be facing away from their travel.
 */
import {
  EntityFlag,
  type EntityState,
  NEVER_FIRED,
  type Vec3,
  Weapon,
  angleUnitsToRadians,
} from '@gladiator/sim'

/**
 * The slice of `EntityState` the visual representation may read.
 *
 * Deeply readonly, and a **copy** — `playerNetState` clones the vectors rather
 * than aliasing them. Both halves matter: `readonly` stops the renderer writing
 * to simulation state at compile time, and the copy stops it *reading* a value
 * that `tick()` has since changed underneath it. `tick()` mutates entities in
 * place and keeps the same objects (`AGENTS.md`), so a held reference would
 * quietly become a reference to the present.
 */
export type PlayerNetState = {
  readonly id: number
  readonly slot: number
  /** Feet, Quake frame. */
  readonly origin: Vec3
  /** Quake units per second, Quake frame. */
  readonly velocity: Vec3
  /** `[pitch, yaw, roll]` in angle units. */
  readonly angles: Vec3
  /** `EntityFlag` bits. */
  readonly flags: number
  readonly health: number
  readonly weapon: Weapon
  /** The tick they last fired on, or `NEVER_FIRED`. */
  readonly lastFireTick: number
}

/** Copy the readable slice out of an entity. The renderer's only door in. */
export function playerNetState(entity: EntityState): PlayerNetState {
  return {
    id: entity.id,
    slot: entity.slot,
    origin: [entity.origin[0], entity.origin[1], entity.origin[2]],
    velocity: [entity.velocity[0], entity.velocity[1], entity.velocity[2]],
    angles: [entity.angles[0], entity.angles[1], entity.angles[2]],
    flags: entity.flags,
    health: entity.health,
    weapon: entity.weapon,
    lastFireTick: entity.lastFireTick,
  }
}

/** The animations a player model can be playing. */
export const AnimState = {
  Idle: 'idle',
  Run: 'run',
  Jump: 'jump',
  Land: 'land',
  FireRocket: 'fire-rocket',
  FireRail: 'fire-rail',
  Death: 'death',
} as const

export type AnimState = (typeof AnimState)[keyof typeof AnimState]

/**
 * Which way a player is travelling relative to where they are looking.
 *
 * Separate from {@link AnimState} because it is orthogonal to it: a player
 * strafing right is strafing right whether they are running, airborne or
 * shooting, and the legs should say so in all three.
 */
export const MoveDirection = {
  Still: 'still',
  Forward: 'forward',
  Back: 'back',
  Left: 'left',
  Right: 'right',
} as const

export type MoveDirection = (typeof MoveDirection)[keyof typeof MoveDirection]

/**
 * How long a firing pose is held, in sub-steps. 25 = 200 ms.
 *
 * Long enough to be seen across an arena on a frame that happened to land
 * between two snapshots, short enough that it is over before the next rocket.
 * It is a *display* duration and has nothing to do with a weapon's refire time,
 * which is GLAD-0QWRYK's and belongs to the simulation.
 */
export const FIRE_TICKS = 25

/** How long the landing crouch is held, in sub-steps. 15 = 120 ms. */
export const LAND_TICKS = 15

/**
 * Horizontal speed below which a player is standing still, in qu/s.
 *
 * 20 is well under a walk and well over the residual velocity friction leaves
 * behind, so a stopped player stops rather than shuffling.
 */
export const IDLE_SPEED = 20

/**
 * One player's animation, and the one bit of history the fold carries.
 *
 * `since` is a *tick*, not a timestamp: everything that reads it is comparing
 * against the simulation's own clock, which is the only clock either peer
 * agrees about.
 */
export type AnimFrame = {
  readonly state: AnimState
  /** The tick `state` was entered on. Blend weights are derived from it. */
  readonly since: number
  /** Travel relative to facing. Present in every state, including `jump`. */
  readonly move: MoveDirection
  /** Horizontal speed, qu/s. Drives the stride rate. */
  readonly speed: number
  /** Off the ground. Carried so the *next* frame can recognise a landing. */
  readonly airborne: boolean
}

/** What a player model starts on, before any netstate has arrived. */
export const INITIAL_ANIM: AnimFrame = {
  state: AnimState.Idle,
  since: 0,
  move: MoveDirection.Still,
  speed: 0,
  airborne: false,
}

/** Horizontal speed. `Math.hypot` is fine here — this is not the simulation. */
export function horizontalSpeed(velocity: Vec3): number {
  return Math.sqrt(velocity[0] * velocity[0] + velocity[1] * velocity[1])
}

/**
 * Travel direction relative to facing.
 *
 * Quake's basis at roll zero: forward is `(cos y, sin y)` and right is
 * `(sin y, -cos y)` — `+y` is *left* in the Quake frame, which is why right
 * carries the minus sign. Getting that backwards mirrors every strafe
 * animation, and a mirrored strafe is worse than no strafe animation: it tells
 * a player the opponent is about to move the wrong way.
 */
export function moveDirection(velocity: Vec3, yawUnits: number): MoveDirection {
  if (horizontalSpeed(velocity) < IDLE_SPEED) return MoveDirection.Still

  const yaw = angleUnitsToRadians(yawUnits)
  const cos = Math.cos(yaw)
  const sin = Math.sin(yaw)
  const forward = velocity[0] * cos + velocity[1] * sin
  const right = velocity[0] * sin - velocity[1] * cos

  if (Math.abs(forward) >= Math.abs(right)) {
    return forward >= 0 ? MoveDirection.Forward : MoveDirection.Back
  }
  return right >= 0 ? MoveDirection.Right : MoveDirection.Left
}

/** Dead by either measure. Both, because either one alone would flicker. */
export function isDead(net: PlayerNetState): boolean {
  return (net.flags & EntityFlag.Dead) !== 0 || net.health <= 0
}

/**
 * Whether the firing pose is still on screen at `tick`.
 *
 * Derived from `tick - lastFireTick` rather than from a fire *event*, which is
 * what makes it survive a dropped snapshot: a client that misses the snapshot
 * the shot happened on still draws the tail of the animation from the next one.
 * See the header of `packages/sim/src/weapon.ts`.
 */
export function isFiring(net: PlayerNetState, tick: number): boolean {
  if (net.lastFireTick === NEVER_FIRED) return false
  const elapsed = tick - net.lastFireTick
  // A fire tick in the future is a snapshot from ahead of us — during
  // reconciliation, or from a peer whose clock we have not caught up with. Draw
  // it: a shot about to happen is better than a shot that never does.
  return elapsed >= 0 && elapsed < FIRE_TICKS
}

/** The firing animation for a weapon, or `null` if it has none. */
function fireStateFor(weapon: Weapon): AnimState | null {
  if (weapon === Weapon.RocketLauncher) return AnimState.FireRocket
  if (weapon === Weapon.Railgun) return AnimState.FireRail
  return null
}

/**
 * The next animation frame.
 *
 * Pure: `(previous, net, tick)` in, a frame out, no clock and no engine. The
 * priority order below is the interesting part, and it is chosen for what a
 * duellist has to read first:
 *
 *   1. **death** — nothing after it matters
 *   2. **firing** — the one thing you have to react to *now*
 *   3. **airborne** — a player in the air cannot change direction much, which
 *      is the whole reason to shoot at where they will be
 *   4. **landing** — a short crouch, so a hop reads as a hop
 *   5. **run / idle** — by speed
 *
 * Firing above airborne means a rocket jump draws as a shot rather than as a
 * jump. That is the right way round: the jump is obvious from the trajectory
 * and the shot is what is about to hurt you.
 */
export function advanceAnim(
  previous: AnimFrame,
  net: PlayerNetState,
  tick: number,
): AnimFrame {
  const airborne = (net.flags & EntityFlag.OnGround) === 0
  const speed = horizontalSpeed(net.velocity)
  const move = moveDirection(net.velocity, net.angles[1])
  const state = nextState(previous, net, tick, airborne, speed)

  return {
    state,
    since: state === previous.state ? previous.since : tick,
    move,
    speed,
    airborne,
  }
}

function nextState(
  previous: AnimFrame,
  net: PlayerNetState,
  tick: number,
  airborne: boolean,
  speed: number,
): AnimState {
  if (isDead(net)) return AnimState.Death

  if (isFiring(net, tick)) {
    const firing = fireStateFor(net.weapon)
    if (firing !== null) return firing
  }

  if (airborne) return AnimState.Jump

  // Touched down this frame, or still inside the window opened when we did.
  if (previous.airborne) return AnimState.Land
  if (previous.state === AnimState.Land && tick - previous.since < LAND_TICKS) {
    return AnimState.Land
  }

  return speed >= IDLE_SPEED ? AnimState.Run : AnimState.Idle
}

/**
 * Run a recorded netstate sequence through the machine.
 *
 * Exists for the test that the acceptance check names, and it is worth having
 * as production code rather than as a fixture: it is the definition of "the
 * animation is a fold over the snapshots", written once, so the test cannot
 * accidentally assert a different fold than the renderer runs.
 */
export function animSequence(
  states: readonly PlayerNetState[],
  startTick = 0,
  initial: AnimFrame = INITIAL_ANIM,
): AnimFrame[] {
  const frames: AnimFrame[] = []
  let frame = initial
  for (const [index, net] of states.entries()) {
    frame = advanceAnim(frame, net, startTick + index)
    frames.push(frame)
  }
  return frames
}
