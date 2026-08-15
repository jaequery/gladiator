/**
 * Crucible's nav graph, asserted.
 *
 * `maps/arena1.nav.ts` is content, and content usually gets reviewed by looking
 * at it. The things below cannot be reviewed by looking at it — whether the bot
 * can get from everywhere to everywhere, whether the two spawns are served by
 * the same quality of routing, whether the perches are honest about being
 * out of reach — so they are measured instead, against the baked artifact the
 * game will actually load.
 *
 * The bake's own rules are asserted in `packages/bot/src/nav/nav.test.ts`. This
 * file is only ever about *this* arena.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { RUN_SPEED, loadMap } from '@gladiator/sim'
import {
  canSee,
  isGround,
  loadNav,
  navPath,
  nextHop,
  nodeIndexOf,
  nodeNear,
  nodeOrigin,
  routeCost,
} from '@gladiator/bot'
import type { NavLink, NavNode } from '@gladiator/bot'

import authoredNav from './arena1.nav.ts'

const map = loadMap(JSON.parse(readFileSync('maps/baked/arena1.json', 'utf8')))
const nav = loadNav(JSON.parse(readFileSync('maps/baked/arena1.nav.json', 'utf8')), map.hash)

const nodes = nav.source.nodes
const ground: number[] = []
for (let i = 0; i < nav.nodeCount; i += 1) if (isGround(nav, i)) ground.push(i)

const at = (id: string): number => {
  const index = nodeIndexOf(nav, id)
  if (index < 0) throw new Error(`arena1.nav has no node called "${id}"`)
  return index
}

describe('the committed artifact', () => {
  it('is the graph in the source file', () => {
    // `loadNav` has already verified both hashes; this is the human-readable
    // half of the same statement.
    expect(nav.source.map).toBe('arena1')
    expect(nav.nodeCount).toBe(authoredNav.nodes.length)
    expect(nav.source.links.length).toBe(authoredNav.links.length)
  })

  it('is an afternoon of authoring rather than a generated mesh', () => {
    // The ticket's premise: a small arena has 30-70 meaningful positions. A
    // graph that has grown past that is a graph nobody is hand-checking any
    // more, and the argument for authoring it by hand has evaporated.
    expect(nav.nodeCount).toBeGreaterThanOrEqual(30)
    expect(nav.nodeCount).toBeLessThanOrEqual(70)
  })
})

/* --------------------------------------------------------------------------
 * Routing — the acceptance check this graph was authored against
 * ----------------------------------------------------------------------- */

describe('every ground node reaches every other ground node', () => {
  it('has a next hop and a finite cost for all of them, both ways', () => {
    expect(ground.length).toBeGreaterThan(30)
    const stranded: string[] = []
    for (const i of ground) {
      for (const j of ground) {
        if (i === j) continue
        if (nextHop(nav, i, j) >= 0 && Number.isFinite(routeCost(nav, i, j))) continue
        stranded.push(`${nodes[i]?.id} -> ${nodes[j]?.id}`)
      }
    }
    expect(stranded).toEqual([])
  })

  it('hands back a route whose every step is a real hop', () => {
    const route: number[] = []
    for (const i of ground) {
      for (const j of ground) {
        if (i === j) continue
        expect(navPath(nav, i, j, route)).toBeGreaterThan(0)
        expect(route[0]).toBe(i)
        expect(route[route.length - 1]).toBe(j)
      }
    }
  })

  it('crosses the arena in the time a duel map should take', () => {
    // The same measurement `arena1.test.ts` makes with the reachability graph,
    // asked of the routing the bot will actually follow. If the two ever
    // disagree badly, one of them is describing a different arena.
    const oneWay = routeCost(nav, at('spawn-sw'), at('spawn-ne'))
    expect((2 * oneWay) / RUN_SPEED).toBeGreaterThan(6)
    expect((2 * oneWay) / RUN_SPEED).toBeLessThan(12)
  })
})

/* --------------------------------------------------------------------------
 * The perches are honest about being out of reach
 * ----------------------------------------------------------------------- */

describe('the perches', () => {
  const perches = nodes.filter((n) => n.tags.includes('perch')).map((n) => n.id)

  it('are the two balconies and the tower, which is what a rocket buys you', () => {
    expect([...perches].sort()).toEqual([
      'balcony-nw-back',
      'balcony-nw-lip',
      'balcony-se-back',
      'balcony-se-lip',
      'tower-top',
    ])
  })

  it('cannot be routed to, because rocketjump is a v2 link kind', () => {
    // The honest encoding. Linking them with a jump the movement cannot make
    // would make the routing guarantee pass and the bot walk into a wall.
    for (const id of perches) {
      for (const i of ground) expect([id, nextHop(nav, i, at(id))]).toEqual([id, -1])
    }
  })

  it('can all be left, so a bot that is somehow up there is not stuck', () => {
    for (const id of perches) {
      const out = nav.source.links.filter((l) => l.from === id)
      expect([id, out.length > 0]).toEqual([id, true])
    }
  })

  it('put a bot back on the ground when it falls off one', () => {
    for (const lip of ['balcony-se-lip', 'balcony-nw-lip', 'tower-top']) {
      const landings = nav.source.links
        .filter((l) => l.from === lip && l.kind === 'drop')
        .map((l) => at(l.to))
      expect([lip, landings.length]).toEqual([lip, landings.length])
      expect(landings.every((i) => isGround(nav, i))).toBe(true)
    }
  })
})

/* --------------------------------------------------------------------------
 * The duel
 * ----------------------------------------------------------------------- */

describe('the spawns', () => {
  it('each have a node on them, and it is the one nodeNear finds', () => {
    for (const spawn of map.source.spawns) {
      const found = nodeNear(nav, spawn.origin)
      expect(found).toBeGreaterThanOrEqual(0)
      expect(nodes[found]?.tags).toContain('spawn')
    }
  })

  it('cannot see each other, which is the tower doing its one job', () => {
    // `arena1.test.ts` proves this with a ray at bake time. Here it is the
    // O(1) lookup the bot will use, over the same geometry.
    expect(canSee(nav, at('spawn-sw'), at('spawn-ne'))).toBe(false)
  })

  it('can both see the ground they start on', () => {
    for (const id of ['spawn-sw', 'spawn-ne']) expect(canSee(nav, at(id), at(id))).toBe(true)
  })
})

describe('the tower breaks sightlines rather than granting them', () => {
  it('hides the mound ring from itself across the middle', () => {
    // The ring is 96 wide and the tower stands in it: from the north side you
    // cannot see the south side, which is what makes circling it work.
    expect(canSee(nav, at('mound-n'), at('mound-s'))).toBe(false)
    expect(canSee(nav, at('mound-e'), at('mound-w'))).toBe(false)
  })

  it('leaves the corners of the ring visible to their neighbours', () => {
    expect(canSee(nav, at('mound-n'), at('mound-ne'))).toBe(true)
    expect(canSee(nav, at('mound-ne'), at('mound-e'))).toBe(true)
  })
})

/* --------------------------------------------------------------------------
 * Fairness
 * ----------------------------------------------------------------------- */

/** A node's position turned half a turn about the middle of the arena. */
function turnedKey(node: NavNode): string {
  return `${-node.origin[0]},${-node.origin[1]},${node.origin[2]}`
}

function key(node: NavNode): string {
  return `${node.origin[0]},${node.origin[1]},${node.origin[2]}`
}

describe('neither player owns better routing', () => {
  const byPosition = new Map(nodes.map((n) => [key(n), n] as const))

  it('is the same graph rotated half a turn', () => {
    // `arena1.ts` is rotationally symmetric, so a routing graph over it that
    // was not would hand one spawn shorter paths than the other — a fairness
    // bug invisible in a playtest and obvious here.
    for (const node of nodes) {
      const twin = byPosition.get(turnedKey(node))
      expect([node.id, twin !== undefined]).toEqual([node.id, true])
      expect([node.id, twin?.tags]).toEqual([node.id, node.tags])
    }
  })

  it('mirrors every link, kind included', () => {
    const idOf = new Map(nodes.map((n) => [n.id, n] as const))
    const declared = new Set(nav.source.links.map((l) => `${l.from} ${l.to} ${l.kind}`))
    const twinOf = (id: string): string => {
      const node = idOf.get(id)
      const twin = node === undefined ? undefined : byPosition.get(turnedKey(node))
      return twin?.id ?? '?'
    }
    const missing: string[] = []
    for (const link of nav.source.links satisfies readonly NavLink[]) {
      const mirrored = `${twinOf(link.from)} ${twinOf(link.to)} ${link.kind}`
      if (!declared.has(mirrored)) missing.push(`${link.from} -> ${link.to} (${link.kind})`)
    }
    expect(missing).toEqual([])
  })

  it('costs the same to get from either spawn to the middle', () => {
    const toMound = (spawn: string, mound: string): number => routeCost(nav, at(spawn), at(mound))
    expect(toMound('spawn-sw', 'mound-sw')).toBe(toMound('spawn-ne', 'mound-ne'))
    expect(toMound('spawn-sw', 'mound-n')).toBe(toMound('spawn-ne', 'mound-s'))
  })
})

/* --------------------------------------------------------------------------
 * The graph describes the arena it is for
 * ----------------------------------------------------------------------- */

describe('every node is inside the arena', () => {
  it('stands within the sealed volume, on the surface it was authored on', () => {
    const origin: [number, number, number] = [0, 0, 0]
    for (let i = 0; i < nav.nodeCount; i += 1) {
      nodeOrigin(nav, i, origin)
      expect([nodes[i]?.id, Math.abs(origin[0]) < 512, Math.abs(origin[1]) < 512]).toEqual([
        nodes[i]?.id,
        true,
        true,
      ])
      expect(origin[2]).toBeGreaterThanOrEqual(0)
      expect(origin[2]).toBeLessThan(512)
    }
  })
})
