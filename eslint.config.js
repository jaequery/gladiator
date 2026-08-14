import js from '@eslint/js'
import globals from 'globals'
import tseslint from 'typescript-eslint'

import gladiator from './eslint-rules/index.js'

/**
 * Layer three of the simulation boundary.
 *
 * Layer one is resolution: `packages/sim` declares zero dependencies and pnpm
 * hoists nothing, so `import '@babylonjs/core'` there does not resolve. Layer
 * two is the typechecker: `lib: ["ES2023"]` and `types: []` make `window`,
 * `process` and `setTimeout` "Cannot find name" errors in the editor.
 *
 * What is left over is the class of things that resolve fine and type fine and
 * still destroy determinism: a clock, a PRNG, a transcendental whose last bit
 * is implementation-defined, a promise that reorders work between two runtimes.
 * Those are what this file bans, and only inside `packages/sim`.
 */

/** @type {Array<{ selector: string, message: string }>} */
const DETERMINISM_BANS = [
  {
    selector: "MemberExpression[object.name='Math'][property.name='random']",
    message:
      'gladiator: Math.random() is banned in packages/sim. Two peers must produce the same world from the same inputs, and an ambient PRNG guarantees they will not. Draw from the seeded PRNG carried in the sim state instead.',
  },
  {
    selector: "MemberExpression[object.name='Date'][property.name='now']",
    message:
      'gladiator: Date.now() is banned in packages/sim. The simulation has no clock — it advances by a fixed timestep and knows only its tick number. Take the time you need from the tick.',
  },
  {
    selector: "NewExpression[callee.name='Date']",
    message:
      'gladiator: new Date() is banned in packages/sim. The simulation has no clock — it advances by a fixed timestep and knows only its tick number.',
  },
  {
    selector: "CallExpression[callee.name='Date']",
    message:
      'gladiator: Date() is banned in packages/sim. The simulation has no clock — it advances by a fixed timestep and knows only its tick number.',
  },
  {
    selector: "MemberExpression[object.name='performance'][property.name='now']",
    message:
      'gladiator: performance.now() is banned in packages/sim. Wall-clock time is an input to the scheduler that drives the simulation, never an input to the simulation itself.',
  },
  {
    selector: "MemberExpression[object.name='Math'][property.name='hypot']",
    message:
      'gladiator: Math.hypot() is banned in packages/sim. Its result is only required to be "implementation-approximated", so V8 and JavaScriptCore are free to disagree in the last bit and desync the two peers. Write Math.sqrt(x * x + y * y) — sqrt is exactly specified by IEEE 754.',
  },
  {
    selector: "BinaryExpression[operator='**']",
    message:
      'gladiator: the ** operator is banned in packages/sim. Exponentiation is implementation-approximated (as is Math.pow), so it is not bit-identical across engines. Multiply explicitly, or square with x * x.',
  },
  {
    selector: "AssignmentExpression[operator='**=']",
    message:
      'gladiator: the **= operator is banned in packages/sim. Exponentiation is implementation-approximated (as is Math.pow), so it is not bit-identical across engines. Multiply explicitly, or square with x * x.',
  },
  {
    selector: 'AwaitExpression',
    message:
      'gladiator: await is banned in packages/sim. A tick is a synchronous, total function of (state, inputs); the moment it can suspend, the order in which the world updates depends on the host event loop and the two peers drift apart.',
  },
  {
    selector: 'FunctionDeclaration[async=true]',
    message:
      'gladiator: async functions are banned in packages/sim. A tick is a synchronous, total function of (state, inputs). Do the I/O in the client or the server and hand the sim a plain value.',
  },
  {
    selector: 'FunctionExpression[async=true]',
    message:
      'gladiator: async functions are banned in packages/sim. A tick is a synchronous, total function of (state, inputs). Do the I/O in the client or the server and hand the sim a plain value.',
  },
  {
    selector: 'ArrowFunctionExpression[async=true]',
    message:
      'gladiator: async functions are banned in packages/sim. A tick is a synchronous, total function of (state, inputs). Do the I/O in the client or the server and hand the sim a plain value.',
  },
  {
    selector: 'ForOfStatement[await=true]',
    message:
      'gladiator: for-await-of is banned in packages/sim. A tick is a synchronous, total function of (state, inputs).',
  },
]

/**
 * The transcendentals, which are the same hazard as `Math.hypot` with a much
 * better disguise: `Math.sin` looks like arithmetic and is not. The
 * specification calls every one of these "implementation-approximated", so V8
 * and JavaScriptCore may legally return different last bits — and a view angle
 * turned into a direction vector feeds that difference straight into position.
 *
 * `packages/sim/src/trig.ts` computes sine and cosine from IEEE-exact
 * operations only. These are banned so that it is the only way to get one.
 *
 * Split out from DETERMINISM_BANS because `trig.test.ts` legitimately needs
 * `Math.sin` as the reference it asserts against — see the test override below.
 *
 * @type {Array<{ selector: string, message: string }>}
 */
const TRANSCENDENTAL_BANS = [
  'sin',
  'cos',
  'tan',
  'asin',
  'acos',
  'atan',
  'atan2',
  'exp',
  'expm1',
  'log',
  'log2',
  'log10',
  'log1p',
  'sinh',
  'cosh',
  'tanh',
  'cbrt',
  'pow',
].map((name) => ({
  selector: `MemberExpression[object.name='Math'][property.name='${name}']`,
  message: `gladiator: Math.${name}() is banned in packages/sim. The specification only requires it to be "implementation-approximated", so V8 and JavaScriptCore may return different last bits for the same argument — which is a desync, not a rounding error. Use packages/sim/src/trig.ts, which computes sine and cosine from IEEE-exact operations only, or multiply the value out.`,
}))

/**
 * What `packages/client` may not name.
 *
 * The simulation is authoritative. Babylon will happily run a *second* one —
 * `mesh.checkCollisions`, `camera.applyGravity`, `camera.ellipsoid` and
 * `moveWithCollisions()` need no plugin, no dependency and no ceremony, and
 * they are the canonical Babylon first-person-controller recipe that every
 * tutorial, every forum answer and every autocomplete will offer. Using one
 * would not break the game. It would produce movement that is *almost* right:
 * a client that disagrees with the server by a few units per second, which
 * looks like a network problem, is diagnosed as a network problem, and is not
 * one.
 *
 * `attachControl` is here for the same reason one layer up. View angles are
 * authoritative float state the client owns, because they go into the
 * `UserCmd` the server simulates and lag-compensates against. A camera that
 * reads the mouse itself makes the renderer the source of truth for aim.
 *
 * The physics-plugin API is banned as the outer fence: it cannot be reached
 * without a dependency, and `scripts/no-physics-plugin.mjs` fails the build if
 * one ever appears in the lockfile. Two locks, because this is the mistake
 * that would be hardest to find later.
 *
 * @type {Array<{ selector: string, message: string }>}
 */
const ENGINE_COLLISION_BANS = [
  [
    'checkCollisions',
    "gladiator: `checkCollisions` is banned in packages/client. Babylon's built-in collision system is a second simulation, and the authoritative one lives in packages/sim. Two collision systems do not produce a compromise; they produce a desync that looks like lag. Trace against the map with `traceBox` instead.",
  ],
  [
    'moveWithCollisions',
    'gladiator: `moveWithCollisions` is banned in packages/client. Movement is `pmove` in packages/sim, replayed identically by the server — nothing in the renderer may move a body. The renderer draws where the simulation says things are.',
  ],
  [
    'applyGravity',
    "gladiator: `applyGravity` is banned in packages/client. Gravity is a simulation constant (`pmove.ts`), applied in 8 ms sub-steps on both peers. A camera falling at Babylon's rate would fight prediction every frame.",
  ],
  [
    'ellipsoid',
    'gladiator: `ellipsoid` is banned in packages/client. The player is a 30x30x56 axis-aligned *box* (`bbox.ts`), and every movement constant in this repo was measured against that box. An ellipsoid is a different solid and a different game.',
  ],
  [
    'attachControl',
    'gladiator: `attachControl` is banned in packages/client. The camera is a puppet: yaw and pitch are ours, they go into the `UserCmd` the server lag-compensates against, and they are written to the camera every frame and never read back. Babylon reading the mouse itself inverts that.',
  ],
  [
    'enablePhysics',
    'gladiator: `enablePhysics` is banned in packages/client. There is no physics engine in this project and there will not be one — the simulation is 400 lines of Quake movement that has to run bit-identically in two runtimes. See `scripts/no-physics-plugin.mjs`.',
  ],
  [
    'PhysicsAggregate',
    'gladiator: `PhysicsAggregate` is banned in packages/client. See `enablePhysics`: there is no physics engine here, on purpose.',
  ],
  [
    'PhysicsBody',
    'gladiator: `PhysicsBody` is banned in packages/client. See `enablePhysics`: there is no physics engine here, on purpose.',
  ],
].map(([name, message]) => ({ selector: `Identifier[name='${name}']`, message }))

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.vite/**',
      '**/coverage/**',
      '.fredrin/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { gladiator },
  },

  /* Repo tooling: plain Node scripts and config files. */
  {
    files: ['*.config.{js,ts,mjs}', 'scripts/**/*.mjs', 'eslint-rules/**/*.js'],
    languageOptions: {
      globals: globals.nodeBuiltin,
    },
  },

  /* Authored maps and the tools that bake them. Both are repo-level Node
   * TypeScript belonging to no package; both carry the `.ts` extension
   * convention, because the baker runs under `tsx` and under Node's native
   * type stripping and neither invents an extension for you. */
  {
    files: ['maps/**/*.ts', 'tools/**/*.ts'],
    languageOptions: {
      globals: globals.nodeBuiltin,
    },
    rules: {
      'gladiator/require-ts-extension': 'error',
    },
  },

  /* The browser smoke test is a Node script that also contains functions which
   * run *inside the page* — `page.evaluate(() => window.__gladiator...)`. Both
   * sets of globals are legitimately in scope in the same file. */
  {
    files: ['scripts/e2e.mjs'],
    languageOptions: {
      globals: { ...globals.nodeBuiltin, ...globals.browser },
    },
  },

  /* ------------------------------------------------------------------
   * packages/sim — the deterministic core.
   *
   * `globals: {}` is deliberate: not `browser`, not `node`, nothing. This
   * package's only ambient surface is the ECMAScript standard library.
   * ------------------------------------------------------------------ */
  {
    files: ['packages/sim/**/*.ts'],
    languageOptions: {
      globals: {},
    },
    rules: {
      'no-restricted-syntax': ['error', ...DETERMINISM_BANS, ...TRANSCENDENTAL_BANS],
      'gladiator/no-external-import': 'error',
      'gladiator/require-ts-extension': 'error',
    },
  },
  {
    /* Tests are the one place inside the sim allowed a bare import, and the
     * allowlist is exactly one entry long.
     *
     * They are also the one place allowed `Math.sin`: `trig.test.ts` exists to
     * assert that our own implementation tracks the engine's, and it cannot do
     * that without naming the engine's. Every other determinism ban still
     * applies — a test that reaches for `Math.random()` is still a bug. */
    files: ['packages/sim/**/*.test.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...DETERMINISM_BANS],
      'gladiator/no-external-import': ['error', { allow: ['vitest'] }],
    },
  },

  /* packages/bot inherits the sim's purity through its tsconfig; the `.ts`
   * extension convention applies to every package that the server bundles. */
  {
    files: ['packages/bot/**/*.ts', 'packages/server/**/*.ts'],
    rules: {
      'gladiator/require-ts-extension': 'error',
    },
  },
  {
    files: ['packages/server/**/*.ts'],
    languageOptions: {
      globals: globals.nodeBuiltin,
    },
  },
  /* ------------------------------------------------------------------
   * packages/client — the renderer.
   *
   * The simulation boundary protects `packages/sim` from the outside world.
   * This protects the outside world from *reimplementing* the simulation:
   * Babylon ships a collision system and a physics API, and either one would
   * silently compete with the authoritative one. See ENGINE_COLLISION_BANS.
   * ------------------------------------------------------------------ */
  {
    files: ['packages/client/**/*.ts'],
    languageOptions: {
      globals: globals.browser,
    },
    rules: {
      'no-restricted-syntax': ['error', ...ENGINE_COLLISION_BANS],
    },
  },
)
