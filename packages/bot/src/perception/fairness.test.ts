/**
 * The fairness harness: the four claims that make "the bot is not omniscient"
 * a property rather than a promise.
 *
 * 1. **The mutation test.** Perturb ground truth the `WorldModel` does not
 *    carry and the bot's `UserCmd` stream comes out **bit-identical**. Binary
 *    and un-gameable — unlike a correlation threshold, which can be satisfied
 *    by a bot that cheats a little. A *positive control* moves the opponent
 *    somewhere the bot can see and requires the stream to differ, so the whole
 *    thing cannot pass by the bot standing still.
 * 2. **The blind test.** With the opponent behind a sealed wall and silent,
 *    confidence falls to exactly zero inside the memory window, and the bot's
 *    commands are identical for five different true bearings — which is
 *    "uncorrelated with the true bearing" in its strongest form: *independent*
 *    of it.
 * 3. **The sound-only test.** A rocket fired from outside the field of view at
 *    1400 units turns the bot towards the *sound* bearing, which is wrong by up
 *    to 22 degrees, and not towards the opponent.
 * 4. **The structural check.** The contact record carries no health, no
 *    armour, no ammunition and no aim, it is a copy rather than a window on to
 *    an `EntityState`, and no number anywhere in the model is one only the
 *    opponent's body knows. The *static* half of this claim is the lint rule
 *    `GROUND_TRUTH_BANS` (`eslint.config.js`), proved to fire by
 *    `scripts/guardrails.mjs`.
 */

import {
  BUTTON_ATTACK,
  EntityKind,
  NEVER_FIRED,
  Weapon,
  seedRng,
  spawnEntity,
  yawUnitsFromDegrees,
} from '@gladiator/sim'
import type { UserCmd } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { MAX_TURN_UNITS } from '../brain.ts'
import { FLOOR, angleBetween, bearingDegrees, createArena, place, runBot } from './fixture.ts'
import type { Arena, RunOptions } from './fixture.ts'
import {
  MEMORY_TICKS,
  SOUND_BEARING_ERROR_DEGREES,
  SOUND_DISTANCE_ERROR,
} from './worldModel.ts'

const UNITS_PER_DEGREE = 65536 / 360

/** The opponent standing still, holding what they spawned with. */
function idle(over: Partial<UserCmd> = {}): UserCmd {
  return {
    forwardMove: 0,
    sideMove: 0,
    yaw: 0,
    pitch: 0,
    buttons: 0,
    weapon: Weapon.RocketLauncher,
    ...over,
  }
}

/* --------------------------------------------------------------------------
 * 1. The mutation test
 * ----------------------------------------------------------------------- */

/**
 * The scenario every mutation is run against.
 *
 * The opponent is visible and 900 units away for the first 60 sub-steps, at the
 * edge of the cone rather than dead ahead, so the bot acquires them, *turns*,
 * and starts closing — a stream with something in it. At step 60 they are
 * teleported into the far chamber, which no sight line reaches and no sound
 * crosses at that range, and the remaining 280 sub-steps are the belief
 * decaying to nothing. Both halves matter: a mutation has to be invisible while
 * the bot is *looking*, and invisible while it is remembering.
 */
const RUN_STEPS = 340
const TELEPORT_STEP = 60
const HIDDEN: [number, number, number] = [0, 700, FLOOR]

function scenario(): Arena {
  return createArena({
    seed: 11,
    botOrigin: [0, -1100, FLOOR],
    botYawDegrees: 130,
    enemyOrigin: [0, -200, FLOOR],
  })
}

function baselineOptions(): RunOptions {
  return {
    before: (arena, step) => {
      if (step === TELEPORT_STEP) place(arena.enemy, HIDDEN)
    },
    enemyCmd: () => idle(),
  }
}

function play(options: RunOptions): UserCmd[] {
  return runBot(scenario(), RUN_STEPS, options)
}

/**
 * A perturbation of ground truth, and whether the bot is allowed to notice it.
 *
 * Everything below is either a field the model deliberately does not carry, or
 * a field it carries only under a gate that is shut for the whole run.
 */
const MUTATIONS: readonly { name: string; options: RunOptions }[] = [
  {
    name: 'the opponent is on 25 health rather than 100',
    options: {
      ...baselineOptions(),
      before: (arena, step) => {
        arena.enemy.health = 25
        if (step === TELEPORT_STEP) place(arena.enemy, HIDDEN)
      },
    },
  },
  {
    name: 'the opponent has no armour left',
    options: {
      ...baselineOptions(),
      before: (arena, step) => {
        arena.enemy.armor = 0
        if (step === TELEPORT_STEP) place(arena.enemy, HIDDEN)
      },
    },
  },
  {
    name: 'the opponent cannot fire for another four seconds',
    options: {
      ...baselineOptions(),
      before: (arena, step) => {
        arena.enemy.nextFireTick = arena.state.tick + 500
        if (step === TELEPORT_STEP) place(arena.enemy, HIDDEN)
      },
    },
  },
  {
    name: 'the opponent fired at some point in the past',
    options: {
      ...baselineOptions(),
      before: (arena, step) => {
        // A tick that is never the current one, so this is a *record* of a shot
        // rather than a shot going off in earshot — which the bot may hear.
        if (step >= 5) arena.enemy.lastFireTick = 3
        if (step === TELEPORT_STEP) place(arena.enemy, HIDDEN)
      },
    },
  },
  {
    name: 'the opponent is looking the other way',
    options: { ...baselineOptions(), enemyCmd: () => idle({ yaw: yawUnitsFromDegrees(180) }) },
  },
  {
    name: 'the opponent switches to the railgun once out of sight',
    options: {
      ...baselineOptions(),
      enemyCmd: (step) =>
        idle({ weapon: step >= TELEPORT_STEP ? Weapon.Railgun : Weapon.RocketLauncher }),
    },
  },
  {
    name: 'the opponent hides somewhere else entirely',
    options: {
      ...baselineOptions(),
      before: (arena, step) => {
        if (step === TELEPORT_STEP) place(arena.enemy, [600, 700, FLOOR])
      },
    },
  },
  {
    name: "the world's PRNG is reseeded",
    options: {
      ...baselineOptions(),
      before: (arena, step) => {
        if (step === 0) arena.state.rng = seedRng(0xdecafbad)
        if (step === TELEPORT_STEP) place(arena.enemy, HIDDEN)
      },
    },
  },
  {
    name: 'a rocket is in the air in the far chamber',
    options: {
      ...baselineOptions(),
      before: (arena, step) => {
        if (step === TELEPORT_STEP) place(arena.enemy, HIDDEN)
        if (step !== TELEPORT_STEP + 10) return
        spawnEntity(arena.state, {
          kind: EntityKind.Projectile,
          origin: [-800, 400, 60],
          velocity: [900, 0, 0],
          trBase: [-800, 400, 60],
          ownerId: arena.enemy.id,
          weapon: Weapon.RocketLauncher,
          expireTick: arena.state.tick + 150,
        })
      },
    },
  },
]

describe('the mutation test', () => {
  const baseline = play(baselineOptions())

  it('produced a stream with something in it', () => {
    expect(baseline).toHaveLength(RUN_STEPS)
    const distinct = new Set(baseline.map((cmd) => `${cmd.yaw}:${cmd.forwardMove}:${cmd.sideMove}`))
    // A bot that stood still would pass every mutation below for the wrong
    // reason. It turns, closes, and stops — that is at least three commands.
    expect(distinct.size).toBeGreaterThan(3)
  })

  for (const mutation of MUTATIONS) {
    it(`is bit-identical when ${mutation.name}`, () => {
      expect(play(mutation.options)).toEqual(baseline)
    })
  }

  it('control: differs when the opponent stays in view and moves', () => {
    // Deliberately *moves*. Leaving them standing where they were last seen
    // produces the identical stream, because a dead-reckoned belief about a
    // body that did not move is not wrong about anything — which is the memory
    // working rather than the bot seeing through a wall.
    const watched = play({
      before: () => {},
      enemyCmd: (step) => idle({ forwardMove: step >= TELEPORT_STEP ? 1 : 0 }),
    })
    expect(watched).not.toEqual(baseline)
  })

  it('control: differs when the opponent moves somewhere still in view', () => {
    const moved = play({
      ...baselineOptions(),
      before: (arena, step) => {
        if (step === TELEPORT_STEP) place(arena.enemy, [400, -200, FLOOR])
      },
    })
    expect(moved).not.toEqual(baseline)
  })
})

/* --------------------------------------------------------------------------
 * 2. The blind test
 * ----------------------------------------------------------------------- */

describe('the blind test', () => {
  /** Sight them once, then put a sealed wall between the two of them. */
  function blind(hiddenX: number): { commands: UserCmd[]; arena: Arena; confidence: number[] } {
    const arena = createArena({
      botOrigin: [0, -700, FLOOR],
      botYawDegrees: 90,
      enemyOrigin: [0, -200, FLOOR],
    })
    const confidence: number[] = []
    const commands = runBot(arena, TELEPORT_STEP + MEMORY_TICKS + 40, {
      before: (a, step) => {
        if (step === TELEPORT_STEP) place(a.enemy, [hiddenX, 700, FLOOR])
        confidence.push(a.bot.worldModel.enemy.confidence)
      },
      enemyCmd: () => idle(),
    })
    return { commands, arena, confidence }
  }

  it('reaches zero confidence inside the memory window, and clears the contact', () => {
    const { arena, confidence } = blind(0)

    // Full confidence while it is being looked at.
    expect(confidence[TELEPORT_STEP]).toBe(1)
    // Still believed immediately afterwards, and decaying.
    const soonAfter = confidence[TELEPORT_STEP + 40] ?? 0
    expect(soonAfter).toBeGreaterThan(0)
    expect(soonAfter).toBeLessThan(1)
    // Gone by the end of the window, and gone *exactly* rather than nearly.
    expect(confidence[TELEPORT_STEP + MEMORY_TICKS] ?? -1).toBe(0)
    expect(arena.bot.worldModel.enemy.source).toBe('none')
    expect(arena.bot.worldModel.enemy.confidence).toBe(0)
  })

  it('aims identically whatever the true bearing is', () => {
    const bearings = [-1000, -500, 0, 500, 1000]
    const runs = bearings.map((x) => ({ x, ...blind(x) }))

    // The scenario is only worth anything if the bearings genuinely differ.
    const trueBearings = runs.map((run) =>
      bearingDegrees(run.arena.self.origin, run.arena.enemy.origin),
    )
    const spread = Math.max(...trueBearings) - Math.min(...trueBearings)
    expect(spread).toBeGreaterThan(60)

    // Independence, which is the strongest form of "uncorrelated": the same
    // stream, command for command, for every one of them.
    const first = runs[0]?.commands
    for (const run of runs) expect(run.commands).toEqual(first)

    // And the identical thing it aims at is the place it last *saw* them,
    // which is a different place from where they are in four of the five runs.
    // (In the fifth the two happen to be on the same bearing, which is a
    // coincidence of the geometry and not the bot knowing anything.)
    const finalYaw = (first?.[first.length - 1]?.yaw ?? 0) / UNITS_PER_DEGREE
    const lastSeen = bearingDegrees([0, -700, FLOOR], [0, -200, FLOOR])
    expect(angleBetween(finalYaw, lastSeen)).toBeLessThan(1)
    expect(trueBearings.filter((bearing) => angleBetween(finalYaw, bearing) > 10)).toHaveLength(4)
  })
})

/* --------------------------------------------------------------------------
 * 3. The sound-only test
 * ----------------------------------------------------------------------- */

describe('the sound-only test', () => {
  /** 1400 units away, directly behind the bot, with a sealed wall between. */
  const FIRE_STEP = 2

  function shot(seed: number, steps: number, after?: RunOptions['after']): Arena {
    const arena = createArena({
      seed,
      botOrigin: [0, -700, FLOOR],
      botYawDegrees: 270,
      enemyOrigin: [0, 700, FLOOR],
    })
    runBot(arena, steps, {
      // Aimed away from the wall, so the rocket is a *noise* and nothing else:
      // it never reaches the divider, and the bot never sees it.
      enemyCmd: (step) =>
        idle({
          yaw: yawUnitsFromDegrees(90),
          buttons: step === FIRE_STEP ? BUTTON_ATTACK : 0,
        }),
      ...(after === undefined ? {} : { after }),
    })
    return arena
  }

  it('hears the shot and never sees the shooter', () => {
    const arena = shot(4, 6)
    const contact = arena.bot.worldModel.enemy
    expect(contact.source).toBe('sound')
    expect(contact.visible).toBe(false)
    expect(contact.lastSeenTick).toBe(-1)
    // The shot really happened, rather than a field being poked.
    expect(arena.enemy.lastFireTick).not.toBe(NEVER_FIRED)
  })

  it('places the contact within the stated bearing and range error, and never on the truth', () => {
    const errors: number[] = []
    const ranges: number[] = []
    for (let seed = 0; seed < 64; seed += 1) {
      const arena = shot(seed, 6)
      const contact = arena.bot.worldModel.enemy
      expect(contact.source).toBe('sound')
      errors.push(
        angleBetween(
          bearingDegrees(arena.self.origin, contact.origin),
          bearingDegrees(arena.self.origin, arena.enemy.origin),
        ),
      )
      const dx = contact.origin[0] - arena.self.origin[0]
      const dy = contact.origin[1] - arena.self.origin[1]
      ranges.push(Math.sqrt(dx * dx + dy * dy) / 1400)
    }

    for (const error of errors) expect(error).toBeLessThanOrEqual(SOUND_BEARING_ERROR_DEGREES)
    for (const range of ranges) {
      expect(range).toBeGreaterThan(1 - SOUND_DISTANCE_ERROR - 0.01)
      expect(range).toBeLessThan(1 + SOUND_DISTANCE_ERROR + 0.01)
    }
    // Hearing is never a position: the whole distribution is wrong, not just
    // the tail of it.
    expect(Math.max(...errors)).toBeGreaterThan(15)
    expect(errors.filter((error) => error < 0.5).length).toBeLessThan(errors.length / 8)
  })

  it('turns to the sound bearing, which is over 15 degrees off the opponent', () => {
    // The first seed whose draw is over 15 degrees. Chosen by search rather
    // than by hand so that the number in the assertion is the design's, not a
    // seed somebody went looking for.
    let seed = -1
    for (let candidate = 0; candidate < 64 && seed < 0; candidate += 1) {
      const arena = shot(candidate, 6)
      const error = angleBetween(
        bearingDegrees(arena.self.origin, arena.bot.worldModel.enemy.origin),
        bearingDegrees(arena.self.origin, arena.enemy.origin),
      )
      if (error > 15) seed = candidate
    }
    expect(seed).toBeGreaterThanOrEqual(0)

    const yaws: number[] = []
    const aimErrors: number[] = []
    shot(seed, 200, (arena, _step, cmd) => {
      yaws.push(cmd.yaw)
      aimErrors.push(
        angleBetween(
          cmd.yaw / UNITS_PER_DEGREE,
          bearingDegrees(arena.self.origin, arena.enemy.origin),
        ),
      )
    })

    const completed = turnCompletion(yaws)
    expect(completed).toBeGreaterThan(0)
    expect(aimErrors[completed] ?? 0).toBeGreaterThan(15)
  })
})

/**
 * The first sub-step after the bot stopped slewing at its maximum rate.
 *
 * "Turn completion" has to be the tick the *rate limit* stops binding, not the
 * tick the yaw stops changing at all — the bot is walking while it turns, so
 * the bearing to a fixed point keeps moving by a unit or two forever.
 */
function turnCompletion(yaws: readonly number[]): number {
  let started = -1
  for (let i = 1; i < yaws.length; i += 1) {
    const step = Math.abs(shortest((yaws[i] ?? 0) - (yaws[i - 1] ?? 0)))
    if (started < 0 && step >= MAX_TURN_UNITS) started = i
    if (started >= 0 && i > started && step < MAX_TURN_UNITS) return i
  }
  return -1
}

function shortest(delta: number): number {
  let d = delta % 65536
  if (d > 32768) d -= 65536
  if (d <= -32768) d += 65536
  return d
}

/* --------------------------------------------------------------------------
 * 4. The structural check
 * ----------------------------------------------------------------------- */

describe('the model carries nothing a player could not have', () => {
  function watching(): Arena {
    const arena = createArena({
      botOrigin: [0, -700, FLOOR],
      botYawDegrees: 90,
      enemyOrigin: [0, -300, FLOOR],
    })
    runBot(arena, 10)
    return arena
  }

  it('has no field for the opponent that this game refuses to tell you', () => {
    const arena = watching()
    expect(arena.bot.worldModel.enemy.visible).toBe(true)
    const fields = Object.keys(arena.bot.worldModel.enemy)
    for (const banned of [
      'health',
      'armor',
      'armour',
      'ammo',
      'angles',
      'pitch',
      'nextFireTick',
      'knockbackTicks',
      'entity',
      'state',
    ]) {
      expect(fields, `EnemyContact must not carry \`${banned}\``).not.toContain(banned)
    }
  })

  it('is a copy, not a window on to the opponent', () => {
    const arena = watching()
    const believed = [...arena.bot.worldModel.enemy.origin]
    arena.enemy.origin[0] += 512
    expect([...arena.bot.worldModel.enemy.origin]).toEqual(believed)
  })

  it('contains no number only the opponent could know', () => {
    const arena = createArena({
      botOrigin: [0, -700, FLOOR],
      botYawDegrees: 90,
      enemyOrigin: [0, -300, FLOOR],
    })
    // Values nothing else in the world would ever produce, so finding one in
    // the model is proof of a leak rather than a coincidence.
    const marks = [1234.5678, 8765.4321, 4242.4242]
    runBot(arena, 10, {
      before: (a) => {
        a.enemy.health = marks[0] ?? 0
        a.enemy.armor = marks[1] ?? 0
        a.enemy.nextFireTick = marks[2] ?? 0
      },
    })
    expect(arena.bot.worldModel.enemy.visible).toBe(true)
    for (const mark of numbersIn(arena.bot.worldModel)) {
      expect(marks).not.toContain(mark)
    }
  })
})

/** Every number reachable from `value`, however deeply nested. */
function numbersIn(value: unknown, seen = new Set<object>()): number[] {
  if (typeof value === 'number') return [value]
  if (value === null || typeof value !== 'object') return []
  if (seen.has(value)) return []
  seen.add(value)
  return Object.values(value).flatMap((child) => numbersIn(child, seen))
}
