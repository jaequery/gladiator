import { describe, expect, it } from 'vitest'

import { PLAYER_MAXS, PLAYER_MINS } from '../bbox.ts'
import { boxBrush, createCollisionWorld } from '../collide.ts'
import { FELT_GRAVITY, JUMP_VELOCITY, RUN_SPEED, createPmoveBody, pmove } from '../pmove/index.ts'
import { STEP_SIZE } from '../slidemove.ts'
import { BUTTON_JUMP, NULL_CMD } from '../usercmd.ts'
import {
  MAX_CLIMB,
  ROCKET_JUMP_LAUNCH,
  TECHNIQUES,
  analyzeReachability,
  apexOf,
  buildReachabilityGraph,
  horizontalReachOf,
  walkRouteLength,
} from './reachability.ts'
import type { MapBrush, MapSource } from './schema.ts'
import { validateMap } from './validate.ts'

/* --------------------------------------------------------------------------
 * Measuring the four techniques against the movement that has to make them
 * ----------------------------------------------------------------------- */

const FLAT = createCollisionWorld([boxBrush([-4096, -4096, -64], [4096, 4096, 0])])

/** A player standing still on the flat world, settled on the floor. */
function standing(world = FLAT) {
  const body = createPmoveBody(PLAYER_MINS, PLAYER_MAXS)
  body.origin[2] = 1
  for (let i = 0; i < 60 && !body.walking; i += 1) pmove(world, body, NULL_CMD)
  return body
}

/** The highest the feet get, launched straight up at `launch`, in world `z`. */
function measuredApex(launch: number): number {
  const body = standing()
  body.velocity[2] = launch
  let highest = 0
  for (let i = 0; i < 800; i += 1) {
    pmove(FLAT, body, NULL_CMD)
    if (body.origin[2] > highest) highest = body.origin[2]
    if (i > 3 && body.walking) break
  }
  return highest
}

/** One attempt at a ledge `height` tall, launching `at` units short of it. */
function attempt(height: number, launch: number, pressJump: boolean, at: number): boolean {
  const lip = 512
  const world = createCollisionWorld([
    boxBrush([-4096, -4096, -64], [4096, 4096, 0]),
    boxBrush([lip, -4096, 0], [4096, 4096, height]),
  ])
  const body = standing(world)
  body.origin[0] = -768
  const run = { ...NULL_CMD, forwardMove: 1 }
  const jump = { ...run, buttons: BUTTON_JUMP }

  let launched = false
  for (let i = 0; i < 700; i += 1) {
    if (!launched && body.origin[0] >= lip - at) {
      launched = true
      if (pressJump) {
        pmove(world, body, jump)
        // The rocket lands on the same tick as the jump: the best case, and the
        // one §5.4's tallest number is stated for.
        if (launch > JUMP_VELOCITY) body.velocity[2] = launch
        continue
      }
      body.velocity[2] = launch
    }
    pmove(world, body, run)
    if (launched && body.walking && body.origin[2] > height - 1) return true
  }
  return false
}

/**
 * Can a player running at {@link RUN_SPEED} get on to a ledge `height` tall,
 * from anywhere.
 *
 * Sweeps the moment of the launch, because "can this be done" is a question
 * about the best-timed attempt rather than about one arbitrary one.
 */
function canReach(height: number, launch: number, pressJump: boolean): boolean {
  const widest = horizontalReachOf(launch === 0 ? JUMP_VELOCITY : launch, 0)
  for (let at = 16; at <= widest; at += 16) {
    if (attempt(height, launch, pressJump, at)) return true
  }
  return false
}

describe('the four techniques', () => {
  it('are the ones §5.4 names', () => {
    expect(TECHNIQUES.map((t) => t.height)).toEqual([18, 48, 166, 395])
    expect(TECHNIQUES.map((t) => t.key)).toEqual(['step', 'jump', 'rocket-jump', 'jump-rocket'])
    expect(MAX_CLIMB).toBe(395)
  })

  it('state heights the real pmove reaches, to the unit', () => {
    // The whole design contract in one assertion: every number a level is built
    // around is the floor of what the movement measurably does. A change to
    // JUMP_VELOCITY, to GRAVITY or to the snapping moves both sides together.
    for (const technique of TECHNIQUES) {
      if (technique.launch === 0) continue
      const apex = measuredApex(technique.launch)
      expect(Math.floor(apex)).toBe(technique.height)
      // And the closed form the analysis uses agrees with the measurement.
      expect(apexOf(technique.launch)).toBeCloseTo(apex, 0)
    }
  })

  it('are derived from the movement constants rather than typed beside them', () => {
    expect(FELT_GRAVITY).toBe(750)
    expect(apexOf(JUMP_VELOCITY)).toBeCloseTo(48.6, 6)
    expect(apexOf(ROCKET_JUMP_LAUNCH)).toBeCloseTo(166.667, 3)
    expect(apexOf(JUMP_VELOCITY + ROCKET_JUMP_LAUNCH)).toBeCloseTo(395.267, 3)
  })

  it('each get a running player on to a ledge of exactly their height', () => {
    for (const technique of TECHNIQUES) {
      const pressJump = technique.key === 'jump' || technique.key === 'jump-rocket'
      expect([technique.key, canReach(technique.height, technique.launch, pressJump)]).toEqual([
        technique.key,
        true,
      ])
    }
  })

  it('and none of them on to one a step-up higher than that', () => {
    // Step-up applies on the way *down* — `StepSlideMove` only refuses it while
    // rising — so a jump does in practice mantle up to STEP_SIZE above its
    // apex. That slack is the margin that makes designing to the bare apex
    // safe; it is not more reach, and a ledge past it is out.
    for (const technique of TECHNIQUES) {
      const pressJump = technique.key === 'jump' || technique.key === 'jump-rocket'
      const beyond = technique.height + STEP_SIZE + 8
      expect([technique.key, canReach(beyond, technique.launch, pressJump)]).toEqual([
        technique.key,
        false,
      ])
    }
  })
})

describe('horizontal reach', () => {
  it('is the whole flight when there is nothing to climb', () => {
    const flight = (2 * JUMP_VELOCITY * RUN_SPEED) / FELT_GRAVITY
    expect(horizontalReachOf(JUMP_VELOCITY, 0)).toBeCloseTo(flight, 9)
  })

  it('is half of it at the apex, where there is no time left to travel', () => {
    const apex = apexOf(JUMP_VELOCITY)
    expect(horizontalReachOf(JUMP_VELOCITY, apex)).toBeCloseTo(horizontalReachOf(JUMP_VELOCITY, 0) / 2, 6)
  })

  it('is nothing at all above the apex', () => {
    expect(horizontalReachOf(JUMP_VELOCITY, apexOf(JUMP_VELOCITY) + 1)).toBe(0)
  })
})

/* --------------------------------------------------------------------------
 * The sampled world
 * ----------------------------------------------------------------------- */

/** A sealed room with two legal spawns, plus whatever the test puts in it. */
function room(...brushes: MapBrush[]): MapSource {
  const shell: MapBrush[] = [
    { kind: 'box', surface: 'shell', mins: [-576, -576, -64], maxs: [576, 576, 0] },
    { kind: 'box', surface: 'shell', mins: [-576, -576, 512], maxs: [576, 576, 576] },
    { kind: 'box', surface: 'shell', mins: [512, -576, -64], maxs: [576, 576, 576] },
    { kind: 'box', surface: 'shell', mins: [-576, -576, -64], maxs: [-512, 576, 576] },
    { kind: 'box', surface: 'shell', mins: [-576, 512, -64], maxs: [576, 576, 576] },
    { kind: 'box', surface: 'shell', mins: [-576, -576, -64], maxs: [576, -512, 576] },
  ]
  return {
    name: 'fixture',
    title: 'Fixture',
    author: 'test',
    surfaces: [{ name: 'shell', material: 'concrete', tint: [0.3, 0.3, 0.3] }],
    brushes: [...shell, ...brushes],
    spawns: [
      { origin: [-384, -384, 0], yaw: 0 },
      { origin: [384, 384, 0], yaw: 32768 },
    ],
    lights: [],
    props: [],
  }
}

/** A box brush of the shell surface. */
function slab(mins: [number, number, number], maxs: [number, number, number]): MapBrush {
  return { kind: 'box', surface: 'shell', mins, maxs }
}

describe('the walk graph', () => {
  it('walks up risers under STEP_SIZE and refuses one over it', () => {
    const stairs = analyzeReachability(
      room(slab([-48, -256, 0], [0, 256, 16]), slab([0, -256, 0], [48, 256, 32])),
    )
    expect(stairs.unreachable).toEqual([])
    expect(stairs.tallestStep).toBeCloseTo(16, 6)
    // Everything is walk-reachable: nothing had to be jumped on to.
    expect(stairs.ledges).toEqual([])

    const cliff = analyzeReachability(room(slab([-48, -256, 0], [48, 256, 32])))
    expect(cliff.ledges.map((l) => l.technique)).toEqual(['jump'])
  })

  it('strides over a slot narrower than the player and not over a real gap', () => {
    // The floor is one piece; these cut a trench in it by standing walls up on
    // either side of a strip, which is how a map makes a gap you fall into.
    const slot = analyzeReachability(
      room(slab([-256, -256, 0], [-8, 256, 64]), slab([8, -256, 0], [256, 256, 64])),
    )
    const gap = analyzeReachability(
      room(slab([-256, -256, 0], [-24, 256, 64]), slab([24, -256, 0], [256, 256, 64])),
    )

    const walked = (r: ReturnType<typeof analyzeReachability>) =>
      r.ledges.filter((l) => l.technique !== 'step').length
    // A 16-unit slot between two 64-high blocks is crossed on foot: the 30-unit
    // player box never falls into it. Widen it to 48 and the two block tops are
    // separate ledges, each jumped on to.
    expect(walked(slot)).toBe(1)
    expect(walked(gap)).toBe(2)
  })

  it('measures a walking route rather than a straight line', () => {
    const wall = room(slab([-32, -512, 0], [32, 256, 256]))
    const graph = buildReachabilityGraph(wall)
    const straight = walkRouteLength(graph, [-384, -384, 0], [384, -384, 0])
    // 768 apart in a straight line, and the wall between them means walking
    // round the top of it.
    expect(straight).toBeGreaterThan(768)
    expect(straight).toBeLessThan(2400)
  })
})

/* --------------------------------------------------------------------------
 * The rule the bake enforces
 * ----------------------------------------------------------------------- */

describe('unreachable ledges', () => {
  /** A pillar whose top is out of reach of everything on the floor. */
  const tooTall = slab([-64, 256, 0], [64, 384, MAX_CLIMB + 25])

  it('are refused, and say where and by how much', () => {
    const diagnostics = validateMap(room(tooTall))
    expect(diagnostics.map((d) => d.code)).toEqual(['unreachable-ledge'])
    expect(diagnostics[0]?.detail).toContain(String(MAX_CLIMB + 25))
    expect(diagnostics[0]?.detail).toContain(String(MAX_CLIMB))
  })

  it('bake once something puts them within a climb', () => {
    // The same pillar, with a landing beside it that a rocket jump reaches and
    // a jump-plus-rocket then carries you off. Nothing about the pillar
    // changed; the route to it did.
    const stone = slab([-64, 64, 0], [64, 192, 120])
    expect(validateMap(room(tooTall, stone))).toEqual([])

    const analysis = analyzeReachability(room(tooTall, stone))
    expect(analysis.unreachable).toEqual([])
    expect(analysis.ledges.map((l) => l.technique).sort()).toEqual(['jump-rocket', 'rocket-jump'])
  })

  it('do not stop the earlier passes from being the ones that report first', () => {
    // Reachability is the third pass, and it never runs on a map whose spawns
    // are in the floor: the expensive analysis of a broken map is a worse error
    // message, not a better one.
    const broken = room(tooTall)
    const buried: MapSource = { ...broken, spawns: [{ origin: [0, 0, -32], yaw: 0 }, ...broken.spawns] }
    expect(validateMap(buried).map((d) => d.code)).toContain('spawn-in-solid')
    expect(validateMap(buried).map((d) => d.code)).not.toContain('unreachable-ledge')
  })
})
