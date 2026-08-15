/**
 * The follower, driving a real body through the real movement.
 *
 * The map is `nav/fixture.ts`'s and the thing that makes it the right one is the
 * bottomless 128-unit hole in the middle of its floor: the graph's route from `a` to
 * `b` goes *round* it via `north`, and the straight line between them goes *through*
 * it. So "did it follow the graph" and "did it fall out of the world" are the same
 * two hundred sub-steps.
 */

import {
  BUTTON_JUMP,
  MatchPhase,
  RUN_SPEED,
  STEP_SIZE,
  yawUnitsFromDegrees,
} from '@gladiator/sim'
import type { Vec3 } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { NO_NODE } from '../nav/schema.ts'
import { fixtureNav, fixtureNavWith, fixtureNode } from '../nav/fixture.ts'
import { nodeIndexOf } from '../nav/query.ts'
import { STUCK_TICKS } from '../stuck.ts'
import { createWalker, fixtureLoadedNav, flatTo, speedOf, walk } from './fixture.ts'

const nav = fixtureLoadedNav()

const A: Vec3 = [-512, 0, 0]
const B: Vec3 = [512, 0, 0]
/** Inside the hole. Nothing routes here and nothing should walk here. */
const PIT: Vec3 = [0, 0, 0]
/** The floor of the world. Below this the body has left the map through the hole. */
const FELL_IN = -64

describe('following a route', () => {
  it('walks from one end of the graph to the other, round the hole', () => {
    const walker = createWalker({ origin: A, nav })
    walk(walker, 1400, { goal: B })
    expect(flatTo(walker, B)).toBeLessThan(64)
    // Never through the middle: the route is `a -> north -> b` and the hole is at
    // the origin, so a bot that cut the corner would be in it.
    expect(walker.body.origin[2]).toBeGreaterThan(FELL_IN)
  })

  it('gets there whatever the view is doing', () => {
    // The yaw belongs to the aim controller and points at whatever the bot is
    // fighting. A follower that only worked when the view agreed with the route would
    // work until the first duel.
    for (const yawDegrees of [0, 90, 180, 270]) {
      const walker = createWalker({ origin: A, nav })
      walk(walker, 1400, { goal: B, yawDegrees })
      expect(flatTo(walker, B)).toBeLessThan(64)
    }
  })

  it('gets there with the view spinning, which is what a fight looks like', () => {
    const walker = createWalker({ origin: A, nav })
    walk(walker, 1400, { goal: B, yawDegrees: (step) => step * 3 })
    expect(flatTo(walker, B)).toBeLessThan(64)
  })

  it('is on exactly one link, and holds it until it arrives', () => {
    const walker = createWalker({ origin: A, nav })
    const hops: number[] = []
    walk(walker, 600, {
      goal: B,
      after: () => {
        const hop = walker.move.hopNode
        // `NO_NODE` is a genuine state on a graph this sparse: three nodes 1024 units
        // apart, and `nodeNear` reads nine cells of a 128-unit grid, so the middle of
        // a link is off the graph. The bot steers straight at its goal there and
        // re-anchors when a node comes back into range.
        if (hop !== NO_NODE && hops[hops.length - 1] !== hop) hops.push(hop)
      },
    })
    // The route is `a -> north -> b`, and the property is that the bot walks it in
    // order and never re-enters a link it has left. A follower that re-derived from
    // `nodeNear` every sub-step would cut corners and revisit.
    expect(hops).toEqual([nodeIndexOf(nav, 'north'), nodeIndexOf(nav, 'b')])
    expect(walker.move.hop).toBe('walk')
  })

  it('re-anchors when it is put somewhere else', () => {
    const walker = createWalker({ origin: A, nav })
    walk(walker, 300, { goal: B })
    expect(walker.move.atNode).not.toBe(nodeIndexOf(nav, 'a'))
    // A rocket lands. Nothing about the bot's plan survives, and nothing needs to:
    // it asks the graph again from where it woke up, and the answer is already correct
    // for wherever that is.
    walker.body.origin[0] = A[0]
    walker.body.origin[1] = A[1]
    walker.body.origin[2] = 0.125
    walker.body.velocity[0] = 0
    walker.body.velocity[1] = 0
    walk(walker, 2, { goal: B })
    expect(walker.move.atNode).toBe(nodeIndexOf(nav, 'a'))
    expect(walker.move.hopNode).toBe(nodeIndexOf(nav, 'north'))
  })

  it('stands still when there is nowhere to be and no graph to roam', () => {
    const walker = createWalker({ origin: A, nav: null })
    const commands = walk(walker, 40, { goal: null })
    for (const cmd of commands) {
      expect(cmd.forwardMove).toBe(0)
      expect(cmd.sideMove).toBe(0)
      expect(cmd.buttons).toBe(0)
    }
    expect(walker.move.hasTarget).toBe(false)
  })

  it('steers straight at a goal when it has a world and no graph', () => {
    // The configuration `perception/fairness.test.ts` uses: no routing, but the ledge
    // guard is still on, because a bot off the graph is the one that most needs it.
    const walker = createWalker({ origin: A, nav: null })
    walk(walker, 300, { goal: [-512, 512, 0] })
    expect(flatTo(walker, [-512, 512, 0])).toBeLessThan(64)
    expect(walker.move.hop).toBe(null)
  })

  it('does not steer at all while nobody is allowed to', () => {
    // An intermission. The kernel throws a command away in that phase, so a follower
    // that kept driving would look like one that had stopped responding — and
    // `stuck.ts` would call three seconds of it a wedge.
    const walker = createWalker({ origin: A, nav })
    walker.model.match.phase = MatchPhase.Intermission
    const commands = walk(walker, 600, { goal: B })
    for (const cmd of commands) expect(cmd.forwardMove).toBe(0)
    expect(walker.move.stuck.episodes).toBe(0)
  })

  it('does not steer while dead', () => {
    const walker = createWalker({ origin: A, nav })
    walker.model.self.alive = false
    const commands = walk(walker, 40, { goal: B })
    for (const cmd of commands) expect(cmd.buttons).toBe(0)
  })
})

describe('the ledge guard, over a hole that goes nowhere', () => {
  it('refuses to walk into the pit even when the goal is inside it', () => {
    // The worst case the guard exists for: the last leg of a route, where the target
    // is a *point* rather than a node and nothing validated the line to it.
    const walker = createWalker({ origin: [-256, 0, 0], nav })
    walk(walker, 600, { goal: PIT })
    expect(walker.body.origin[2]).toBeGreaterThan(FELL_IN)
    expect(walker.move.vetoed || speedOf(walker) < RUN_SPEED).toBe(true)
  })

  it('refuses from every direction', () => {
    for (const start of [
      [-256, 0, 0],
      [256, 0, 0],
      [0, -256, 0],
      [0, 256, 0],
    ] as const) {
      const walker = createWalker({ origin: start, nav })
      walk(walker, 500, { goal: PIT })
      expect(walker.body.origin[2]).toBeGreaterThan(FELL_IN)
    }
  })

  it('lets a drop link off a ledge happen, because that is what a drop is', () => {
    // The fixture's 48-tall block, with a `drop` off it. The guard is switched off for
    // exactly the two kinds that mean "there is supposed to be nothing under you", and
    // a guard that was not would make every drop link in the graph unwalkable.
    const graph = fixtureNavWith(
      [fixtureNode('block', [192, -192, 48], 'ground'), fixtureNode('under', [192, -100, 0], 'ground')],
      [
        { from: 'block', to: 'under', kind: 'drop' },
        { from: 'under', to: 'block', kind: 'jump' },
        { from: 'under', to: 'b', kind: 'walk' },
        { from: 'b', to: 'under', kind: 'walk' },
      ],
    )
    const loaded = fixtureLoadedNav(graph)
    const under: Vec3 = [192, -100, 0]
    const walker = createWalker({ origin: [192, -192, 48], nav: loaded })
    walk(walker, 400, { goal: under })
    expect(walker.body.origin[2]).toBeLessThan(STEP_SIZE)
    expect(flatTo(walker, under)).toBeLessThan(64)
  })
})

describe('the jump button', () => {
  it('is never held on two consecutive sub-steps', () => {
    // `PMF_JUMP_HELD` is only cleared by a sub-step with the button up, so a bot that
    // held jump would jump once and never again. Asserted over a run that contains a
    // jump link, so there is something to hold.
    const graph = fixtureNavWith(
      [fixtureNode('block', [192, -192, 48], 'ground'), fixtureNode('under', [192, -100, 0], 'ground')],
      [
        { from: 'under', to: 'block', kind: 'jump' },
        { from: 'block', to: 'under', kind: 'drop' },
        { from: 'under', to: 'b', kind: 'walk' },
        { from: 'b', to: 'under', kind: 'walk' },
      ],
    )
    const loaded = fixtureLoadedNav(graph)
    const walker = createWalker({ origin: [192, -100, 0], nav: loaded })
    const commands = walk(walker, 500, { goal: [192, -192, 48] })

    let jumps = 0
    let previous = false
    for (const cmd of commands) {
      const jump = (cmd.buttons & BUTTON_JUMP) !== 0
      if (jump) {
        jumps += 1
        expect(previous).toBe(false)
      }
      previous = jump
    }
    expect(jumps).toBeGreaterThan(0)
  })

  it('gets the bot up on to the block it could not step on to', () => {
    const graph = fixtureNavWith(
      [fixtureNode('block', [192, -192, 48], 'ground'), fixtureNode('under', [192, -100, 0], 'ground')],
      [
        { from: 'under', to: 'block', kind: 'jump' },
        { from: 'block', to: 'under', kind: 'drop' },
        { from: 'under', to: 'b', kind: 'walk' },
        { from: 'b', to: 'under', kind: 'walk' },
      ],
    )
    const loaded = fixtureLoadedNav(graph)
    const walker = createWalker({ origin: [192, -100, 0], nav: loaded })
    walk(walker, 500, { goal: [192, -192, 48] })
    // 48 is over a step, so the only way up is the jump.
    expect(walker.body.origin[2]).toBeGreaterThan(STEP_SIZE)
  })
})

describe('roaming', () => {
  it('goes somewhere on its own when the brain has nothing to ask for', () => {
    const walker = createWalker({ origin: A, nav, seed: 3 })
    walk(walker, 400, { goal: null })
    expect(walker.move.roamNode).not.toBe(NO_NODE)
    expect(flatTo(walker, A)).toBeGreaterThan(200)
  })

  it('picks somewhere new once it gets there', () => {
    const walker = createWalker({ origin: A, nav, seed: 5 })
    const visited = new Set<number>()
    walk(walker, 3000, {
      goal: null,
      after: () => {
        if (walker.move.roamNode !== NO_NODE) visited.add(walker.move.roamNode)
      },
    })
    expect(visited.size).toBeGreaterThan(1)
  })

  it('is not idling, so the stuck detector has something to measure', () => {
    const walker = createWalker({ origin: A, nav, seed: 7 })
    walk(walker, STUCK_TICKS * 2, { goal: null })
    // Two rounds of the stuck clock without a single recovery is a bot that kept
    // covering ground.
    expect(walker.move.stuck.episodes).toBe(0)
  })

  it('draws only from the bot’s own seeded stream, so a run replays', () => {
    const one = createWalker({ origin: A, nav, seed: 11 })
    const two = createWalker({ origin: A, nav, seed: 11 })
    expect(walk(one, 800, { goal: null })).toEqual(walk(two, 800, { goal: null }))

    const other = createWalker({ origin: A, nav, seed: 12 })
    expect(walk(other, 800, { goal: null })).not.toEqual(walk(one, 800, { goal: null }))
  })
})

describe('the view is not the follower’s to touch', () => {
  it('sends back exactly the yaw it was handed', () => {
    const walker = createWalker({ origin: A, nav })
    const commands = walk(walker, 200, { goal: B, yawDegrees: 137 })
    for (const cmd of commands) expect(cmd.yaw).toBe(yawUnitsFromDegrees(137))
  })
})

describe('the graph the fixture routes on', () => {
  it('goes round the hole rather than across it', () => {
    // The premise of every assertion above. If the fixture graph ever gains a direct
    // `a -> b` link, the ledge tests would still pass and would stop meaning anything.
    const source = fixtureNav()
    const direct = source.links.some(
      (link) =>
        (link.from === 'a' && link.to === 'b') || (link.from === 'b' && link.to === 'a'),
    )
    expect(direct).toBe(false)
  })
})
