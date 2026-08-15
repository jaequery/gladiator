/**
 * `pnpm assets:budget` — the size guard.
 *
 * Git has no forget. A 40 MB texture committed once and deleted in the next
 * commit is 40 MB in every clone of this repository forever, and the only fix
 * is a history rewrite that invalidates every fork and every open branch. So
 * the check has to be the thing that stops it going in, which means it has to
 * run in CI on the pull request rather than on anybody's good intentions.
 *
 * Two limits, because they catch different mistakes:
 *
 *   - **{@link MAX_FILE_BYTES} per file** catches the one that matters most —
 *     someone commits an uncompressed 4K PNG or a raw `.wav`, which is almost
 *     always a source file that should have been gitignored or an asset that
 *     never went through `pnpm assets:build`.
 *   - **{@link TOTAL_BUDGET_BYTES} across everything** catches the one nobody
 *     notices: fifty files of 900 KB, each individually reasonable.
 *
 * The check runs over `git ls-files`, not a directory walk. The question is
 * what this repository *ships*; a scratch file in a working tree is not that,
 * and using the index is what makes the answer identical on a contributor's
 * machine and on a clean CI checkout.
 *
 * ### When the budget is genuinely too small
 *
 * Raise it, once, in a commit that says what went in. And if the answer ever
 * approaches 50 MB, do not raise it again: move the baked assets to a release
 * tarball that a script fetches. **Not Git LFS** — LFS bandwidth is metered per
 * repository and the meter is charged to whoever owns it, so a public repo that
 * gets popular is one whose clones start failing for everyone at once.
 */

import { execFileSync } from 'node:child_process'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { PUBLIC_DIR, SOURCE_DIR, abs } from './assets/plan.ts'

/**
 * The per-file ceiling.
 *
 * 5 MB is far above anything this pipeline produces — the largest artifact in
 * the tree is a 455 KB transcoder — and far below anything that would be an
 * accident worth keeping. A file that trips it is a question, not a threshold
 * to nudge.
 */
export const MAX_FILE_BYTES = 5 * 1024 * 1024

/**
 * The total, across the authored sources and the shipped artifacts together.
 *
 * Both halves count. Sources are committed so that `pnpm assets:build --check`
 * can reproduce what ships, which is worth its bytes — and it is still bytes.
 */
export const TOTAL_BUDGET_BYTES = 24 * 1024 * 1024

/** Where a warning starts, so the ceiling is never the first anyone hears of it. */
export const WARN_AT = 0.75

/** Directories the budget covers. */
export const BUDGETED: readonly string[] = [SOURCE_DIR, PUBLIC_DIR]

export type Entry = { readonly path: string; readonly bytes: number }

export type Verdict = {
  readonly total: number
  /** Files over {@link MAX_FILE_BYTES}, largest first. */
  readonly oversized: readonly Entry[]
  readonly overBudget: boolean
  readonly nearBudget: boolean
  /** The biggest few, for the log — a budget nobody can see is a budget nobody manages. */
  readonly largest: readonly Entry[]
}

/** Pure, so the rules can be tested without a repository in a particular state. */
export function judge(entries: readonly Entry[]): Verdict {
  const total = entries.reduce((sum, entry) => sum + entry.bytes, 0)
  const bySize = [...entries].sort((a, b) => b.bytes - a.bytes)
  return {
    total,
    oversized: bySize.filter((entry) => entry.bytes > MAX_FILE_BYTES),
    overBudget: total > TOTAL_BUDGET_BYTES,
    nearBudget: total > TOTAL_BUDGET_BYTES * WARN_AT,
    largest: bySize.slice(0, 5),
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** Every committed file under the budgeted directories, with its size on disk. */
export function committedEntries(): Entry[] {
  const listed = execFileSync('git', ['ls-files', '-z', '--', ...BUDGETED], {
    cwd: abs('.'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  return listed
    .split('\0')
    .filter((path) => path.length > 0)
    .map((path) => ({ path, bytes: statSync(abs(path)).size }))
}

function main(): number {
  const entries = committedEntries()
  const verdict = judge(entries)

  process.stdout.write(
    `\ngladiator: ${entries.length} committed asset files, ${formatBytes(verdict.total)} of ${formatBytes(TOTAL_BUDGET_BYTES)}\n`,
  )
  for (const entry of verdict.largest) {
    process.stdout.write(`  ${formatBytes(entry.bytes).padStart(10)}  ${entry.path}\n`)
  }

  if (verdict.oversized.length > 0) {
    process.stderr.write(
      `\ngladiator: ${verdict.oversized.length} committed file(s) exceed the ${formatBytes(MAX_FILE_BYTES)} per-file limit:\n`,
    )
    for (const entry of verdict.oversized) {
      process.stderr.write(`  ${formatBytes(entry.bytes).padStart(10)}  ${entry.path}\n`)
    }
    process.stderr.write(
      `\nA file this big is usually a source that belongs in .gitignore, or an asset that never went through \`pnpm assets:build\`. See docs/assets.md.\n`,
    )
    return 1
  }

  if (verdict.overBudget) {
    process.stderr.write(
      `\ngladiator: committed assets total ${formatBytes(verdict.total)}, over the ${formatBytes(TOTAL_BUDGET_BYTES)} budget.\nSee docs/assets.md §7 before raising it — past ~50 MB the answer is a release tarball, not a bigger number.\n`,
    )
    return 1
  }

  if (verdict.nearBudget) {
    process.stdout.write(
      `\ngladiator: warning — ${Math.round((verdict.total / TOTAL_BUDGET_BYTES) * 100)}% of the asset budget is used.\n`,
    )
  }

  process.stdout.write('\nWithin budget.\n')
  return 0
}

// Only when run as a program. `tools/assets-budget.test.ts` imports the rules
// above and must not trip the CLI on the way in.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = main()
}
