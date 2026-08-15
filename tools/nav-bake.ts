/**
 * `pnpm nav:bake` — compile `maps/*.nav.ts` to `maps/baked/*.nav.json`.
 *
 * The same three jobs as `tools/bake-map.ts`, in the same order and no other:
 *
 *   1. **compile** — import the TypeScript graph and normalise it to exactly
 *      the schema fields, so no stray property an author left behind can reach
 *      the bot or change a hash
 *   2. **validate** — against the *baked map*, with the real trace and the real
 *      player box. Every rule lives in `packages/bot/src/nav/validate.ts`
 *      rather than here, for the same reason the map's live in the sim: a rule
 *      enforced by the baker alone protects only graphs that came through it
 *   3. **precompute** — all-pairs next-hop and cost, the visibility bitset and
 *      the locate grid, folded into an artifact the bot only ever indexes into
 *
 * A nav graph is baked against a *map that has already been baked*, and the
 * map's hash goes into the artifact. That ordering is not incidental: the graph
 * is a set of claims about where the geometry is, and the only geometry worth
 * checking them against is the one the game will load.
 *
 * The artifacts are committed, so `pnpm build` needs no bake step in front of
 * it, and `tools/nav-bake.test.ts` re-bakes in memory and fails if what is
 * committed is stale.
 *
 * Usage:
 *
 *     pnpm nav:bake            bake every graph, write the artifacts
 *     pnpm nav:bake --check    verify the committed artifacts, write nothing
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  NAV_LINK_KINDS,
  bakeNav,
  formatNavDiagnostics,
  type BakedNav,
  type NavDiagnostic,
  type NavSource,
} from '@gladiator/bot'
import { loadMap } from '@gladiator/sim'
import type { LoadedMap } from '@gladiator/sim'

import { serializeJson } from './json.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Where nav graphs are authored, beside the maps they are for. */
export const MAPS_DIR = join(ROOT, 'maps')

/** Where the baked artifacts go. Committed, not generated at build time. */
export const BAKED_DIR = join(MAPS_DIR, 'baked')

export type NavBakeReport = {
  readonly name: string
  readonly path: string
  readonly baked: BakedNav | null
  readonly diagnostics: readonly NavDiagnostic[]
  /** `write` mode: whether the file on disk changed. `check` mode: whether it is stale. */
  readonly changed: boolean
}

/** Every authored nav graph under `maps/`, by map name, sorted. */
export function discoverNavGraphs(dir: string = MAPS_DIR): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.nav.ts') && !file.endsWith('.test.ts'))
    .map((file) => file.replace(/\.nav\.ts$/, ''))
    .sort()
}

/** Where a graph's artifact lives. */
export function bakedNavPathFor(name: string): string {
  return join(BAKED_DIR, `${name}.nav.json`)
}

/** Import an authored graph and hand back its default export. */
async function importNav(file: string): Promise<NavSource> {
  const module: unknown = await import(pathToFileURL(file).href)
  const exported = (module as { default?: unknown }).default
  if (exported === undefined) {
    throw new Error(`gladiator: ${file} has no default export — a nav file exports defineNav({...}).`)
  }
  return exported as NavSource
}

/** Load the baked map a graph is for. Throws if it has not been baked yet. */
export function loadBakedMap(name: string): LoadedMap {
  const path = join(BAKED_DIR, `${name}.json`)
  if (!existsSync(path)) {
    throw new Error(
      `gladiator: ${path} does not exist. A nav graph is baked against a baked map — run pnpm map:bake first.`,
    )
  }
  return loadMap(JSON.parse(readFileSync(path, 'utf8')))
}

/**
 * Bake every nav graph in `maps/`.
 *
 * In `check` mode nothing is written and `changed` means "the committed
 * artifact does not match what this source bakes to" — the thing CI asks.
 */
export async function bakeAllNav(mode: 'write' | 'check'): Promise<NavBakeReport[]> {
  const reports: NavBakeReport[] = []

  for (const name of discoverNavGraphs()) {
    const path = bakedNavPathFor(name)
    const source = await importNav(join(MAPS_DIR, `${name}.nav.ts`))
    const outcome = bakeNav(source, loadBakedMap(name))

    if (!outcome.ok) {
      reports.push({ name, path, baked: null, diagnostics: outcome.diagnostics, changed: false })
      continue
    }

    const json = serializeJson(outcome.baked)
    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
    const changed = existing !== json
    if (changed && mode === 'write') {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, json, 'utf8')
    }
    reports.push({ name, path, baked: outcome.baked, diagnostics: [], changed })
  }

  return reports
}

/* --------------------------------------------------------------------------
 * CLI
 * ----------------------------------------------------------------------- */

/**
 * What the graph says about the arena, in two lines.
 *
 * The validator has already refused anything wrong, so this is not a check — it
 * is the level design, printed. A graph whose every link is a walk is a flat
 * box; one that grows a drop nobody meant to author says so in a diff of the
 * bake output. The visibility figure is the one worth watching: it is the
 * fraction of the arena that can shoot at the rest of it, and a duel map where
 * it climbs towards one is a map with nowhere to hide.
 */
function navSummary(baked: BakedNav): string[] {
  const nodes = baked.nav.nodes
  const ground = nodes.filter((n) => n.tags.includes('ground')).length
  const byKind = NAV_LINK_KINDS.map(
    (kind) => `${baked.nav.links.filter((l) => l.kind === kind).length} x ${kind}`,
  ).join(', ')

  let seen = 0
  for (const word of baked.visibility.bits) seen += popcount(word)
  const pairs = nodes.length * nodes.length
  const visible = pairs === 0 ? 0 : Math.round((100 * seen) / pairs)

  return [
    `${nodes.length} nodes (${ground} ground, ${nodes.length - ground} perch), ${baked.nav.links.length} links: ${byKind}`,
    `sees ${visible}% of node pairs; hash ${baked.hash} over map ${baked.mapHash}`,
  ]
}

function popcount(word: number): number {
  let n = word >>> 0
  let count = 0
  while (n !== 0) {
    n &= n - 1
    count += 1
  }
  return count
}

export async function main(argv: readonly string[]): Promise<number> {
  const mode = argv.includes('--check') ? 'check' : 'write'
  const reports = await bakeAllNav(mode)

  if (reports.length === 0) {
    console.error(`gladiator: no nav graphs found in ${MAPS_DIR}`)
    return 1
  }

  let failed = false
  for (const report of reports) {
    if (report.baked === null) {
      failed = true
      console.error(`✗ ${report.name} — ${report.diagnostics.length} problem(s):`)
      console.error(formatNavDiagnostics(report.diagnostics))
      continue
    }

    if (mode === 'check') {
      if (report.changed) {
        failed = true
        console.error(`✗ ${report.name} — ${report.path} is stale. Run pnpm nav:bake.`)
      } else {
        console.log(`· ${report.name} — up to date, hash ${report.baked.hash}`)
      }
      continue
    }

    console.log(`${report.changed ? '✓' : '·'} ${report.name}`)
    for (const line of navSummary(report.baked)) console.log(`    ${line}`)
  }

  return failed ? 1 : 0
}

// Only when run as a program. `tools/nav-bake.test.ts` imports the functions
// above and must not trip the CLI on the way in.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (cause: unknown) => {
      console.error(`gladiator: the nav bake threw — ${String(cause)}`)
      process.exitCode = 1
    },
  )
}
