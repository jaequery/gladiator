/**
 * Two bots moving around Crucible, and the four claims a match can be measured
 * against. GLAD-TSED8V.
 *
 * `packages/bot/src/movement/*.test.ts` is about the pieces, over a fixture map built
 * to make one rule expressible at a time. This file is about *this arena*: the graph
 * that ships, the geometry that ships, and whether the movement gets a body round it
 * without leaving the world, falling off a walk, turning faster than a human can, or
 * standing on something for three seconds.
 *
 * It runs a handful of matches so that `pnpm test` stays something somebody runs
 * before every commit. **The acceptance check's two hundred matches of two minutes is
 * `pnpm bot:soak`**, which is the same claims from the same `soakFailures` at forty
 * times the sample — the only difference between the two is how long you are prepared
 * to wait.
 */

import { readFileSync } from 'node:fs'

import { NULL_CMD, RUN_SPEED, TICK_RATE, findPlayer, loadMap } from '@gladiator/sim'
import type { UserCmd } from '@gladiator/sim'
import { CIRCLE_JUMP_HOLD_TICKS, MAX_TURN_UNITS, loadNav } from '@gladiator/bot'
import { describe, expect, it } from 'vitest'

import { formatSoak, runBotMatch, soakBots, soakFailures } from '../tools/bot-arena.ts'
import type { BotArena } from '../tools/bot-arena.ts'

const map = loadMap(JSON.parse(readFileSync('maps/baked/arena1.json', 'utf8')))
const nav = loadNav(JSON.parse(readFileSync('maps/baked/arena1.nav.json', 'utf8')), map.hash)

/** Four matches of twenty seconds. Enough to cross the arena a dozen times each. */
const MATCHES = 4
const SECONDS = 20

const soak = soakBots({ map, nav, seed: 1, matches: MATCHES, seconds: SECONDS })

describe('the sample is worth asserting on', () => {
  it('has both bots covering real ground rather than standing still', () => {
    // Every claim below is trivially true of a bot that did not move. This is the
    // control: at least half of a flat-out run's distance, and most of the time spent
    // on a link rather than off the graph.
    const floor = RUN_SPEED * SECONDS * MATCHES * 0.5
    for (const slot of soak.slots) {
      expect(slot.distance, formatSoak(soak)).toBeGreaterThan(floor)
      expect(slot.hops['walk'] ?? 0).toBeGreaterThan(soak.ticks * 0.5)
    }
  })

  it('exercises the drop links, which are most of what is interesting up there', () => {
    // `arena1` has eight drops off the mound corners and six off the perches. A run
    // that never took one would not have tested the controller that does not jump.
    const drops = soak.slots.reduce((total, slot) => total + (slot.hops['drop'] ?? 0), 0)
    expect(drops).toBeGreaterThan(0)
  })
})

describe('the acceptance checks', () => {
  it('all hold over the sample', () => {
    // One assertion, because `soakFailures` is where the claims live — the CLI at two
    // hundred matches and this test at four must not be able to disagree about what
    // passing means.
    expect(soakFailures(soak), formatSoak(soak)).toEqual([])
  })

  it('never leaves the map AABB', () => {
    for (const slot of soak.slots) expect(slot.outsideAabb).toBe(0)
  })

  it('never falls off a walk link', () => {
    for (const slot of soak.slots) {
      expect(slot.fellOnWalk).toBe(0)
      expect(slot.worstWalkFall).toBeLessThanOrEqual(0)
    }
  })

  it('never turns faster than the configured rate, plus 5%', () => {
    const cap = Math.floor(MAX_TURN_UNITS * 1.05)
    for (const slot of soak.slots) {
      expect(slot.maxYawDelta).toBeLessThanOrEqual(cap)
      expect(slot.maxPitchDelta).toBeLessThanOrEqual(cap)
      // And it does turn: a bot whose view never moved would pass the cap by not
      // having a rate at all.
      expect(slot.maxYawDelta).toBeGreaterThan(0)
    }
  })

  it('never sends a pitch outside +/-89 degrees', () => {
    for (const slot of soak.slots) expect(slot.maxPitch).toBeLessThanOrEqual(16202)
  })

  it('resolves every stall well inside the recovery budget', () => {
    for (const slot of soak.slots) {
      expect(slot.worstStall).toBeLessThanOrEqual(3 * TICK_RATE + Math.round(1.5 * TICK_RATE))
    }
  })
})

describe('the circle jump, over a real match rather than an empty lane', () => {
  it('mostly lands faster than a flat-out run, and never absurdly faster', () => {
    const taken = soak.slots.reduce((total, slot) => total + slot.circleJumps, 0)
    expect(taken, formatSoak(soak)).toBeGreaterThan(0)
    for (const slot of soak.slots) {
      if (slot.landings === 0) continue
      // `movement/circleJump.ts` was tuned to 369 ups over one hop down an empty lane.
      // In a match a hop taken off a ramp starts above run speed and one that clips a
      // corner mid-flight ends below it, so the claim is about the *distribution*: over
      // four hundred minutes of duel, four hops in five beat 320 and the tail is about
      // one in a hundred. A bound on the slowest landing would be a claim about that
      // one hop.
      expect(slot.fastLandings / slot.landings, formatSoak(soak)).toBeGreaterThan(0.6)
      expect(slot.fastestLanding).toBeGreaterThan(RUN_SPEED)
      // 452 was the highest over two hundred matches, and anything much past it would
      // mean the offset window had stopped being a window.
      expect(slot.fastestLanding).toBeLessThan(500)
    }
  })

  it('holds its offset for a bounded window rather than the whole flight', () => {
    // 24 sub-steps of a 90-sub-step hop. The rest of the flight is the latched
    // heading, which is what keeps the drift to a third of the mound ring's width.
    expect(CIRCLE_JUMP_HOLD_TICKS).toBeLessThan(90)
  })
})

/* --------------------------------------------------------------------------
 * The fairness boundary, extended to the movement layer
 * ----------------------------------------------------------------------- */

/**
 * One bot, one opponent standing still, and the bot's whole command stream.
 *
 * One bot rather than two, for the reason `BotArenaOptions.botSlots` gives: perturbing
 * the opponent's health legitimately changes the *opponent's* own commands, so a
 * two-bot run could not tell a leak from the other bot reacting to its own vitals.
 */
function play(before?: (arena: BotArena) => void): UserCmd[] {
  const stream: UserCmd[] = []
  runBotMatch({
    map,
    nav,
    seed: 9,
    ticks: 600,
    botSlots: [0],
    scripted: () => NULL_CMD,
    ...(before === undefined ? {} : { before }),
    observe: (arena) => {
      const cmd = arena.commands[0]
      if (cmd !== undefined) stream.push(cmd)
    },
  })
  return stream
}

/** Perturb a field of the opponent's body that the bot's model does not carry. */
const MUTATIONS: readonly (readonly [string, (arena: BotArena) => void])[] = [
  [
    'the opponent is on 25 health rather than 100',
    (arena) => {
      const enemy = findPlayer(arena.state, 1)
      if (enemy !== null) enemy.health = 25
    },
  ],
  [
    'the opponent has no armour left',
    (arena) => {
      const enemy = findPlayer(arena.state, 1)
      if (enemy !== null) enemy.armor = 0
    },
  ],
  [
    'the opponent is looking straight at the bot',
    (arena) => {
      const enemy = findPlayer(arena.state, 1)
      if (enemy !== null) {
        enemy.angles[0] = 4000
        enemy.angles[1] = 32768
      }
    },
  ],
  [
    'the opponent could fire again this instant',
    (arena) => {
      const enemy = findPlayer(arena.state, 1)
      if (enemy !== null) enemy.nextFireTick = 0
    },
  ],
]

describe('the movement layer cannot see what the model does not carry', () => {
  const baseline = play()

  it('produced a stream with movement in it', () => {
    expect(baseline).toHaveLength(600)
    const moving = baseline.filter((cmd) => cmd.forwardMove !== 0 || cmd.sideMove !== 0)
    expect(moving.length).toBeGreaterThan(500)
  })

  for (const [name, mutate] of MUTATIONS) {
    it(`routes identically when ${name}`, () => {
      // Bit-identical, command for command. The static half of this claim is
      // `GROUND_TRUTH_BANS` in `eslint.config.js`, which refuses the *name*
      // `EntityState` anywhere in `packages/bot` outside `perception/` — so nothing in
      // `movement/`, `travel/` or `stuck.ts` could reach any of the fields above even
      // if it wanted to. This is the consequence, measured.
      expect(play(mutate)).toEqual(baseline)
    })
  }

  it('control: routes differently when the opponent moves somewhere it can be seen', () => {
    // Without this the whole block above could pass by the bot ignoring the world.
    expect(
      play((arena) => {
        const enemy = findPlayer(arena.state, 1)
        if (enemy !== null && arena.state.tick === 40) {
          enemy.origin[0] = -352
          enemy.origin[1] = -220
          enemy.origin[2] = 0.125
        }
      }),
    ).not.toEqual(baseline)
  })
})
