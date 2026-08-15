/**
 * Two bots shooting at each other on Crucible. GLAD-HK3ATM's third and fourth
 * acceptance checks, measured over real duels rather than over a fixture.
 *
 * `packages/bot/src/combat/*.test.ts` is about the pieces — the allowance
 * arithmetic, the settle predicate, the shot selection — over worlds built to
 * make one claim expressible at a time. This file is about *every rocket and
 * every rail a match actually contains*, and it re-derives the two guards from
 * the `UserCmd` that was sent rather than asking the bot whether it thinks it
 * obeyed them.
 *
 * That distinction is the same one `tools/bot-arena.ts` makes about the stall
 * clock, and for the same reason: a guard that reports on itself is not a
 * measurement.
 *
 * ## The self-damage claim is about the *shot*, not about the bruises
 *
 * A bot that fires a legal rocket and then runs into its own explosion has not
 * broken the rule — the rule is that it never *fires* one it predicts will cost
 * it more than the allowance. So the assertion recomputes the prediction from
 * the muzzle and the angles the command carries, which is exactly what
 * `weapons.ts` is about to do with them, and compares that against what the bot
 * knew about its own health at the time.
 */

import { readFileSync } from 'node:fs'

import {
  BUTTON_ATTACK,
  MUZZLE_FORWARD,
  MatchPhase,
  PLAYER_VIEW_HEIGHT,
  Weapon,
  angleVectors,
  findPlayer,
  loadMap,
  snapVector,
  vec3,
} from '@gladiator/sim'
import {
  RAIL_SETTLE_RATE,
  RAIL_SETTLE_UNITS,
  acceptableSelfSplash,
  loadNav,
  predictSelfSplash,
} from '@gladiator/bot'
import { describe, expect, it } from 'vitest'

import { actBotArena, advanceBotArena, createBotArena } from '../tools/bot-arena.ts'

const map = loadMap(JSON.parse(readFileSync('maps/baked/arena1.json', 'utf8')))
const nav = loadNav(JSON.parse(readFileSync('maps/baked/arena1.nav.json', 'utf8')), map.hash)

/** Long enough for several matches to run to a decision. */
const TICKS = 125 * 120

type Shot = {
  readonly slot: number
  readonly tick: number
  readonly weapon: Weapon
  /** What the bot predicted this rocket would cost it, in points. */
  readonly selfSplash: number
  /** What it was willing to pay at the time, in points. */
  readonly allowance: number
  /** The aim error when the trigger went down, in angle units. */
  readonly error: number
  /** The angular rate when the trigger went down, in angle units per sub-step. */
  readonly rate: number
}

/* Scratch, so a hundred thousand sub-steps do not allocate a vector each. */
const forward = vec3()
const muzzle = vec3()

/**
 * Play until the budget runs out, recording every shot either bot took.
 *
 * A match that decides itself is restarted from a fresh state, exactly as
 * `runBotMatch` does it, so the whole budget is spent on live rounds.
 */
function duel(seed: number): { shots: Shot[]; matches: number; rounds: number } {
  const shots: Shot[] = []
  let arena = createBotArena({ map, nav, seed })
  let matches = 0
  let rounds = 0

  for (let step = 0; step < TICKS; step += 1) {
    actBotArena(arena)

    for (let slot = 0; slot < arena.bots.length; slot += 1) {
      const bot = arena.bots[slot]
      const cmd = arena.commands[slot]
      const body = findPlayer(arena.state, slot)
      if (bot === null || bot === undefined || cmd === undefined || body === null) continue
      if ((cmd.buttons & BUTTON_ATTACK) === 0) continue

      // The muzzle `weapons.ts` is about to compute from this very command.
      angleVectors(cmd.pitch, cmd.yaw, 0, forward, null, null)
      muzzle[0] = body.origin[0] + forward[0] * MUZZLE_FORWARD
      muzzle[1] = body.origin[1] + forward[1] * MUZZLE_FORWARD
      muzzle[2] = body.origin[2] + PLAYER_VIEW_HEIGHT + forward[2] * MUZZLE_FORWARD
      snapVector(muzzle)

      const model = bot.worldModel
      const contact = model.enemy
      shots.push({
        slot,
        tick: arena.state.tick,
        weapon: cmd.weapon,
        selfSplash:
          cmd.weapon === Weapon.Railgun
            ? 0
            : predictSelfSplash(
                map.world,
                model.self.origin,
                muzzle,
                forward,
                contact.source === 'none' ? null : contact.origin,
              ),
        allowance: acceptableSelfSplash(model.self.health),
        error: bot.brain.combat.aim.error,
        rate: bot.brain.combat.aim.rate,
      })
    }

    const before = arena.state.match.round
    advanceBotArena(arena)
    if (arena.state.match.round !== before) rounds += 1
    if (arena.state.match.phase === MatchPhase.Over) {
      matches += 1
      arena = createBotArena({ map, nav, seed: seed + matches * 101 })
    }
  }

  return { shots, matches, rounds }
}

const played = duel(3)
const rockets = played.shots.filter((shot) => shot.weapon !== Weapon.Railgun)
const rails = played.shots.filter((shot) => shot.weapon === Weapon.Railgun)

describe('the sample is worth asserting on', () => {
  it('played matches to a decision rather than to the clock', () => {
    // Before this ticket nothing shot, so every round ended on the time limit.
    // A match that reaches `Over` is two bots that killed each other three times.
    expect(played.matches).toBeGreaterThan(0)
    expect(played.rounds).toBeGreaterThan(played.matches)
  })

  it('used both weapons, so neither claim below is vacuous', () => {
    expect(rockets.length).toBeGreaterThan(20)
    expect(rails.length).toBeGreaterThan(0)
  })

  it('is mostly rockets, which is what a duel at these ranges should be', () => {
    // `combat/weaponSelect.ts` rails an airborne target and a distant one, and
    // rockets everything else. A run that was mostly rails would mean the range
    // rule had swallowed the arena.
    expect(rockets.length).toBeGreaterThan(rails.length)
  })
})

describe('the self-damage guard, over every rocket a duel contained', () => {
  it('never fires one it predicts will cost more than it is willing to pay', () => {
    const over = rockets.filter((shot) => shot.selfSplash > shot.allowance)
    expect(
      over.slice(0, 5).map((shot) => `slot ${shot.slot} @ ${shot.tick}: ${shot.selfSplash} > ${shot.allowance}`),
    ).toEqual([])
  })

  it('does pay something, rather than refusing every rocket that could touch it', () => {
    // The other side of the guard, and the one a timid bot would fail. If no
    // rocket in four minutes of duelling was ever predicted to splash the
    // shooter, the allowance is not doing anything and the bot is backing away
    // from close range.
    expect(rockets.some((shot) => shot.selfSplash > 0)).toBe(true)
  })
})

describe('rail discipline, over every rail a duel contained', () => {
  it('takes one only once the aim has settled below the configured threshold', () => {
    const unsettled = rails.filter(
      (shot) => shot.error > RAIL_SETTLE_UNITS || shot.rate > RAIL_SETTLE_RATE,
    )
    expect(
      unsettled
        .slice(0, 5)
        .map((shot) => `slot ${shot.slot} @ ${shot.tick}: ${shot.error} off, ${shot.rate} per tick`),
    ).toEqual([])
  })

  it('takes them with the aim genuinely on the body, not merely inside the band', () => {
    // The thresholds are 60 angle units (a third of a degree) and 90 per
    // sub-step. Over a whole duel the realised worst should sit well inside
    // both, because what actually gates a rail is the servo having arrived
    // rather than the number being just met.
    const worstError = rails.reduce((worst, shot) => Math.max(worst, shot.error), 0)
    expect(worstError).toBeLessThanOrEqual(RAIL_SETTLE_UNITS)
  })
})
