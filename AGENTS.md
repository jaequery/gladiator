# AGENTS.md — conventions for working in this repo

Gladiator is a browser-native recreation of the Quake mod *Rocket Arena*:
round-based 1v1 duels, full health on spawn, no pickups, a rocket launcher and
a railgun. It runs the same simulation in the browser and on the server. Almost
every convention below exists to protect that one sentence.

Vocabulary is in [`CONTEXT.md`](./CONTEXT.md). Physics numbers are in
[`docs/physics-spec.md`](./docs/physics-spec.md).

---

## Commands

| Command              | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `pnpm install`       | install (pnpm 10, exact versions, `--frozen-lockfile` in CI) |
| `pnpm run typecheck` | `tsc --noEmit` in every package                        |
| `pnpm run lint`      | ESLint over the whole repo                             |
| `pnpm run test`      | Vitest, once                                           |
| `pnpm run build`     | Vite (client) and esbuild (server)                     |
| `pnpm run guardrails`| proves the simulation boundary rejects violations      |
| `pnpm run map:bake`  | compiles `maps/*.ts` to `maps/baked/*.json` (`--check` verifies) |
| `pnpm run ci`        | all five, in that order — what CI runs                 |
| `pnpm run e2e`       | the browser smoke test — needs Chromium, own CI job    |

> `pnpm run ci`, not `pnpm ci`. pnpm reserves the bare `ci` verb
> (`ERR_PNPM_CI_NOT_IMPLEMENTED`) and will not fall through to a package
> script of that name.

## Packages

| Package             | May depend on            | Built?                        |
| ------------------- | ------------------------ | ----------------------------- |
| `packages/sim`      | **nothing**              | never — consumed as source    |
| `packages/bot`      | `sim`                    | never — consumed as source    |
| `packages/client`   | `sim`, `bot`, Babylon    | Vite                          |
| `packages/server`   | `sim`, `bot`, `ws`       | esbuild                       |

`sim` and `bot` are source-only. Their `exports` point straight at `./src/*.ts`
and there is no `dist`, so there is exactly one resolution condition and nothing
for `bundler` and `NodeNext` to disagree about.

Two directories belong to no package and ship with neither build: `maps/` (the
authored maps and their baked artifacts) and `tools/` (the baker). Both are
typechecked by the root `tsconfig.json` and linted with Node globals; both may
import `@gladiator/sim`, which is why it is a devDependency of the root
`package.json`.

---

## The simulation boundary

`packages/sim` must produce **bit-identical** results from the same inputs, in
V8 and in JavaScriptCore, in a browser tab and in a Node process. Two peers that
disagree by one ULP diverge into two different games within seconds.

That property is enforced in three layers. The ordering matters, because only
the first cannot be switched off by someone in a hurry.

### 1. Resolution — unfakeable

`packages/sim/package.json` declares `"dependencies": {}`, literally. And
`pnpm-workspace.yaml` sets `hoistPattern: []` and `publicHoistPattern: []`, so
pnpm creates no shared `node_modules/.pnpm/node_modules` bucket for a package
to accidentally resolve through.

The result is that `import '@babylonjs/core'` inside `packages/sim` fails to
*resolve*. Not fails to lint — fails to exist. **Do not add a dependency to
`packages/sim`.** If you find yourself wanting to, the code you are writing
belongs in `client`, `server` or `bot`, and the sim should be handed the result
as a plain value.

### 2. The typechecker — the editor tells you

`packages/sim/tsconfig.json` sets:

- `"lib": ["ES2023"]` — no `DOM`, so `window`, `document` and `console` are
  `Cannot find name` errors
- `"types": []` — no ambient `@types/*` at all, so `process`, `Buffer` and
  `setTimeout` are too, even when a dependency's `.d.ts` would otherwise drag
  them in
- `"rootDir": "./src"` — reaching sideways into another package by relative
  path is `TS6059`, not a code-review comment

### 3. ESLint — for what resolves fine and types fine

Banned in `packages/sim` only, each with an error message explaining itself:

| Banned                          | Because                                                        |
| ------------------------------- | -------------------------------------------------------------- |
| `Math.random()`                 | draw from the seeded PRNG in the sim state instead              |
| `Date.now()`, `new Date()`      | the sim has no clock; it knows its tick number                  |
| `performance.now()`             | wall-clock drives the scheduler, never the simulation           |
| `Math.hypot()`                  | implementation-approximated — use `Math.sqrt(x * x + y * y)`    |
| `Math.sin`, `Math.cos`, `Math.pow`, … | implementation-approximated — use `sim/src/trig.ts`        |
| `**` and `**=`                  | implementation-approximated (so is `Math.pow`) — multiply out   |
| `async` / `await`               | a tick is a synchronous, total function of `(state, inputs)`    |
| bare / cross-package imports    | see layer 1                                                     |

`scripts/guardrails.mjs` writes deliberately-violating code into
`packages/sim`, runs the check that should reject it, and fails if the check
passes. It runs in `pnpm run ci`. A guardrail nobody has watched fire is a
guardrail nobody knows is connected.

---

## The simulation kernel

`packages/sim/src/kernel.ts`. Numbers and the reasoning behind them are
[`docs/physics-spec.md` §0.1](./docs/physics-spec.md).

### `tick()` mutates `GameState` in place

```ts
tick(state, inputs, world)   // advances `state` by one 8 ms sub-step
const before = cloneGameState(state)   // if you need the old one, say so
```

`world` is a `CollisionWorld` and defaults to `SKELETON_ARENA` — level data,
loaded once, never mutated by a sub-step, which is why it sits beside the state
rather than inside it. It needs no cloning for reconciliation and no hashing;
two peers agreeing about the map is something the lobby settles before the
first tick. A real map replaces the *value* (GLAD-G2M8QQ, GLAD-B8DI4J), never
the code that takes it.

It returns nothing, allocates nothing in the steady state, and keeps the same
entity objects — a reference you held before the call points at the new values
after it. This is deliberate: a tick runs 125 times a second per room and
reconciliation replays dozens of them per correction, and a fresh world object
per tick is garbage nobody needs to make.

It is also the one genuinely surprising thing about the API, which is why it is
written down here. **A caller that needs the previous state calls
`cloneGameState` first.** Getting this wrong produces a bug that only appears
under packet loss, which is the worst kind to go looking for.

### Sub-steps, not frames

The host reports elapsed wall-clock; the kernel converts it into whole 8 ms
sub-steps and carries the remainder:

```ts
const kernel = createKernel(createGameState(seed))
advanceHost(kernel, clampHostDelta(dtMs), commands, onTick)
```

`advanceHost` runs exactly `floor((remainder + dtMs) / 8)` sub-steps — no
hidden clamp, because throwing time away after a hitch is scheduler *policy*
and belongs to whoever can also tell the other peer about it. Run the measured
delta through `clampHostDelta` first.

`onTick` fires after **every sub-step**, not once per host frame. Sampling
state per frame silently skips whichever ticks shared one.

### Phase order

`tick()` runs fixed phases, and the order is the contract later tickets build
against: advance the PRNG, move players, integrate, expire. Adding a phase
means deciding where it goes, once, for everyone.

The *movement* phase has an order of its own, and it is not negotiable either:
`docs/physics-spec.md` §1.5. `PM_CheckJump` runs before `PM_Friction`, and that
one ordering is the whole bunny hop.

The PRNG (`rng.ts`, mulberry32 over one uint32) advances once per sub-step
whether or not anything drew from it, so the stream position is a function of
the tick number. It lives in `GameState`, so snapshots, hashing and rewinding
carry it for free.

### One name per number

The timestep is `tick.ts`; the movement constants live next to the movement
code that owns them — `GRAVITY`, `RUN_SPEED` and `JUMP_VELOCITY` in
`pmove/index.ts`, friction's two in `pmove/friction.ts`, acceleration's four in
`pmove/accelerate.ts`; the player bounding box is `bbox.ts`; the collision
constants — `OVERCLIP`, `STEP_SIZE`, `MIN_WALK_NORMAL`, the trace epsilon — are
`slidemove.ts` and `trace.ts`; the map's rules — the ramp gradients, the spawn
headroom and separation minima — are `map/schema.ts`; angles are angle units,
defined in `usercmd.ts`; sine and cosine are `trig.ts`. Everything else imports
rather than restating. Two names for one number is the drift everything else in
this file exists to prevent, so if you find yourself adding a `constants.ts`,
put the constant next to the code that owns it instead.

There is exactly **one** world: `GameState`/`tick()`. The walking skeleton's
`PlayerState`/`pmove(state, cmd)` stub is gone, and the deployed client and
server both run the kernel over the same `CollisionWorld`. Two implementations
of "how a player moves" is precisely the drift a desync hides in, which is why
there is no second, smaller state hash either.

### The movement layer

`packages/sim/src/pmove/` is Quake's `bg_pmove.c`: `cmdscale.ts`,
`friction.ts`, `accelerate.ts`, `snap.ts`, and the `PmoveSingle` ordering in
`index.ts`. It moves a `PmoveBody` — a `MoveBody` plus the jump latch — through
a `CollisionWorld`, and it knows nothing about `GameState`; the kernel copies an
entity in and the result back out. That seam is deliberate: the bot
(GLAD-TSED8V) and client prediction (GLAD-6RT64L) both need to run the real
movement over a body that is not an entity in the live state.

Three things in there look like bugs and are load-bearing — the acceleration
gate on `dot(velocity, wishdir)`, `PM_CheckJump` before `PM_Friction`, and
integer velocity snapping. All three are argued in `docs/physics-spec.md` §1
and measured in `pmove/pmove.test.ts`.

### The collision layer

`collide.ts` (the brush world and its broadphase), `trace.ts` (the swept-AABB
trace) and `slidemove.ts` (`SlideMove`, `StepSlideMove`, the ground trace) are
the layer `pmove` stands on. `MoveBody` is the shape a body has to be to be
moved and `CollisionWorld` is level data loaded once; nothing in there touches
`GameState`. `arena.ts` holds the world the kernel defaults to — see the note
at the end of **Maps** for why that is not a baked map. Numbers and reasoning:
`docs/physics-spec.md` §2.

They mutate in place and reuse module-level scratch, for the same reason and
under the same guarantee as `hashState` — single-threaded and synchronous, with
`await` a lint error in this package. Two consequences worth knowing before you
call them: a `TraceResult` may not alias a trace's `start` or `end`, and a trace
may not be interleaved with another query on the same world.

### Maps

`packages/sim/src/map/`. Numbers and reasoning: `docs/physics-spec.md` §4.

Maps are hand-authored TypeScript under `maps/`, compiled by `pnpm map:bake` to
JSON in `maps/baked/`, and loaded by both the client and the server from the
committed artifact — `maps/baked/*.json` is in the repository on purpose, so a
build needs no bake step in front of it. A test re-bakes in memory and fails if
what is committed is stale.

**Visual geometry is derived from the collision brushes, never authored beside
them.** One brush list, two consumers: `map/collide.ts` makes trace structures
out of it and `map/geometry.ts` cuts render polygons out of the *same planes*.
So what you can walk on is what you can see by construction, and the two named
escape hatches — `nonSolid` (drawn, not collided) and `noRender` (collided, not
drawn) — are the only way to separate them, both visible in a diff.

If you are adding a rule about what a map may contain, it goes in
`map/validate.ts`, inside the sim. A rule that lived in `tools/` would protect
only maps that went through the baker.

Client and server exchange `mapHash` in the handshake and refuse the session if
it differs, because the client deploys to Vercel and the server to Fly and
never at the same instant. `PROTOCOL_VERSION` covers the message shapes; the
map hash covers the world they describe.

**Nothing simulates a baked map yet, and that is staged rather than forgotten.**
`packages/sim` cannot import `maps/` — `rootDir` is `./src`, and the package has
no filesystem — so the kernel's default world is the hand-written brush world in
`arena.ts`, which is also what the golden replay runs in and what the renderer
draws. The client and the server load `testbed`, verify its hash and exchange
it, and then tick `SKELETON_ARENA`. Wiring the loaded map through is one line in
each once there is something that draws it: the renderer is GLAD-0IDR6J and the
arena worth playing in is GLAD-B8DI4J. Until then, moving the simulation onto a
map the renderer does not draw would trade a cosmetic gap for players walking
into invisible walls.

### The golden replay

`packages/sim/src/determinism.test.ts` runs a committed input stream and
compares a committed hash trace sampled every half second. A failure names the
half-second where the two first diverged, and prints the new trace as a
paste-ready literal.

A ticket that changes what a sub-step does **is expected to move that trace**.
Re-bake it by pasting what the failure prints over `GOLDEN_TRACE` in
`src/fixtures/golden-replay.ts`, and say in the commit message why the world
moved. There is no bake script, because a bake script would need a filesystem
and this package does not have one.

`hashState` hashes raw IEEE 754 bit patterns — it never rounds, because
rounding is precisely what would hide a slow drift. It does normalise `-0` to
`+0` and every NaN to one NaN; see `encoding.ts` for why both are necessary.

---

## TypeScript conventions

**Relative imports carry the `.ts` extension.** In `packages/sim` and
`packages/server` this is a lint error, not a preference:

```ts
import { tick } from './step.ts' // yes
import { tick } from './step'    // no — resolves in Vite, fails in Node
import { tick } from './step.js' // no — type-checks, then resolves to nothing
```

`./step.ts` is the only spelling simultaneously valid for Vite, esbuild, `tsx`
and Node's native type stripping.

**`erasableSyntaxOnly` is on repo-wide.** No `enum`, no `namespace`, no
parameter properties — nothing TypeScript would have to *generate code* for.
What survives is types-as-annotations, which Node can strip natively and which
no bundler can get subtly wrong. Use a `const` object with an `as const` and a
union type where you reach for an enum.

**`tsc` never emits.** It is a typechecker; Vite and esbuild emit.

**Versions are pinned exactly.** No caret ranges — a patch bump to Babylon or
TypeScript is a commit someone reviewed, not a surprise on a Tuesday.
TypeScript is held at `6.0.3` on purpose: `typescript-eslint@8` declares a peer
of `>=4.8.4 <6.1.0`, so TypeScript 7 silently breaks linting.

---

## Coordinate systems

Normative copy: [`docs/physics-spec.md` §0.3](./docs/physics-spec.md). Restated
here because it is the single most expensive thing to get wrong, and because
prose is not a specification.

The simulation thinks in the **Quake frame**: `+x` forward, `+y` left, `+z` up,
right-handed. The renderer draws in the **engine frame**: `+x` right, `+y` up,
`-z` forward, right-handed.

```
(qx, qy, qz) -> (-qy, qz, -qx)
```

As a literal matrix, applied as `e = M · q`:

```
        |  0  -1   0 |
M   =   |  0   0   1 |
        | -1   0   0 |

det(M) = +1
```

`det(M) = +1` means `M` is a pure rotation and the world is not mirrored. The
naive reading — following the axis names and writing one minus sign instead of
two — gives `det = -1`, a rotation composed with a mirror. That version runs,
looks almost right, and makes every rocket-jump curve the wrong way, and no
amount of tuning the movement constants will recover it.

The executable copy is `packages/sim/src/axis.ts`; `axis.test.ts` asserts the
determinant and the basis vectors. `packages/sim` never applies `M` itself —
the conversion happens once, at the renderer boundary.

---

## Conventions that are just taste

- No semicolons, single quotes, trailing commas. Match the file you are in.
- Comments explain *why*. The code already says what.
- Ticket IDs (`GLAD-XXXXXX`) in comments where a stub is waiting on one.
