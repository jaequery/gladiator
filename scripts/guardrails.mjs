#!/usr/bin/env node
/**
 * Proves the simulation boundary is real.
 *
 * Every other check in `pnpm run ci` proves the repo is *clean*. This one
 * proves it is *closed*: it writes deliberately-violating code into
 * `packages/sim`, runs the check that is supposed to reject it, and fails if
 * the check passes. A guardrail nobody has ever seen fire is a guardrail
 * nobody knows is connected — and this repo's entire multiplayer story rests
 * on `packages/sim` producing bit-identical results in two runtimes.
 *
 * Each case names the layer it exercises:
 *
 *   resolve    the module graph — `packages/sim` declares zero dependencies
 *              and pnpm hoists nothing, so there is nothing to import
 *   typecheck  `lib: ["ES2023"]`, `types: []`, `rootDir: "./src"`
 *   lint       the determinism bans that resolve fine and type fine
 *
 * The layers are listed strongest first. Only the first cannot be switched off
 * by a future contributor in a hurry.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PROBE = join(ROOT, 'packages', 'sim', 'src', '__guardrail_probe__.ts')
const PROBE_REL = relative(ROOT, PROBE)

const RESOLVE_BABYLON = [
  'node',
  '--input-type=module',
  '-e',
  "console.log(import.meta.resolve('@babylonjs/core'))",
]

/**
 * @typedef {{
 *   layer: 'resolve' | 'typecheck' | 'lint',
 *   label: string,
 *   probe?: string,
 *   command: string[],
 *   cwd?: string,
 *   expect: 'fail' | 'pass',
 *   match?: RegExp[],
 * }} Case
 */

/** @type {Case[]} */
const CASES = [
  {
    layer: 'resolve',
    label: 'a renderer does not resolve from packages/sim at all',
    command: RESOLVE_BABYLON,
    cwd: join(ROOT, 'packages', 'sim'),
    expect: 'fail',
    match: [/ERR_MODULE_NOT_FOUND|Cannot find package/],
  },
  {
    layer: 'resolve',
    label: 'control: the same renderer does resolve from packages/client',
    command: RESOLVE_BABYLON,
    cwd: join(ROOT, 'packages', 'client'),
    expect: 'pass',
  },
  {
    layer: 'typecheck',
    label: 'importing a renderer in packages/sim fails typecheck',
    probe: [
      "import * as BABYLON from '@babylonjs/core'",
      'export const renderer: unknown = BABYLON',
      '',
    ].join('\n'),
    command: ['pnpm', '--filter', '@gladiator/sim', 'run', 'typecheck'],
    expect: 'fail',
    match: [/Cannot find module '@babylonjs\/core'/],
  },
  {
    layer: 'typecheck',
    label: 'browser and Node globals are not in scope in packages/sim',
    probe: [
      'export const width = window.innerWidth',
      'export const title = document.title',
      'export const cwd = process.cwd()',
      'export const buf = Buffer.alloc(1)',
      'export const timer = setTimeout(() => {}, 0)',
      'export const now = performance.now()',
      '',
    ].join('\n'),
    command: ['pnpm', '--filter', '@gladiator/sim', 'run', 'typecheck'],
    expect: 'fail',
    match: [
      /Cannot find name 'window'/,
      /Cannot find name 'document'/,
      /Cannot find name 'process'/,
      /Cannot find name 'Buffer'/,
      /Cannot find name 'setTimeout'/,
      /Cannot find name 'performance'/,
    ],
  },
  {
    layer: 'typecheck',
    label: 'reaching into another package by relative path fails typecheck',
    probe: ["export { DEFAULT_PORT } from '../../server/src/config.ts'", ''].join('\n'),
    command: ['pnpm', '--filter', '@gladiator/sim', 'run', 'typecheck'],
    expect: 'fail',
    match: [/TS6059/, /is not under 'rootDir'/],
  },
  {
    layer: 'lint',
    label: 'Math.random() in packages/sim fails pnpm lint',
    probe: ['export const roll = Math.random()', ''].join('\n'),
    command: ['pnpm', 'run', 'lint'],
    expect: 'fail',
    match: [/Math\.random\(\) is banned in packages\/sim/],
  },
  {
    layer: 'lint',
    label: 'every other determinism ban fires',
    probe: [
      'export const t = Date.now()',
      'export const d = new Date()',
      'export const p = performance.now()',
      'export const h = Math.hypot(3, 4)',
      'export const sq = 2 ** 8',
      'export async function load(): Promise<number> {',
      '  await Promise.resolve()',
      '  return 1',
      '}',
      '',
    ].join('\n'),
    command: ['pnpm', 'run', 'lint'],
    expect: 'fail',
    match: [
      /Date\.now\(\) is banned/,
      /new Date\(\) is banned/,
      /performance\.now\(\) is banned/,
      /Math\.hypot\(\) is banned/,
      /the \*\* operator is banned/,
      /async functions are banned/,
      /await is banned/,
    ],
  },
  {
    layer: 'lint',
    label: 'a cross-package import fails lint with the reason, not just a resolver error',
    probe: ["export { debugAxisMap } from '@gladiator/bot'", ''].join('\n'),
    command: ['pnpm', 'run', 'lint'],
    expect: 'fail',
    match: [/may not import '@gladiator\/bot'/],
  },
  {
    layer: 'lint',
    label: 'a relative import without the .ts extension fails lint',
    probe: ["export { quakeToEngine } from './axis'", ''].join('\n'),
    command: ['pnpm', 'run', 'lint'],
    expect: 'fail',
    match: [/must carry the '\.ts' extension/],
  },
]

function removeProbe() {
  if (existsSync(PROBE)) rmSync(PROBE)
}

/** @param {Case} testCase */
function run(testCase) {
  if (testCase.probe !== undefined) {
    writeFileSync(
      PROBE,
      `/* Written by scripts/guardrails.mjs. Deleted again immediately. */\n${testCase.probe}`,
      'utf8',
    )
  }
  try {
    const result = spawnSync(testCase.command[0], testCase.command.slice(1), {
      cwd: testCase.cwd ?? ROOT,
      encoding: 'utf8',
      env: process.env,
    })
    if (result.error) {
      return { ok: false, reason: `could not run the check: ${result.error.message}` }
    }
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
    const failed = result.status !== 0

    if (testCase.expect === 'pass') {
      return failed
        ? { ok: false, reason: `expected exit 0, got ${result.status}`, output }
        : { ok: true }
    }
    if (!failed) {
      return { ok: false, reason: 'the violation was accepted — exit 0', output }
    }
    const missing = (testCase.match ?? []).filter((pattern) => !pattern.test(output))
    if (missing.length > 0) {
      return {
        ok: false,
        reason: `rejected, but not for the stated reason. Missing: ${missing.map(String).join(', ')}`,
        output,
      }
    }
    return { ok: true }
  } finally {
    removeProbe()
  }
}

removeProbe()

let failures = 0
console.log(`guardrails: ${CASES.length} deliberate violations, via ${PROBE_REL}\n`)

for (const testCase of CASES) {
  const outcome = run(testCase)
  const mark = outcome.ok ? 'ok  ' : 'FAIL'
  console.log(`  ${mark} [${testCase.layer}] ${testCase.label}`)
  if (!outcome.ok) {
    failures += 1
    console.log(`       ${outcome.reason}`)
    if (outcome.output !== undefined) {
      const tail = outcome.output.trimEnd().split('\n').slice(-20)
      for (const line of tail) console.log(`       | ${line}`)
    }
  }
}

if (failures > 0) {
  console.error(
    `\nguardrails: ${failures} of ${CASES.length} guardrails did not hold. The simulation boundary is not closed — a violating commit would reach main.`,
  )
  process.exit(1)
}

console.log(`\nguardrails: ${CASES.length}/${CASES.length} held.`)
