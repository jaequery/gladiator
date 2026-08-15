/**
 * A world built to make one perceptual claim at a time.
 *
 * Two sealed chambers with a wall between them, which is the only geometry the
 * fairness argument actually needs: somewhere the opponent is visible, and
 * somewhere they provably are not. Everything else the tests want — distance,
 * bearing, whether a shot is in earshot — is a position inside one of the two.
 *
 * `packages/bot` cannot reach `maps/` (`rootDir` is `./src`, which is the
 * boundary doing its job), so the map is built here out of the sim's own
 * primitives, exactly as `nav/fixture.ts` does it one directory over.
 *
 * ## The bot plays through the real kernel
 *
 * {@link runBot} does not poke a `WorldModel` and read the answer. It runs the
 * actual `tick()` with the bot's `UserCmd` in the slot a human's would be in,
 * so the bot's own body accelerates, collides and has its view angles assigned
 * by the movement phase like anybody else's. A harness that skipped that would
 * be asserting things about a bot that does not exist.
 */

import {
  EntityKind,
  NULL_CMD,
  boxBrush,
  createCollisionWorld,
  SPAWN_ARMOR,
  SPAWN_HEALTH,
  SURFACE_CLIP_EPSILON,
  Weapon,
  createGameState,
  loadMap,
  mapHashOf,
  spawnEntity,
  tick,
  yawUnitsFromDegrees,
} from '@gladiator/sim'
import type {
  CollisionWorld,
  EntityState,
  GameState,
  MapSource,
  UserCmd,
  Vec3,
} from '@gladiator/sim'

import { botCommand, createBot } from '../bot.ts'
import type { Bot } from '../bot.ts'

function box(mins: Vec3, maxs: Vec3): MapSource['brushes'][number] {
  return { kind: 'box', surface: 'shell', mins, maxs }
}

/** Half the width of the room, in Quake units. The chambers are 1200 x 1184. */
export const ROOM_HALF = 1200

/**
 * The dividing wall runs the full width and the full height at `y = 0`, so the
 * two chambers share no sight line at all — not through a doorway, not over the
 * top, not at a grazing angle from a corner. "Provably not visible" has to be a
 * property of the geometry or the blind test is asserting a coincidence.
 */
export const DIVIDER_HALF = 16

/** The fixture map, as a `MapSource`. */
export const FAIRNESS_MAP: MapSource = {
  name: 'fairness',
  title: 'Fairness',
  author: 'test',
  surfaces: [{ name: 'shell', material: 'concrete', tint: [1, 1, 1] }],
  brushes: [
    box([-ROOM_HALF, -ROOM_HALF, -64], [ROOM_HALF, ROOM_HALF, 0]),
    box([-ROOM_HALF, -ROOM_HALF, 512], [ROOM_HALF, ROOM_HALF, 576]),
    box([-ROOM_HALF - 64, -ROOM_HALF, 0], [-ROOM_HALF, ROOM_HALF, 512]),
    box([ROOM_HALF, -ROOM_HALF, 0], [ROOM_HALF + 64, ROOM_HALF, 512]),
    box([-ROOM_HALF, -ROOM_HALF - 64, 0], [ROOM_HALF, -ROOM_HALF, 512]),
    box([-ROOM_HALF, ROOM_HALF, 0], [ROOM_HALF, ROOM_HALF + 64, 512]),
    box([-ROOM_HALF, -DIVIDER_HALF, 0], [ROOM_HALF, DIVIDER_HALF, 512]),
  ],
  spawns: [
    { origin: [-600, -600, 0], yaw: 0 },
    { origin: [600, 600, 0], yaw: 32768 },
  ],
  lights: [],
  props: [],
}

/** The two seats. The bot is always slot 0. */
export const BOT_SLOT = 0
export const ENEMY_SLOT = 1

/**
 * The height a body at rest sits at, in Quake units — the trace epsilon.
 *
 * Not zero, and not "a unit above the floor", and both are worth a sentence
 * because a test that gets it wrong looks like a perception bug:
 *
 * - At exactly zero the box's bottom face is coincident with the floor's top
 *   plane, so `traceBox` reports `startsolid` and `correctAllSolid` shuffles
 *   the body a unit sideways to get it out. Every position in the test is then
 *   a unit away from where it was written.
 * - A unit *above* the floor is worse. The body falls, and the sub-step it
 *   crosses into the 0.25-unit ground band it can end up `walking` with its
 *   downward velocity never having been clipped by a contact — at which point
 *   `PM_WalkMove`'s "put the speed back after clipping to the slope" step
 *   renormalises what is left of it and turns 36 qu/s of fall into 36 qu/s of
 *   *rise*. The body bounces, forever, a unit off the floor. That is
 *   `pmove/index.ts` behaviour and reproduces with a bare `pmove` over
 *   `SKELETON_ARENA`; it is not the bot's, and it is not this ticket's to fix.
 *
 * {@link SURFACE_CLIP_EPSILON} is where a landing body actually comes to rest,
 * so a body placed there is already still on the first sub-step.
 */
export const FLOOR = SURFACE_CLIP_EPSILON

export type Arena = {
  state: GameState
  world: CollisionWorld
  bot: Bot
  /** The bot's own body. */
  self: EntityState
  /** The opponent's body — **ground truth**, which is the point of having it. */
  enemy: EntityState
}

export type ArenaOptions = {
  /** The bot's seed. Only the sound channel draws from it. */
  seed?: number
  botOrigin: Vec3
  /** Which way the bot starts facing, in degrees. `+y` is 90. */
  botYawDegrees: number
  enemyOrigin: Vec3
}

/** Two players standing in a room, and a bot driving one of them. */
export function createArena(options: ArenaOptions): Arena {
  const map = loadMap({ format: 1, hash: mapHashOf(FAIRNESS_MAP), map: FAIRNESS_MAP })
  const state = createGameState(1)

  const self = spawnEntity(state, {
    kind: EntityKind.Player,
    slot: BOT_SLOT,
    origin: [options.botOrigin[0], options.botOrigin[1], options.botOrigin[2]],
    angles: [0, yawUnitsFromDegrees(options.botYawDegrees), 0],
    health: SPAWN_HEALTH,
    armor: SPAWN_ARMOR,
    weapon: Weapon.RocketLauncher,
  })
  const enemy = spawnEntity(state, {
    kind: EntityKind.Player,
    slot: ENEMY_SLOT,
    origin: [options.enemyOrigin[0], options.enemyOrigin[1], options.enemyOrigin[2]],
    health: SPAWN_HEALTH,
    armor: SPAWN_ARMOR,
    weapon: Weapon.RocketLauncher,
  })

  return { state, world: map.world, bot: createBot(BOT_SLOT, options.seed ?? 1), self, enemy }
}

export type RunOptions = {
  /**
   * Called before the bot observes, with the tick index the run is about to
   * take. This is where a test perturbs ground truth: it has to happen before
   * `observe`, or the perturbation lands a tick late and the two runs differ by
   * one command for the wrong reason.
   */
  before?: (arena: Arena, step: number) => void
  /**
   * Called with the command the bot just produced, *before* it is simulated —
   * so `arena.self.origin` is still the position that command was computed
   * from, which is the only frame in which "the aim error at this tick" means
   * anything.
   */
  after?: (arena: Arena, step: number, cmd: UserCmd) => void
  /** What the opponent's own hands are doing. Standing still by default. */
  enemyCmd?: (step: number) => UserCmd
}

/**
 * Run the bot for `steps` sub-steps and return every command it emitted.
 *
 * One `observe` per sub-step, which is the cadence `perception/perceive.ts`
 * requires — its damage channel is an edge one sub-step wide.
 */
export function runBot(arena: Arena, steps: number, options: RunOptions = {}): UserCmd[] {
  const commands: UserCmd[] = []
  for (let step = 0; step < steps; step += 1) {
    options.before?.(arena, step)
    const cmd = botCommand(arena.bot, { state: arena.state, world: arena.world })
    commands.push(cmd)
    options.after?.(arena, step, cmd)
    tick(arena.state, [cmd, options.enemyCmd?.(step) ?? NULL_CMD], arena.world)
  }
  return commands
}

/**
 * A world containing one hanging beam and nothing else.
 *
 * The shape the weighted sight samples exist for: a body on the far side shows
 * its legs and nothing above them, which is the difference between spotting
 * somebody and keeping track of somebody already spotted.
 */
export function beamWorld(low: number, high: number): CollisionWorld {
  return createCollisionWorld([boxBrush([180, -400, low], [220, 400, high])])
}

/** A world with nothing in it at all, for the cone and the range gate. */
export function emptyWorld(): CollisionWorld {
  return createCollisionWorld([])
}

/** Put a body somewhere, at rest. A teleport, which is what a test wants. */
export function place(entity: EntityState, origin: Vec3): void {
  entity.origin[0] = origin[0]
  entity.origin[1] = origin[1]
  entity.origin[2] = origin[2]
  entity.velocity[0] = 0
  entity.velocity[1] = 0
  entity.velocity[2] = 0
}

/** The horizontal bearing from `from` to `to`, in degrees. */
export function bearingDegrees(from: Vec3, to: Vec3): number {
  return (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI
}

/** The shortest way round between two bearings in degrees, always non-negative. */
export function angleBetween(a: number, b: number): number {
  let delta = (a - b) % 360
  if (delta > 180) delta -= 360
  if (delta <= -180) delta += 360
  return Math.abs(delta)
}
