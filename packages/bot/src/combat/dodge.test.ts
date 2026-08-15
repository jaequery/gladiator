/**
 * Getting out of the way, and not getting out of the way of what you cannot see.
 * GLAD-HK3ATM's fifth acceptance check.
 *
 * The two halves are one scenario with the shooter moved. In both, the opponent
 * fires a **real rocket** through the real weapons layer by sending a `UserCmd`
 * with `BUTTON_ATTACK` in it — not a hand-spawned entity — so what the bot does
 * or does not know about it comes from `perception/perceive.ts`'s cone, range and
 * line-of-sight tests and from nothing else.
 *
 * - Fired from in front: the rocket is in {@link WorldModel.threats}, the bot
 *   decides to evade, and its feet actually move.
 * - Fired from behind, by a shooter too far away to hear: the rocket is never in
 *   `threats` at all, no evade is ever decided, and the bot's feet never move.
 *
 * **The second shooter is out of earshot on purpose, and it is not a way of
 * making the test easier.** A bot that hears a launch behind it and turns round
 * to look has done nothing wrong — that is the sound channel working, and if it
 * then sees the rocket it is entitled to dodge it. What would be a cheat is
 * dodging one it never perceived, so isolating the field of view means taking the
 * other three channels out of the scenario rather than out of the bot.
 *
 * Dodging a rocket fired from behind is the most infuriating cheat in the genre,
 * and the reason it is so common is that the naive implementation is a loop over
 * the entity list — which `eslint.config.js`'s `GROUND_TRUTH_BANS` refuses in
 * `combat/`.
 */

import { BUTTON_ATTACK, Weapon, yawUnitsFromDegrees } from '@gladiator/sim'
import type { MutVec3, UserCmd, Vec3 } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { FIRE_HEARING_RANGE } from '../perception/worldModel.ts'
import { FLOOR, bearingDegrees, createArena, runBot } from '../perception/fixture.ts'
import type { Arena } from '../perception/fixture.ts'
import { SPLASH_RADIUS } from './damage.ts'
import { DODGE_DANGER } from './dodge.ts'

/** The sub-step the opponent pulls the trigger on. */
const FIRE_STEP = 5

type Run = {
  readonly commands: UserCmd[]
  /** The first sub-step somebody else's rocket was in the threat list, or -1. */
  readonly firstThreat: number
  /** The first sub-step the decision layer wanted to evade, or -1. */
  readonly firstEvade: number
  /** Sub-steps on which it wanted to. */
  readonly evades: number
  /** The evade direction the last time there was one. */
  readonly direction: MutVec3
  /** The first sub-step the bot's own vitals dropped, or -1. */
  readonly hurt: number
  /** The arena afterwards, for the vitals. */
  readonly arena: Arena
}

/**
 * The opponent standing at `enemyOrigin`, firing once at the bot.
 *
 * They hold still otherwise, and their yaw is derived from the geometry rather
 * than typed, so the rocket is genuinely on target over any distance.
 */
function play(
  botOrigin: Vec3,
  botYawDegrees: number,
  enemyOrigin: Vec3,
  steps: number,
): Run {
  const arena: Arena = createArena({
    seed: 7,
    botOrigin,
    botYawDegrees,
    enemyOrigin,
    terrain: true,
  })

  const enemyYaw = yawUnitsFromDegrees(bearingDegrees(enemyOrigin, botOrigin))
  let firstThreat = -1
  let firstEvade = -1
  let hurt = -1
  let evades = 0
  const direction: MutVec3 = [0, 0, 0]

  const commands = runBot(arena, steps, {
    enemyCmd: (step) => ({
      forwardMove: 0,
      sideMove: 0,
      yaw: enemyYaw,
      pitch: 0,
      buttons: step === FIRE_STEP ? BUTTON_ATTACK : 0,
      weapon: Weapon.RocketLauncher,
    }),
    after: (a, step) => {
      // The bot's *own* rockets are in the list too and are always known — you
      // know where you aimed — so only somebody else's count here.
      if (firstThreat < 0 && a.bot.worldModel.threats.some((threat) => !threat.own)) {
        firstThreat = step
      }
      if (hurt < 0 && a.self.health + a.self.armor < 200) hurt = step
      const decision = a.bot.brain.decision
      if (!decision.hasEvade) return
      if (firstEvade < 0) firstEvade = step
      evades += 1
      direction[0] = decision.evade[0]
      direction[1] = decision.evade[1]
      direction[2] = decision.evade[2]
    },
  })

  return { commands, firstThreat, firstEvade, evades, direction, hurt, arena }
}

/* --------------------------------------------------------------------------
 * In front
 * ----------------------------------------------------------------------- */

/** Bot facing `+y`, opponent 500 units down it. Both inside `ENGAGE_RANGE`. */
const FRONT_BOT: Vec3 = [0, -600, FLOOR]
const FRONT_ENEMY: Vec3 = [0, -100, FLOOR]

describe('a rocket fired from in front', () => {
  const run = play(FRONT_BOT, 90, FRONT_ENEMY, 120)

  it('is perceived, through the same channel a body is', () => {
    expect(run.firstThreat).toBeGreaterThanOrEqual(0)
  })

  it('is dodged, and never before it was perceived', () => {
    expect(run.evades).toBeGreaterThan(0)
    expect(run.firstEvade).toBeGreaterThanOrEqual(run.firstThreat)
  })

  it('is dodged across its path rather than away down it', () => {
    // The rocket flies down `-y`, so an escape along `x` is perpendicular and one
    // along `y` is a retreat. Backing away from 900 qu/s buys almost nothing;
    // stepping out of the line moves the whole body for the same stride.
    expect(Math.abs(run.direction[0])).toBeGreaterThan(Math.abs(run.direction[1]))
    expect(run.direction[2]).toBe(0)
  })

  it('actually moves the feet, rather than deciding to and standing there', () => {
    // The opponent is inside `ENGAGE_RANGE` so the decision layer sets no goal,
    // and there is no nav graph to roam on. Any movement at all is the dodge.
    const moving = run.commands.filter((cmd) => cmd.forwardMove !== 0 || cmd.sideMove !== 0)
    expect(moving.length).toBeGreaterThan(0)
  })
})

/* --------------------------------------------------------------------------
 * Behind, and out of earshot
 * ----------------------------------------------------------------------- */

/**
 * Opposite corners of the same chamber: 2417 units apart, which is past
 * {@link FIRE_HEARING_RANGE} and inside `SIGHT_RANGE`. The bot faces `-x`, so
 * the shooter is 156 degrees off its centre line — outside the sight cone and
 * outside the widened one being shot opens.
 */
const BACK_BOT: Vec3 = [-1100, -100, FLOOR]
const BACK_ENEMY: Vec3 = [1100, -1100, FLOOR]

/** Long enough for 2417 units of rocket at 900 qu/s, and then some. */
const BACK_STEPS = 380

describe('a rocket fired from outside the field of view', () => {
  const run = play(BACK_BOT, 180, BACK_ENEMY, BACK_STEPS)

  it('came from somewhere the bot could not have heard', () => {
    // The scenario's own precondition. If the two ever drift together, this
    // fails rather than the test quietly becoming one about hearing.
    const dx = BACK_ENEMY[0] - BACK_BOT[0]
    const dy = BACK_ENEMY[1] - BACK_BOT[1]
    expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThan(FIRE_HEARING_RANGE)
  })

  it('is never perceived at all', () => {
    expect(run.firstThreat).toBe(-1)
  })

  it('is not dodged', () => {
    expect(run.evades).toBe(0)
  })

  it('does not move the bot while it is in the air, so the claim is about the dodge', () => {
    // Up to the explosion, and no further. *Afterwards* the bot is entitled to
    // move: it has been shoved, it turns to the bearing the hit came from, and
    // at 2417 units the shooter is inside `SIGHT_RANGE`, so it acquires them and
    // starts closing. That is four channels working. The claim is about the
    // window in which the only thing that existed was a rocket it could not see.
    expect(run.hurt).toBeGreaterThan(0)
    for (const cmd of run.commands.slice(0, run.hurt + 1)) {
      expect(cmd.forwardMove).toBe(0)
      expect(cmd.sideMove).toBe(0)
    }
  })

  it('did fire a real rocket that really reached the bot', () => {
    // Without this the silence above could be a scenario in which nothing
    // happened. The bot's own vitals are the proof: it stood there and was hit.
    expect(run.arena.self.health + run.arena.self.armor).toBeLessThan(200)
  })
})

describe('the danger threshold', () => {
  it('is a splash radius plus a body, not a body width', () => {
    // A rocket aimed at the wall beside you is the one that kills you: splash
    // does not have to touch you. So the test is a distance rather than an
    // intersection.
    expect(DODGE_DANGER).toBeGreaterThan(SPLASH_RADIUS)
  })
})
