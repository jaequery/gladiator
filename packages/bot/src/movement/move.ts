/**
 * The follower: a route, a link, and one `UserCmd`'s worth of axes. GLAD-TSED8V.
 *
 * This is the file the ticket is about. Everything in it exists because of one
 * constraint: **the bot emits exactly the struct a human emits**. There is no
 * "move to point P" available — only "which of `forwardMove` and `sideMove` on
 * `-1/0/+1`, given the yaw the aim controller chose, produces velocity towards P
 * under the friction and acceleration model". So movement is a controller, and
 * this is its loop.
 *
 * ## The three guards, and where each one lives
 *
 * 1. **Ledge guard.** `movement/ledge.ts` probes the ground under the projected
 *    position and re-steers when there is none. It is switched on here rather than
 *    inside a controller, and it is switched off for exactly the two link kinds
 *    that mean "there is supposed to be nothing under you" — `drop` and `jump`. A
 *    controller that had to remember to disable it would be one refactor away from
 *    a bot that walks off every ledge in the arena.
 * 2. **Link ownership.** The bot is on **exactly one** link, and it keeps it until
 *    the controller says it arrived, until the bot is displaced off it, or until
 *    the hop runs out of time. It deliberately does *not* re-ask the graph every
 *    sub-step: `nodeNear` flips to the far node halfway along a link, so a
 *    follower that re-derived every tick would start cutting corners — and a cut
 *    corner is a straight line across geometry nothing validated, which on the
 *    mound ring is a line through the tower and off the far edge. Falling while
 *    the link is a `walk` is a bug and a test assertion, not something fixed up
 *    here.
 * 3. **Airborne recovery.** The axes are **latched at take-off** and held. Air
 *    acceleration is a tenth of the ground figure, so a stick oscillating mid-air
 *    buys nothing and reads as a machine; the only two things that change a
 *    latched heading are the circle jump's bounded offset window and a single
 *    permitted correction when the flight is carrying the bot *away* from where it
 *    was going.
 *
 * ## Why the jump button is released between hops
 *
 * `PMF_JUMP_HELD` is cleared only by a sub-step with the button up
 * (`pmove/index.ts`), so a bot that held jump would jump once and never again.
 * {@link MoveState.jumpHeld} is this layer's copy of that latch and it is why no
 * two consecutive commands ever carry `BUTTON_JUMP`.
 *
 * ## What it reads
 *
 * A {@link WorldModel} and a {@link BotDecision}, and level data — the collision
 * world and the nav graph — that it is handed once at construction. Level data is
 * not ground truth: the geometry of the arena is on both players' screens, and the
 * nav graph is a function of it. What it never sees is a `GameState`, which
 * `eslint.config.js`'s `GROUND_TRUTH_BANS` enforces by refusing the name in this
 * directory at all.
 */

import { MatchPhase, vec3 } from '@gladiator/sim'
import type { CollisionWorld, MutVec3, RngHolder, Vec3 } from '@gladiator/sim'

import type { BotDecision } from '../brain.ts'
import type { LoadedNav } from '../nav/load.ts'
import { hopKind, nextHop, nodeNear, nodeOrigin } from '../nav/query.ts'
import { NO_NODE } from '../nav/schema.ts'
import type { NavLinkKind } from '../nav/schema.ts'
import { navLinkBudget } from '../nav/validate.ts'
import { NEVER_TICK } from '../perception/worldModel.ts'
import type { WorldModel } from '../perception/worldModel.ts'
import { createStuck, isRecovering, recoverySteer, resetStuck, trackProgress } from '../stuck.ts'
import type { StuckState } from '../stuck.ts'
import { createIntent, travellerFor, walkTravel } from '../travel/index.ts'
import type { Travel, TravelIntent } from '../travel/index.ts'
import {
  CIRCLE_JUMP_HOLD_TICKS,
  createStraightRun,
  straightRun,
  wantsCircleJump,
} from './circleJump.ts'
import type { StraightRun } from './circleJump.ts'
import { guardedAxes } from './ledge.ts'
import { roamTarget } from './roam.ts'
import { createAxes, rotate45, steerAxes } from './steer.ts'
import type { Axes } from './steer.ts'

/**
 * The level data a bot moves through.
 *
 * Both together, or neither. A nav graph without the world it was baked against
 * cannot be ledge-probed, and a world without a graph cannot be routed on — so the
 * pair is one value with one name rather than two optional parameters that can
 * disagree. `nav` is separately nullable because a world with no graph is a real
 * configuration: the bot steers straight at its goal, ledge-guarded, which is what
 * `perception/fairness.test.ts`'s two sealed chambers are.
 */
export type BotTerrain = {
  readonly world: CollisionWorld
  readonly nav: LoadedNav | null
}

/** Everything the follower remembers between sub-steps. */
export type MoveState = {
  readonly terrain: BotTerrain | null
  /** The bot's seeded stream, shared with the perception layer. `bot.ts`. */
  readonly rng: RngHolder

  /** The node the current hop starts from, or {@link NO_NODE}. */
  atNode: number
  /** The node the current hop ends at, or {@link NO_NODE}. */
  hopNode: number
  /** The node the route is heading for, or {@link NO_NODE}. */
  goalNode: number
  /**
   * How the current hop is travelled, or `null` when the bot is not on a link at
   * all — off the graph, or steering at a point inside its own node.
   *
   * This is the field guard 2 is about, and the one the soak asserts on: a bot
   * that is falling while this says `'walk'` is a bug in the graph or in this file.
   */
  hop: NavLinkKind | null
  /** The sub-step the current hop began on, or {@link NEVER_TICK}. */
  hopTick: number
  /** How many sub-steps this hop gets before it is given up on. */
  hopBudget: number
  /** Where the current hop started, at the feet. */
  readonly from: MutVec3
  /** The point being steered at: a node, or the goal on the last leg. */
  readonly target: MutVec3
  /** Whether there is anything to walk towards at all. */
  hasTarget: boolean
  /**
   * How far the route goes straight from here, and which way it bends at the end.
   *
   * The circle jump's trigger and its lean (`movement/circleJump.ts`), recomputed
   * when a hop is derived rather than every sub-step — it is a property of the
   * route, and the route only changes when the hop does.
   */
  readonly run: StraightRun
  /** Whether the current straight run has already spent its one hop. */
  runHopped: boolean

  /** Where a roam is heading, or {@link NO_NODE}. */
  roamNode: number

  /** The axes latched at take-off, held for the flight. */
  readonly airAxes: Axes
  /** The circle jump's offset axes, held for {@link CIRCLE_JUMP_HOLD_TICKS}. */
  readonly hopAxes: Axes
  /** Whether {@link airAxes} holds a latch for the current flight. */
  latched: boolean
  /** Sub-steps of offset wish left to hold. */
  offsetTicks: number
  /** Whether this flight has spent its one permitted mid-air correction. */
  corrected: boolean

  /** What was sent last sub-step, so the next one can release. See the header. */
  jumpHeld: boolean
  readonly stuck: StuckState

  /* ---- this sub-step's answer ---- */
  readonly axes: Axes
  jump: boolean
  /** Whether the ledge guard changed the direction. Diagnostics and tests. */
  vetoed: boolean
  /** The controller's own intent, before the guards. Reused; never reallocated. */
  readonly intent: TravelIntent
}

export function createMovement(rng: RngHolder, terrain: BotTerrain | null = null): MoveState {
  return {
    terrain,
    rng,
    atNode: NO_NODE,
    hopNode: NO_NODE,
    goalNode: NO_NODE,
    hop: null,
    hopTick: NEVER_TICK,
    hopBudget: 0,
    from: vec3(),
    target: vec3(),
    hasTarget: false,
    run: createStraightRun(),
    runHopped: false,
    roamNode: NO_NODE,
    airAxes: createAxes(),
    hopAxes: createAxes(),
    latched: false,
    offsetTicks: 0,
    corrected: false,
    jumpHeld: false,
    stuck: createStuck(),
    axes: createAxes(),
    jump: false,
    vetoed: false,
    intent: createIntent(),
  }
}

/* Scratch. Single-threaded and synchronous; see `perception/sight.ts`. */
const goal: MutVec3 = vec3()
const rotated: MutVec3 = vec3()
const beyond: MutVec3 = vec3()
const nodePoint: MutVec3 = vec3()

/** The controller's input, filled in once a sub-step. See {@link Travel}. */
const travel: {
  origin: Vec3
  velocity: Vec3
  onGround: boolean
  from: Vec3
  to: Vec3
  flat: number
  rise: number
} = {
  origin: vec3(),
  velocity: vec3(),
  onGround: false,
  from: vec3(),
  to: vec3(),
  flat: 0,
  rise: 0,
}

/** Hands off the sticks entirely, and forget the route. */
function stand(move: MoveState): void {
  move.axes.forwardMove = 0
  move.axes.sideMove = 0
  move.jump = false
  move.jumpHeld = false
  move.hop = null
  move.hopTick = NEVER_TICK
  move.hasTarget = false
  move.latched = false
  move.offsetTicks = 0
  move.roamNode = NO_NODE
  resetStuck(move.stuck)
}

/**
 * Whether a command sent now reaches the bot's body.
 *
 * The kernel's own rule (`match/match.ts`'s `acceptsCommands`), restated against
 * the model's copy of the phase because that is all this layer is given. A bot that
 * kept driving through an intermission would look like one that had stopped
 * responding, since nothing it sent would move anything — and `stuck.ts` would call
 * three seconds of it a wedge.
 */
function steerable(phase: MatchPhase): boolean {
  return phase === MatchPhase.Warmup || phase === MatchPhase.Live
}

/**
 * One sub-step of movement. Writes {@link MoveState.axes} and
 * {@link MoveState.jump}; `brain.ts` assembles the command around them.
 *
 * `yaw` is the view the aim controller has already chosen for this sub-step, and
 * it arrives as an argument rather than being read off the model because the axes
 * are relative to it: the command is built once, in one order, and the aim is
 * decided before the feet are.
 */
export function moveBot(
  move: MoveState,
  model: WorldModel,
  decision: BotDecision,
  yaw: number,
): void {
  move.vetoed = false
  const self = model.self

  if (!self.alive || !steerable(model.match.phase)) {
    stand(move)
    return
  }

  const terrain = move.terrain
  const nav = terrain === null ? null : terrain.nav
  const near = nav === null ? NO_NODE : nodeNear(nav, self.origin)

  if (!chooseGoal(move, model, decision, nav, near)) {
    stand(move)
    return
  }

  planHop(move, nav, near, model.tick, self)

  /* ---- what the link's controller wants ---- */
  fillTravel(move, model)
  const controller = move.hop === null ? walkTravel : travellerFor(move.hop)
  const intent = controller(travel, move.intent)

  /* ---- stuck recovery may take the wheel ---- */
  const recovering = trackProgress(
    move.stuck,
    self.slot,
    model.tick,
    self.origin,
    move.hasTarget,
  )
  if (recovering) {
    intent.jump = recoverySteer(
      move.stuck,
      model.tick,
      intent.wish[0],
      intent.wish[1],
      intent.wish,
    )
    // A recovery is not an arrival, whatever the controller thought: the bot has
    // not moved 32 units in three seconds, so anything within the arrive radius is
    // a node it is standing next to and cannot leave.
    intent.arrived = false
  }

  /* ---- the circle jump ---- */
  const speed = Math.sqrt(
    self.velocity[0] * self.velocity[0] + self.velocity[1] * self.velocity[1],
  )
  const align =
    speed === 0
      ? 0
      : (self.velocity[0] * intent.wish[0] + self.velocity[1] * intent.wish[1]) / speed
  const hopping =
    !recovering &&
    move.hop === 'walk' &&
    move.run.lean !== 0 &&
    wantsCircleJump(self.onGround, speed, align, move.run.length, move.runHopped)
  if (hopping) intent.jump = true

  /* ---- axes: latched in the air, guarded on the ground ---- */
  const airborne = !self.onGround
  if (!airborne) {
    move.latched = false
    move.corrected = false
    move.offsetTicks = 0
  }

  if (intent.jump && !move.jumpHeld && self.onGround) {
    takeOff(move, yaw, intent, hopping)
  } else if (airborne) {
    fly(move, model, yaw, intent)
  } else {
    ground(move, model, yaw, intent)
  }

  move.jumpHeld = move.jump

  // Arrival is consumed *after* the command is built, so the sub-step the bot
  // arrives on is still driven by the link it arrived along. Clearing the hop is
  // how the next sub-step is made to ask the graph again — there is no plan to
  // advance, which is the property `nav/query.ts` is built around.
  if (intent.arrived) {
    if (move.hopNode !== NO_NODE && move.hopNode === move.goalNode) move.roamNode = NO_NODE
    // The last leg has no next link to ask for — the bot is standing on the thing it
    // wanted. Clearing the hop there would re-derive the identical walk every
    // sub-step, which costs nothing and makes `hop` flicker in every readout that
    // shows it. Anything that should end it — the goal moving, the bot being knocked
    // off — is already one of `planHop`'s four re-anchors.
    if (move.hopNode !== move.atNode) {
      move.hop = null
      move.hopTick = NEVER_TICK
    }
  }
}

/* --------------------------------------------------------------------------
 * Where to go
 * ----------------------------------------------------------------------- */

/**
 * Fill in {@link goal} and return whether there is one.
 *
 * Two sources, and the second is why a bot is never idle:
 *
 * 1. **The decision's goal.** Something the brain wants: the opponent's believed
 *    position, today (`brain.ts`).
 * 2. **A roam target.** `movement/roam.ts` argues why search behaviour lives down
 *    here — `brain.ts` points at it by name.
 *
 * There is deliberately no third case in which the bot stands still. `decide` stops
 * setting a goal once a contact is inside {@link ENGAGE_RANGE}, and that means
 * *stop closing* rather than *stop moving*: a bot rooted to a spot in front of
 * somebody holding a rocket launcher is a bot losing a duel, and it is also the one
 * failure mode a player reads as "the AI is broken". So the absence of a goal is
 * answered with a route somewhere, which is what "moves around the arena" means.
 *
 * A layer that genuinely wants the bot to plant itself — holding an angle on a
 * corridor, waiting out a reload it does not have — should say so with a flag on
 * {@link BotDecision}, so that standing still is always a decision somebody took
 * rather than a gap in this ladder. Nothing wants one today.
 */
function chooseGoal(
  move: MoveState,
  model: WorldModel,
  decision: BotDecision,
  nav: LoadedNav | null,
  near: number,
): boolean {
  if (decision.hasGoal) {
    move.roamNode = NO_NODE
    goal[0] = decision.goal[0]
    goal[1] = decision.goal[1]
    goal[2] = decision.goal[2]
    return true
  }

  if (nav === null) return false

  if (move.roamNode === NO_NODE) move.roamNode = roamTarget(nav, move.rng, near)
  if (move.roamNode === NO_NODE) return false
  nodeOrigin(nav, move.roamNode, goal)
  return true
}

/**
 * Keep the current link, or ask the graph for a new one.
 *
 * Four things end a hop, and the list is short on purpose — see guard 2 in the
 * header for why re-deriving every sub-step would be worse than any of them:
 *
 * - **`hop === null`** — the previous sub-step arrived, or there was never a link.
 * - **displaced** — the nearest node is neither end of the link the bot thought it
 *   was on. That is a rocket having moved it, and the answer is already correct for
 *   wherever it landed.
 * - **stale** — the hop has taken longer than {@link navLinkBudget} allows, which
 *   is the same budget `nav/validate.ts` gives up on a link after. A hop that is
 *   over budget is one the graph is wrong about, and the bot re-anchors rather than
 *   pressing forward at it for the rest of the round.
 * - **the goal moved**, but only on the ground and only on a `walk`. Turning around
 *   mid-`walk` is free — a walk link is symmetric by definition (`nav/schema.ts`) —
 *   and abandoning a `jump` or a `drop` halfway through is the same thing as
 *   falling.
 *
 * **Every one of the four re-anchors to `near`**, and that uniformity is a fix
 * rather than tidiness. Keeping the old `atNode` when only the goal had moved looked
 * harmless and was not: a bot most of the way down a ramp, spotting the opponent and
 * therefore changing goal, re-derived its route from the node at the *top* of the
 * ramp and spent a sub-step being told to walk back up it. Anchoring at the nearest
 * node is the answer that is correct wherever the bot actually is, which is the same
 * property `nav/query.ts` is built around.
 */
function planHop(
  move: MoveState,
  nav: LoadedNav | null,
  near: number,
  tick: number,
  self: WorldModel['self'],
): void {
  if (nav === null) {
    move.atNode = NO_NODE
    move.hopNode = NO_NODE
    move.goalNode = NO_NODE
    move.hop = null
    setTarget(move, self.origin, goal)
    return
  }

  const goalNode = nodeNear(nav, goal)
  const displaced = near !== move.atNode && near !== move.hopNode
  const stale = move.hopTick !== NEVER_TICK && tick - move.hopTick > move.hopBudget

  const rerouted = goalNode !== move.goalNode && self.onGround && move.hop === 'walk'
  if (!(move.hop === null || displaced || stale || rerouted)) return

  move.atNode = near
  move.hop = null
  move.goalNode = goalNode
  move.hopTick = tick

  const at = move.atNode
  if (at === NO_NODE || goalNode === NO_NODE) {
    // Somewhere the graph does not describe. That is a real answer and it is a
    // thing to walk out of rather than to route from (`nav/query.ts`): steer
    // straight at the goal, ledge-guarded, and re-ask next sub-step.
    move.hopNode = NO_NODE
    setTarget(move, self.origin, goal)
    return
  }

  if (at === goalNode) {
    // The last leg. The goal is inside the node the bot is standing at, so this is
    // a walk by construction — which is what keeps guard 2's assertion meaningful
    // right up to the moment the bot arrives.
    move.hopNode = at
    move.hop = 'walk'
    nodeOrigin(nav, at, beyond)
    setTarget(move, beyond, goal)
    return
  }

  const next = nextHop(nav, at, goalNode)
  if (next === NO_NODE) {
    move.hopNode = NO_NODE
    setTarget(move, self.origin, goal)
    return
  }

  move.hopNode = next
  // A next-hop table entry that is not a direct link would be a corrupt artifact
  // rather than a routing answer, and `walk` is the reading that keeps the ledge
  // guard switched on for it — the conservative direction.
  move.hop = hopKind(nav, at, next) ?? 'walk'
  nodeOrigin(nav, at, beyond)
  setTarget(move, beyond, nodeOrigin(nav, next, nodePoint))

  // The straight run, and the turn at the end of it — the circle jump's trigger and
  // its lean. Measured from where the bot actually is, so the trigger is "at the
  // start of a straight run" rather than "anywhere along one", and reset only when
  // the run itself changes so that one run gets one hop.
  const previousEnd = move.run.end
  straightRun(nav, self.origin, at, goalNode, move.run)
  if (move.run.end !== previousEnd) move.runHopped = false
}

/** Point the follower at `to`, from `from`, and reset the hop's own clocks. */
function setTarget(move: MoveState, from: Vec3, to: Vec3): void {
  move.from[0] = from[0]
  move.from[1] = from[1]
  move.from[2] = from[2]
  move.target[0] = to[0]
  move.target[1] = to[1]
  move.target[2] = to[2]
  move.hasTarget = true
  move.hopBudget = navLinkBudget(flatBetween(from, to))
  move.run.length = 0
  move.run.end = NO_NODE
  move.run.lean = 0
  move.runHopped = false
}

function flatBetween(a: Vec3, b: Vec3): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  return Math.sqrt(dx * dx + dy * dy)
}

/** Copy this sub-step's body and link into the controller's input. */
function fillTravel(move: MoveState, model: WorldModel): Travel {
  const self = model.self
  travel.origin = self.origin
  travel.velocity = self.velocity
  travel.onGround = self.onGround
  travel.from = move.from
  travel.to = move.target
  travel.flat = flatBetween(self.origin, move.target)
  travel.rise = move.target[2] - self.origin[2]
  return travel
}

/* --------------------------------------------------------------------------
 * The three ways axes get chosen
 * ----------------------------------------------------------------------- */

/** Leaving the ground: latch the heading, and the offset window if this is a hop. */
function takeOff(move: MoveState, yaw: number, intent: TravelIntent, hopping: boolean): void {
  steerAxes(yaw, intent.wish[0], intent.wish[1], move.airAxes)

  if (hopping) {
    rotate45(intent.wish[0], intent.wish[1], move.run.lean, rotated)
    steerAxes(yaw, rotated[0], rotated[1], move.hopAxes)
    move.offsetTicks = CIRCLE_JUMP_HOLD_TICKS
    move.runHopped = true
  } else {
    move.offsetTicks = 0
  }

  const held = move.offsetTicks > 0 ? move.hopAxes : move.airAxes
  move.axes.forwardMove = held.forwardMove
  move.axes.sideMove = held.sideMove
  move.latched = true
  move.jump = true
}

/**
 * In the air: hold what was latched.
 *
 * The one exception is a flight that is carrying the bot away from where it was
 * going, which is a mistimed take-off or a knockback. `AIR_STOP_ACCELERATE` exists
 * for exactly that case (`pmove/accelerate.ts`) — 2.5 rather than 1, applying if
 * and only if the wish opposes the velocity, so it can kill speed the bot did not
 * want and never add speed it did not earn. The correction is allowed **once** per
 * flight: twice is an oscillation, and an oscillation is the tell.
 */
function fly(move: MoveState, model: WorldModel, yaw: number, intent: TravelIntent): void {
  const self = model.self

  if (!move.latched) {
    steerAxes(yaw, intent.wish[0], intent.wish[1], move.airAxes)
    move.latched = true
    move.offsetTicks = 0
  } else if (!move.corrected && move.offsetTicks === 0) {
    const away =
      self.velocity[0] * intent.wish[0] + self.velocity[1] * intent.wish[1] < 0
    if (away) {
      steerAxes(yaw, intent.wish[0], intent.wish[1], move.airAxes)
      move.corrected = true
    }
  }

  const held = move.offsetTicks > 0 ? move.hopAxes : move.airAxes
  if (move.offsetTicks > 0) move.offsetTicks -= 1
  move.axes.forwardMove = held.forwardMove
  move.axes.sideMove = held.sideMove
  move.jump = false
}

/**
 * On the ground and not taking off: quantise, then let the ledge guard have a look.
 *
 * The guard is off for `drop` and `jump` and on for everything else, including the
 * `null` hop — a bot that is off the graph is the one that most needs to be told
 * there is a hole in front of it.
 */
function ground(move: MoveState, model: WorldModel, yaw: number, intent: TravelIntent): void {
  const terrain = move.terrain

  if (terrain !== null && move.hop !== 'drop' && move.hop !== 'jump') {
    move.vetoed = guardedAxes(
      terrain.world,
      model.self.origin,
      model.self.velocity,
      yaw,
      intent.wish[0],
      intent.wish[1],
      isRecovering(move.stuck) ? move.stuck.side : move.run.lean,
      move.axes,
    )
  } else {
    steerAxes(yaw, intent.wish[0], intent.wish[1], move.axes)
  }

  move.jump = false
}
