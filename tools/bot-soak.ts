/**
 * `pnpm bot:soak` — the acceptance check that needs two hundred matches.
 *
 * `maps/arena1.bot.test.ts` runs a handful of matches so that `pnpm test` stays a
 * thing somebody runs before every commit. This is the same claims at the sample
 * size the ticket asks for: **200 matches of 2 minutes**, which is 3,000,000
 * sub-steps of two bots walking around Crucible, and about a minute and a half of
 * wall-clock.
 *
 * It exits non-zero on any failed claim and prints the numbers either way, because
 * a soak that only says "ok" is a soak nobody can tell the difference between
 * passing and not running.
 *
 * ```
 * pnpm bot:soak                 # 200 matches of 2 minutes
 * pnpm bot:soak 20 30           # 20 matches of 30 seconds
 * ```
 */

import { readFileSync } from 'node:fs'
import process from 'node:process'

import { loadMap } from '@gladiator/sim'
import { loadNav } from '@gladiator/bot'

import { formatSoak, soakBots, soakFailures } from './bot-arena.ts'

/** The ticket's numbers. */
const DEFAULT_MATCHES = 200
const DEFAULT_SECONDS = 120

function positive(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`gladiator: "${value}" is not a positive number of matches or seconds.`)
  }
  return parsed
}

const matches = positive(process.argv[2], DEFAULT_MATCHES)
const seconds = positive(process.argv[3], DEFAULT_SECONDS)

const map = loadMap(JSON.parse(readFileSync('maps/baked/arena1.json', 'utf8')))
const nav = loadNav(JSON.parse(readFileSync('maps/baked/arena1.nav.json', 'utf8')), map.hash)

console.log(`gladiator: soaking ${matches} matches of ${seconds}s on ${map.source.name}...`)
const started = Date.now()
const soak = soakBots({
  map,
  nav,
  seed: 1,
  matches,
  seconds,
  onMatch: (index) => {
    // One line every ten matches: enough to see it is alive, not enough to bury
    // the report underneath itself.
    if ((index + 1) % 10 === 0) console.log(`  ${index + 1}/${matches}`)
  },
})
const elapsed = (Date.now() - started) / 1000

console.log(formatSoak(soak))
console.log(`ran in ${elapsed.toFixed(1)}s of wall-clock`)

const failures = soakFailures(soak)
if (failures.length === 0) {
  console.log(`gladiator: all acceptance checks hold over ${soak.matches} matches.`)
  process.exit(0)
}

for (const failure of failures) console.error(`FAIL ${failure.check}: ${failure.detail}`)
console.error(`gladiator: ${failures.length} failed claim(s) over ${soak.matches} matches.`)
process.exit(1)
