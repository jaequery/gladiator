/**
 * A closed loop through the real movement, with no `GameState` anywhere in it.
 *
 * The follower's inputs are a {@link WorldModel} and a {@link BotDecision}, and its
 * output is a stick position. Neither end needs a simulation *state* — only a body
 * and a world — so the tests in this directory drive `pmove` directly over a
 * `PmoveBody` and copy the result into a model by hand. That is not a shortcut
 * around the real movement: `pmove` *is* the real movement, the same function the
 * kernel calls, and `packages/sim/src/kernel.ts` says in as many words that the bot
 * and client prediction both need to run it over a body that is not an entity in
 * the live state.
 *
 * The reason it matters is the fairness fence. `eslint.config.js`'s
 * `GROUND_TRUTH_BANS` refuses the name `GameState` anywhere in `packages/bot`
 * outside `perception/`, so a fixture in here *cannot* build one — and the fence is
 * worth more than the convenience. Two bots in a real match, which does need a
 * state, is `tools/bot-arena.ts` on the far side of it.
 *
 * The map is `nav/fixture.ts`'s, and the thing that makes it the right map is the
 * 128-unit hole in the middle of its floor. That hole is bottomless: the shell is
 * sealed at the top and open underneath, so a body that walks into it falls forever.
 * "Never dies to a pit while its current link is a `walk`" is therefore a claim
 * with something to bite on here, which it is not on `arena1` — Crucible has no pit
 * in it at all.
 */

import {
  BUTTON_JUMP,
  MatchPhase,
  PLAYER_MAXS,
  PLAYER_MINS,
  SURFACE_CLIP_EPSILON,
  Weapon,
  createPmoveBody,
  pmove,
  seedRng,
  yawUnitsFromDegrees,
} from '@gladiator/sim'
import type { CollisionWorld, PmoveBody, UserCmd, Vec3 } from '@gladiator/sim'

import { createBrain } from '../brain.ts'
import type { BotBrain } from '../brain.ts'
import { bakeNav } from '../nav/bake.ts'
import { fixtureMap, fixtureNav } from '../nav/fixture.ts'
import { loadNav } from '../nav/load.ts'
import type { LoadedNav } from '../nav/load.ts'
import type { NavSource } from '../nav/schema.ts'
import { createWorldModel } from '../perception/worldModel.ts'
import type { WorldModel } from '../perception/worldModel.ts'
import { createMovement, moveBot } from './move.ts'
import type { MoveState } from './move.ts'

/** The fixture map, loaded once — building a collision world is not free. */
const MAP = fixtureMap()

/** The fixture map's collision world. */
export function fixtureWorld(): CollisionWorld {
  return MAP.world
}

/**
 * Bake and load a nav graph against the fixture map.
 *
 * Through the real bake, so a fixture graph that would not survive `pnpm nav:bake`
 * fails here rather than quietly giving the follower a route the arena's graph could
 * never contain.
 */
export function fixtureLoadedNav(source: NavSource = fixtureNav()): LoadedNav {
  const outcome = bakeNav(source, MAP)
  if (!outcome.ok) {
    throw new Error(
      `gladiator: the movement fixture's graph does not bake:\n${outcome.diagnostics
        .map((d) => `  ${d.code}: ${d.detail}`)
        .join('\n')}`,
    )
  }
  return loadNav(JSON.parse(JSON.stringify(outcome.baked)) as unknown, MAP.hash)
}

/** A body, a model, a follower, and the tick they share. */
export type Walker = {
  readonly world: CollisionWorld
  readonly nav: LoadedNav | null
  readonly body: PmoveBody
  readonly model: WorldModel
  readonly move: MoveState
  readonly brain: BotBrain
  tick: number
}

export type WalkerOptions = {
  /** Where the feet start. Dropped an epsilon clear of the surface — see below. */
  readonly origin: Vec3
  /** The graph to route on, or `null` for a bot with a world and no graph. */
  readonly nav?: LoadedNav | null
  /** The bot's seed. Only roaming draws from it, down here. */
  readonly seed?: number
}

/**
 * A walker standing at `origin`.
 *
 * The feet go {@link SURFACE_CLIP_EPSILON} above the surface rather than on it, for
 * the reason `perception/fixture.ts` spells out at length: on the plane exactly, the
 * box's bottom face is coincident with the floor's top plane and the trace reports
 * `startsolid`; a whole unit above it, the body can enter the 0.25-unit ground band
 * with its downward velocity un-clipped and bounce off the floor forever.
 */
export function createWalker(options: WalkerOptions): Walker {
  const body = createPmoveBody(PLAYER_MINS, PLAYER_MAXS)
  body.origin[0] = options.origin[0]
  body.origin[1] = options.origin[1]
  body.origin[2] = options.origin[2] + SURFACE_CLIP_EPSILON

  const model = createWorldModel(0)
  model.self.alive = true
  model.match.phase = MatchPhase.Live

  const nav = options.nav ?? null
  const rng = { rng: seedRng(options.seed ?? 1) }
  return {
    world: MAP.world,
    nav,
    body,
    model,
    move: createMovement(rng, { world: MAP.world, nav }),
    brain: createBrain(rng),
    tick: 0,
  }
}

export type WalkOptions = {
  /** Where to go, or `null` to leave the follower to roam. */
  readonly goal?: Vec3 | null
  /** The view yaw in degrees, which the aim controller owns and this stands in for. */
  readonly yawDegrees?: number | ((step: number) => number)
  /** Called after the command is built, before it is simulated. */
  readonly after?: (walker: Walker, step: number, cmd: UserCmd) => void
}

/**
 * Run `steps` sub-steps and return every command the follower produced.
 *
 * One `moveBot` and one `pmove` per sub-step, in that order, which is the order the
 * kernel runs them in — the command is computed from the body *before* the sub-step
 * and simulated after it. Getting that backwards is the phase trap
 * `tools/bot-arena.ts` documents.
 */
export function walk(walker: Walker, steps: number, options: WalkOptions = {}): UserCmd[] {
  const commands: UserCmd[] = []
  const goal = options.goal ?? null

  for (let step = 0; step < steps; step += 1) {
    const yawDegrees =
      typeof options.yawDegrees === 'function'
        ? options.yawDegrees(step)
        : (options.yawDegrees ?? 0)
    const yaw = yawUnitsFromDegrees(yawDegrees)

    readBody(walker, yaw)

    const decision = walker.brain.decision
    decision.hasGoal = goal !== null
    if (goal !== null) {
      decision.goal[0] = goal[0]
      decision.goal[1] = goal[1]
      decision.goal[2] = goal[2]
    }

    moveBot(walker.move, walker.model, decision, yaw)
    const cmd: UserCmd = {
      forwardMove: walker.move.axes.forwardMove,
      sideMove: walker.move.axes.sideMove,
      yaw,
      pitch: 0,
      buttons: walker.move.jump ? BUTTON_JUMP : 0,
      weapon: Weapon.RocketLauncher,
    }
    commands.push(cmd)
    options.after?.(walker, step, cmd)

    pmove(walker.world, walker.body, cmd)
    walker.tick += 1
  }

  return commands
}

/** Copy the body into the model, which is all the perception layer would have done. */
function readBody(walker: Walker, yaw: number): void {
  const self = walker.model.self
  walker.model.tick = walker.tick
  self.origin[0] = walker.body.origin[0]
  self.origin[1] = walker.body.origin[1]
  self.origin[2] = walker.body.origin[2]
  self.velocity[0] = walker.body.velocity[0]
  self.velocity[1] = walker.body.velocity[1]
  self.velocity[2] = walker.body.velocity[2]
  self.angles[0] = 0
  self.angles[1] = yaw
  self.angles[2] = 0
  self.onGround = walker.body.walking
}

/** How far the walker is from a point, horizontally. */
export function flatTo(walker: Walker, point: Vec3): number {
  const dx = point[0] - walker.body.origin[0]
  const dy = point[1] - walker.body.origin[1]
  return Math.sqrt(dx * dx + dy * dy)
}

/** The walker's horizontal speed, in qu/s. */
export function speedOf(walker: Walker): number {
  const v = walker.body.velocity
  return Math.sqrt(v[0] * v[0] + v[1] * v[1])
}
