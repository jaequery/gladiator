/**
 * Loading a baked nav graph, and the two hashes that prove it is the right one.
 *
 * The shape of this file is `map/load.ts`'s, deliberately and almost line for
 * line, because it is solving the same problem one layer up: JSON arrives as an
 * `unknown`, the types say `Vec3` and `'walk' | 'jump'`, and somewhere that gap
 * has to be closed by looking.
 *
 * ## Two hashes, not one
 *
 * `hash` covers the authored graph, and catches an artifact somebody edited by
 * hand at 2am rather than re-baking.
 *
 * `mapHash` covers the *map the graph was baked against*, and catches the much
 * more likely thing: a brush moved, the map re-baked, and the nav graph did
 * not. Every claim in a nav graph is a claim about geometry — this point is
 * standable, that edge is a 48-unit drop, these two nodes can see each other —
 * and all of them expire the instant the geometry does. Without this the bot
 * routes confidently into a wall that used to be a doorway, and the symptom
 * looks like a pathfinding bug.
 *
 * ## The tables become typed arrays, once
 *
 * `loadNav` unpacks the JSON's plain arrays into `Int32Array`s and derives the
 * two tables that are cheaper to rebuild than to store — which node is
 * `ground`, and the kind of the direct link between each ordered pair. The
 * derived pair costs one pass over the links; storing them would cost a
 * thousand lines of committed JSON that can disagree with the links above them.
 */

import {
  formatHash,
  hashFloat64,
  hashInit,
  hashString,
  hashUint32,
} from '@gladiator/sim'
import type { Vec3 } from '@gladiator/sim'

import {
  NAV_FORMAT_VERSION,
  NAV_LINK_KINDS,
  NAV_TAGS,
  NO_NODE,
  type BakedNav,
  type NavGrid,
  type NavLink,
  type NavLinkKind,
  type NavNode,
  type NavRoutes,
  type NavSource,
  type NavTag,
  type NavVisibility,
} from './schema.ts'

/* --------------------------------------------------------------------------
 * The hash
 * ----------------------------------------------------------------------- */

/** Fold a string in, length first — see `map/load.ts` for why the length. */
function foldText(digest: number, text: string): number {
  return hashString(text, hashUint32(digest, text.length))
}

function foldPoint(digest: number, v: readonly number[]): number {
  let next = digest
  for (const n of v) next = hashFloat64(next, n)
  return next
}

/**
 * The content hash of a nav graph, as a uint32.
 *
 * Over the *authored* graph only — the nodes and the links. The routing tables,
 * the visibility bitset and the locate grid are all functions of those plus the
 * map, so hashing them as well would say nothing the two hashes here do not
 * already say, and would make the digest depend on the order Floyd-Warshall
 * happened to relax its edges in.
 */
export function hashNavSource(nav: NavSource): number {
  let d = hashUint32(hashInit(), NAV_FORMAT_VERSION)
  d = foldText(d, nav.map)

  d = hashUint32(d, nav.nodes.length)
  for (const node of nav.nodes) {
    d = foldText(d, node.id)
    d = foldPoint(d, node.origin)
    d = hashUint32(d, node.tags.length)
    for (const tag of node.tags) d = foldText(d, tag)
  }

  d = hashUint32(d, nav.links.length)
  for (const link of nav.links) {
    d = foldText(d, link.from)
    d = foldText(d, link.to)
    d = foldText(d, link.kind)
  }

  return d >>> 0
}

/** The eight hex digits that go in the artifact. */
export function navHashOf(nav: NavSource): string {
  return formatHash(hashNavSource(nav))
}

/* --------------------------------------------------------------------------
 * The parser
 * ----------------------------------------------------------------------- */

function fail(where: string, detail: string): never {
  throw new Error(`gladiator: ${where}: ${detail}`)
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(where, 'expected an object')
  }
  return value as Record<string, unknown>
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(where, 'expected an array')
  return value
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(where, 'expected a string')
  return value
}

function number(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, 'expected a finite number')
  return value
}

function integer(value: unknown, where: string): number {
  const n = number(value, where)
  if (!Number.isInteger(n)) fail(where, 'expected an integer')
  return n
}

function integers(value: unknown, where: string): number[] {
  return array(value, where).map((n, i) => integer(n, `${where}[${i}]`))
}

function triple(value: unknown, where: string): Vec3 {
  const items = array(value, where)
  if (items.length !== 3) fail(where, `expected three numbers, got ${items.length}`)
  return [
    number(items[0], `${where}[0]`),
    number(items[1], `${where}[1]`),
    number(items[2], `${where}[2]`),
  ]
}

function parseNode(value: unknown, where: string): NavNode {
  const raw = record(value, where)
  const tags = array(raw['tags'], `${where}.tags`).map((tag, i) => {
    const name = text(tag, `${where}.tags[${i}]`)
    if (!NAV_TAGS.includes(name as NavTag)) {
      fail(`${where}.tags[${i}]`, `expected one of ${NAV_TAGS.join(', ')}, got "${name}"`)
    }
    return name as NavTag
  })
  return { id: text(raw['id'], `${where}.id`), origin: triple(raw['origin'], `${where}.origin`), tags }
}

function parseLink(value: unknown, where: string): NavLink {
  const raw = record(value, where)
  const kind = text(raw['kind'], `${where}.kind`)
  if (!NAV_LINK_KINDS.includes(kind as NavLinkKind)) {
    fail(`${where}.kind`, `expected one of ${NAV_LINK_KINDS.join(', ')}, got "${kind}"`)
  }
  return {
    from: text(raw['from'], `${where}.from`),
    to: text(raw['to'], `${where}.to`),
    kind: kind as NavLinkKind,
  }
}

/** Parse a `NavSource` out of whatever JSON handed us. Throws on anything else. */
export function parseNavSource(value: unknown, where = 'nav'): NavSource {
  const raw = record(value, where)
  return {
    map: text(raw['map'], `${where}.map`),
    nodes: array(raw['nodes'], `${where}.nodes`).map((n, i) => parseNode(n, `${where}.nodes[${i}]`)),
    links: array(raw['links'], `${where}.links`).map((l, i) => parseLink(l, `${where}.links[${i}]`)),
  }
}

function parseRoutes(value: unknown, where: string, count: number): NavRoutes {
  const raw = record(value, where)
  const nextHop = integers(raw['nextHop'], `${where}.nextHop`)
  const cost = integers(raw['cost'], `${where}.cost`)
  const wanted = count * count
  if (nextHop.length !== wanted || cost.length !== wanted) {
    fail(
      where,
      `${count} nodes need ${wanted} entries in each table; got ${nextHop.length} next-hops and ${cost.length} costs.`,
    )
  }
  return { nextHop, cost }
}

function parseVisibility(value: unknown, where: string, count: number): NavVisibility {
  const raw = record(value, where)
  const words = integer(raw['words'], `${where}.words`)
  const bits = integers(raw['bits'], `${where}.bits`)
  if (words !== wordsFor(count) || bits.length !== count * words) {
    fail(where, `${count} nodes need ${wordsFor(count)} words per row and ${count * wordsFor(count)} in total.`)
  }
  return { words, bits }
}

function parseGrid(value: unknown, where: string): NavGrid {
  const raw = record(value, where)
  const grid: NavGrid = {
    cell: integer(raw['cell'], `${where}.cell`),
    minX: integer(raw['minX'], `${where}.minX`),
    minY: integer(raw['minY'], `${where}.minY`),
    nx: integer(raw['nx'], `${where}.nx`),
    ny: integer(raw['ny'], `${where}.ny`),
    cellStart: integers(raw['cellStart'], `${where}.cellStart`),
    cellNodes: integers(raw['cellNodes'], `${where}.cellNodes`),
  }
  if (grid.cellStart.length !== grid.nx * grid.ny + 1) {
    fail(`${where}.cellStart`, `a ${grid.nx}x${grid.ny} grid needs ${grid.nx * grid.ny + 1} offsets.`)
  }
  return grid
}

/** Parse a baked artifact. Checks the format version; does not check either hash. */
export function parseBakedNav(value: unknown): BakedNav {
  const raw = record(value, 'baked nav')
  const format = integer(raw['format'], 'baked nav.format')
  if (format !== NAV_FORMAT_VERSION) {
    fail(
      'baked nav.format',
      `this build reads nav format ${NAV_FORMAT_VERSION} and the artifact is format ${format}. Re-run pnpm nav:bake.`,
    )
  }
  const hash = text(raw['hash'], 'baked nav.hash')
  const mapHash = text(raw['mapHash'], 'baked nav.mapHash')
  for (const [digest, name] of [
    [hash, 'baked nav.hash'],
    [mapHash, 'baked nav.mapHash'],
  ] as const) {
    if (!/^[0-9a-f]{8}$/.test(digest)) fail(name, 'expected eight lowercase hex digits')
  }

  const nav = parseNavSource(raw['nav'], 'baked nav.nav')
  return {
    format,
    hash,
    mapHash,
    nav,
    routes: parseRoutes(raw['routes'], 'baked nav.routes', nav.nodes.length),
    visibility: parseVisibility(raw['visibility'], 'baked nav.visibility', nav.nodes.length),
    grid: parseGrid(raw['grid'], 'baked nav.grid'),
  }
}

/* --------------------------------------------------------------------------
 * The loaded graph
 * ----------------------------------------------------------------------- */

/** Uint32s a row of the visibility bitset needs. */
export function wordsFor(nodeCount: number): number {
  return Math.max(1, Math.ceil(nodeCount / 32))
}

/** A nav graph, ready to route on. Immutable, and indexed rather than searched. */
export type LoadedNav = {
  readonly source: NavSource
  readonly hash: string
  readonly mapHash: string
  readonly nodeCount: number
  /** Node ids, in index order. */
  readonly ids: readonly string[]
  /** Id to index. The one place a lookup is by name rather than by number. */
  readonly index: ReadonlyMap<string, number>
  /** Snapped origins, flattened: node `i` is `origins[i * 3 .. i * 3 + 2]`. */
  readonly origins: Float64Array
  /** 1 where the node is `ground`-tagged. */
  readonly ground: Uint8Array
  /** `n * n`, indexed `from * n + to`. -1 where there is no route. */
  readonly nextHop: Int32Array
  /** `n * n`, indexed `from * n + to`. -1 where there is no route. */
  readonly cost: Int32Array
  /**
   * `n * n`, indexed `from * n + to`: the index into {@link NAV_LINK_KINDS} of
   * the direct link between the pair, or {@link NO_NODE}.
   *
   * This is how a bot that has been told to move to `nextHop` finds out *how*
   * — which traversal controller to hand the hop to. Derived at load rather
   * than stored, because it is one pass over the links and a stored copy is a
   * copy that can disagree with them.
   */
  readonly linkKind: Int8Array
  readonly visWords: number
  readonly vis: Uint32Array
  readonly grid: LoadedNavGrid
}

/** The locate grid, unpacked. */
export type LoadedNavGrid = {
  readonly cell: number
  readonly minX: number
  readonly minY: number
  readonly nx: number
  readonly ny: number
  readonly cellStart: Int32Array
  readonly cellNodes: Int32Array
}

/**
 * Parse, verify against the map it claims, and unpack.
 *
 * `mapHash` is the hash of the map the caller has actually loaded — pass
 * `LoadedMap.hash`. There is no way to skip it, which is the point.
 */
export function loadNav(value: unknown, mapHash: string): LoadedNav {
  const baked = parseBakedNav(value)
  const computed = navHashOf(baked.nav)
  if (computed !== baked.hash) {
    fail(
      `nav graph for "${baked.nav.map}"`,
      `its contents hash to ${computed} and it claims ${baked.hash}. The artifact has been edited by hand, or written by a different build. Re-run pnpm nav:bake.`,
    )
  }
  if (baked.mapHash !== mapHash) {
    fail(
      `nav graph for "${baked.nav.map}"`,
      `it was baked against map ${baked.mapHash} and the loaded map is ${mapHash}. Every node in a nav graph is a claim about where the geometry is; the geometry has moved. Re-run pnpm nav:bake.`,
    )
  }

  const nodes = baked.nav.nodes
  const n = nodes.length
  const ids: string[] = []
  const index = new Map<string, number>()
  const origins = new Float64Array(n * 3)
  const ground = new Uint8Array(n)

  for (let i = 0; i < n; i += 1) {
    const node = nodes[i]
    if (node === undefined) continue
    ids.push(node.id)
    index.set(node.id, i)
    origins[i * 3] = node.origin[0]
    origins[i * 3 + 1] = node.origin[1]
    origins[i * 3 + 2] = node.origin[2]
    ground[i] = node.tags.includes('ground') ? 1 : 0
  }

  const linkKind = new Int8Array(n * n).fill(NO_NODE)
  for (const link of baked.nav.links) {
    const from = index.get(link.from)
    const to = index.get(link.to)
    if (from === undefined || to === undefined) {
      fail(`nav graph for "${baked.nav.map}"`, `link ${link.from} -> ${link.to} names a node that is not in the graph.`)
    }
    linkKind[from * n + to] = NAV_LINK_KINDS.indexOf(link.kind)
  }

  return {
    source: baked.nav,
    hash: baked.hash,
    mapHash: baked.mapHash,
    nodeCount: n,
    ids,
    index,
    origins,
    ground,
    nextHop: Int32Array.from(baked.routes.nextHop),
    cost: Int32Array.from(baked.routes.cost),
    linkKind,
    visWords: baked.visibility.words,
    vis: Uint32Array.from(baked.visibility.bits),
    grid: {
      cell: baked.grid.cell,
      minX: baked.grid.minX,
      minY: baked.grid.minY,
      nx: baked.grid.nx,
      ny: baked.grid.ny,
      cellStart: Int32Array.from(baked.grid.cellStart),
      cellNodes: Int32Array.from(baked.grid.cellNodes),
    },
  }
}
