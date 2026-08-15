/**
 * The query API is O(1), measured rather than asserted in prose.
 *
 * "No search at runtime" is easy to claim and easy to lose: somebody adds a
 * "just scan the neighbours" and nothing fails. So the tests below count the
 * *table reads* each query performs and check two things — that the count is a
 * small constant, and that it is the **same** constant for a four-node graph
 * and a seventy-node one. A search cannot pass the second test.
 */

import { describe, expect, it } from 'vitest'

import {
  NAV_FORMAT_VERSION,
  NO_NODE,
  buildGrid,
  canSee,
  computeRoutes,
  hopKind,
  loadNav,
  navHashOf,
  navPath,
  nextHop,
  nodeIndexOf,
  nodeNear,
  nodeOrigin,
  routeCost,
  wordsFor,
} from '../index.ts'
import type { BakedNav, LoadedNav, NavLink, NavNode, NavSource } from '../index.ts'
import { bakeNav } from './bake.ts'
import { fixtureMap, fixtureNav } from './fixture.ts'

/* --------------------------------------------------------------------------
 * Two graphs of very different sizes, and a way to count what a query touches
 * ----------------------------------------------------------------------- */

/** `n` nodes in a line, every neighbour walkable. No map, no traces, no bake. */
function chainNav(n: number): LoadedNav {
  const nodes: NavNode[] = []
  const links: NavLink[] = []
  for (let i = 0; i < n; i += 1) {
    nodes.push({ id: `n${i}`, origin: [i * 64, 0, 0], tags: ['ground'] })
    if (i === 0) continue
    links.push({ from: `n${i - 1}`, to: `n${i}`, kind: 'walk' })
    links.push({ from: `n${i}`, to: `n${i - 1}`, kind: 'walk' })
  }
  const nav: NavSource = { map: 'chain', nodes, links }

  const words = wordsFor(n)
  const bits: number[] = new Array<number>(n * words).fill(0)
  for (let i = 0; i < n; i += 1) {
    const at = i * words + (i >>> 5)
    bits[at] = ((bits[at] ?? 0) | (1 << (i & 31))) >>> 0
  }

  const baked: BakedNav = {
    format: NAV_FORMAT_VERSION,
    hash: navHashOf(nav),
    mapHash: 'ffffffff',
    nav,
    routes: computeRoutes(nav),
    visibility: { words, bits },
    grid: buildGrid(nodes),
  }
  return loadNav(JSON.parse(JSON.stringify(baked)), 'ffffffff')
}

/**
 * The same graph with every table behind a proxy that counts indexed reads.
 *
 * Only the four `n * n`-shaped tables are counted, because those are the ones a
 * search would have to walk. Reading `nodeCount` off the object is arithmetic,
 * not a lookup.
 */
function counted(nav: LoadedNav): { nav: LoadedNav; reads: () => number; reset: () => void } {
  let count = 0
  const wrap = <T extends object>(table: T): T =>
    new Proxy(table, {
      get(target, key) {
        if (typeof key === 'string' && /^\d+$/.test(key)) count += 1
        return Reflect.get(target, key) as unknown
      },
    })

  return {
    nav: {
      ...nav,
      nextHop: wrap(nav.nextHop),
      cost: wrap(nav.cost),
      vis: wrap(nav.vis),
      linkKind: wrap(nav.linkKind),
    },
    reads: () => count,
    reset: () => {
      count = 0
    },
  }
}

const SMALL = counted(chainNav(4))
const LARGE = counted(chainNav(70))

/** How many table reads `query` performs against `graph`. */
function readsFor(graph: typeof SMALL, query: (nav: LoadedNav) => unknown): number {
  graph.reset()
  query(graph.nav)
  return graph.reads()
}

describe('a path query is one table read', () => {
  const cases: readonly [string, (nav: LoadedNav) => unknown][] = [
    ['nextHop', (nav) => nextHop(nav, 0, nav.nodeCount - 1)],
    ['routeCost', (nav) => routeCost(nav, 0, nav.nodeCount - 1)],
    ['canSee', (nav) => canSee(nav, 0, nav.nodeCount - 1)],
    ['hopKind', (nav) => hopKind(nav, 0, 1)],
  ]

  for (const [name, query] of cases) {
    it(`${name} reads the table exactly once`, () => {
      expect(readsFor(SMALL, query)).toBe(1)
    })

    it(`${name} reads the same number of times whatever the graph size`, () => {
      // The whole point. Four nodes and seventy nodes, same work: there is
      // nothing here that walks the graph.
      expect(readsFor(LARGE, query)).toBe(readsFor(SMALL, query))
    })
  }
})

describe('navPath walks the answer rather than searching for it', () => {
  it('reads once per node on the route, and not once more', () => {
    const out: number[] = []
    const reads = readsFor(LARGE, (nav) => navPath(nav, 0, nav.nodeCount - 1, out))
    expect(out.length).toBe(70)
    expect(reads).toBe(out.length)
  })

  it('hands back the whole chain, in order', () => {
    const out: number[] = []
    expect(navPath(SMALL.nav, 0, 3, out)).toBe(4)
    expect(out).toEqual([0, 1, 2, 3])
  })

  it('is empty when there is no route', () => {
    const orphaned = chainNav(3)
    const out: number[] = []
    // Node 0 and node 2 are connected in a chain, so ask for something that is
    // not there at all: an index past the end has no row and no route.
    expect(navPath(orphaned, 0, 99, out)).toBe(0)
    expect(out).toEqual([])
  })
})

describe('the answers themselves', () => {
  it('step towards the destination one node at a time', () => {
    expect(nextHop(SMALL.nav, 0, 3)).toBe(1)
    expect(nextHop(SMALL.nav, 3, 0)).toBe(2)
    expect(nextHop(SMALL.nav, 2, 2)).toBe(2)
  })

  it('report Infinity rather than a sentinel when there is no route', () => {
    expect(routeCost(SMALL.nav, 0, 99)).toBe(Infinity)
    expect(nextHop(SMALL.nav, 0, 99)).toBe(NO_NODE)
  })

  it('name the traversal for a hop, and nothing for a pair that is not one', () => {
    expect(hopKind(SMALL.nav, 0, 1)).toBe('walk')
    expect(hopKind(SMALL.nav, 0, 3)).toBe(null)
  })
})

/* --------------------------------------------------------------------------
 * Getting on to the graph
 * ----------------------------------------------------------------------- */

describe('nodeNear', () => {
  const map = fixtureMap()
  const outcome = bakeNav(fixtureNav(), map)
  if (!outcome.ok) throw new Error('the fixture graph should bake')
  const nav = loadNav(JSON.parse(JSON.stringify(outcome.baked)), map.hash)

  it('finds the node a player is standing on', () => {
    const at = nodeIndexOf(nav, 'north')
    const origin: [number, number, number] = [0, 0, 0]
    nodeOrigin(nav, at, origin)
    expect(nodeNear(nav, origin)).toBe(at)
  })

  it('finds the nearest node from a step away', () => {
    expect(nodeNear(nav, [-500, 30, 0])).toBe(nodeIndexOf(nav, 'a'))
  })

  it('says so when there is nothing near, rather than widening the search', () => {
    // Widening would be a search, and "the graph does not describe where I am"
    // is a real answer a bot can act on.
    expect(nodeNear(nav, [0, -900, 0])).toBe(NO_NODE)
  })
})
