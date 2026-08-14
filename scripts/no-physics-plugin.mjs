#!/usr/bin/env node
/**
 * Fails if a physics engine has appeared in the lockfile.
 *
 * Gladiator's movement is `pmove` — a few hundred lines of Quake ported into
 * `packages/sim`, which has to produce bit-identical results in V8 and in
 * JavaScriptCore, on a phone and in a Node process on Fly. A physics engine
 * cannot do that and is not trying to: Havok, Rapier, Cannon and Ammo are all
 * built for plausibility at speed, and every one of them is a WASM blob whose
 * arithmetic is nobody's contract.
 *
 * ESLint already bans the *API* — `enablePhysics`, `PhysicsAggregate`,
 * `PhysicsBody` — inside `packages/client`. This is the outer fence, and it is
 * the one that cannot be worked around by writing the call somewhere else:
 * a physics engine cannot be used without being installed, and it cannot be
 * installed without appearing here.
 *
 * It reads the lockfile as text rather than parsing YAML, on purpose. There is
 * no YAML parser in this repo's dependency tree, adding one to check that a
 * dependency was not added would be funny, and the package names it looks for
 * are unambiguous strings.
 *
 *     node scripts/no-physics-plugin.mjs                  # the repo's lockfile
 *     node scripts/no-physics-plugin.mjs --lockfile <path>
 *
 * The `--lockfile` flag is not a convenience: `scripts/guardrails.mjs` points
 * it at a lockfile that *does* contain Havok and fails if this script accepts
 * it. A guardrail nobody has watched fire is a guardrail nobody knows is
 * connected.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * Package names that mean "a physics engine is in the build".
 *
 * Matched against the package name a lockfile entry declares, so `@babylonjs/
 * havok` is caught and a package that merely mentions havok in its description
 * is not. Scoped and unscoped spellings are both listed because both exist.
 */
const PHYSICS_PACKAGES = [
  '@babylonjs/havok',
  'havok',
  '@dimforge/rapier3d',
  '@dimforge/rapier3d-compat',
  'rapier3d',
  'cannon',
  'cannon-es',
  'ammo.js',
  'ammojs-typed',
  'oimo',
  'oimophysics',
  'matter-js',
  'planck-js',
  'p2',
  'box2d-wasm',
  'physx-js',
  '@react-three/rapier',
  '@react-three/cannon',
]

/**
 * Every package name a pnpm lockfile mentions.
 *
 * pnpm v9 and v10 write entries as `  <name>@<version>:` under `packages:` and
 * `snapshots:`, with the name quoted when it is scoped. Versions can carry a
 * peer-dependency suffix in parentheses, which is why the name is taken as
 * everything before the *last* `@`.
 */
export function lockfilePackages(text) {
  const names = new Set()
  for (const line of text.split('\n')) {
    const match = /^ {2}'?((?:@[^@'\s]+\/)?[^@'\s]+)@[^'\s]*'?:\s*$/.exec(line)
    if (match !== null && match[1] !== undefined) names.add(match[1])
  }
  return names
}

/** The physics packages present in a lockfile's text. */
export function findPhysicsPackages(text) {
  const present = lockfilePackages(text)
  return PHYSICS_PACKAGES.filter((name) => present.has(name))
}

function main() {
  const argv = process.argv.slice(2)
  const flag = argv.indexOf('--lockfile')
  const lockfile = flag === -1 ? join(ROOT, 'pnpm-lock.yaml') : (argv[flag + 1] ?? '')

  if (lockfile === '' || !existsSync(lockfile)) {
    console.error(`no-physics-plugin: no lockfile at ${lockfile || '(unset)'}`)
    process.exit(2)
  }

  const found = findPhysicsPackages(readFileSync(lockfile, 'utf8'))
  const where = relative(ROOT, lockfile) || lockfile

  if (found.length === 0) {
    console.log(`no-physics-plugin: ${where} is clean — no physics engine in the build.`)
    return
  }

  console.error(
    `no-physics-plugin: ${where} contains ${found.length} physics ${
      found.length === 1 ? 'engine' : 'engines'
    }:\n` +
      found.map((name) => `  - ${name}`).join('\n') +
      '\n\nGladiator has no physics engine, on purpose. Movement is `pmove` in packages/sim,\n' +
      'and it must produce bit-identical results in two JavaScript engines — which a WASM\n' +
      'physics blob is not built to do and does not claim to do. If you need a body moved,\n' +
      'move it in the simulation and let the renderer draw the result.\n',
  )
  process.exit(1)
}

main()
