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

/**
 * Where a deliberately-violating probe is written.
 *
 * One per boundary: the simulation's, the renderer's, the bot's fairness line
 * (on both sides of it, because the exemption is half the claim), and the
 * lockfile the physics-plugin check reads. All of them are deleted
 * immediately, whether the check passed or threw.
 */
const PROBES = {
  sim: join(ROOT, 'packages', 'sim', 'src', '__guardrail_probe__.ts'),
  client: join(ROOT, 'packages', 'client', 'src', '__guardrail_probe__.ts'),
  bot: join(ROOT, 'packages', 'bot', 'src', '__guardrail_probe__.ts'),
  botPerception: join(
    ROOT,
    'packages',
    'bot',
    'src',
    'perception',
    '__guardrail_probe__.ts',
  ),
  lockfile: join(ROOT, '__guardrail_lock__.yaml'),
}
const PROBE_REL = relative(ROOT, PROBES.sim)

const RESOLVE_BABYLON = [
  'node',
  '--input-type=module',
  '-e',
  "console.log(import.meta.resolve('@babylonjs/core'))",
]

/**
 * @typedef {{
 *   layer: 'resolve' | 'typecheck' | 'lint' | 'lockfile',
 *   label: string,
 *   probe?: string,
 *   probeAt?: keyof typeof PROBES,
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
    label: 'the transcendentals are banned, so trig.ts is the only way to get a direction',
    probe: [
      "import { angleUnitsToRadians } from './usercmd.ts'",
      'export const forward = Math.cos(angleUnitsToRadians(1024))',
      'export const left = Math.sin(angleUnitsToRadians(1024))',
      'export const bearing = Math.atan2(1, 2)',
      'export const decay = Math.exp(-1)',
      'export const raised = Math.pow(2, 8)',
      '',
    ].join('\n'),
    command: ['pnpm', 'run', 'lint'],
    expect: 'fail',
    match: [
      /Math\.cos\(\) is banned/,
      /Math\.sin\(\) is banned/,
      /Math\.atan2\(\) is banned/,
      /Math\.exp\(\) is banned/,
      /Math\.pow\(\) is banned/,
      /trig\.ts/,
    ],
  },
  {
    layer: 'lint',
    label: 'a cross-package import fails lint with the reason, not just a resolver error',
    probe: ["export { createBot } from '@gladiator/bot'", ''].join('\n'),
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

  /* ------------------------------------------------------------------
   * The renderer's boundary.
   *
   * The simulation is authoritative, and Babylon will run a second one for
   * free if asked. These are the four calls every first-person tutorial
   * offers, plus the camera input attachment and the physics API.
   * ------------------------------------------------------------------ */
  {
    layer: 'lint',
    label: "Babylon's own collision system cannot be reached from packages/client",
    probeAt: 'client',
    probe: [
      "import { Vector3 } from '@babylonjs/core/Maths/math.vector'",
      '',
      'type Body = {',
      '  checkCollisions: boolean',
      '  ellipsoid: Vector3',
      '  applyGravity: boolean',
      '  moveWithCollisions(displacement: Vector3): void',
      '}',
      '',
      'export function walk(body: Body): void {',
      '  body.checkCollisions = true',
      '  body.applyGravity = true',
      '  body.ellipsoid = new Vector3(15, 28, 15)',
      '  body.moveWithCollisions(new Vector3(1, 0, 0))',
      '}',
      '',
    ].join('\n'),
    command: ['pnpm', 'run', 'lint'],
    expect: 'fail',
    match: [
      /`checkCollisions` is banned in packages\/client/,
      /`applyGravity` is banned in packages\/client/,
      /`ellipsoid` is banned in packages\/client/,
      /`moveWithCollisions` is banned in packages\/client/,
    ],
  },
  {
    layer: 'lint',
    label: 'the camera cannot be given its own input, and physics cannot be enabled',
    probeAt: 'client',
    probe: [
      'type Camera = { attachControl(element: unknown): void }',
      'type World = { enablePhysics(): void }',
      '',
      'export function drive(camera: Camera, world: World): void {',
      '  camera.attachControl(null)',
      '  world.enablePhysics()',
      '}',
      '',
      'export const shapes = { PhysicsAggregate: 1, PhysicsBody: 2 }',
      '',
    ].join('\n'),
    command: ['pnpm', 'run', 'lint'],
    expect: 'fail',
    match: [
      /`attachControl` is banned in packages\/client/,
      /`enablePhysics` is banned in packages\/client/,
      /`PhysicsAggregate` is banned in packages\/client/,
      /`PhysicsBody` is banned in packages\/client/,
    ],
  },
  {
    layer: 'lint',
    label: 'the post-processing chain cannot grow a pass',
    probeAt: 'client',
    probe: [
      '// A full-screen pass is input-to-photon latency on every frame, and it',
      '// is exactly the change that looks like an improvement in a screenshot.',
      'export const chain = {',
      '  bloom: 1,',
      '}',
      '',
      'export function grade(): unknown {',
      '  return [DefaultRenderingPipeline, PostProcess, FxaaPostProcess]',
      '}',
      '',
    ].join('\n'),
    command: ['pnpm', 'run', 'lint'],
    expect: 'fail',
    match: [
      /`DefaultRenderingPipeline` is banned in packages\/client/,
      /`PostProcess` is banned in packages\/client/,
      /`FxaaPostProcess` is banned in packages\/client/,
    ],
  },
  /* ------------------------------------------------------------------
   * The bot's fairness boundary. GLAD-V7CMHR.
   *
   * Only `packages/bot/src/perception/` may look at the world. The pair below
   * is the interesting part: the *same* file is a lint error one directory up
   * and clean inside `perception/`, which is what proves the exemption is a
   * boundary rather than a hole.
   * ------------------------------------------------------------------ */
  {
    layer: 'lint',
    label: 'the bot cannot read the simulation entity list outside perception/',
    probeAt: 'bot',
    probe: [
      "import { findPlayer } from '@gladiator/sim'",
      "import type { EntityState, GameState } from '@gladiator/sim'",
      '',
      'export function cheat(state: GameState, slot: number): number {',
      '  const them: EntityState | null = findPlayer(state, slot)',
      '  for (const entity of state.entities) if (entity.id === 0) return 0',
      '  return them === null ? 0 : them.health + them.armor',
      '}',
      '',
    ].join('\n'),
    command: ['pnpm', 'run', 'lint'],
    expect: 'fail',
    match: [
      /`GameState` is banned in packages\/bot outside perception\//,
      /`EntityState` is banned in packages\/bot outside perception\//,
      /`findPlayer` is banned in packages\/bot outside perception\//,
      /`\.entities` is banned in packages\/bot outside perception\//,
    ],
  },
  {
    layer: 'lint',
    label: 'control: the same code is fine inside perception/, which is the one place that looks',
    probeAt: 'botPerception',
    probe: [
      "import { findPlayer } from '@gladiator/sim'",
      "import type { EntityState, GameState } from '@gladiator/sim'",
      '',
      'export function look(state: GameState, slot: number): number {',
      '  const them: EntityState | null = findPlayer(state, slot)',
      '  for (const entity of state.entities) if (entity.id === 0) return 0',
      '  return them === null ? 0 : them.health + them.armor',
      '}',
      '',
    ].join('\n'),
    command: ['pnpm', 'run', 'lint'],
    expect: 'pass',
  },

  {
    layer: 'lockfile',
    label: 'a physics engine in the lockfile fails the build',
    probeAt: 'lockfile',
    probe: [
      'packages:',
      '',
      "  '@babylonjs/havok@1.3.10':",
      '    resolution: {integrity: sha512-guardrail}',
      '',
      '  cannon-es@0.20.0:',
      '    resolution: {integrity: sha512-guardrail}',
      '',
    ].join('\n'),
    command: ['node', 'scripts/no-physics-plugin.mjs', '--lockfile', PROBES.lockfile],
    expect: 'fail',
    match: [/@babylonjs\/havok/, /cannon-es/, /no physics engine, on purpose/],
  },
  {
    layer: 'lockfile',
    label: "control: the repo's own lockfile passes the same check",
    command: ['node', 'scripts/no-physics-plugin.mjs'],
    expect: 'pass',
  },
]

function removeProbe() {
  for (const path of Object.values(PROBES)) if (existsSync(path)) rmSync(path)
}

/** @param {Case} testCase */
function run(testCase) {
  if (testCase.probe !== undefined) {
    const path = PROBES[testCase.probeAt ?? 'sim']
    const comment = path.endsWith('.yaml') ? '#' : '/*'
    const close = path.endsWith('.yaml') ? '' : ' */'
    writeFileSync(
      path,
      `${comment} Written by scripts/guardrails.mjs. Deleted again immediately.${close}\n${testCase.probe}`,
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
console.log(
  `guardrails: ${CASES.length} deliberate violations, via ${PROBE_REL} and four like it\n`,
)

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
