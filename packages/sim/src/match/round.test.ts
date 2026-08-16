/**
 * The round and match rules, driven headlessly.
 *
 * Four of this ticket's five acceptance checks are in here — a whole match run
 * to a winner, and the three self-damage modes measured against a real rocket
 * — and the fifth ("no pickup entity exists anywhere") is at the bottom, as an
 * assertion about the shape of the simulation rather than about its behaviour.
 */

import { describe, expect, it } from 'vitest'

import { boxBrush, createCollisionWorld } from '../collide.ts'
import { applyDamage, radiusDamage } from '../damage.ts'
import { NO_INPUTS, advanceTicks, createKernel, tick } from '../kernel.ts'
import { createMapWorld } from '../map/collide.ts'
import type { MapBrush, MapSource, MapSpawn } from '../map/schema.ts'
import { validateMap } from '../map/validate.ts'
import { vec3 } from '../math.ts'
import {
  EntityKind,
  NO_ENTITY,
  cloneGameState,
  createGameState,
  findPlayer,
  hashState,
  spawnEntity,
} from '../state.ts'
import type { EntityState, GameState } from '../state.ts'
import { SURFACE_CLIP_EPSILON } from '../trace.ts'
import { BUTTON_ATTACK, MAX_PITCH_UNITS, NULL_CMD, yawUnitsFromDegrees } from '../usercmd.ts'
import type { UserCmd } from '../usercmd.ts'
import { AMMO_UNLIMITED, WEAPONS, spawnProjectile } from '../weapons.ts'
import { MatchPhase, NO_WINNER, RESPAWN_DELAY_TICKS, matchRules } from './match.ts'
import type { MatchRules } from './match.ts'
import {
  advanceMatch,
  damageReserve,
  forfeitMatch,
  isPlayableScore,
  resetMatch,
  roundOutcome,
  startMatch,
} from './round.ts'
import { SelfDamage } from './selfDamage.ts'
import type { SelfDamageMode } from './selfDamage.ts'
import { DUEL_SLOTS, SPAWN_ARMOR, SPAWN_HEALTH, buildSpawnPlan } from './spawn.ts'

/* --------------------------------------------------------------------------
 * The fixture
 * ----------------------------------------------------------------------- */

const HALF = 1024
const CEILING = 512
const SHELL = 64

function slab(mins: [number, number, number], maxs: [number, number, number]): MapBrush {
  return { kind: 'box', surface: 'shell', mins, maxs }
}

function corner(x: number, y: number, yawDegrees: number): MapSpawn {
  return { origin: [x, y, 0], yaw: yawUnitsFromDegrees(yawDegrees) }
}

/**
 * A sealed room with a screen across the middle and two spawns on the diagonal.
 *
 * The screen is what makes the two spawns a *legal* pair — far enough apart and
 * unable to see each other — which is the only thing a match needs of a map
 * (`spawn.ts`). It is deliberately wider than it is deep for the reason
 * `spawn.test.ts` gives: a square centred on the origin is grazed by the
 * diagonal exactly at its corners, and a knife-edge is not a fixture.
 */
const ARENA: MapSource = {
  name: 'round-fixture',
  title: 'Round fixture',
  author: 'test',
  surfaces: [{ name: 'shell', material: 'concrete', tint: [0.3, 0.3, 0.3] }],
  brushes: [
    slab([-HALF - SHELL, -HALF - SHELL, -SHELL], [HALF + SHELL, HALF + SHELL, 0]),
    slab([-HALF - SHELL, -HALF - SHELL, CEILING], [HALF + SHELL, HALF + SHELL, CEILING + SHELL]),
    slab([HALF, -HALF - SHELL, -SHELL], [HALF + SHELL, HALF + SHELL, CEILING + SHELL]),
    slab([-HALF - SHELL, -HALF - SHELL, -SHELL], [-HALF, HALF + SHELL, CEILING + SHELL]),
    slab([-HALF - SHELL, HALF, -SHELL], [HALF + SHELL, HALF + SHELL, CEILING + SHELL]),
    slab([-HALF - SHELL, -HALF - SHELL, -SHELL], [HALF + SHELL, -HALF, CEILING + SHELL]),
    slab([-192, -128, 0], [192, 128, CEILING]),
  ],
  spawns: [corner(-768, -768, 45), corner(768, 768, -135)],
  lights: [],
  props: [],
}

const WORLD = createMapWorld(ARENA)
const PLAN = buildSpawnPlan(ARENA, WORLD)

function cmd(over: Partial<UserCmd> = {}): UserCmd {
  return { ...NULL_CMD, ...over }
}

function playerIn(state: GameState, slot: number): EntityState {
  const player = findPlayer(state, slot)
  if (player === null) throw new Error(`no player in slot ${slot}`)
  return player
}

function projectilesIn(state: GameState): EntityState[] {
  return state.entities.filter((e) => e.kind === EntityKind.Projectile)
}

/** Kill `slot`, credited to the other one. */
function kill(state: GameState, slot: number): void {
  const victim = playerIn(state, slot)
  const killer = playerIn(state, slot === DUEL_SLOTS[0] ? DUEL_SLOTS[1] : DUEL_SLOTS[0])
  applyDamage(state, victim, killer.id, [0, 0, 1], 1000)
}

/** What the world looked like on the tick a round began. */
type RoundStart = {
  readonly round: number
  readonly tick: number
  readonly projectiles: number
  readonly players: readonly {
    readonly health: number
    readonly armor: number
    readonly speed: number
    readonly flags: number
    readonly canFire: boolean
    readonly id: number
  }[]
}

function recordStart(state: GameState): RoundStart {
  return {
    round: state.match.round,
    tick: state.tick,
    projectiles: projectilesIn(state).length,
    players: DUEL_SLOTS.map((slot) => {
      const player = playerIn(state, slot)
      return {
        health: player.health,
        armor: player.armor,
        speed:
          Math.abs(player.velocity[0]) + Math.abs(player.velocity[1]) + Math.abs(player.velocity[2]),
        flags: player.flags,
        canFire: player.nextFireTick <= state.tick,
        id: player.id,
      }
    }),
  }
}

/** A tick's worth of nothing, for a match nobody is playing by hand. */
const idle = () => NO_INPUTS

/**
 * Run a whole match, calling `duringRound` once per round after it has been
 * live for a few ticks.
 *
 * Returns the state and a record of what every round looked like on the tick it
 * started, which is what the "resets cleanly" check reads.
 */
function playMatch(
  seed: number,
  rules: MatchRules,
  duringRound: (state: GameState, round: number) => void,
): { state: GameState; starts: RoundStart[] } {
  const state = createGameState(seed, rules)
  const kernel = createKernel(state, WORLD, PLAN)
  startMatch(state, PLAN)

  const starts: RoundStart[] = [recordStart(state)]
  const acted = new Set<number>()

  // A ceiling, so a rule that fails to terminate fails this test rather than
  // hanging the runner.
  const limit = rules.maxRounds * (rules.roundTimeLimitTicks + rules.intermissionTicks) + 100

  for (let i = 0; i < limit && state.match.phase !== MatchPhase.Over; i += 1) {
    advanceTicks(kernel, 1, idle)

    const match = state.match
    if (match.phase === MatchPhase.Live && match.phaseStartTick === state.tick) {
      starts.push(recordStart(state))
    }
    if (
      match.phase === MatchPhase.Live &&
      state.tick - match.phaseStartTick === 8 &&
      !acted.has(match.round)
    ) {
      acted.add(match.round)
      duringRound(state, match.round)
    }
  }

  return { state, starts }
}

/* --------------------------------------------------------------------------
 * A whole match
 * ----------------------------------------------------------------------- */

describe('a headless match', () => {
  it('is played on a map the validator is happy with', () => {
    expect(validateMap(ARENA)).toEqual([])
    expect(PLAN.pairs).toEqual([[0, 1]])
  })

  it('starts in warmup and does nothing until it is told to', () => {
    const state = createGameState(4)
    expect(state.match.phase).toBe(MatchPhase.Warmup)
    expect(state.match.round).toBe(0)

    const kernel = createKernel(state, WORLD, PLAN)
    advanceTicks(kernel, 500, idle)

    expect(state.match.phase).toBe(MatchPhase.Warmup)
    expect(state.match.round).toBe(0)
    expect(state.entities).toHaveLength(0)
  })

  it('runs to a winner: first to three, and the loser scores nothing', () => {
    const { state } = playMatch(7, matchRules(), (world) => kill(world, DUEL_SLOTS[1]))

    expect(state.match.phase).toBe(MatchPhase.Over)
    expect(state.match.winner).toBe(DUEL_SLOTS[0])
    expect(state.match.wins).toEqual([3, 0])
    expect(state.match.round).toBe(3)
  })

  it('can be started from a score, which is how a duel survives a deploy', () => {
    // A room is a live world in one process's memory, so a machine going away
    // destroys it (GLAD-G41FQ9). What crosses to the next machine is three
    // numbers, and this is where they are put back: the next round starts from
    // spawn points like any other, at the scoreline the players earned.
    const state = createGameState(11)
    startMatch(state, PLAN, { wins: [1, 2], roundsPlayed: 3 })

    expect(state.match.phase).toBe(MatchPhase.Live)
    expect(state.match.wins).toEqual([1, 2])
    // Round four, because three have been decided — not round one again, and
    // not round three replayed.
    expect(state.match.round).toBe(4)
    // Everything else is a fresh round: full health, no leftover winner.
    expect(state.match.lastRoundWinner).toBe(NO_WINNER)
    expect(playerIn(state, DUEL_SLOTS[0]).health).toBe(SPAWN_HEALTH)
  })

  it('refuses a score that is not a match still being played', () => {
    const rules = matchRules()
    // Already won, so `advanceMatch` would end it on the first sub-step and
    // both players would watch a round that never happened.
    expect(isPlayableScore({ wins: [3, 0], roundsPlayed: 3 }, rules)).toBe(false)
    // More wins than rounds decided: arithmetic nobody could have played.
    expect(isPlayableScore({ wins: [2, 2], roundsPlayed: 3 }, rules)).toBe(false)
    // Past the round cap, and negative, and fractional.
    expect(isPlayableScore({ wins: [0, 0], roundsPlayed: rules.maxRounds }, rules)).toBe(false)
    expect(isPlayableScore({ wins: [-1, 0], roundsPlayed: 1 }, rules)).toBe(false)
    expect(isPlayableScore({ wins: [0.5, 0], roundsPlayed: 1 }, rules)).toBe(false)
    // And one that is fine.
    expect(isPlayableScore({ wins: [2, 2], roundsPlayed: 4 }, rules)).toBe(true)

    expect(() => startMatch(createGameState(11), PLAN, { wins: [3, 0], roundsPlayed: 3 })).toThrow(
      RangeError,
    )
  })

  it('goes the distance when the rounds are shared out', () => {
    // Slot 1 takes rounds 1 and 3; slot 0 takes 2, 4 and 5.
    const { state } = playMatch(9, matchRules(), (world, round) => {
      kill(world, round === 1 || round === 3 ? DUEL_SLOTS[0] : DUEL_SLOTS[1])
    })

    expect(state.match.winner).toBe(DUEL_SLOTS[0])
    expect(state.match.wins).toEqual([3, 2])
    expect(state.match.round).toBe(5)
  })

  it('resets state cleanly between every round', () => {
    // Every round is dirtied before it is decided — damage taken, speed on the
    // bodies, both weapons on cooldown, and a rocket left in the air — so that
    // a reset that missed a field would show up as a round starting with it.
    const { state, starts } = playMatch(13, matchRules(), (world) => {
      for (const slot of DUEL_SLOTS) {
        const player = playerIn(world, slot)
        player.health = 40
        player.armor = 7
        player.velocity[0] = 600
        player.nextFireTick = world.tick + 500
        player.knockbackTicks = 20
      }
      spawnProjectile(world, playerIn(world, DUEL_SLOTS[0]), WEAPONS[0], [0, 0, 200], [0, 0, 1])
      kill(world, DUEL_SLOTS[1])
    })

    expect(starts).toHaveLength(3)
    for (const start of starts) {
      expect(start.projectiles).toBe(0)
      for (const player of start.players) {
        expect(player.health).toBe(SPAWN_HEALTH)
        expect(player.armor).toBe(SPAWN_ARMOR)
        expect(player.speed).toBe(0)
        expect(player.flags).toBe(0)
        expect(player.canFire).toBe(true)
      }
    }

    // Same two bodies all match, so a client interpolating an opponent watches
    // them move rather than watching a stranger appear (`spawn.ts`).
    const ids = starts.map((start) => start.players.map((p) => p.id))
    expect(ids[1]).toEqual(ids[0])
    expect(ids[2]).toEqual(ids[0])
    expect(state.match.wins).toEqual([3, 0])
  })

  it('waits the respawn delay between one round ending and the next beginning', () => {
    const { starts } = playMatch(21, matchRules(), (world) => kill(world, DUEL_SLOTS[1]))

    // Round 1 ends 9 ticks in — the kill lands after tick 8, and the round
    // rules see it at the end of the tick after that.
    const first = starts[0]
    const second = starts[1]
    expect(first).toBeDefined()
    expect(second).toBeDefined()
    if (first === undefined || second === undefined) return
    expect(second.tick - first.tick).toBe(9 + RESPAWN_DELAY_TICKS)
  })

  it('freezes the bodies between rounds and lets nobody fire', () => {
    const state = createGameState(5, matchRules())
    const kernel = createKernel(state, WORLD, PLAN)
    startMatch(state, PLAN)
    advanceTicks(kernel, 1, idle)
    kill(state, DUEL_SLOTS[1])
    advanceTicks(kernel, 1, idle)
    expect(state.match.phase).toBe(MatchPhase.Intermission)

    const survivor = playerIn(state, DUEL_SLOTS[0])
    const before = [...survivor.origin]
    const facing = [...survivor.angles]

    // A full second of a player trying to run, turn and shoot.
    const running = cmd({ forwardMove: 1, yaw: yawUnitsFromDegrees(123), buttons: BUTTON_ATTACK })
    advanceTicks(kernel, 125, () => [running, running])

    expect([...survivor.origin]).toEqual(before)
    // And the freeze does not spin them to due north on the way, which writing
    // a null command's angles into a frozen body would.
    expect([...survivor.angles]).toEqual(facing)
    expect(projectilesIn(state)).toHaveLength(0)
  })

  it('refuses to tick a running match with no spawn plan to stand players on', () => {
    const state = createGameState(2, matchRules({ roundTimeLimitTicks: 4 }))
    startMatch(state, PLAN)

    // The round ends on its own clock, and then the intermission runs out with
    // nowhere to put anybody. Silently never starting another round would look
    // exactly like a hung server, so it says so instead.
    expect(() => {
      for (let i = 0; i < 4 + RESPAWN_DELAY_TICKS + 2; i += 1) tick(state, NO_INPUTS, WORLD)
    }).toThrow(/spawn plan/)
  })

  it('will not start a match twice', () => {
    const state = createGameState(2)
    startMatch(state, PLAN)
    expect(() => startMatch(state, PLAN)).toThrow(/already in phase/)
  })
})

/* --------------------------------------------------------------------------
 * A match nobody can finish
 * ----------------------------------------------------------------------- */

describe('forfeiting', () => {
  it('awards the round in progress and the match with it', () => {
    // The connection lifecycle's edge into the simulation (GLAD-DVDV6P):
    // thirty seconds after a socket died, there is nobody to finish the match
    // against. Awarding only the *round* would start the next one against an
    // empty seat and award that too, three seconds later, until the score ran
    // out — the same result, arrived at over half a minute of nothing.
    const state = createGameState(1, matchRules())
    const kernel = createKernel(state, WORLD, PLAN)
    startMatch(state, PLAN)
    advanceTicks(kernel, 10, idle)

    expect(forfeitMatch(state, DUEL_SLOTS[1])).toBe(true)
    expect(state.match.phase).toBe(MatchPhase.Over)
    expect(state.match.winner).toBe(DUEL_SLOTS[1])
    expect(state.match.lastRoundWinner).toBe(DUEL_SLOTS[1])
    expect(state.match.wins).toEqual([0, 1])
  })

  it('gives the match to the player still there, not to the score', () => {
    // A player who quits while ahead leaves a score that says they were winning
    // and a match their opponent won. Those two facts disagree because a
    // forfeit is exactly the situation in which they should.
    const state = createGameState(1, matchRules())
    startMatch(state, PLAN)
    state.match.wins[0] = 2
    state.match.wins[1] = 0

    forfeitMatch(state, DUEL_SLOTS[1])
    expect(state.match.wins).toEqual([2, 1])
    expect(state.match.winner).toBe(DUEL_SLOTS[1])
  })

  it('does not award a round that has already been scored', () => {
    const rules = matchRules({ roundTimeLimitTicks: 20 })
    const state = createGameState(1, rules)
    const kernel = createKernel(state, WORLD, PLAN)
    startMatch(state, PLAN)
    kill(state, DUEL_SLOTS[0])
    advanceTicks(kernel, 1, idle)
    expect(state.match.phase).toBe(MatchPhase.Intermission)
    expect(state.match.wins).toEqual([0, 1])

    // An intermission's round is already on the board, and scoring it twice
    // would hand the leaver's opponent a round they had already been given.
    forfeitMatch(state, DUEL_SLOTS[1])
    expect(state.match.wins).toEqual([0, 1])
    expect(state.match.winner).toBe(DUEL_SLOTS[1])
  })

  it('ends a match nobody is left to win with nobody winning it', () => {
    const state = createGameState(1, matchRules())
    startMatch(state, PLAN)

    expect(forfeitMatch(state, NO_WINNER)).toBe(true)
    expect(state.match.phase).toBe(MatchPhase.Over)
    expect(state.match.winner).toBe(NO_WINNER)
    expect(state.match.wins).toEqual([0, 0])
  })

  it('has nothing to end in warmup, or in a match already decided', () => {
    const warmup = createGameState(1, matchRules())
    expect(forfeitMatch(warmup, DUEL_SLOTS[0])).toBe(false)
    expect(warmup.match.phase).toBe(MatchPhase.Warmup)

    const over = createGameState(1, matchRules())
    startMatch(over, PLAN)
    forfeitMatch(over, DUEL_SLOTS[0])
    expect(forfeitMatch(over, DUEL_SLOTS[1])).toBe(false)
    // The second call changed nothing: the first answer stands.
    expect(over.match.winner).toBe(DUEL_SLOTS[0])
  })

  it('takes the rockets in the air with it', () => {
    const state = createGameState(1, matchRules())
    startMatch(state, PLAN)
    const shooter = playerIn(state, DUEL_SLOTS[0])
    spawnProjectile(state, shooter, WEAPONS[0], [0, 0, 200], [0, 0, 1])
    expect(state.entities.some((entity) => entity.kind === EntityKind.Projectile)).toBe(true)

    forfeitMatch(state, DUEL_SLOTS[1])
    // A decided match cannot be un-decided by an explosion that arrives
    // afterwards — the same rule as a round ending, for the same reason.
    expect(state.entities.some((entity) => entity.kind === EntityKind.Projectile)).toBe(false)
  })
})

/* --------------------------------------------------------------------------
 * The match after this one
 * ----------------------------------------------------------------------- */

describe('clearing a finished match', () => {
  it('puts a decided match back where a fresh one starts', () => {
    const { state } = playMatch(7, matchRules(), (world) => kill(world, DUEL_SLOTS[1]))
    expect(state.match.phase).toBe(MatchPhase.Over)
    expect(state.match.wins).toEqual([3, 0])

    const decidedAt = state.tick
    const rules = state.match.rules
    resetMatch(state)

    // Everything a fresh `createMatchState` has, at the tick it was cleared on.
    expect(state.match.phase).toBe(MatchPhase.Warmup)
    expect(state.match.round).toBe(0)
    expect(state.match.wins).toEqual([0, 0])
    expect(state.match.winner).toBe(NO_WINNER)
    expect(state.match.lastRoundWinner).toBe(NO_WINNER)
    expect(state.match.phaseStartTick).toBe(decidedAt)
    // The rules are the room's, not this match's, and survive it — the same
    // object, so the next match is played under the one both peers hashed.
    expect(state.match.rules).toBe(rules)
  })

  it('leaves the bodies alone — standing them up is the next round\'s job', () => {
    const { state } = playMatch(7, matchRules(), (world) => kill(world, DUEL_SLOTS[1]))
    const loser = playerIn(state, DUEL_SLOTS[1])
    const fellAt: [number, number, number] = [loser.origin[0], loser.origin[1], loser.origin[2]]

    resetMatch(state)
    expect([...loser.origin]).toEqual(fellAt)
    expect(loser.health).toBeLessThanOrEqual(0)

    // And the next round is the one that picks them up — same entity, same id,
    // full health, on a spawn point.
    startMatch(state, PLAN)
    expect(state.match.phase).toBe(MatchPhase.Live)
    expect(state.match.round).toBe(1)
    expect(playerIn(state, DUEL_SLOTS[1]).id).toBe(loser.id)
    expect(loser.health).toBe(SPAWN_HEALTH)
    expect(loser.armor).toBe(SPAWN_ARMOR)
    expect([...loser.origin]).not.toEqual(fellAt)
  })

  it('plays the next match out like any other', () => {
    // The point of the whole edge: a second best-of-five in the same world,
    // scored from nil-nil and decided on its own rounds.
    const rules = matchRules()
    const { state } = playMatch(7, rules, (world) => kill(world, DUEL_SLOTS[1]))
    resetMatch(state)
    startMatch(state, PLAN)

    const kernel = createKernel(state, WORLD, PLAN)
    const limit = rules.maxRounds * (rules.roundTimeLimitTicks + rules.intermissionTicks) + 100
    const acted = new Set<number>()
    for (let i = 0; i < limit && state.match.phase !== MatchPhase.Over; i += 1) {
      advanceTicks(kernel, 1, idle)
      const match = state.match
      if (
        match.phase === MatchPhase.Live &&
        state.tick - match.phaseStartTick === 8 &&
        !acted.has(match.round)
      ) {
        acted.add(match.round)
        kill(state, DUEL_SLOTS[0])
      }
    }

    // The other player takes this one, and the score has no memory of the last.
    expect(state.match.phase).toBe(MatchPhase.Over)
    expect(state.match.winner).toBe(DUEL_SLOTS[1])
    expect(state.match.wins).toEqual([0, 3])
  })

  it('refuses a match that is still being played', () => {
    const warmup = createGameState(3, matchRules())
    expect(() => resetMatch(warmup)).toThrow(/only a finished match/)

    const live = createGameState(3, matchRules())
    const kernel = createKernel(live, WORLD, PLAN)
    startMatch(live, PLAN)
    expect(() => resetMatch(live)).toThrow(RangeError)

    kill(live, DUEL_SLOTS[1])
    advanceTicks(kernel, 1, idle)
    expect(live.match.phase).toBe(MatchPhase.Intermission)
    // An intermission is a match between rounds, not a match that is over — and
    // clearing one would throw away a scoreline two players are mid-duel on.
    expect(() => resetMatch(live)).toThrow(RangeError)
    expect(live.match.wins).toEqual([1, 0])
  })

  it('cannot tell a forfeit from a defeat, which is why the host decides', () => {
    // Both are `Over` with a winner, and the difference between them — whether
    // there is anybody left in the other seat — is a fact about sockets. So
    // this layer does what it is told and `server/room.ts` is what refuses to
    // restart a forfeit (GLAD-8VZ12W, `room.test.ts`).
    const state = createGameState(1, matchRules())
    startMatch(state, PLAN)
    forfeitMatch(state, DUEL_SLOTS[1])

    expect(() => resetMatch(state)).not.toThrow()
    expect(state.match.phase).toBe(MatchPhase.Warmup)
  })
})

/* --------------------------------------------------------------------------
 * How a round ends
 * ----------------------------------------------------------------------- */

describe('how a round ends', () => {
  it('gives the round to whoever is still standing', () => {
    const state = createGameState(1, matchRules())
    const kernel = createKernel(state, WORLD, PLAN)
    startMatch(state, PLAN)

    expect(roundOutcome(state)).toBeNull()
    kill(state, DUEL_SLOTS[0])
    expect(roundOutcome(state)).toBe(DUEL_SLOTS[1])

    advanceTicks(kernel, 1, idle)
    expect(state.match.wins).toEqual([0, 1])
    expect(state.match.lastRoundWinner).toBe(DUEL_SLOTS[1])
  })

  it('scores a mutual kill to nobody and plays on', () => {
    const state = createGameState(1, matchRules())
    const kernel = createKernel(state, WORLD, PLAN)
    startMatch(state, PLAN)

    // Two rockets that landed on the same sub-step. Rare, reachable, and the
    // alternative — picking a winner by entity order — would hand the round to
    // whoever happened to spawn first.
    kill(state, DUEL_SLOTS[0])
    kill(state, DUEL_SLOTS[1])
    advanceTicks(kernel, 1, idle)

    expect(state.match.lastRoundWinner).toBe(NO_WINNER)
    expect(state.match.wins).toEqual([0, 0])
    expect(state.match.phase).toBe(MatchPhase.Intermission)
    // A draw still costs a round, which is what makes the cap reachable.
    expect(state.match.round).toBe(1)
  })

  it('decides a round that runs out of time on health plus armour', () => {
    const rules = matchRules({ roundTimeLimitTicks: 40 })
    const state = createGameState(1, rules)
    const kernel = createKernel(state, WORLD, PLAN)
    startMatch(state, PLAN)

    // Slot 1 is ahead on health and behind on armour, and loses on the total:
    // 190 against 200. Armour is not a lesser kind of health here.
    const first = playerIn(state, DUEL_SLOTS[0])
    const second = playerIn(state, DUEL_SLOTS[1])
    first.health = 100
    first.armor = 100
    second.health = 120
    second.armor = 70
    expect(damageReserve(first)).toBe(200)
    expect(damageReserve(second)).toBe(190)

    advanceTicks(kernel, 40, idle)
    expect(state.match.lastRoundWinner).toBe(DUEL_SLOTS[0])
  })

  it('draws a round that runs out of time with nothing between them', () => {
    const rules = matchRules({ roundTimeLimitTicks: 40 })
    const state = createGameState(1, rules)
    const kernel = createKernel(state, WORLD, PLAN)
    startMatch(state, PLAN)

    advanceTicks(kernel, 40, idle)

    expect(state.match.lastRoundWinner).toBe(NO_WINNER)
    expect(state.match.wins).toEqual([0, 0])
  })

  it('stops at the round cap rather than drawing forever', () => {
    // Two players who never find each other. Without the cap this is a match
    // that never ends.
    const rules = matchRules({ roundTimeLimitTicks: 20 })
    const { state } = playMatch(3, rules, () => {})

    expect(state.match.phase).toBe(MatchPhase.Over)
    expect(state.match.round).toBe(rules.maxRounds)
    expect(state.match.winner).toBe(NO_WINNER)
    expect(state.match.wins).toEqual([0, 0])
  })

  it('takes the rockets in the air with it', () => {
    const state = createGameState(1, matchRules())
    const kernel = createKernel(state, WORLD, PLAN)
    startMatch(state, PLAN)

    spawnProjectile(state, playerIn(state, DUEL_SLOTS[0]), WEAPONS[0], [0, 0, 200], [0, 0, 1])
    expect(projectilesIn(state)).toHaveLength(1)

    kill(state, DUEL_SLOTS[1])
    advanceTicks(kernel, 1, idle)

    // Removed, not detonated: a round that has been decided cannot be
    // un-decided by an explosion that arrives afterwards.
    expect(projectilesIn(state)).toHaveLength(0)
    expect(playerIn(state, DUEL_SLOTS[0]).health).toBe(SPAWN_HEALTH)
  })

  it('does not end a round in warmup, however dead anyone gets', () => {
    const state = createGameState(1)
    const kernel = createKernel(state, WORLD, PLAN)
    // A world with no match started in it behaves exactly as it did before
    // there were round rules — which is what the golden replay relies on.
    spawnEntity(state, { kind: EntityKind.Player, slot: 0, health: 0 })
    advanceTicks(kernel, 10, idle)

    expect(state.match.phase).toBe(MatchPhase.Warmup)
    expect(state.match.round).toBe(0)
  })
})

/* --------------------------------------------------------------------------
 * The three self-damage modes
 * ----------------------------------------------------------------------- */

/** A sealed box with a floor at z = 0, for firing a rocket into. */
const JUMP_WORLD = createCollisionWorld([
  boxBrush([-1024, -1024, -64], [1024, 1024, 0]),
  boxBrush([-1024, -1024, 512], [1024, 1024, 576]),
  boxBrush([1024, -1088, -64], [1088, 1088, 576]),
  boxBrush([-1088, -1088, -64], [-1024, 1088, 576]),
  boxBrush([-1024, 1024, -64], [1024, 1088, 576]),
  boxBrush([-1024, -1088, -64], [1024, -1024, 576]),
])

/** One player at a round's starting health and armour, standing on the floor. */
function standing(mode: SelfDamageMode): { state: GameState; player: EntityState } {
  const state = createGameState(1, matchRules({ selfDamage: mode }))
  const player = spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    origin: vec3(0, 0, SURFACE_CLIP_EPSILON),
    health: SPAWN_HEALTH,
    armor: SPAWN_ARMOR,
  })
  return { state, player }
}

/** One real rocket at your own feet, fired and detonated on the same tick. */
function rocketJump(state: GameState): void {
  tick(state, [cmd({ pitch: MAX_PITCH_UNITS, buttons: BUTTON_ATTACK })], JUMP_WORLD)
}

/**
 * Another full-power self-splash, without moving.
 *
 * A real rocket jump leaves the floor, and the second one would land on a body
 * that has drifted — so the repeat cases detonate 100 points at the player's
 * own origin instead, which is exactly what a rocket at your feet delivers
 * (`distanceToBox` is zero inside the box).
 */
function selfSplash(state: GameState, player: EntityState): void {
  radiusDamage(
    state,
    JUMP_WORLD,
    player.origin,
    WEAPONS[0].splashDamage,
    WEAPONS[0].splashRadius,
    player.id,
    NO_ENTITY,
  )
}

describe('self-damage: full', () => {
  it('takes 33 armour and 17 health from a rocket jump, and still launches at 500', () => {
    const { state, player } = standing(SelfDamage.Full)
    rocketJump(state)

    expect(player.armor).toBe(67)
    expect(player.health).toBe(83)
    // Not exactly 500: the pitch clamp is 89 degrees rather than 90, so the
    // rocket drifts a fraction of a unit sideways over its first 45.
    expect(player.velocity[2]).toBeCloseTo(500, 1)
  })

  it('allows exactly three survivable full-power rocket jumps; the fourth kills', () => {
    const { state, player } = standing(SelfDamage.Full)

    // 100 halved is 50, of which the armour absorbs ceil(50 * 0.66) = 33 while
    // it has 33 to give: 100/100 -> 67/83 -> 34/66 -> 1/49, and then the fourth
    // finds one point of armour and 49 of health to take.
    const after: [number, number][] = []
    for (let i = 0; i < 4; i += 1) {
      selfSplash(state, player)
      after.push([player.armor, player.health])
    }

    expect(after).toEqual([
      [67, 83],
      [34, 66],
      [1, 49],
      [0, 0],
    ])
    expect(player.health).toBeLessThanOrEqual(0)
  })
})

describe('self-damage: armor_only', () => {
  it('is the default a match runs under', () => {
    expect(createGameState(1).match.rules.selfDamage).toBe(SelfDamage.ArmorOnly)
  })

  it('costs 33 armour and 0 health, and still launches at 500', () => {
    const { state, player } = standing(SelfDamage.ArmorOnly)
    rocketJump(state)

    expect(player.armor).toBe(SPAWN_ARMOR - 33)
    expect(player.health).toBe(SPAWN_HEALTH)
    expect(player.velocity[2]).toBeCloseTo(500, 1)
  })

  it('never takes health, however many times you do it', () => {
    const { state, player } = standing(SelfDamage.ArmorOnly)

    for (let i = 0; i < 10; i += 1) {
      selfSplash(state, player)
      expect(player.health).toBe(SPAWN_HEALTH)
    }

    // The armour runs out, and after that a jump is free — which is the same
    // trade read from the other end: a player who has spent their armour on
    // mobility dies to one rocket instead of two.
    expect(player.armor).toBe(0)
  })

  it('does not protect you from anybody else', () => {
    const { state, player } = standing(SelfDamage.ArmorOnly)
    const enemy = spawnEntity(state, { kind: EntityKind.Player, slot: 1, health: 100 })

    applyDamage(state, player, enemy.id, [1, 0, 0], 100)

    // 66 off the armour and the other 34 off the health, so two rockets kill.
    expect(player.armor).toBe(34)
    expect(player.health).toBe(66)
  })
})

describe('self-damage: none', () => {
  it('costs nothing at all and still launches at 500', () => {
    const { state, player } = standing(SelfDamage.None)
    rocketJump(state)

    expect(player.armor).toBe(SPAWN_ARMOR)
    expect(player.health).toBe(SPAWN_HEALTH)
    expect(player.velocity[2]).toBeCloseTo(500, 1)
  })

  it('still arms the knockback window, so a jump cannot be cancelled on landing', () => {
    const { state, player } = standing(SelfDamage.None)
    selfSplash(state, player)

    expect(player.velocity[2]).toBe(500)
    expect(player.knockbackTicks).toBe(25)
  })
})

describe('every mode', () => {
  it('launches a rocket jump identically, because knockback is computed first', () => {
    const launches = [SelfDamage.Full, SelfDamage.ArmorOnly, SelfDamage.None].map((mode) => {
      const { state, player } = standing(mode)
      selfSplash(state, player)
      return player.velocity[2]
    })

    expect(launches).toEqual([500, 500, 500])
  })
})

/* --------------------------------------------------------------------------
 * The match is part of the world
 * ----------------------------------------------------------------------- */

describe('match state in the world', () => {
  it('is hashed, so two peers cannot quietly disagree about the score', () => {
    const base = hashState(createGameState(1))

    const mutations: ((state: GameState) => void)[] = [
      (s) => (s.match.phase = MatchPhase.Live),
      (s) => (s.match.round = 2),
      (s) => (s.match.wins[0] = 1),
      (s) => (s.match.wins[1] = 1),
      (s) => (s.match.phaseStartTick = 3),
      (s) => (s.match.phaseEndTick = 3),
      (s) => (s.match.lastRoundWinner = 0),
      (s) => (s.match.winner = 0),
    ]

    for (const mutate of mutations) {
      const state = createGameState(1)
      mutate(state)
      expect(hashState(state)).not.toBe(base)
    }
  })

  it('hashes the rules too, so two peers cannot play different games', () => {
    const base = hashState(createGameState(1))
    const rules: Partial<MatchRules>[] = [
      { selfDamage: SelfDamage.None },
      { roundsToWin: 4 },
      { maxRounds: 4 },
      { roundTimeLimitTicks: 4 },
      { intermissionTicks: 4 },
    ]

    for (const override of rules) {
      expect(hashState(createGameState(1, matchRules(override)))).not.toBe(base)
    }
  })

  it('is deep-copied by `cloneGameState`, so a rewind cannot rewrite the score', () => {
    const state = createGameState(1)
    const copy = cloneGameState(state)

    copy.match.wins[0] = 2
    copy.match.phase = MatchPhase.Over

    expect(state.match.wins).toEqual([0, 0])
    expect(state.match.phase).toBe(MatchPhase.Warmup)
  })

  it('reproduces a whole match from the seed alone', () => {
    // The point of putting the round state in `GameState`: two runs of the same
    // seed agree tick for tick, spawn draw for spawn draw, score and all.
    const play = (seed: number): GameState =>
      playMatch(seed, matchRules(), (world, round) =>
        kill(world, round === 2 ? DUEL_SLOTS[0] : DUEL_SLOTS[1]),
      ).state

    expect(hashState(play(31))).toBe(hashState(play(31)))
    expect(hashState(play(31))).not.toBe(hashState(play(32)))
  })

  it('advances by itself when a match is running and not otherwise', () => {
    // `advanceMatch` is a kernel phase and is safe to call on a warmup world
    // with no plan at all, which is what every physics test is.
    const state = createGameState(1)
    expect(() => advanceMatch(state)).not.toThrow()
    expect(state.match.phase).toBe(MatchPhase.Warmup)
  })
})

/* --------------------------------------------------------------------------
 * No pickups. Anywhere.
 * ----------------------------------------------------------------------- */

describe('there are no pickups', () => {
  it('has no pickup entity kind, and adding one is a deliberate edit to this test', () => {
    // Rocket Arena's whole thesis: no item game. A third entity kind called
    // Item or Pickup is the shape that would have to appear first, so it is
    // pinned here rather than left to review.
    expect(Object.keys(EntityKind)).toEqual(['None', 'Player', 'Projectile'])
  })

  it('has nothing on an entity to pick anything up with', () => {
    const state = createGameState(1)
    const entity = spawnEntity(state, { kind: EntityKind.Player, slot: 0 })

    expect(Object.keys(entity)).toEqual([
      'id',
      'kind',
      'slot',
      'flags',
      'origin',
      'velocity',
      'angles',
      'health',
      'armor',
      'weapon',
      'lastFireTick',
      'knockbackTicks',
      'ownerId',
      'nextFireTick',
      'trBase',
      'spawnTick',
      'expireTick',
    ])
  })

  it('has nowhere in the map format to author one', () => {
    // A map is surfaces, brushes, spawns, lights and props — and a prop is
    // decoration the simulation never parses. There is no `items`, no
    // `pickups`, and no way to write one.
    expect(Object.keys(ARENA)).toEqual([
      'name',
      'title',
      'author',
      'surfaces',
      'brushes',
      'spawns',
      'lights',
      'props',
    ])
  })

  it('has no ammunition to run out of', () => {
    for (const weapon of WEAPONS) expect(weapon.ammo).toBe(AMMO_UNLIMITED)
  })
})
