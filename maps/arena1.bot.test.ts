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
import { CIRCLE_JUMP_HOLD_TICKS, MAX_TURN_UNITS, NAV_MAX_STEP, loadNav } from '@gladiator/bot'
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
      // A `walk` link is walkable ground the whole way (`nav/schema.ts`), so
      // leaving one means landing *more than a step* below its lower end. A
      // landing inside a step is the bot stepping down, which is the thing a
      // walk link is for. This used to assert nothing came down low at all, and
      // that was a property of the sample rather than of the movement — since
      // GLAD-6BIYFQ tuned the engagement range the bots take different routes
      // and one landing in four matches comes down 15 units, which is a step.
      expect(slot.fellOnWalk, formatSoak(soak)).toBe(0)
      expect(slot.worstWalkFall, formatSoak(soak)).toBeLessThanOrEqual(NAV_MAX_STEP)
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
    // Both seats pooled, because the claim is about the *mechanic* rather than
    // about a seat. Four matches of twenty seconds is a handful of hops, and
    // since GLAD-6BIYFQ closed the engagement range there are fewer of them —
    // a bot that stops closing sooner runs shorter routes, and a circle jump
    // needs 320 units of straight one. Per seat that leaves a denominator of two
    // or three, and a ratio over two hops is not a distribution.
    const taken = soak.slots.reduce((total, slot) => total + slot.circleJumps, 0)
    const landings = soak.slots.reduce((total, slot) => total + slot.landings, 0)
    const fast = soak.slots.reduce((total, slot) => total + slot.fastLandings, 0)
    const fastest = soak.slots.reduce((top, slot) => Math.max(top, slot.fastestLanding), 0)

    expect(taken, formatSoak(soak)).toBeGreaterThan(0)
    // And enough of them landed to have a distribution at all. `pnpm bot:soak`
    // is where this is a real sample; here it is a control on the two below.
    expect(landings, formatSoak(soak)).toBeGreaterThan(3)

    // `movement/circleJump.ts` was tuned to 369 ups over one hop down an empty lane.
    // In a match a hop taken off a ramp starts above run speed and one that clips a
    // corner mid-flight ends below it, so the claim is about the *distribution*: over
    // four hundred minutes of duel, four hops in five beat 320 and the tail is about
    // one in a hundred. A bound on the slowest landing would be a claim about that
    // one hop.
    expect(fast / landings, formatSoak(soak)).toBeGreaterThan(0.6)
    expect(fastest).toBeGreaterThan(RUN_SPEED)
    // 452 was the highest over two hundred matches, and anything much past it would
    // mean the offset window had stopped being a window.
    expect(fastest).toBeLessThan(500)
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
function play(before: (arena: BotArena) => void): UserCmd[] {
  const stream: UserCmd[] = []
  runBotMatch({
    map,
    nav,
    seed: 9,
    ticks: 600,
    botSlots: [0],
    scripted: () => NULL_CMD,
    before,
    observe: (arena) => {
      const cmd = arena.commands[0]
      if (cmd !== undefined) stream.push(cmd)
    },
  })
  return stream
}

/**
 * Pin the opponent's vitals every sub-step, and put them somewhere if asked.
 *
 * **The pinning is what makes the comparison mean anything since GLAD-HK3ATM.**
 * The bot now shoots, so an opponent perturbed down to 25 health *dies* to a rocket
 * the bot legitimately fired at a body it legitimately saw — the round ends, both
 * bots stand through an intermission, and the streams differ for a reason that has
 * nothing to do with a leak. A perturbation is only a fairness experiment while it
 * cannot change the outcome, so both numbers are held far enough above what a rocket
 * takes off (34 health through full armour, 100 through none) that neither run can
 * end early. What is left is the only thing being asked: whether the *number* reaches
 * the bot's commands.
 */
function vitals(health: number, armor: number, place?: (arena: BotArena) => void) {
  return (arena: BotArena): void => {
    const enemy = findPlayer(arena.state, 1)
    if (enemy === null) return
    enemy.health = health
    enemy.armor = armor
    place?.(arena)
  }
}

/** What every run pins the opponent to unless it is the thing being perturbed. */
const HEALTH = 1000
const ARMOR = 1000

/** Perturb a field of the opponent's body that the bot's model does not carry. */
const MUTATIONS: readonly (readonly [string, (arena: BotArena) => void])[] = [
  ['the opponent is on a quarter of the health', vitals(HEALTH / 4, ARMOR)],
  ['the opponent has no armour left', vitals(HEALTH, 0)],
  [
    'the opponent is looking straight at the bot',
    vitals(HEALTH, ARMOR, (arena) => {
      const enemy = findPlayer(arena.state, 1)
      if (enemy !== null) {
        enemy.angles[0] = 4000
        enemy.angles[1] = 32768
      }
    }),
  ],
  [
    'the opponent could fire again this instant',
    vitals(HEALTH, ARMOR, (arena) => {
      const enemy = findPlayer(arena.state, 1)
      if (enemy !== null) enemy.nextFireTick = 0
    }),
  ],
]

describe('the movement layer cannot see what the model does not carry', () => {
  const baseline = play(vitals(HEALTH, ARMOR))

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
      play(
        vitals(HEALTH, ARMOR, (arena) => {
          const enemy = findPlayer(arena.state, 1)
          if (enemy !== null && arena.state.tick === 40) {
            enemy.origin[0] = -352
            enemy.origin[1] = -220
            enemy.origin[2] = 0.125
          }
        }),
      ),
    ).not.toEqual(baseline)
  })
})
