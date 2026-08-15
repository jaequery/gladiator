/**
 * A bot: a seeded stream, a perception layer, and a brain that reads what the
 * perception layer believes.
 *
 * It plays by emitting `UserCmd`s, exactly like a human — the same struct a
 * keyboard produces, through the same door the network uses. That is the
 * fairness guarantee at its coarsest: whatever the bot decides, it can only
 * ask for the eight numbers a player can ask for, and the server simulates
 * those with the identical `tick()` either way.
 *
 * ## The one line that touches the world
 *
 * `observe` is it. Everything after it in {@link botCommand} is a function of
 * {@link Bot.worldModel}, and this file never names `GameState` — it forwards a
 * {@link Ground} it cannot read, which is what lets `eslint.config.js`'s
 * `GROUND_TRUTH_BANS` ban the name outright.
 *
 * ## Why the PRNG is seeded
 *
 * The bot is *not* required to be bit-deterministic with the server: it is a
 * client producing input, not a peer producing a world, and it lives in
 * `packages/bot` precisely so it may use `Math.atan2` and draw noise — both
 * lint errors inside `packages/sim`. But a headless bot match has to replay, or
 * a bug found in one is a bug nobody can look at twice, so the randomness is a
 * seed rather than an ambient `Math.random()`. Today the only consumer is the
 * sound channel's bearing and range error (`perception/sound.ts`).
 */

import { seedRng } from '@gladiator/sim'
import type { RngHolder, UserCmd } from '@gladiator/sim'

import { createBrain, think } from './brain.ts'
import type { BotBrain } from './brain.ts'
import { createMovement } from './movement/move.ts'
import type { BotTerrain, MoveState } from './movement/move.ts'
import { createPerception, observe } from './perception/perceive.ts'
import type { Ground, Perception } from './perception/perceive.ts'
import type { WorldModel } from './perception/worldModel.ts'

export type Bot = {
  /** The seeded stream. See the header. */
  readonly rng: RngHolder
  readonly perception: Perception
  readonly brain: BotBrain
  /**
   * The follower: which link the bot is on, and what its feet are doing.
   * `movement/move.ts`, GLAD-TSED8V.
   *
   * Level data goes in here rather than into a parameter of {@link botCommand}
   * because the arena and its nav graph are things a bot is handed once — the same
   * argument `kernel.ts` makes for keeping the `CollisionWorld` beside the state
   * rather than inside it.
   */
  readonly movement: MoveState
  /**
   * What the bot believes.
   *
   * The same object `perception` writes, exposed here because this is the name
   * every layer above the perception boundary is written against — a test that
   * wants to know what the bot knows reads `bot.worldModel`, and one that wants
   * to know what is *true* has to go and get a `GameState` from somewhere else.
   */
  readonly worldModel: WorldModel
}

/**
 * A bot seated in `slot`, with `seed` for its stream and `terrain` to walk on.
 *
 * `terrain` is `null` for a bot with no map: it aims, it holds, and it never asks
 * for a stick position. That is the shape every test of the perception boundary
 * uses (`perception/fixture.ts`), and it is why the movement layer is optional
 * rather than required — a bot that could not be built without a nav graph would
 * make every aim assertion depend on one.
 */
export function createBot(slot: number, seed: number, terrain: BotTerrain | null = null): Bot {
  const rng: RngHolder = { rng: seedRng(seed) }
  const perception = createPerception(slot, rng)
  return {
    rng,
    perception,
    brain: createBrain(),
    movement: createMovement(rng, terrain),
    worldModel: perception.model,
  }
}

/**
 * One sub-step: perceive, then decide, then act.
 *
 * Call it once per sub-step. The perception layer's damage channel is an edge
 * on the bot's own vitals across exactly one of them (`perception/perceive.ts`),
 * and the brain's 20 Hz phase is counted off the world's tick number, so both
 * halves assume this cadence and neither would say so if it were wrong.
 */
export function botCommand(bot: Bot, ground: Ground): UserCmd {
  observe(bot.perception, ground)
  return think(bot.brain, bot.worldModel, bot.movement.terrain === null ? null : bot.movement)
}
