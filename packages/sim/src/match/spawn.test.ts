import { describe, expect, it } from 'vitest'

import { PLAYER_VIEW_HEIGHT } from '../bbox.ts'
import { NO_INPUTS, tick } from '../kernel.ts'
import { createMapWorld } from '../map/collide.ts'
import { MIN_SPAWN_SEPARATION } from '../map/schema.ts'
import type { MapBrush, MapSource, MapSpawn } from '../map/schema.ts'
import { validateMap } from '../map/validate.ts'
import { EntityFlag, EntityKind, createGameState, findPlayer, hashState } from '../state.ts'
import type { EntityState, GameState } from '../state.ts'
import { SURFACE_CLIP_EPSILON, createTrace, traceRay } from '../trace.ts'
import { yawUnitsFromDegrees } from '../usercmd.ts'
import {
  DUEL_SLOTS,
  RESPAWN_DELAY_TICKS,
  SIGHT_TARGETS,
  SPAWN_HEALTH,
  SPAWN_PROTECTION_TICKS,
  buildSpawnPlan,
  isSpawnProtected,
  playersOverlap,
  selectSpawnPair,
  spawnPlayer,
  spawnRound,
  spawnSeparation,
  spawnsAreBlind,
} from './spawn.ts'
import type { SpawnEvent, SpawnPlan } from './spawn.ts'

/* --------------------------------------------------------------------------
 * The fixture
 * ----------------------------------------------------------------------- */

/** Half-width of the fixture's open floor. */
const HALF = 1024

/** Height of its open volume. */
const CEILING = 512

const SHELL = 64

function slab(mins: [number, number, number], maxs: [number, number, number]): MapBrush {
  return { kind: 'box', surface: 'shell', mins, maxs }
}

/**
 * The screen in the middle.
 *
 * Deliberately **not** square. The two diagonal sightlines this fixture is
 * built around run along `y = x` and `y = -x`, and a square centred on the
 * origin is grazed by both of them exactly at its corners — a knife-edge that
 * makes the test's answer a floating-point coin toss rather than a statement
 * about the geometry. Wider than it is deep, and both diagonals cross two
 * faces with sixty-four units to spare.
 *
 * Floor to ceiling, so it adds no ledge for the reachability pass to object to.
 */
const SCREEN = slab([-192, -128, 0], [192, 128, CEILING])

function corner(x: number, y: number, yawDegrees: number): MapSpawn {
  return { origin: [x, y, 0], yaw: yawUnitsFromDegrees(yawDegrees) }
}

/**
 * Four spawns in the four corners of a room with a screen across the middle.
 *
 * The pairs are chosen so that the plan has to reject some of them: the two
 * *diagonal* pairs look through the screen and are legal, and the four
 * *orthogonal* pairs — down a wall, with nothing in between — are separated by
 * plenty and can see each other perfectly well, which is the whole point.
 */
function duelArena(spawns: readonly MapSpawn[] = FOUR_CORNERS): MapSource {
  return {
    name: 'fixture',
    title: 'Fixture',
    author: 'test',
    surfaces: [{ name: 'shell', material: 'concrete', tint: [0.3, 0.3, 0.3] }],
    brushes: [
      slab([-HALF - SHELL, -HALF - SHELL, -SHELL], [HALF + SHELL, HALF + SHELL, 0]),
      slab([-HALF - SHELL, -HALF - SHELL, CEILING], [HALF + SHELL, HALF + SHELL, CEILING + SHELL]),
      slab([HALF, -HALF - SHELL, -SHELL], [HALF + SHELL, HALF + SHELL, CEILING + SHELL]),
      slab([-HALF - SHELL, -HALF - SHELL, -SHELL], [-HALF, HALF + SHELL, CEILING + SHELL]),
      slab([-HALF - SHELL, HALF, -SHELL], [HALF + SHELL, HALF + SHELL, CEILING + SHELL]),
      slab([-HALF - SHELL, -HALF - SHELL, -SHELL], [HALF + SHELL, -HALF, CEILING + SHELL]),
      SCREEN,
    ],
    spawns,
    lights: [],
    props: [],
  }
}

const FOUR_CORNERS: readonly MapSpawn[] = [
  corner(-768, -768, 45),
  corner(768, 768, -135),
  corner(-768, 768, -45),
  corner(768, -768, 135),
]

/** The four corners plus one point too close to the first to pair with it. */
const CROWDED: readonly MapSpawn[] = [...FOUR_CORNERS, corner(-768, -512, 90)]

const arena = duelArena()
const world = createMapWorld(arena)
const plan = buildSpawnPlan(arena, world)

/* --------------------------------------------------------------------------
 * The plan
 * ----------------------------------------------------------------------- */

describe('the spawn plan', () => {
  it('is a legal map to begin with, so the rules below are not fighting each other', () => {
    expect(validateMap(arena)).toEqual([])
  })

  it('keeps the pairs that cannot see each other and drops the ones that can', () => {
    // (0, 1) and (2, 3) are the diagonals, and the screen stands in both of
    // them. The four pairs down a wall are separated by 1536 units of nothing.
    expect(plan.pairs).toEqual([
      [0, 1],
      [2, 3],
    ])
  })

  it('drops a pair that is too close even when nothing can see through it', () => {
    const crowded = buildSpawnPlan(duelArena(CROWDED))
    const withNewcomer = crowded.pairs.filter((pair) => pair.includes(4))

    // The newcomer is 256 units from spawn 0 — inside `MIN_SPAWN_SEPARATION`,
    // so that pair is gone whatever the geometry says. It keeps the one legal
    // partner it has.
    expect(withNewcomer).toEqual([[1, 4]])
    expect(spawnSeparation(CROWDED[0] as MapSpawn, CROWDED[4] as MapSpawn)).toBeLessThan(
      MIN_SPAWN_SEPARATION,
    )
  })

  it('asks about sight in both directions and about the whole body, not just the eyes', () => {
    const [a, b, c] = FOUR_CORNERS as [MapSpawn, MapSpawn, MapSpawn]
    expect(spawnsAreBlind(world, a, b)).toBe(true)
    expect(spawnsAreBlind(world, b, a)).toBe(true)
    expect(spawnsAreBlind(world, a, c)).toBe(false)
    // Nine points per body: the eye and the eight corners of the box.
    expect(SIGHT_TARGETS).toHaveLength(9)
  })

  it('refuses to draw from a map where every pair fails, rather than picking one anyway', () => {
    const open = duelArena().brushes.filter((b) => b !== SCREEN)
    const noScreen: MapSource = { ...duelArena(), brushes: open }
    const emptyPlan = buildSpawnPlan(noScreen)

    expect(emptyPlan.pairs).toEqual([])
    expect(() => selectSpawnPair(emptyPlan, createGameState(1))).toThrow(/no two spawn points/)
    // And the bake says so first, which is where a map author will meet it.
    expect(validateMap(noScreen).map((d) => d.code)).toContain('no-blind-spawn-pair')
  })
})

/* --------------------------------------------------------------------------
 * A thousand round starts
 * ----------------------------------------------------------------------- */

/** How many seeded round starts the acceptance checks are run over. */
const ROUND_STARTS = 1000

/** The point a `SpawnEvent` landed on. */
function pointFor(index: number): MapSpawn {
  const point = plan.spawns[index]
  if (point === undefined) throw new Error(`no spawn ${index}`)
  return point
}

function playerIn(state: GameState, slot: number): EntityState {
  const player = findPlayer(state, slot)
  if (player === null) throw new Error(`slot ${slot} has no player`)
  return player
}

/**
 * Can a player standing at `from` see any part of a player standing at `to`?
 *
 * Asked of two *simulated* bodies rather than two spawn points, with the same
 * hitscan trace the railgun will use and the same nine sample points
 * `match/spawn.ts` reasons about — so the answer is about where the players
 * actually ended up on the first frame, not about where the map said to put
 * them.
 */
function sightBetween(a: EntityState, b: EntityState): boolean {
  const trace = createTrace()
  const eye: [number, number, number] = [a.origin[0], a.origin[1], a.origin[2] + PLAYER_VIEW_HEIGHT]
  for (const target of SIGHT_TARGETS) {
    traceRay(trace, world, eye, [
      b.origin[0] + target[0],
      b.origin[1] + target[1],
      b.origin[2] + target[2],
    ])
    if (trace.fraction === 1) return true
  }
  return false
}

type Round = {
  readonly seed: number
  readonly first: SpawnEvent
  readonly second: SpawnEvent
  readonly state: GameState
}

describe(`${ROUND_STARTS} seeded round starts`, () => {
  const seats = new Set<string>()
  const rounds: Round[] = []

  for (let seed = 0; seed < ROUND_STARTS; seed += 1) {
    const state = createGameState(seed)
    const [first, second] = spawnRound(state, plan)
    // The acceptance check says "on the first simulated frame", so it is asked
    // of the world one sub-step in — after gravity, the ground trace and
    // everything else `tick` does to a body that has just been put down.
    tick(state, NO_INPUTS, world)
    seats.add(`${first.point}:${second.point}`)
    rounds.push({ seed, first, second, state })
  }

  it('never puts both players on the same point', () => {
    for (const round of rounds) expect(round.first.point).not.toBe(round.second.point)
  })

  it('never puts them inside the minimum separation', () => {
    for (const round of rounds) {
      const distance = spawnSeparation(pointFor(round.first.point), pointFor(round.second.point))
      expect(distance).toBeGreaterThanOrEqual(MIN_SPAWN_SEPARATION)
    }
  })

  it('never overlaps the two bodies', () => {
    for (const round of rounds) {
      const a = playerIn(round.state, DUEL_SLOTS[0])
      const b = playerIn(round.state, DUEL_SLOTS[1])
      expect(playersOverlap(a, b)).toBe(false)
    }
  })

  it('never gives either player sight of the other on the first simulated frame', () => {
    for (const round of rounds) {
      const a = playerIn(round.state, DUEL_SLOTS[0])
      const b = playerIn(round.state, DUEL_SLOTS[1])
      expect([round.seed, sightBetween(a, b), sightBetween(b, a)]).toEqual([round.seed, false, false])
    }
  })

  it('telefrags nobody, because a round start cannot', () => {
    for (const round of rounds) {
      expect(round.first.telefragged).toEqual([])
      expect(round.second.telefragged).toEqual([])
    }
  })

  it('uses every legal pair, and both ends of each, rather than one seating forever', () => {
    // Two pairs, two orientations: four seatings, and a thousand draws from a
    // uniform generator finds all four or the generator is not the one claimed.
    expect([...seats].sort()).toEqual(['0:1', '1:0', '2:3', '3:2'])
  })
})

/* --------------------------------------------------------------------------
 * Determinism
 * ----------------------------------------------------------------------- */

describe('a replay reproduces the spawns exactly', () => {
  it('draws from the seeded PRNG in the state, and nothing else', () => {
    const state = createGameState(12345)
    const before = state.rng
    spawnRound(state, plan)
    // Two draws — which pair, then which end — so the stream has moved and the
    // state carries the fact that it did.
    expect(state.rng).not.toBe(before)
  })

  it('puts the same seed in the same corners, every time', () => {
    for (let seed = 0; seed < 64; seed += 1) {
      const a = createGameState(seed)
      const b = createGameState(seed)
      expect(spawnRound(a, plan)).toEqual(spawnRound(b, plan))
      expect(hashState(a)).toBe(hashState(b))
    }
  })

  it('survives being replayed from the state, which is what reconciliation does', () => {
    // A client rewinds to a state it kept and replays forward. The spawns are
    // part of what has to come out the same, and they do because the draw is
    // made from `state.rng` — carried in the state, hashed, cloned.
    const live = createGameState(99)
    const kept = { ...live, entities: [] }

    spawnRound(live, plan)
    for (let i = 0; i < 250; i += 1) tick(live, NO_INPUTS, world)

    spawnRound(kept, plan)
    for (let i = 0; i < 250; i += 1) tick(kept, NO_INPUTS, world)

    expect(hashState(kept)).toBe(hashState(live))
  })

  it('does not put every seed in the same corner, or the draw would be decoration', () => {
    const seatings = new Set<string>()
    for (let seed = 0; seed < 64; seed += 1) {
      const state = createGameState(seed)
      const [first] = spawnRound(state, plan)
      seatings.add(String(first.point))
    }
    expect(seatings.size).toBeGreaterThan(1)
  })
})

/* --------------------------------------------------------------------------
 * The loadout, and which way you are looking
 * ----------------------------------------------------------------------- */

describe('a spawned player', () => {
  const state = createGameState(4)
  const [first] = spawnRound(state, plan)
  const player = playerIn(state, DUEL_SLOTS[0])

  it('stands on the point with their feet an epsilon clear of the floor', () => {
    const point = pointFor(first.point)
    expect([player.origin[0], player.origin[1], player.origin[2]]).toEqual([
      point.origin[0],
      point.origin[1],
      point.origin[2] + SURFACE_CLIP_EPSILON,
    ])
  })

  it('faces the way the map says, level and without roll', () => {
    const point = pointFor(first.point)
    expect([player.angles[0], player.angles[1], player.angles[2]]).toEqual([0, point.yaw, 0])
  })

  it('starts at full health, standing still, with no flags carried over', () => {
    expect(player.health).toBe(SPAWN_HEALTH)
    expect([player.velocity[0], player.velocity[1], player.velocity[2]]).toEqual([0, 0, 0])
    expect(player.flags).toBe(0)
  })

  it('is not protected, because there is no spawn protection', () => {
    expect(SPAWN_PROTECTION_TICKS).toBe(0)
    expect(isSpawnProtected(state, player)).toBe(false)
  })

  it('waits a whole number of ticks between rounds', () => {
    expect(Number.isInteger(RESPAWN_DELAY_TICKS)).toBe(true)
    expect(RESPAWN_DELAY_TICKS).toBeGreaterThan(0)
  })
})

describe('respawning between rounds', () => {
  it('reuses the same body rather than leaving a corpse and creating a stranger', () => {
    const state = createGameState(11)
    spawnRound(state, plan)
    const ids = state.entities.map((e) => e.id)

    // A round happens: the player dies, drifts, and is respawned.
    const player = playerIn(state, DUEL_SLOTS[0])
    player.health = 0
    player.flags = EntityFlag.Dead | EntityFlag.JumpHeld
    player.velocity[0] = 900
    for (let i = 0; i < RESPAWN_DELAY_TICKS; i += 1) tick(state, NO_INPUTS, world)

    spawnRound(state, plan)
    expect(state.entities.map((e) => e.id)).toEqual(ids)

    const revived = playerIn(state, DUEL_SLOTS[0])
    expect(revived.health).toBe(SPAWN_HEALTH)
    expect(revived.flags).toBe(0)
    expect(revived.velocity[0]).toBe(0)
    // `spawnTick` is the clock spawn protection would be measured against, so
    // it has to be this round's, not the one two rounds ago.
    expect(revived.spawnTick).toBe(state.tick)
  })

  it('does not telefrag the other player for having been where the round left them', () => {
    const state = createGameState(3)
    spawnRound(state, plan)

    // Stand slot 1 exactly on the point slot 0 is about to be given, and start
    // the next round. Both bodies move before either is allowed to kill.
    const forced = playerIn(state, DUEL_SLOTS[1])
    const target = pointFor(0)
    forced.origin[0] = target.origin[0]
    forced.origin[1] = target.origin[1]
    forced.origin[2] = target.origin[2] + SURFACE_CLIP_EPSILON

    for (const event of spawnRound(state, plan)) expect(event.telefragged).toEqual([])
    expect(playerIn(state, DUEL_SLOTS[1]).health).toBe(SPAWN_HEALTH)
  })
})

/* --------------------------------------------------------------------------
 * Telefrag
 * ----------------------------------------------------------------------- */

/** Every pair of living players whose boxes share any volume. */
function overlappingLivePairs(state: GameState): [number, number][] {
  const live = state.entities.filter(
    (e) => e.kind === EntityKind.Player && (e.flags & EntityFlag.Dead) === 0,
  )
  const found: [number, number][] = []
  for (let i = 0; i < live.length; i += 1) {
    for (let j = i + 1; j < live.length; j += 1) {
      const a = live[i]
      const b = live[j]
      if (a !== undefined && b !== undefined && playersOverlap(a, b)) found.push([a.id, b.id])
    }
  }
  return found
}

describe('spawning on to an occupied point', () => {
  /** Slot 1 standing on point 0, and slot 0 arriving on top of them. */
  function collide(seed: number): { state: GameState; killed: readonly number[]; victim: number } {
    const state = createGameState(seed)
    const occupant = spawnPlayer(state, plan, 0, DUEL_SLOTS[1])
    expect(occupant.telefragged).toEqual([])
    const victim = playerIn(state, DUEL_SLOTS[1]).id
    const arrival = spawnPlayer(state, plan, 0, DUEL_SLOTS[0])
    return { state, killed: arrival.telefragged, victim }
  }

  it('kills the occupant, not the arrival — Quake’s answer, on purpose', () => {
    const { state, killed, victim } = collide(1)
    expect(killed).toEqual([victim])

    const occupant = playerIn(state, DUEL_SLOTS[1])
    expect(occupant.health).toBe(0)
    expect(occupant.flags & EntityFlag.Dead).toBe(EntityFlag.Dead)
    expect(playerIn(state, DUEL_SLOTS[0]).health).toBe(SPAWN_HEALTH)
  })

  it('leaves no two living players overlapping', () => {
    expect(overlappingLivePairs(collide(2).state)).toEqual([])
  })

  it('resolves identically from the same state, twice', () => {
    const a = collide(5)
    const b = collide(5)
    expect(a.killed).toEqual(b.killed)
    expect(hashState(a.state)).toBe(hashState(b.state))
  })

  it('kills nobody when the point is free', () => {
    const state = createGameState(6)
    spawnPlayer(state, plan, 0, DUEL_SLOTS[1])
    expect(spawnPlayer(state, plan, 1, DUEL_SLOTS[0]).telefragged).toEqual([])
    expect(overlappingLivePairs(state)).toEqual([])
  })

  it('does not kill a body that is already dead, which would score it twice', () => {
    const { state, victim } = collide(8)
    // Arrive a second time. The occupant is a corpse now and is not killed again.
    expect(spawnPlayer(state, plan, 0, DUEL_SLOTS[0]).telefragged).toEqual([])
    expect(playerIn(state, DUEL_SLOTS[1]).id).toBe(victim)
  })

  it('counts a body as clear the moment it is touching rather than inside', () => {
    // Two players exactly 30 units apart are shoulder to shoulder, which is
    // legal. One unit closer is not.
    const state = createGameState(9)
    spawnPlayer(state, plan, 0, DUEL_SLOTS[0])
    spawnPlayer(state, plan, 1, DUEL_SLOTS[1])
    const a = playerIn(state, DUEL_SLOTS[0])
    const b = playerIn(state, DUEL_SLOTS[1])

    b.origin[0] = a.origin[0] + 30
    b.origin[1] = a.origin[1]
    b.origin[2] = a.origin[2]
    expect(playersOverlap(a, b)).toBe(false)

    b.origin[0] = a.origin[0] + 29
    expect(playersOverlap(a, b)).toBe(true)
  })
})

/* --------------------------------------------------------------------------
 * The trace the sightline is asked with
 * ----------------------------------------------------------------------- */

describe('line of sight', () => {
  it('is measured with the same trace the railgun will use', () => {
    // Not a new raycaster: a `traceRay` from the eye, which is a `traceBox`
    // with a zero-extent box. Straight down the open wall between spawn 0 and
    // spawn 2 there is nothing at all in the way.
    const trace = createTrace()
    const [a, , c] = FOUR_CORNERS as [MapSpawn, MapSpawn, MapSpawn]
    traceRay(
      trace,
      world,
      [a.origin[0], a.origin[1], a.origin[2] + PLAYER_VIEW_HEIGHT],
      [c.origin[0], c.origin[1], c.origin[2] + PLAYER_VIEW_HEIGHT],
    )
    expect(trace.fraction).toBe(1)
  })

  it('is blocked by the screen on the diagonal, with the trace stopping short of it', () => {
    const trace = createTrace()
    const [a, b] = FOUR_CORNERS as [MapSpawn, MapSpawn]
    traceRay(
      trace,
      world,
      [a.origin[0], a.origin[1], a.origin[2] + PLAYER_VIEW_HEIGHT],
      [b.origin[0], b.origin[1], b.origin[2] + PLAYER_VIEW_HEIGHT],
    )
    expect(trace.fraction).toBeLessThan(1)
  })
})

/* --------------------------------------------------------------------------
 * The shape of a plan
 * ----------------------------------------------------------------------- */

describe('buildSpawnPlan', () => {
  it('builds its own collision world when it is not handed one', () => {
    const built: SpawnPlan = buildSpawnPlan(arena)
    expect(built.pairs).toEqual(plan.pairs)
  })

  it('is a function of the map alone, so it can be built once and kept', () => {
    const again = buildSpawnPlan(arena, world)
    expect(again.pairs).toEqual(plan.pairs)
    expect(again.spawns).toEqual(arena.spawns)
  })

  it('has no pairs at all when a map has one spawn', () => {
    // The same room, one corner in it. There is nothing to pair with, and
    // `selectSpawnPair` says so rather than seating both players on it.
    const lonely = buildSpawnPlan(duelArena([FOUR_CORNERS[0] as MapSpawn]), world)
    expect(lonely.pairs).toEqual([])
    expect(() => selectSpawnPair(lonely, createGameState(1))).toThrow()
  })
})
