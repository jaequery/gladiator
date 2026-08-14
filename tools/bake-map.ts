/**
 * `pnpm map:bake` — compile `maps/*.ts` to `maps/baked/*.json`.
 *
 * Three jobs, in this order and no other:
 *
 *   1. **compile** — import the TypeScript map and normalise it to exactly the
 *      schema fields, so no stray property an author left behind can reach a
 *      loader or change a hash
 *   2. **validate** — `validateMap`, which is the sim's, not the baker's. A rule
 *      that lived here would protect only maps that came through here
 *   3. **hash** — fold the normalised content into eight hex digits the client
 *      and the server compare at the handshake
 *
 * The artifacts are committed. That is what lets `pnpm build` and a Vercel
 * deploy work without a bake step in front of them, and `tools/bake-map.test.ts`
 * re-bakes in memory and fails if what is committed is stale — so the tree
 * cannot quietly hold a map nobody can reproduce.
 *
 * Usage:
 *
 *     pnpm map:bake            bake every map, write the artifacts
 *     pnpm map:bake --check    verify the committed artifacts, write nothing
 */

import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  MAP_FORMAT_VERSION,
  TECHNIQUES,
  type BakedMap,
  type MapDiagnostic,
  type MapSource,
  analyzeReachability,
  formatDiagnostics,
  mapHashOf,
  parseMapSource,
  validateMap,
} from '@gladiator/sim'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** Where maps are authored. */
export const MAPS_DIR = join(ROOT, 'maps')

/** Where the baked artifacts go. Committed, not generated at build time. */
export const BAKED_DIR = join(MAPS_DIR, 'baked')

/** Files under `maps/` that are not maps. */
const NOT_A_MAP = new Set(['helpers.ts'])

export type BakeOutcome =
  | { readonly ok: true; readonly baked: BakedMap; readonly json: string }
  | { readonly ok: false; readonly diagnostics: readonly MapDiagnostic[] }

/* --------------------------------------------------------------------------
 * The bake itself — pure, so the tests can drive it without a filesystem
 * ----------------------------------------------------------------------- */

/**
 * Normalise, validate and hash one map.
 *
 * Normalising *before* validating matters: `parseMapSource` is the same parser
 * a client runs over the artifact, so a map that validates here is a map that
 * survives the round trip, rather than one that happened to be fine in the
 * shape the author's helper produced.
 */
export function bake(source: MapSource): BakeOutcome {
  const normalised = parseMapSource(source)
  const diagnostics = validateMap(normalised)
  if (diagnostics.length > 0) return { ok: false, diagnostics }

  const baked: BakedMap = {
    format: MAP_FORMAT_VERSION,
    hash: mapHashOf(normalised),
    map: normalised,
  }
  return { ok: true, baked, json: serialize(baked) }
}

/* --------------------------------------------------------------------------
 * Serialisation
 *
 * `JSON.stringify(x, null, 2)` would put every coordinate of every brush on its
 * own line and turn a hundred-brush map into four thousand of them, which makes
 * a diff useless and a review impossible. So: one line per brush, per spawn,
 * per surface, and a vector stays a vector.
 * ----------------------------------------------------------------------- */

/** How wide a rendered *value* may get before it is broken across lines. */
const LINE_BUDGET = 100

function inlineJson(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) {
    const parts = value.map(inlineJson)
    if (parts.some((p) => p === null)) return null
    return `[${parts.join(', ')}]`
  }
  const parts: string[] = []
  for (const [key, item] of Object.entries(value)) {
    const rendered = inlineJson(item)
    if (rendered === null) return null
    parts.push(`${JSON.stringify(key)}: ${rendered}`)
  }
  return `{ ${parts.join(', ')} }`
}

function renderJson(value: unknown, indent: string): string {
  const inline = inlineJson(value)
  if (inline !== null && indent.length + inline.length <= LINE_BUDGET) return inline

  const inner = `${indent}  `
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map((item) => `${inner}${renderJson(item, inner)}`)
    return `[\n${items.join(',\n')}\n${indent}]`
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
    if (entries.length === 0) return '{}'
    const items = entries.map(
      ([key, item]) => `${inner}${JSON.stringify(key)}: ${renderJson(item, inner)}`,
    )
    return `{\n${items.join(',\n')}\n${indent}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** A baked map as the bytes that go on disk. Stable: same map, same file. */
export function serialize(baked: BakedMap): string {
  return `${renderJson(baked, '')}\n`
}

/* --------------------------------------------------------------------------
 * The filesystem half
 * ----------------------------------------------------------------------- */

/** Every authored map under `maps/`, by name, sorted. */
export function discoverMaps(dir: string = MAPS_DIR): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts') && !NOT_A_MAP.has(file))
    .sort()
}

/** Import an authored map and hand back its default export. */
async function importMap(file: string): Promise<MapSource> {
  const module: unknown = await import(pathToFileURL(file).href)
  const exported = (module as { default?: unknown }).default
  if (exported === undefined) {
    throw new Error(`gladiator: ${file} has no default export — a map file exports defineMap({...}).`)
  }
  return exported as MapSource
}

/** Where a map's artifact lives. */
export function bakedPathFor(name: string): string {
  return join(BAKED_DIR, `${name.replace(/\.ts$/, '')}.json`)
}

export type BakeReport = {
  readonly name: string
  readonly path: string
  readonly outcome: BakeOutcome
  /** `write` mode: whether the file on disk changed. `check` mode: whether it is stale. */
  readonly changed: boolean
}

/**
 * Bake every map in `maps/`.
 *
 * In `check` mode nothing is written and `changed` means "the committed
 * artifact does not match what this source bakes to" — the thing CI asks.
 */
export async function bakeAll(mode: 'write' | 'check'): Promise<BakeReport[]> {
  const reports: BakeReport[] = []

  for (const file of discoverMaps()) {
    const name = file.replace(/\.ts$/, '')
    const path = bakedPathFor(name)
    const source = await importMap(join(MAPS_DIR, file))
    const outcome = bake(source)

    if (!outcome.ok) {
      reports.push({ name, path, outcome, changed: false })
      continue
    }

    const existing = existsSync(path) ? readFileSync(path, 'utf8') : null
    const changed = existing !== outcome.json
    if (changed && mode === 'write') {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, outcome.json, 'utf8')
    }
    reports.push({ name, path, outcome, changed })
  }

  return reports
}

/* --------------------------------------------------------------------------
 * CLI
 * ----------------------------------------------------------------------- */

export async function main(argv: readonly string[]): Promise<number> {
  const mode = argv.includes('--check') ? 'check' : 'write'
  const reports = await bakeAll(mode)

  if (reports.length === 0) {
    console.error(`gladiator: no maps found in ${MAPS_DIR}`)
    return 1
  }

  let failed = false
  for (const report of reports) {
    if (!report.outcome.ok) {
      failed = true
      console.error(`✗ ${report.name} — ${report.outcome.diagnostics.length} problem(s):`)
      console.error(formatDiagnostics(report.outcome.diagnostics))
      continue
    }

    const { baked } = report.outcome
    const solid = baked.map.brushes.filter((b) => b.nonSolid !== true).length
    const summary = `${baked.map.brushes.length} brushes (${solid} solid), ${baked.map.spawns.length} spawns, hash ${baked.hash}`

    if (mode === 'check') {
      if (report.changed) {
        failed = true
        console.error(`✗ ${report.name} — ${report.path} is stale. Run pnpm map:bake.`)
      } else {
        console.log(`· ${report.name} — up to date, hash ${baked.hash}`)
      }
      continue
    }

    console.log(`${report.changed ? '✓' : '·'} ${report.name} — ${summary}`)
    console.log(`    ${ledgeSummary(baked.map)}`)
  }

  return failed ? 1 : 0
}

/**
 * How a player gets around this map, in one line.
 *
 * `validateMap` has already refused anything unreachable, so this is not a
 * check — it is the level design, printed. A map whose line says every ledge is
 * a step is a flat box, and a map that grows a jump-plus-rocket nobody meant to
 * author says so in a diff of the bake output.
 */
function ledgeSummary(map: MapSource): string {
  const analysis = analyzeReachability(map)
  const counted = TECHNIQUES.slice(1)
    .map((t) => `${analysis.ledges.filter((l) => l.technique === t.key).length} x ${t.label}`)
    .join(', ')
  return `ledges: ${counted}; tallest step ${Math.round(analysis.tallestStep)}`
}

// Only when run as a program. `tools/bake-map.test.ts` imports the functions
// above and must not trip the CLI on the way in.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (cause: unknown) => {
      console.error(`gladiator: the bake threw — ${String(cause)}`)
      process.exitCode = 1
    },
  )
}
