/**
 * The projection, and the one property the whole HUD rests on: it is a *total
 * function of the world right now*, with no memory in it anywhere.
 *
 * That is what "the readout reflects `GameState` within one frame of a change"
 * reduces to once the view is driven from the frame loop — there is nothing
 * between a field changing and the next projection seeing it. So the tests
 * below change one field at a time and insist the model moves, and then insist
 * that two identical worlds project to identical models no matter what was
 * projected in between.
 */
import {
  EntityKind,
  MatchPhase,
  NO_DEADLINE,
  NO_WINNER,
  SPAWN_ARMOR,
  SPAWN_HEALTH,
  TICK_INTERVAL_MS,
  TICK_RATE,
  Weapon,
  createGameState,
  findPlayer,
  matchRules,
  spawnEntity,
  weaponDef,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  ABSENT_PLAYER,
  HEALTH_CRITICAL,
  HEALTH_LOW,
  formatClock,
  healthTier,
  hudModel,
  matchAnnouncement,
  matchHeadline,
  opponentSlot,
  scoreFor,
} from './hudModel.ts'

const SEED = 7

/** A world with both duellists standing, at full health, holding launchers. */
function duel() {
  const state = createGameState(SEED)
  for (const slot of [0, 1]) {
    spawnEntity(state, {
      kind: EntityKind.Player,
      slot,
      health: SPAWN_HEALTH,
      armor: SPAWN_ARMOR,
      weapon: Weapon.RocketLauncher,
    })
  }
  return state
}

describe('projecting a player', () => {
  it('reads health, armour and the weapon in hand straight off the entity', () => {
    const state = duel()
    const model = hudModel(state, 0)

    expect(model.self.present).toBe(true)
    expect(model.self.alive).toBe(true)
    expect(model.self.health).toBe(SPAWN_HEALTH)
    expect(model.self.armor).toBe(SPAWN_ARMOR)
    expect(model.self.healthFraction).toBe(1)
    expect(model.self.weapon).toBe(Weapon.RocketLauncher)
    expect(model.self.weaponName).toBe(weaponDef(Weapon.RocketLauncher).name)
  })

  it('is the other duellist that ends up in `opponent`', () => {
    const state = duel()
    const first = findPlayer(state, 0)
    const second = findPlayer(state, 1)
    if (first === null || second === null) throw new Error('both players should exist')
    second.health = 37

    expect(hudModel(state, 0).opponent.health).toBe(37)
    expect(hudModel(state, 1).self.health).toBe(37)
    expect(hudModel(state, 1).opponent.health).toBe(first.health)
    expect(opponentSlot(0)).toBe(1)
    expect(opponentSlot(1)).toBe(0)
  })

  it('reports a slot nobody holds as absent rather than throwing', () => {
    const state = createGameState(SEED)
    const model = hudModel(state, 0)
    expect(model.self).toEqual(ABSENT_PLAYER)
    expect(model.opponent).toEqual(ABSENT_PLAYER)
  })

  it('is a copy: writing to the model cannot reach the entity', () => {
    const state = duel()
    const player = findPlayer(state, 0)
    if (player === null) throw new Error('player 0 should exist')
    const model = hudModel(state, 0)

    expect(model.self.velocity).not.toBe(player.velocity)
    // The double cast is the point: `readonly` already makes this a compile
    // error, and what is being checked here is the *other* half — that the
    // array is a copy, so a write that got past the types still goes nowhere.
    ;(model.self.velocity as unknown as number[])[0] = 999
    expect(player.velocity[0]).toBe(0)
  })

  it('counts a player on zero health as dead even before the flag lands', () => {
    const state = duel()
    const player = findPlayer(state, 0)
    if (player === null) throw new Error('player 0 should exist')
    player.health = 0
    expect(hudModel(state, 0).self.alive).toBe(false)
    expect(healthTier(hudModel(state, 0).self)).toBe('dead')
  })
})

describe('the cooldown', () => {
  it('is zero when the weapon is ready', () => {
    const state = duel()
    expect(hudModel(state, 0).self.cooldownMs).toBe(0)
    expect(hudModel(state, 0).self.cooldownFraction).toBe(0)
  })

  it('counts down in real milliseconds from the shot that set it', () => {
    const state = duel()
    const player = findPlayer(state, 0)
    if (player === null) throw new Error('player 0 should exist')
    const rocket = weaponDef(Weapon.RocketLauncher)

    state.tick = 100
    player.lastFireTick = 100
    player.nextFireTick = 100 + rocket.refireTicks

    expect(hudModel(state, 0).self.cooldownMs).toBeCloseTo(rocket.refireMs, 6)
    expect(hudModel(state, 0).self.cooldownFraction).toBe(1)

    state.tick = 100 + rocket.refireTicks / 2
    expect(hudModel(state, 0).self.cooldownFraction).toBeCloseTo(0.5, 6)

    state.tick = 100 + rocket.refireTicks
    expect(hudModel(state, 0).self.cooldownFraction).toBe(0)
  })

  /**
   * The one case a naive implementation gets wrong. Both weapons share the
   * timer, so dividing the wait by the *held* weapon's interval draws a ring
   * more than full for the 700 ms after a rail shot and a switch.
   */
  it('scales the ring by the weapon that fired, not the one now in hand', () => {
    const state = duel()
    const player = findPlayer(state, 0)
    if (player === null) throw new Error('player 0 should exist')
    const rail = weaponDef(Weapon.Railgun)

    state.tick = 0
    player.weapon = Weapon.Railgun
    player.lastFireTick = 0
    player.nextFireTick = rail.refireTicks

    // Switch to the launcher, whose own interval is shorter than what is left.
    player.weapon = Weapon.RocketLauncher
    state.tick = 1

    const model = hudModel(state, 0)
    expect(model.self.weapon).toBe(Weapon.RocketLauncher)
    expect(model.self.cooldownMs).toBeGreaterThan(weaponDef(Weapon.RocketLauncher).refireMs)
    expect(model.self.cooldownFraction).toBeLessThanOrEqual(1)
  })

  it('draws a full ring for a wait with no shot behind it', () => {
    const state = duel()
    const player = findPlayer(state, 0)
    if (player === null) throw new Error('player 0 should exist')
    player.nextFireTick = 50
    expect(hudModel(state, 0).self.cooldownFraction).toBe(1)
  })
})

describe('projecting the match', () => {
  it('carries the phase, the round, the score and the target', () => {
    const state = duel()
    state.match.phase = MatchPhase.Live
    state.match.round = 2
    state.match.wins = [1, 0]

    const model = hudModel(state, 0)
    expect(model.match.phase).toBe(MatchPhase.Live)
    expect(model.match.round).toBe(2)
    expect(model.match.roundsToWin).toBe(state.match.rules.roundsToWin)
    expect(scoreFor(model.match, 0)).toBe(1)
    expect(scoreFor(model.match, 1)).toBe(0)
  })

  it('turns the phase deadline into milliseconds, and no deadline into null', () => {
    const state = duel()
    state.tick = 100
    state.match.phaseEndTick = 100 + 2 * TICK_RATE
    expect(hudModel(state, 0).match.remainingMs).toBeCloseTo(2000, 6)

    state.match.phaseEndTick = NO_DEADLINE
    expect(hudModel(state, 0).match.remainingMs).toBeNull()
  })

  it('never reports a negative clock', () => {
    const state = duel()
    state.tick = 500
    state.match.phaseEndTick = 100
    expect(hudModel(state, 0).match.remainingMs).toBe(0)
  })

  it('reads the rules the match is actually being played under', () => {
    const state = createGameState(SEED, matchRules({ roundsToWin: 5 }))
    expect(hudModel(state, 0).match.roundsToWin).toBe(5)
  })
})

describe('what it says', () => {
  it('names the phase from the viewer’s own side of the duel', () => {
    const state = duel()
    expect(matchHeadline(hudModel(state, 0))).toBe('warm-up')

    state.match.phase = MatchPhase.Live
    state.match.round = 3
    expect(matchHeadline(hudModel(state, 0))).toBe('round 3')

    state.match.phase = MatchPhase.Intermission
    state.match.lastRoundWinner = 0
    expect(matchHeadline(hudModel(state, 0))).toBe('round won')
    expect(matchHeadline(hudModel(state, 1))).toBe('round lost')

    state.match.lastRoundWinner = NO_WINNER
    expect(matchHeadline(hudModel(state, 0))).toBe('round drawn')

    state.match.phase = MatchPhase.Over
    state.match.winner = 1
    expect(matchHeadline(hudModel(state, 0))).toBe('match lost')
    expect(matchHeadline(hudModel(state, 1))).toBe('match won')

    state.match.winner = NO_WINNER
    expect(matchHeadline(hudModel(state, 0))).toBe('match drawn')
  })

  it('only puts a banner over the crosshair when nobody can act on it', () => {
    const state = duel()
    expect(matchAnnouncement(hudModel(state, 0))).toBeNull()

    state.match.phase = MatchPhase.Live
    expect(matchAnnouncement(hudModel(state, 0))).toBeNull()

    state.match.phase = MatchPhase.Intermission
    state.match.lastRoundWinner = 0
    expect(matchAnnouncement(hudModel(state, 0))).toBe('round won')
  })

  it('changes colour at the two health thresholds', () => {
    const state = duel()
    const player = findPlayer(state, 0)
    if (player === null) throw new Error('player 0 should exist')

    for (const [health, tier] of [
      [SPAWN_HEALTH, 'ok'],
      [HEALTH_LOW + 1, 'ok'],
      [HEALTH_LOW, 'low'],
      [HEALTH_CRITICAL + 1, 'low'],
      [HEALTH_CRITICAL, 'critical'],
      [1, 'critical'],
    ] as const) {
      player.health = health
      expect(healthTier(hudModel(state, 0).self)).toBe(tier)
    }
  })

  it('rounds the clock up, so 0:00 means the phase is over', () => {
    expect(formatClock(null)).toBe('—')
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(1)).toBe('0:01')
    expect(formatClock(9500)).toBe('0:10')
    expect(formatClock(120_000)).toBe('2:00')
    expect(formatClock(119_001)).toBe('2:00')
  })
})

/* --------------------------------------------------------------------------
 * The acceptance check itself
 * ----------------------------------------------------------------------- */

describe('reflecting the world within one frame', () => {
  /**
   * Every field the acceptance check names, changed one at a time, with the
   * projection taken before and after. A model that lagged by a frame — a
   * cache, a subscription, a smoothed value — fails here rather than in a
   * duel.
   */
  it('moves with health, armour, weapon, cooldown and score, one field at a time', () => {
    const state = duel()
    const player = findPlayer(state, 0)
    if (player === null) throw new Error('player 0 should exist')

    const changes: ReadonlyArray<readonly [string, () => void, (m: ReturnType<typeof hudModel>) => unknown]> = [
      ['health', () => { player.health = 42 }, (m) => m.self.health],
      ['armour', () => { player.armor = 13 }, (m) => m.self.armor],
      ['weapon', () => { player.weapon = Weapon.Railgun }, (m) => m.self.weapon],
      ['weapon name', () => { player.weapon = Weapon.RocketLauncher }, (m) => m.self.weaponName],
      [
        'cooldown',
        () => {
          player.lastFireTick = state.tick
          player.nextFireTick = state.tick + 100
        },
        (m) => m.self.cooldownMs,
      ],
      ['score', () => { state.match.wins = [2, 1] }, (m) => m.match.wins],
      ['round', () => { state.match.round = 4 }, (m) => m.match.round],
      ['phase', () => { state.match.phase = MatchPhase.Live }, (m) => m.match.phase],
      [
        'clock',
        () => {
          state.match.phaseEndTick = state.tick + TICK_RATE
        },
        (m) => m.match.remainingMs,
      ],
    ]

    for (const [what, mutate, read] of changes) {
      const before = read(hudModel(state, 0))
      mutate()
      const after = read(hudModel(state, 0))
      expect(after, `${what} should show through immediately`).not.toEqual(before)
    }
  })

  it('follows the clock every single tick, with no step and no smoothing', () => {
    const state = duel()
    state.match.phaseEndTick = 40
    let previous = Number.POSITIVE_INFINITY
    for (state.tick = 0; state.tick < 40; state.tick += 1) {
      const remaining = hudModel(state, 0).match.remainingMs
      expect(remaining).toBeCloseTo((40 - state.tick) * TICK_INTERVAL_MS, 6)
      expect(remaining).toBeLessThan(previous)
      previous = remaining ?? 0
    }
  })

  it('has no memory: the same world always projects to the same model', () => {
    const first = duel()
    const second = duel()

    // Drag one of them through a whole match and back, so that anything
    // remembering a previous projection would answer differently.
    const player = findPlayer(first, 0)
    if (player === null) throw new Error('player 0 should exist')
    for (const health of [90, 30, 5, SPAWN_HEALTH]) {
      player.health = health
      hudModel(first, 0)
    }

    expect(hudModel(first, 0)).toEqual(hudModel(second, 0))
  })
})
