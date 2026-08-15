/**
 * A map and a graph to perturb one rule at a time.
 *
 * The nav tests cannot reach `maps/` — `packages/bot`'s `rootDir` is `./src`
 * and reaching sideways into repo-level content is a `TS6059`, which is the
 * boundary working rather than getting in the way. So the fixture is built here
 * out of the sim's own primitives, the same way `packages/sim/src/fixtures`
 * does it, and `maps/arena1.nav.test.ts` is where the *real* arena is asserted.
 *
 * The map is a big floor with four things in it, each of which exists to make
 * exactly one rule expressible:
 *
 * | Feature      | The rule it lets a test reach                 |
 * | ------------ | --------------------------------------------- |
 * | a square pit | a `walk` link with no floor under the middle  |
 * | a 128 pillar | a node inside solid, and a climb no jump makes |
 * | a 48 block   | a rise no step gets up, and a drop that climbs |
 * | two spawns   | the spawn-coverage rules, both directions      |
 */

import { mapHashOf, loadMap } from '@gladiator/sim'
import type { LoadedMap, MapSource, Vec3 } from '@gladiator/sim'

import type { NavLink, NavNode, NavSource, NavTag } from './schema.ts'

function box(mins: Vec3, maxs: Vec3): MapSource['brushes'][number] {
  return { kind: 'box', surface: 'shell', mins, maxs }
}

/** The fixture map, as a `MapSource`. */
export const FIXTURE_MAP: MapSource = {
  name: 'fixture',
  title: 'Fixture',
  author: 'test',
  surfaces: [{ name: 'shell', material: 'concrete', tint: [1, 1, 1] }],
  brushes: [
    // The floor, in four pieces, leaving a 128-unit hole in the middle.
    box([-1024, -1024, -64], [1024, -64, 0]),
    box([-1024, 64, -64], [1024, 1024, 0]),
    box([-1024, -64, -64], [-64, 64, 0]),
    box([64, -64, -64], [1024, 64, 0]),
    // The lid, so every node is inside a sealed volume.
    box([-1024, -1024, 512], [1024, 1024, 576]),
    // A pillar 128 tall, and a block 48 tall.
    box([-64, -320, 0], [64, -192, 128]),
    box([128, -256, 0], [256, -128, 48]),
  ],
  spawns: [
    { origin: [-512, 0, 0], yaw: 0 },
    { origin: [512, 0, 0], yaw: 32768 },
  ],
  lights: [],
  props: [],
}

/** The fixture map, loaded and ready to trace against. */
export function fixtureMap(): LoadedMap {
  return loadMap({ format: 1, hash: mapHashOf(FIXTURE_MAP), map: FIXTURE_MAP })
}

function node(id: string, origin: Vec3, ...tags: readonly NavTag[]): NavNode {
  return { id, origin, tags }
}

function walk(a: string, b: string): NavLink[] {
  return [
    { from: a, to: b, kind: 'walk' },
    { from: b, to: a, kind: 'walk' },
  ]
}

/**
 * A graph the bake accepts: three nodes in a line, going round the pit.
 *
 * Small enough that a routing table can be checked by hand, and big enough that
 * `a -> b` has a middle to have a next hop through.
 */
export function fixtureNav(over: Partial<NavSource> = {}): NavSource {
  return {
    map: 'fixture',
    nodes: [
      node('a', [-512, 0, 0], 'ground', 'spawn'),
      node('b', [512, 0, 0], 'ground', 'spawn'),
      node('north', [0, 320, 0], 'ground'),
    ],
    links: [...walk('a', 'north'), ...walk('north', 'b')],
    ...over,
  }
}

/** The fixture graph with extra nodes and links bolted on. */
export function fixtureNavWith(
  nodes: readonly NavNode[],
  links: readonly NavLink[],
): NavSource {
  const base = fixtureNav()
  return { map: base.map, nodes: [...base.nodes, ...nodes], links: [...base.links, ...links] }
}

export { node as fixtureNode, walk as fixtureWalk }
