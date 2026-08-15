/**
 * The nav bake: what it accepts, what it refuses, and what it computes.
 *
 * Rules are asserted by diagnostic **code** rather than by prose — the sentence
 * an author reads is allowed to be reworded, and the rule is not.
 */

import { describe, expect, it } from 'vitest'

import { NAV_MAX_JUMP, bakeNav, loadNav, navHashOf } from '../index.ts'
import type { NavLink, NavNode, NavSource } from '../index.ts'
import { fixtureMap, fixtureNav, fixtureNavWith, fixtureNode, fixtureWalk } from './fixture.ts'
import { navLinkCost } from './bake.ts'

const map = fixtureMap()

function codesFor(nav: NavSource): string[] {
  const outcome = bakeNav(nav, map)
  return outcome.ok ? [] : outcome.diagnostics.map((d) => d.code)
}

function bakedOf(nav: NavSource) {
  const outcome = bakeNav(nav, map)
  if (!outcome.ok) throw new Error(outcome.diagnostics.map((d) => `${d.code}: ${d.detail}`).join('\n'))
  return outcome.baked
}

describe('the bake', () => {
  it('accepts a graph with nothing wrong with it', () => {
    expect(bakeNav(fixtureNav(), map).ok).toBe(true)
  })

  it('carries the format, its own hash, and the hash of the map it was baked against', () => {
    const baked = bakedOf(fixtureNav())
    expect(baked.format).toBe(1)
    expect(baked.hash).toMatch(/^[0-9a-f]{8}$/)
    expect(baked.mapHash).toBe(map.hash)
  })

  it('drops every node on to the surface under it', () => {
    // Authored at z = 0, which is the floor; a body resting on a floor sits an
    // eighth of a unit clear of it (`docs/physics-spec.md` §2.2).
    for (const node of bakedOf(fixtureNav()).nav.nodes) expect(node.origin[2]).toBeCloseTo(0.125, 6)
  })

  it('hashes the content, so moving a node one unit moves the hash', () => {
    const before = bakedOf(fixtureNav()).hash
    const moved = fixtureNav({
      nodes: [
        fixtureNode('a', [-512, 0, 0], 'ground', 'spawn'),
        fixtureNode('b', [511, 0, 0], 'ground', 'spawn'),
        fixtureNode('north', [0, 320, 0], 'ground'),
      ],
    })
    expect(bakedOf(moved).hash).not.toBe(before)
  })

  it('round-trips through JSON with both hashes intact', () => {
    const baked = bakedOf(fixtureNav())
    const loaded = loadNav(JSON.parse(JSON.stringify(baked)), map.hash)
    expect(loaded.hash).toBe(baked.hash)
    expect(loaded.source).toEqual(baked.nav)
    expect(navHashOf(loaded.source)).toBe(baked.hash)
  })

  it('refuses to load against a map it was not baked for', () => {
    const baked = bakedOf(fixtureNav())
    expect(() => loadNav(JSON.parse(JSON.stringify(baked)), 'deadbeef')).toThrow(/geometry has moved/)
  })

  it('refuses to load an artifact somebody edited by hand', () => {
    const baked = JSON.parse(JSON.stringify(bakedOf(fixtureNav())))
    baked.nav.nodes[0].origin[0] = -256
    expect(() => loadNav(baked, map.hash)).toThrow(/edited by hand/)
  })
})

/* --------------------------------------------------------------------------
 * The four refusals the ticket names
 * ----------------------------------------------------------------------- */

describe('the bake refuses', () => {
  it('a node inside solid', () => {
    // Dead centre of the 128-unit pillar, and still inside it a step higher.
    const nav = fixtureNavWith(
      [fixtureNode('buried', [0, -256, 0], 'ground')],
      fixtureWalk('buried', 'north'),
    )
    expect(codesFor(nav)).toContain('node-in-solid')
  })

  it('a node with no links', () => {
    const nav = fixtureNavWith([fixtureNode('lonely', [256, 256, 0], 'ground')], [])
    expect(codesFor(nav)).toContain('orphan-node')
  })

  it('a walk link crossing a gap wider than the step height', () => {
    // Straight across the 128-unit pit, which is seven times a stride.
    const nav = fixtureNav({ links: [...fixtureNav().links, ...fixtureWalk('a', 'b')] })
    expect(codesFor(nav)).toContain('walk-gap')
  })

  it('an unreachable node pair among ground-tagged nodes', () => {
    const nav = fixtureNavWith(
      [
        fixtureNode('island-1', [-512, 512, 0], 'ground'),
        fixtureNode('island-2', [-256, 512, 0], 'ground'),
      ],
      fixtureWalk('island-1', 'island-2'),
    )
    expect(codesFor(nav)).toContain('unreachable-ground')
  })
})

/** Rules that are not on the ticket's list and fail the same way. */
describe('the bake also refuses', () => {
  it('a link naming a node that does not exist', () => {
    const nav = fixtureNav({ links: [...fixtureNav().links, ...fixtureWalk('a', 'ghost')] })
    expect(codesFor(nav)).toContain('unknown-node')
  })

  it('a node that is tagged neither ground nor perch', () => {
    const nav = fixtureNavWith([fixtureNode('vague', [256, 256, 0])], fixtureWalk('vague', 'north'))
    expect(codesFor(nav)).toContain('bad-tags')
  })

  it('two nodes with the same id', () => {
    const nav = fixtureNavWith([fixtureNode('a', [256, 256, 0], 'ground')], [])
    expect(codesFor(nav)).toContain('duplicate-node')
  })

  it('a node hanging in the air', () => {
    const nav = fixtureNavWith(
      [fixtureNode('floating', [256, 256, 256], 'ground')],
      fixtureWalk('floating', 'north'),
    )
    expect(codesFor(nav)).toContain('node-not-standing')
  })

  it('a map spawn with no node on it', () => {
    const nav: NavSource = {
      map: 'fixture',
      nodes: [
        fixtureNode('a', [-512, 0, 0], 'ground'),
        fixtureNode('north', [0, 320, 0], 'ground'),
      ],
      links: fixtureWalk('a', 'north'),
    }
    expect(codesFor(nav)).toContain('spawn-uncovered')
  })

  it('a walk link up a rise no player steps', () => {
    // On to the 48-unit block, which is a jump and is not a walk.
    const nav = fixtureNavWith(
      [fixtureNode('ledge', [192, -192, 48], 'ground')],
      fixtureWalk('ledge', 'b'),
    )
    expect(codesFor(nav)).toContain('walk-step')
  })

  it('a jump higher than a jump goes', () => {
    const nav = fixtureNavWith(
      [
        fixtureNode('pillar-top', [0, -256, 128], 'ground'),
        fixtureNode('pillar-foot', [0, -400, 0], 'ground'),
      ],
      [
        { from: 'pillar-foot', to: 'pillar-top', kind: 'jump' },
        ...fixtureWalk('pillar-foot', 'a'),
      ],
    )
    expect(codesFor(nav)).toContain('jump-too-high')
    expect(NAV_MAX_JUMP).toBe(48)
  })

  it('a drop that goes up', () => {
    const nav = fixtureNavWith(
      [fixtureNode('ledge', [192, -192, 48], 'ground')],
      [{ from: 'b', to: 'ledge', kind: 'drop' }, { from: 'ledge', to: 'b', kind: 'drop' }],
    )
    expect(codesFor(nav)).toContain('drop-ascends')
  })
})

/* --------------------------------------------------------------------------
 * What it computes
 * ----------------------------------------------------------------------- */

describe('the routing tables', () => {
  const baked = bakedOf(fixtureNav())
  const nav = loadNav(JSON.parse(JSON.stringify(baked)), map.hash)
  const at = (id: string): number => nav.index.get(id) ?? -1

  it('route through the middle, because there is no other way round the pit', () => {
    expect(nav.nextHop[at('a') * nav.nodeCount + at('b')]).toBe(at('north'))
    expect(nav.nextHop[at('b') * nav.nodeCount + at('a')]).toBe(at('north'))
  })

  it('cost a route at the sum of its hops, in whole Quake units', () => {
    const a = baked.nav.nodes.find((n) => n.id === 'a')
    const b = baked.nav.nodes.find((n) => n.id === 'b')
    const north = baked.nav.nodes.find((n) => n.id === 'north')
    if (a === undefined || b === undefined || north === undefined) throw new Error('fixture')
    const expected =
      navLinkCost('walk', a.origin, north.origin) + navLinkCost('walk', north.origin, b.origin)
    expect(nav.cost[at('a') * nav.nodeCount + at('b')]).toBe(expected)
    expect(Number.isInteger(expected)).toBe(true)
  })

  it('cost nothing to be where you already are', () => {
    for (let i = 0; i < nav.nodeCount; i += 1) {
      expect(nav.cost[i * nav.nodeCount + i]).toBe(0)
      expect(nav.nextHop[i * nav.nodeCount + i]).toBe(i)
    }
  })

  it('price a jump above a walk of the same length, because you cannot steer out of one', () => {
    const from: [number, number, number] = [0, 0, 0]
    const to: [number, number, number] = [100, 0, 0]
    expect(navLinkCost('jump', from, to)).toBeGreaterThan(navLinkCost('walk', from, to))
    expect(navLinkCost('drop', from, to)).toBeGreaterThan(navLinkCost('walk', from, to))
  })
})

describe('the visibility bitset', () => {
  const baked = bakedOf(fixtureNav())

  it('is symmetric, so nobody hides from someone who can see them', () => {
    const n = baked.nav.nodes.length
    const w = baked.visibility.words
    const sees = (i: number, j: number): boolean =>
      (((baked.visibility.bits[i * w + (j >>> 5)] ?? 0) >>> (j & 31)) & 1) === 1
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) expect([i, j, sees(i, j)]).toEqual([i, j, sees(j, i)])
    }
  })

  it('says a node sees itself', () => {
    const w = baked.visibility.words
    for (let i = 0; i < baked.nav.nodes.length; i += 1) {
      expect((baked.visibility.bits[i * w + (i >>> 5)] ?? 0) & (1 << (i & 31))).not.toBe(0)
    }
  })
})

describe('the locate grid', () => {
  const baked = bakedOf(fixtureNav())

  it('holds every node exactly once', () => {
    expect([...baked.grid.cellNodes].sort((x, y) => x - y)).toEqual(
      baked.nav.nodes.map((_, i) => i),
    )
  })

  it('has one more offset than it has cells, so a cell is a pair of them', () => {
    expect(baked.grid.cellStart.length).toBe(baked.grid.nx * baked.grid.ny + 1)
    expect(baked.grid.cellStart[baked.grid.nx * baked.grid.ny]).toBe(baked.nav.nodes.length)
  })
})

/* --------------------------------------------------------------------------
 * The authoring shapes the parser has to survive
 * ----------------------------------------------------------------------- */

describe('the parser', () => {
  it('rejects a link kind that is not one of the four', () => {
    const nav = { ...fixtureNav(), links: [{ from: 'a', to: 'b', kind: 'rocketjump' }] }
    expect(() => bakeNav(nav as unknown as NavSource, map)).toThrow(/expected one of/)
  })

  it('rejects a tag that is not one of the three', () => {
    const nodes: NavNode[] = [{ id: 'a', origin: [0, 0, 0], tags: ['sniper' as never] }]
    const links: NavLink[] = []
    expect(() => bakeNav({ map: 'fixture', nodes, links }, map)).toThrow(/expected one of/)
  })
})
