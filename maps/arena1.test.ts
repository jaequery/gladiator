/**
 * The arena's design, asserted.
 *
 * `maps/arena1.ts` is content, and content usually gets reviewed by looking at
 * it. The four things below cannot be reviewed by looking at it — whether every
 * ledge is on a route the movement can take, whether the spawns can see each
 * other, whether a player can walk the place without falling out of it, and
 * whether it is the right *size* — so they are measured instead, against the
 * real `pmove` and the real trace.
 *
 * This runs under vitest from `maps/` rather than from a package: the map is
 * repo-level content, `tools/` bakes it, and neither is somewhere a package
 * test can reach without breaking the import rules in `AGENTS.md`.
 */

import { describe, expect, it } from 'vitest'

import {
  ANGLE_UNITS,
  MIN_SPAWN_SEPARATION,
  NULL_CMD,
  PLAYER_HEIGHT,
  PLAYER_MAXS,
  PLAYER_MINS,
  PLAYER_VIEW_HEIGHT,
  RUN_SPEED,
  STEP_SIZE,
  TECHNIQUES,
  analyzeReachability,
  angleVectors,
  boxPenetration,
  buildReachabilityGraph,
  buildSpawnPlan,
  createGameState,
  createMapWorld,
  createPmoveBody,
  createTrace,
  parseMapSource,
  pmove,
  spawnRound,
  spawnSeparation,
  traceBox,
  traceRay,
  validateMap,
  vec3,
  walkRouteLength,
  yawUnitsFromDegrees,
} from '@gladiator/sim'
import type { MapBrush, MapSpawn, Vec3 } from '@gladiator/sim'

import authored from './arena1.ts'

const arena = parseMapSource(authored)
const world = createMapWorld(arena)
const analysis = analyzeReachability(arena)

/** Half-width of the open floor, from `arena1.ts`. */
const HALF = 512

describe('arena1 bakes', () => {
  it('has nothing the validator objects to', () => {
    expect(validateMap(arena)).toEqual([])
  })

  it('has no pickups to object to, because the format cannot express one', () => {
    // Rocket Arena's design thesis, and the reason it is safe to state here:
    // there is no item entity in the map format at all (GLAD-L4SYN9 owns the
    // rules that keep it that way). Props are decoration the sim never parses.
    expect(arena.props).toEqual([])
  })
})

/* --------------------------------------------------------------------------
 * Reachability — the acceptance check this map was designed against
 * ----------------------------------------------------------------------- */

describe('every ledge is one of the four climbs', () => {
  it('leaves nothing a player cannot get to', () => {
    expect(analysis.unreachable).toEqual([])
  })

  it('labels each ledge with exactly one technique — the cheapest that spans it', () => {
    expect(analysis.ledges.length).toBeGreaterThan(0)
    for (const ledge of analysis.ledges) {
      const spans = TECHNIQUES.filter((t) => t.height >= ledge.climb)
      // The bands are disjoint by construction: 0-18, 18-48, 48-166, 166-395.
      // "Exactly one" is therefore "the cheapest one that reaches", and that is
      // what the analysis has to have picked.
      expect(spans[0]?.key).toBe(ledge.technique)
    }
  })

  it('uses all four of them, which is what makes it a map for this movement', () => {
    const heights = (key: string) =>
      analysis.ledges.filter((l) => l.technique === key).map((l) => Math.round(l.climb))

    // A staircase and two ramps: walked, not jumped.
    expect(analysis.tallestStep).toBeCloseTo(16, 3)
    expect(analysis.tallestStep).toBeLessThanOrEqual(STEP_SIZE)
    // The crates, the balconies, the tower. Two of each of the first two,
    // because the map is symmetric; one tower, because it is the middle.
    expect(heights('jump')).toEqual([40, 40])
    expect(heights('rocket-jump')).toEqual([128, 128])
    expect(heights('jump-rocket')).toEqual([320])
  })
})

/* --------------------------------------------------------------------------
 * The duel
 * ----------------------------------------------------------------------- */

/** Where a player's eyes are on the first frame of a round. */
function eyes(spawn: MapSpawn): Vec3 {
  return [spawn.origin[0], spawn.origin[1], spawn.origin[2] + PLAYER_VIEW_HEIGHT]
}

describe('the two spawns', () => {
  it('are far enough apart to be a duel', () => {
    const [a, b] = arena.spawns
    if (a === undefined || b === undefined) throw new Error('arena1 needs two spawns')
    const dx = b.origin[0] - a.origin[0]
    const dy = b.origin[1] - a.origin[1]
    expect(Math.sqrt(dx * dx + dy * dy)).toBeGreaterThan(MIN_SPAWN_SEPARATION)
  })

  it('cannot see each other on the first frame of the round', () => {
    // Eye to eye, with the hitscan trace the railgun will use (GLAD-0QWRYK).
    // The tower stands in the line, which is the one thing it is there for.
    const trace = createTrace()
    for (const a of arena.spawns) {
      for (const b of arena.spawns) {
        if (a === b) continue
        traceRay(trace, world, eyes(a), eyes(b))
        expect(trace.fraction).toBeLessThan(1)
      }
    }
  })

  it('face the middle, so neither player starts by turning round', () => {
    for (const spawn of arena.spawns) {
      const forward = vec3()
      angleVectors(0, spawn.yaw, 0, forward, null, null)
      // The dot product of "which way you are looking" with "which way the
      // middle is" — positive means towards it.
      const towards = -spawn.origin[0] * forward[0] - spawn.origin[1] * forward[1]
      expect(towards).toBeGreaterThan(0)
    }
  })
})

/* --------------------------------------------------------------------------
 * Round starts on this arena
 * ----------------------------------------------------------------------- */

/** How many seeded round starts the spawn system is exercised over here. */
const ROUND_STARTS = 1000

describe('a thousand seeded round starts on Crucible', () => {
  const plan = buildSpawnPlan(arena, world)

  it('finds exactly one pair to start on, and it is the two opposite corners', () => {
    expect(plan.pairs).toEqual([[0, 1]])
  })

  it('never seats both players on the same point, and never inside the separation', () => {
    for (let seed = 0; seed < ROUND_STARTS; seed += 1) {
      const state = createGameState(seed)
      const [a, b] = spawnRound(state, plan)
      expect(a.point).not.toBe(b.point)
      const [pa, pb] = [arena.spawns[a.point], arena.spawns[b.point]]
      if (pa === undefined || pb === undefined) throw new Error('a spawn that is not there')
      expect(spawnSeparation(pa, pb)).toBeGreaterThanOrEqual(MIN_SPAWN_SEPARATION)
    }
  })

  it('flips which end each player gets, so nobody owns a corner', () => {
    const seats = new Set<string>()
    for (let seed = 0; seed < ROUND_STARTS; seed += 1) {
      const [a] = spawnRound(createGameState(seed), plan)
      seats.add(String(a.point))
    }
    expect([...seats].sort()).toEqual(['0', '1'])
  })
})

describe('the arena is duel-sized', () => {
  it('takes between six and ten seconds to cross and come back', () => {
    const graph = buildReachabilityGraph(arena)
    const [a, b] = arena.spawns
    if (a === undefined || b === undefined) throw new Error('arena1 needs two spawns')
    const oneWay = walkRouteLength(graph, a.origin, b.origin)
    const roundTrip = (2 * oneWay) / RUN_SPEED

    expect(roundTrip).toBeGreaterThan(6)
    expect(roundTrip).toBeLessThan(10)
  })
})

/* --------------------------------------------------------------------------
 * Walking it
 * ----------------------------------------------------------------------- */

/** Knee height: what the wall probe looks along, so a step does not read as a wall. */
const KNEE = 24

/** How far the probes look, in Quake units. */
const PROBE = 320

/** How far off the right-hand wall the follower tries to stay. */
const HUG_NEAR = 48
const HUG_FAR = 96

/** Degrees of yaw per sub-step. 62.5 degrees a second: a human's turn, not a spin. */
const TURN_RATE = 0.5

/** One minute of walking. */
const TRAVERSAL_TICKS = 7500

/**
 * Walk the perimeter with a right-hand wall follower, and report what happened.
 *
 * No waypoints and no bot: two traces of the world in front of the player, a
 * rule about which way to turn, and the same `UserCmd` a keyboard produces. It
 * is deliberately the dumbest thing that can circumnavigate a room, because the
 * point is to exercise the *arena* — its corners, its stairs, the gap between
 * the mound and the balconies — rather than anything clever.
 */
function walkThePerimeter() {
  const body = createPmoveBody(PLAYER_MINS, PLAYER_MAXS)
  const spawn = arena.spawns[0]
  if (spawn === undefined) throw new Error('arena1 needs a spawn')
  body.origin[0] = spawn.origin[0]
  body.origin[1] = spawn.origin[1]
  body.origin[2] = spawn.origin[2] + 1

  const trace = createTrace()
  const forward = vec3()
  const right = vec3()
  const probeMins: Vec3 = [PLAYER_MINS[0], PLAYER_MINS[1], 0]
  const probeMaxs: Vec3 = [PLAYER_MAXS[0], PLAYER_MAXS[1], PLAYER_HEIGHT - KNEE]
  const step = yawUnitsFromDegrees(TURN_RATE)
  let yaw = 0

  const lo: [number, number, number] = [Infinity, Infinity, Infinity]
  const hi: [number, number, number] = [-Infinity, -Infinity, -Infinity]
  let worstPenetration = 0

  const look = (direction: Vec3): number => {
    const from: Vec3 = [body.origin[0], body.origin[1], body.origin[2] + KNEE]
    const to: Vec3 = [from[0] + direction[0] * PROBE, from[1] + direction[1] * PROBE, from[2]]
    traceBox(trace, world, from, to, probeMins, probeMaxs)
    return trace.fraction * PROBE
  }

  for (let i = 0; i < TRAVERSAL_TICKS; i += 1) {
    angleVectors(0, yaw, 0, forward, right, null)
    if (look(forward) < 64) yaw = (yaw + step) % ANGLE_UNITS
    else if (look(right) > HUG_FAR) yaw = (yaw - step + ANGLE_UNITS) % ANGLE_UNITS
    else if (look(right) < HUG_NEAR) yaw = (yaw + step) % ANGLE_UNITS

    pmove(world, body, { ...NULL_CMD, forwardMove: 1, yaw })

    const penetration = boxPenetration(world, body.origin, PLAYER_MINS, PLAYER_MAXS)
    if (penetration > worstPenetration) worstPenetration = penetration
    for (let axis = 0; axis < 3; axis += 1) {
      const at = body.origin[axis] ?? 0
      lo[axis] = Math.min(lo[axis] ?? Infinity, at)
      hi[axis] = Math.max(hi[axis] ?? -Infinity, at)
    }
  }

  return { body, lo, hi, worstPenetration }
}

/**
 * The same tolerance `property.test.ts` uses: zero, plus what a plane with an
 * irrational normal costs in floating point.
 */
const PENETRATION_TOLERANCE = 0.03

describe('a player can walk it without falling out of it', () => {
  const walk = walkThePerimeter()

  it('never ends a sub-step inside the world', () => {
    expect(walk.worstPenetration).toBeLessThanOrEqual(PENETRATION_TOLERANCE)
  })

  it('never leaves the sealed volume', () => {
    expect(walk.lo[0]).toBeGreaterThan(-HALF)
    expect(walk.lo[1]).toBeGreaterThan(-HALF)
    expect(walk.hi[0]).toBeLessThan(HALF)
    expect(walk.hi[1]).toBeLessThan(HALF)
    // Never under the floor, and never above anything it could have climbed on
    // to on foot — a walker that ends up on the tower has been thrown there.
    expect(walk.lo[2]).toBeGreaterThanOrEqual(0)
    expect(walk.hi[2]).toBeLessThan(128)
  })

  it('gets all the way round rather than orbiting a corner', () => {
    // Within 32 units of all four walls: the follower has been down every side.
    expect(walk.lo[0]).toBeLessThan(-HALF + 32)
    expect(walk.lo[1]).toBeLessThan(-HALF + 32)
    expect(walk.hi[0]).toBeGreaterThan(HALF - 32)
    expect(walk.hi[1]).toBeGreaterThan(HALF - 32)
  })

  it('is still on its feet at the end of the minute', () => {
    expect(walk.body.walking).toBe(true)
  })
})

/* --------------------------------------------------------------------------
 * Fairness
 * ----------------------------------------------------------------------- */

/** A brush rotated half a turn about the middle of the arena. */
function turned(brushDef: MapBrush): MapBrush {
  const mins: Vec3 = [-brushDef.maxs[0], -brushDef.maxs[1], brushDef.mins[2]]
  const maxs: Vec3 = [-brushDef.mins[0], -brushDef.mins[1], brushDef.maxs[2]]
  if (brushDef.kind === 'box') return { ...brushDef, mins, maxs }
  const OPPOSITE = { '+x': '-x', '-x': '+x', '+y': '-y', '-y': '+y' } as const
  return { ...brushDef, mins, maxs, rise: OPPOSITE[brushDef.rise] }
}

describe('neither player owns better ground', () => {
  it('is the same map rotated half a turn', () => {
    // Every brush has a twin at (-x, -y) — some of them are their own. This is
    // the cheapest possible statement of "the arena is fair", and unlike a
    // playtest it cannot come out differently tomorrow.
    const key = (b: MapBrush) => JSON.stringify(b)
    const present = new Set(arena.brushes.map(key))
    for (const brushDef of arena.brushes) {
      expect([key(brushDef), present.has(key(turned(brushDef)))]).toEqual([key(brushDef), true])
    }
  })

  it('spawns the two players in opposite corners of it', () => {
    const [a, b] = arena.spawns
    if (a === undefined || b === undefined) throw new Error('arena1 needs two spawns')
    expect([b.origin[0], b.origin[1], b.origin[2]]).toEqual([-a.origin[0], -a.origin[1], a.origin[2]])
    expect((a.yaw + ANGLE_UNITS / 2) % ANGLE_UNITS).toBe(b.yaw)
  })
})
