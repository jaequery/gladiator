/**
 * `pnpm assets:build` — turn the authored sources under `assets/` into the
 * files the game loads out of `packages/client/public/`.
 *
 * Three jobs, in this order:
 *
 *   1. **credit** — read `credits.json`, reject a licence this project may not
 *      ship, and check that every committed asset is accounted for by an entry
 *   2. **compress** — PNG to KTX2 by texture class, glTF through meshopt with
 *      its textures repointed at the compressed ones
 *   3. **generate** — `CREDITS.md` and the machine-readable credits the credits
 *      screen fetches, both from the registry, so they cannot drift from it
 *
 * The artifacts are committed, for the same reason `maps/baked/*.json` are: a
 * build, a Vercel deploy and a fresh clone all work without an encode step in
 * front of them. `--check` re-runs the whole thing in memory and fails if what
 * is committed is not what these sources produce.
 *
 * Usage:
 *
 *     pnpm assets:build            build everything, write the artifacts
 *     pnpm assets:build --check    verify the committed artifacts, write nothing
 *
 * The Basis encoder prints its own progress to stdout. That is the encoder
 * talking, not this script, and there is no flag on it to ask it not to.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { buildArtifacts, checkCoverage, watchedDirectories } from './assets/build.ts'
import type { Artifact } from './assets/build.ts'
import { CREDITS_SOURCE, ROOT, abs } from './assets/plan.ts'
import { parseCredits } from './assets/registry.ts'

/** Committed files under the watched directories, repo-relative and sorted. */
export function committedAssets(): string[] {
  const out = execFileSync('git', ['ls-files', '-z', '--', ...watchedDirectories()], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return out
    .split('\0')
    .filter((path) => path.length > 0)
    .sort()
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

function report(artifact: Artifact, state: string): string {
  return `  ${state.padEnd(9)} ${artifact.path}  (${artifact.note})`
}

async function main(): Promise<number> {
  const check = process.argv.includes('--check')

  const credits = parseCredits(readFileSync(abs(CREDITS_SOURCE), 'utf8'))
  const { plan, artifacts } = await buildArtifacts(credits)

  const coverage = checkCoverage(plan, committedAssets())
  if (coverage.length > 0) {
    process.stderr.write(`\ngladiator: credits.json does not account for everything:\n`)
    for (const problem of coverage) process.stderr.write(`  - ${problem}\n`)
    return 1
  }

  const stale: string[] = []
  const lines: string[] = []

  for (const artifact of artifacts) {
    const path = abs(artifact.path)
    const existing = existsSync(path) ? new Uint8Array(readFileSync(path)) : null
    const changed = existing === null || !sameBytes(existing, artifact.bytes)

    if (!changed) {
      lines.push(report(artifact, 'unchanged'))
      continue
    }
    if (check) {
      stale.push(artifact.path)
      lines.push(report(artifact, existing === null ? 'missing' : 'stale'))
      continue
    }
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, artifact.bytes)
    lines.push(report(artifact, existing === null ? 'created' : 'written'))
  }

  process.stdout.write(`\ngladiator: ${check ? 'checking' : 'building'} assets\n`)
  for (const line of lines) process.stdout.write(`${line}\n`)

  if (stale.length > 0) {
    process.stderr.write(
      `\ngladiator: ${stale.length} committed artifact${stale.length === 1 ? ' is' : 's are'} not what these sources build to:\n`,
    )
    for (const path of stale) process.stderr.write(`  - ${path}\n`)
    process.stderr.write(`\nRun \`pnpm assets:build\` and commit the result.\n`)
    return 1
  }

  process.stdout.write(`\n${artifacts.length} artifacts, ${check ? 'all current' : 'written'}.\n`)
  return 0
}

// Only when run as a program. `tools/assets-build.test.ts` imports
// `committedAssets` and must not trip the CLI on the way in.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await main()
}
