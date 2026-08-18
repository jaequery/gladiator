# AGENTS.md — conventions for working in this repo

Gladiator is a browser-native recreation of the Quake mod *Rocket Arena*:
round-based 1v1 duels, full health on spawn, no pickups, a rocket launcher and
a railgun. It runs the same simulation in the browser and on the server. Almost
every convention below exists to protect that one sentence.

Vocabulary is in [`CONTEXT.md`](./CONTEXT.md). Physics numbers are in
[`docs/physics-spec.md`](./docs/physics-spec.md); renderer settings and their
reasoning are in [`docs/renderer.md`](./docs/renderer.md); the audio
architecture and the sounds themselves are in
[`docs/audio.md`](./docs/audio.md); the asset pipeline, the size budget and the
licence rules are in [`docs/assets.md`](./docs/assets.md); the input-to-photon
budget and what it is made of are in
[`docs/latency.md`](./docs/latency.md). Asset licences are
recorded in [`credits.json`](./credits.json) and rendered to
[`CREDITS.md`](./CREDITS.md), and a file that is not in there does not ship.
Deploying is [`docs/deploy.md`](./docs/deploy.md) — the runbook — and
[`NOTES.md`](./NOTES.md), the operational decisions it rests on: the region and
its latency budget, the origin allowlist, the machine class and what it costs,
and what a deploy does to a match in progress.

---

## Commands

| Command              | What it does                                          |
| -------------------- | ----------------------------------------------------- |
| `pnpm install`       | install (pnpm 10, exact versions, `--frozen-lockfile` in CI) |
| `pnpm run typecheck` | `tsc --noEmit` in every package                        |
| `pnpm run lint`      | ESLint over the whole repo                             |
| `pnpm run test`      | Vitest, once                                           |
| `pnpm run build`     | Vite (client) and esbuild (server)                     |
| `pnpm run no-physics`| fails if a physics engine has appeared in `pnpm-lock.yaml` |
| `pnpm run guardrails`| proves the boundaries reject violations                |
| `pnpm run map:bake`  | compiles `maps/*.ts` to `maps/baked/*.json` (`--check` verifies) |
| `pnpm run nav:bake`  | compiles `maps/*.nav.ts` to `maps/baked/*.nav.json` (`--check` verifies) |
| `pnpm run audio:bake`| synthesises `packages/client/public/audio/*.wav` (`--check` verifies) |
| `pnpm run lightmap:bake`| traces each map's light into `assets/textures/*_lightmap.png` (`--check` verifies) |
| `pnpm run audio:verify`| the audio acceptance checks in a real browser — own CI job |
| `pnpm run assets:build` | compresses `assets/` into `packages/client/public/` and regenerates the credits (`--check` verifies) |
| `pnpm run assets:budget` | fails if a committed asset is over 5 MB, or all of them over 24 MB |
| `pnpm latency`       | the input-to-photon budget, measured and printed — `docs/latency.md` |
| `pnpm run ci`        | all eight, in that order — the whole gate in one command |
| `pnpm run e2e`       | the browser smoke test — needs Chromium, own CI job    |
| `pnpm demo`          | record a match to a file, and replay one — `record`, `replay <file>`, `check` |
| `pnpm bot:soak`      | two bots, 200 matches of 2 minutes, and the movement's acceptance checks |
| `pnpm run raw-input` | measures `unadjustedMovement` per browser; `--write` updates `docs/browser-support.md`, `--check` fails on drift |

Two more exist and are not part of `ci`, because both write files that are then
reviewed: `pnpm run assets:vendor` re-fetches the KTX2 transcoders on a Babylon
upgrade, and `pnpm run assets:placeholders` regenerates the stand-in art.
[`docs/assets.md`](./docs/assets.md).

`pnpm bot:soak` is not in `ci` either, for a different reason: it is 45 seconds of
wall-clock, and `maps/arena1.bot.test.ts` already runs the identical claims — the
same `soakFailures` — over four matches inside `pnpm run test`. Run the soak when
you change the movement.

> `pnpm run ci`, not `pnpm ci`. pnpm reserves the bare `ci` verb
> (`ERR_PNPM_CI_NOT_IMPLEMENTED`) and will not fall through to a package
> script of that name.

## Packages

| Package             | May depend on                      | Built?                        |
| ------------------- | ---------------------------------- | ----------------------------- |
| `packages/sim`      | **nothing**                        | never — consumed as source    |
| `packages/bot`      | `sim`                              | never — consumed as source    |
| `packages/server`   | `sim`, `bot`, `ws`                 | esbuild                       |
| `packages/client`   | `sim`, `bot`, `server`, Babylon    | Vite                          |

`sim`, `bot` and `server` are consumed as source. Their `exports` point straight
at `./src/*.ts` and there is no `dist` on the resolution path, so there is
exactly one resolution condition and nothing for `bundler` and `NodeNext` to
disagree about.

**The client depends on the server, and that is the listen server.** The
authoritative host — `server/src/room.ts` and what it reaches — runs in a
browser tab as well as on Fly, which is what makes single-player the multiplayer
code path rather than a second one. See **The host** below. The arrow only
points one way: nothing in `packages/server` may import the client.

Two directories belong to no package and ship with neither build: `maps/` (the
authored maps, the nav graphs, and their baked artifacts) and `tools/` (the
bakers). Both are typechecked by the root `tsconfig.json` and linted with Node
globals; both may import `@gladiator/sim` and `@gladiator/bot`, which is why
both are devDependencies of the root `package.json`.

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

## The renderer's boundary

The simulation boundary protects `packages/sim` from the outside world. There is
a second one, pointing the other way, and it protects the outside world from
*reimplementing* the simulation. Full reasoning:
[`docs/renderer.md`](./docs/renderer.md).

Babylon ships a collision system that needs no plugin and no dependency, and it
is what every first-person tutorial reaches for. Using it would not break the
game — it would produce movement that is *almost* right, which looks like a
network problem, gets diagnosed as a network problem, and is not one.

Banned in `packages/client` only, by ESLint, each with its reason:

| Banned | Because |
| ------ | ------- |
| `checkCollisions`, `moveWithCollisions` | a second collision system; the authoritative one is `packages/sim` |
| `applyGravity` | gravity is a simulation constant applied in 8 ms sub-steps |
| `ellipsoid` | the player is a 30x30x56 **box**, and every movement constant was measured against it |
| `attachControl` | the camera is a puppet; aim is ours and goes into the `UserCmd` |
| `enablePhysics`, `PhysicsAggregate`, `PhysicsBody` | there is no physics engine here, on purpose |
| `PostProcess`, `DefaultRenderingPipeline`, `FxaaPostProcess`, … | a full-screen pass is latency on every frame to make a *still* frame prettier |

And `pnpm run no-physics` fails if a physics engine ever appears in
`pnpm-lock.yaml` — the fence that cannot be walked around, because an engine
cannot be used without being installed. Both are proved to fire by
`scripts/guardrails.mjs`.

Two more rules that are not lintable and matter as much:

- **The camera is written from simulation state every frame and never read
  back.** `inertia = 0`, no input attached, `position` and `rotation` assigned
  rather than `setTarget`ed. `docs/renderer.md` §1.
- **`packages/client/reference/arena1.png` is a gate.** A renderer change that
  legitimately changes the picture ships its new reference in the same commit
  (`pnpm run e2e -- --update-reference`). A re-shoot in a commit that was not
  supposed to change the picture is the question the gate exists to ask.
- **What a player model is doing comes from `EntityState`, never from the
  scene.** Animating an opponent from what the renderer can see — run when the
  mesh moves, land when it stops falling — is a guess about a simulation that is
  authoritative somewhere else, and it is wrong under exactly the conditions
  nobody tests. `render/animState.ts` takes a deeply-`readonly` **copy** of the
  fields it may read and folds it into an animation state; nothing downstream
  can reach `GameState`. `docs/renderer.md` §11.

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
against: advance the PRNG, move players, fire weapons, move rockets, expire,
advance the match. Adding a phase means deciding where it goes, once, for
everyone — and two of those adjacencies are mechanics rather than bookkeeping
(see **The weapons layer**). The round rules run last, after damage has landed
and rockets have gone, so a death is visible to them on the tick it happened.

`tick()` is handed two things it never writes: the `CollisionWorld` and the
`SpawnPlan`. Both are functions of the map, so neither is cloned, hashed or
snapshotted. The plan may be `null` for a world with no match running in it —
which is every physics test — and a running match ticked without one throws
rather than quietly stopping between rounds.

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
defined in `usercmd.ts`; the weapon ids are `weapon.ts` and what they *do* is
the table in `weapons.ts` and the push formula in `damage.ts`; sine and cosine
are `trig.ts`. Everything else imports
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

### The weapons layer

`packages/sim/src/weapon.ts` (which weapon an entity holds, and when it last
fired — netstate, because you read an opponent's weapon off their silhouette),
`weapons.ts` (the table, the muzzle, the fire phase, the railgun),
`projectile.ts` (a rocket in flight), `damage.ts` (what a hit does). Numbers and
reasoning: `docs/physics-spec.md` §3.

**Two weapons, and there is never a third.** `WEAPONS` is a two-element *tuple*
type, so a third entry is a type error rather than a review comment. Neither has
ammunition — no count in `GameState`, nothing to decrement — and the only thing
between two shots is `EntityState.nextFireTick`, one timer shared by both.

Two things in here look like details and are mechanics:

- **A rocket is a trajectory, not a position.** `trBase`, `trDelta` and
  `spawnTick`, evaluated in closed form every tick, with the delta snapped to
  whole units. Nothing accumulates, which is what lets the wire mention a rocket
  exactly once (GLAD-5QGO11 builds on this).
- **The trajectory clock starts 50 ms in the past**, so a rocket is 45 units
  downrange on the tick it is fired. That is why a rocket at your feet detonates
  on the frame you press the button rather than the one after.

And one ordering, in `tick()`: **players move, then fire, then rockets move.**
`PM_CheckJump` assigns `velocity[2]`, so splash applied before the movement
phase would be overwritten by the jump it was meant to add to. Fire before move
and there is no rocket jump — the game still runs and still looks right, which
is the worst kind of wrong.

`ROCKET_JUMP_LAUNCH` is derived here — splash damage through the knockback
formula — and re-exported by `map/reachability.ts`, so changing the splash
damage fails the reachability tests instead of quietly re-tuning every ledge in
`maps/`.

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

The biggest of those rules is **reachability**: every surface a player can stand
on has to be one they can get to from a spawn, by walking or by one of the four
climbs the movement makes — 18 stepped, 48 jumped, 166 rocket-jumped, 395 with a
jump and a rocket. `map/reachability.ts` samples the map with the real player
box and the real trace and works out which; `docs/physics-spec.md` §5 is where
the numbers come from and what the analysis does and does not prove. Two things
about it are load-bearing and non-obvious: a sample is *dropped* on to a surface
rather than placed on it, because a box rests on its uphill edge on a slope; and
falling does not count as reaching, because a ledge you can only drop on to is a
ledge you can only leave.

Client and server exchange `mapHash` in the handshake and refuse the session if
it differs, because the client deploys to Vercel and the server to Fly and
never at the same instant. `PROTOCOL_VERSION` covers the message shapes; the
map hash covers the world they describe.

**The client and the server simulate the map they draw.** Both load `arena1`,
verify its hash, exchange it, and tick `LoadedMap.world` — the collision world
built from the same brush list `map/geometry.ts` cuts the render mesh out of. So
what you can walk on is what you can see, across the network, by construction.
Both spawn through `createMapState`, which lives in the simulation rather than in
either of them because two peers that compute a spawn point separately are two
peers waiting to disagree about it — and which now goes through the spawn system
below rather than taking `spawns[0]`.

`arena.ts` stays, and is not dead: `packages/sim` cannot import `maps/` —
`rootDir` is `./src`, and the package has no filesystem — so the kernel's
default world and the golden replay's world are still the hand-written brush
world there. Nothing that ships ticks it.

The arena played on is `maps/arena1.ts` — "Crucible", GLAD-B8DI4J. It bakes, it
is asserted against the movement in `maps/arena1.test.ts`, and the two
`import baked from '.../arena1.json'` lines in `packages/client/src/map.ts` and
`packages/server/src/map.ts` are what point the game at it. Those two lines are
the whole of the choice, which is why the map is a *value* and not a parameter:
one machine serves one arena, and a client that loaded a different one is
refused at the handshake rather than allowed to play a world nobody is
authoritative over.

`maps/testbed.ts` stays and is still baked, but nothing plays on it. It is the
fixture the map pipeline and the tracer are proved against — a wall at a known
x, a 1:1 ramp, a pane of `nonSolid` glass — and `packages/server/src/map.test.ts`
deliberately splits its assertions along that line: what must be true of
*whichever* map ships is asserted against `SERVER_MAP`, and what is a fact about
specific geometry is asserted against the fixture. Point the coordinate tests at
the shipped map and the suite starts measuring the level designer.

### The spawn system

`packages/sim/src/match/spawn.ts`. Numbers and reasoning:
`docs/physics-spec.md` §6.

Two policies are decided there rather than discovered in a duel, and each one is
a constant with the argument next to it: **telefrag** (the arrival lives, the
occupant dies) and **spawn protection** (`SPAWN_PROTECTION_TICKS` is zero, and
the seam is `isSpawnProtected` so turning it on is one number). The third — how
long the gap between rounds is — belongs to the round rules below.

The expensive half is geometry and it happens once. `buildSpawnPlan` works out
which *pairs* of a map's spawns are far enough apart and cannot see each other —
nine sample points per body, both directions, with the same `traceRay` the
railgun will use. A round start is then two draws from `state.rng`: which pair,
then which end each player gets. That is what makes a replay reproduce a match,
and it is why `map/validate.ts` refuses a map with no legal pair.

Two things in there look incidental and are not. `spawnRound` moves **both**
bodies before either is allowed to telefrag anything, or a player standing where
the last round left them would be killed for it. And a respawn **reuses** the
slot's entity rather than making a new one, so an opponent's model survives a
round boundary instead of vanishing and being replaced by a stranger.

Facing is an instruction rather than a value: the kernel overwrites `angles`
from the next `UserCmd`, so a client has to adopt the spawn yaw into its own
view angles (`packages/client/src/main.ts`) or the first command a player sends
spins them back to due north.

### The round and match rules

`packages/sim/src/match/match.ts` (the shape), `match/round.ts` (the machine),
`match/selfDamage.ts` (what a hit costs). Numbers and reasoning:
`docs/physics-spec.md` §7 — which flags, at the top of that document, that its
*Rocket Arena* details are reconstructed from a readme and community wikis
rather than from source, unlike every Quake number in §0–§6.

**The whole match is in `GameState`.** `state.match` carries the phase, the
round number, the score, the phase clock and the `MatchRules` — so it is
encoded, hashed, cloned and rewound with everything else, and a replay
reproduces the match rather than only the physics. The rules are hashed even
though nothing writes them: a rule that is not in the hash is a rule two peers
can quietly disagree about.

**A world with no match in it is a match in warmup**, and warmup does nothing.
That is not a special case bolted on for the tests — it is what makes the golden
replay, the walking skeleton and every physics test behave exactly as they did
before there were round rules. `startMatch` is the single external edge out of
it, because the simulation is not the layer that knows both players have
arrived — and `resetMatch` is the single edge back *into* it, for the same
reason read from the other end: only the host knows whether a finished match has
two players left to give another one to (**The host**, GLAD-8VZ12W).

Three things in there look like details and are rules:

- **Armour absorbs 66% of every hit, rounded up** (Quake's `CheckArmor`), which
  is what makes a duel take two rockets — except your own splash, which under
  the default `health_only` mode never reaches the armour at all. **Knockback is
  derived before any of that**, so all four self-damage modes launch a rocket
  jump at the same 500 qu/s and differ only in the bill. §7.2.
- **A round ends the instant a player dies, including when both do** — a mutual
  kill is a draw, and picking a winner by entity order would hand it to whoever
  spawned first. A draw still costs a round, which is what makes the round cap
  reachable, and the cap is what stops two passive players drawing forever.
- **Rockets in the air are removed at a round end, not detonated.** A decided
  round cannot be un-decided by an explosion that arrives afterwards.

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

`demo.ts` is the same machinery pointed at a *real* match rather than a
committed fixture: same command-stream-plus-hash-trace shape, same
`firstDivergence` reading the result. See **Observability**.

---

## The host

`packages/server/src/room.ts`, and everything it reaches. It is the
authoritative side of a duel, and it runs **unchanged** behind a WebSocket on
Fly and inside a browser tab behind a loopback (GLAD-4G4W2T). One host, not a
server and an offline mode that resemble each other — the listen-server pattern,
which is how Quake, Source and most engines have always done
single-player-on-multiplayer-code.

The value is that there is no second implementation of the rules, because the
second one is always the one with the bug. The cost is a handful of constraints,
and every one of them is enforced rather than asked for.

### Two seats, one command per seat per sub-step

A room seats two peers and each has a jitter buffer (`inputQueue.ts`); every
sub-step drains exactly one command from each. That is the answer to the
question a single-seat room could dodge — whose command does a shared tick carry
when only one of them has sent anything — and the answer is *both*, with a
documented fallback for the one that is silent. A tick never stalls waiting for
a peer, because a stall on one peer's socket is a hitch in the other peer's game.

The match starts when the room fills: `startWhenFull` is the one edge out of
warmup, taken between sub-steps, because the simulation is not the layer that
knows both players have arrived. And a room with nobody in it does not tick at
all — two hundred rooms that players have created and not yet joined would
otherwise be 25,000 sub-steps a second over worlds nobody is in.

**A room plays more than one match** (GLAD-8VZ12W). A decided match used to be
where it stopped — `Over` is terminal to the simulation, so both players stood
in a world they could no longer steer and the only way back into a duel was a
reload. So `startWhenFull` also takes the *other* edge: three seconds after a
match is decided, `resetMatch` clears it and the same call starts the next one
nil-nil. Three conditions, and each rules out a different mistake — the room is
still full, nothing was forfeited, and the intermission has passed. The second
is the one worth remembering: a defeat and a forfeit are both `Over` with a
winner and only this layer can tell them apart, so restarting a forfeit would
stand a body up for nobody and duel it.

**A tick label is the peer's, not the world's.** A client counts its own
predicted ticks from one and a room counts sub-steps from one, and the two are
equal only by coincidence — a player joining a room that has been running for a
minute would otherwise have every command they ever send refused as late. That
is exactly why `ServerSnapshot.ack` is a separate field from `state[0]`.

### `Room` is isomorphic, and a test proves it

No `node:` import, no `process`, no `Buffer`, no `ws`, no `setInterval`, no
`Date.now()`. Everything from outside arrives as a constructor argument: the
map, a `Clock`, a peer-id generator, a `Log`, an optional `DemoRecorder`, and
every peer as a `Transport`.

Two layers hold that up. `room.isomorphic.test.ts` walks the import graph from
`room.ts` and fails on any of those names — the same reasoning as
`scripts/guardrails.mjs`, and it has been watched to fire. And
`packages/client` typechecks what it imports under a tsconfig with no
`@types/node` in it, so a `Buffer` in the host is a compile error in the client.

`net/wsTransport.ts` is the *only* module on the authoritative side that knows
what a WebSocket is, and `server.ts` is the Node edge around it: HTTP, the
upgrade, the origin policy, `randomUUID`. Nothing on the other side of that line
may reach back over.

### The clock never reaches the simulation

A host reads its `Clock` to notice a peer that has gone quiet, and to charge the
rate limit in front of the input buffer. It never reads one to decide how far to
advance the world: **`Room.advance(steps)` runs exactly the sub-steps it is
handed**, and the wall-clock that decided that number was measured a layer up.

That split is what makes a recorded input stream reproducible. A test can run
ten thousand sub-steps at a single instant of a manual clock and get the hashes
a real server produces over a real minute, which is what `net/parity.test.ts`
asserts by pushing one stream through a loopback and a real socket on one
schedule and requiring one trace out of both.

### The tick scheduler

`packages/server/src/scheduler.ts`. GLAD-FHKBN8. One timer for every world on
the machine: it wakes about 62.5 times a second, folds the wall-clock that
actually elapsed into a whole number of exact 8.000 ms sub-steps, and hands the
count to every room in the registry.

**It aims at the next boundary; it does not sleep an interval.** `setInterval`
fires *no sooner* than its period after the last dispatch, so every millisecond
of lateness is added to the next one and kept forever — twenty milliseconds of
slip a second is a server whose tick counter runs 2% slow, which is every
client's clock estimate walking away from it. Frame *n* is therefore aimed at
`start + n × frameMs` and the sleep is `deadline − now`, so a wakeup 3 ms late
sleeps 13 ms and the boundary does not move.

**Two things could turn a hitch into a hang and both are refused.** The measured
delta is clamped to `MAX_HOST_FRAME_MS`, so a 3-second stall buys 250 ms of
simulation once and the rest is thrown away and counted — throwing simulated
time away is *policy*, which is why `kernel.ts` deliberately does not do it. And
when the aim point has fallen a whole frame behind, the scheduler **re-aims** at
`now + frameMs` rather than marching through the boundaries it missed, because
those frames measure no elapsed time, run no sub-steps, and are pure CPU burnt
at the worst possible moment.

**`HOST_FRAME_MS` is 16, not 16.667.** Node's timers have millisecond
granularity, so 16.667 is a number this scheduler cannot ask for. And 16 is
exactly two ticks: a frame that arrives on time runs two sub-steps and carries a
remainder of exactly zero, forever, because both numbers are powers of two.

**The budget is a p99 wakeup lateness of one tick**, `WAKEUP_BUDGET_MS`. A
wakeup late by less than a sub-step lands in the same 8 ms the world was going
to be advanced through anyway; past that, one wakeup in a hundred is a whole
tick behind and every snapshot it produces is stale for every player on the
machine. It is measured on the machine class that serves players — `measure-jitter.ts`
drives the real scheduler over real rooms — logged at boot, and served live from
`/healthz` with the deploy's own verdict beside it. The numbers, and what to do
when they are over, are `docs/deploy.md`.

A tab does not need the timer half of this and uses the accumulator:
`listenServer.ts`'s `beat` calls the same `stepsFor`, because
`requestAnimationFrame` already schedules itself against the display and a
second timer chasing 62.5 Hz inside a 60 Hz frame would be two clocks arguing.

### The room registry

`packages/server/src/rooms.ts` and `roomCode.ts`. A `Map` from six characters of
Crockford base32 to a live `Room`, and that is the whole lobby: one player opens
a match, is told the code in the welcome, and sends it to somebody.

**An in-memory `Map` on one machine is not a shortcut.** Two players in one room
have to reach the same *process*, because a room is a `GameState` being advanced
125 times a second and there is no version of that which shards; a registry in
Redis would tell a second machine which code belonged to which room and have
nothing useful to do with the answer. So v1 pins to one machine and the registry
is definitionally consistent because there is only one of it. Scaling out — to a
second region, which is the only thing that would justify it — needs a
room-to-machine directory and a way to route an upgrade at it, and the argument
for when that is worth building is `NOTES.md` §1.

**The alphabet is `0123456789ABCDEFGHJKMNPQRSTVWXYZ`** — no `I`, `L` or `O`,
because a person reading a code off a screen cannot tell them from `1` and `0`,
and no `U`, so that no draw can spell an obscenity. Reading is lenient and
writing is strict: lower case folds up, `O`/`I`/`L` fold to their digits,
hyphens and spaces are dropped, and a `U` is **refused rather than folded** —
it is ambiguous with nothing, so a `U` is a typo or a guess, and mapping it to
something would turn a wrong code into a *different room*.

**An unknown code is a sentence, never a hang.** The socket opens, gets a
`fault` frame naming the code and a 4006 close, and the client prints it. A
socket that opened and then went quiet is the one failure a player cannot
diagnose, and a mistyped six-character code is the commonest thing that can go
wrong in this whole product. "That is not a code" and "no such room" are
deliberately the same sentence: telling a guesser which one they hit is telling
them their character set is right.

Thirty bits, the guess rate at the concurrency this deploy admits, and the
empty-room reaper that stops codes leaking are `docs/deploy.md`.

### Quick match is a line of rooms, not a lobby of sockets

`packages/server/src/queue.ts`. GLAD-ZHRFBK. `?queue=1` on the upgrade instead
of `?room=ABC123`: the host either seats this peer in the room somebody is
already waiting in, or opens one and parks them in it. Room codes are untouched
and stay the way two people who know each other play — a request carrying both
is answered as a *code*, because six characters somebody typed is a request for
a particular match.

**The obvious shape is the wrong one, and `net/wsTransport.ts` is why.** Holding
the sockets and building a room once two of them are in hand means parking a
socket with no handlers installed — and a socket with no handlers silently drops
what arrives on it, the first thing being the client's `hello`. A lobby would
therefore have to buffer frames and replay them into a room that does not exist
yet, which is a second delivery path for the one message whose loss takes the
whole session down. So the room comes first and the *code* goes in the line, and
everything after the choice of room is the code path room codes already take:
the handshake, the welcome, `startWhenFull`, the empty-room reaper.

**An entry is a claim about a room and it is re-checked, never trusted.**
Nothing tells the queue that a queued player closed their tab — the socket dies,
`room.ts` forgets the peer, and the entry still names a code. So every entry is
looked up in the registry the moment before it is used, and a room that has
gone, emptied, or filled by some other route is dropped. That is what makes "a
player who queues and walks away is never paired with anybody" true by
construction rather than by remembering to call a `leave()` from every path a
socket can die on. The sweep rides the tick scheduler's frame beside the
registry's own, so the number served on `/healthz` is never more than a host
frame stale.

**That re-check counts seats, not sockets** — a distinction that did not exist
when the queue was written, and one the connection lifecycle below introduced. A
seat now outlives its socket by thirty seconds, so a room with one live player
and one seat *held* for somebody mid-reconnect reads as one-of-two occupied and
is nothing of the sort: an arrival put in it is refused by `lifecycle.arrive`
after this module has already logged the pairing and told both sides it
happened. A decided match reads the same way and rejects anybody who sits down
in it. So `liveEntry` asks `room.seats` and `room.ended` — the questions the
room actually answers — and keeps the socket count only for "is anybody still
here at all", which seats genuinely cannot tell you.

**The timeout is an outcome, not a hang-up.** A minute of nobody arriving ends
the *matching* and nothing else: the socket, the room and the code all survive,
and the player is told "nobody is waiting — send this code to a friend", which
is a sentence with an action in it. Closing the socket instead would be the
server hanging up on a player who has done nothing wrong, and an indefinite
spinner would be the failure this whole frame exists to prevent. It fires once,
not once per sweep.

### The connection lifecycle

`packages/server/src/lifecycle.ts`, and `packages/client/src/net/reconnect.ts`
on the other end of the wire. GLAD-DVDV6P. Every transition is a named verdict
with a test, because this is the layer two-player room servers actually break
in: a socket closes, a peer is spliced out of an array, and what that means for
the match is whatever the rest of the code happens to do next.

**A seat is not a connection.** A *seat* is a side of the duel — a slot in the
world, a score, a body standing in the arena. A *connection* is a socket, and a
socket dies for reasons that have nothing to do with the match: a tunnel
changing, a laptop lid, a phone moving between cells. So a seat outlives its
connection by `RECONNECT_GRACE_MS` (thirty seconds), and the only thing that
proves ownership of one is the token the host mints when it is first taken and
puts in the welcome. A room code says which match; a token says which *side* of
it. On the wire that is `?room=ABC123&token=…`, which is the same URL a join
uses with proof on it.

**A vacated seat keeps its body, and the body is killable.** The room stops
feeding that slot commands, `kernel.ts` moves it as `NULL_CMD`, and the player
stands there. Removing the body instead would make pulling your network cable
the cheapest way to deny an opponent a frag they had already earned, and would
make a rocket already in the air detonate against nothing.

**Three timeouts, in the order they fire, and each one bounds the next.** The
missing-command fallback repeats the last command for ~500 ms
(`MAX_REPEAT_TICKS`) so a body comes to rest instead of running off the map; a
socket that stops answering without closing is given `DEFAULT_IDLE_TIMEOUT_MS`
(ten seconds) before the room decides the wire is gone; the seat is then held for
thirty. Worst case from "the wire broke" to "the match is forfeit" is forty
seconds, and `EMPTY_ROOM_TTL_MS` is longer than the grace window so that a room
whose *only* peer dropped is not reaped out from under their reconnect.
`lifecycle.test.ts` asserts all three inequalities, because they are exactly the
kind of relationship that survives until somebody tunes one of the numbers.

**A timeout ends the match, not just the round.** Awarding only the round would
start the next one against an empty seat and award that too, three seconds
later, until the score ran out — the same result over half a minute of watching
nothing happen. `forfeitMatch` (`sim/src/match/round.ts`) awards the round in
progress *and* the match, and sets the winner directly rather than deriving it
from the score: a player who quits while ahead leaves a score that says they were
winning and a match their opponent won, and a forfeit is exactly the situation in
which those two should disagree.

**A newer socket holding a seat's token displaces the older one.** The
alternative locks a player out of their own seat behind a connection that is dead
in every sense except that the kernel has not noticed — which is what a half-open
TCP connection is. The displaced socket is told (`replaced`, 4008) rather than
dropped, because from its side those two look identical and only one of them
means "you are now playing in another tab".

**On the way back in, the client throws away everything it predicted across the
gap.** The outbox, the pending commands (`predictor.discard()`), the render
offset and the opponent's history, and then it takes the first snapshot whole.
Replaying input across a multi-second gap draws a journey nobody made, and then
corrects it by the size of the gap. The server does the same on its side: a
resumed seat gets a *fresh* input queue rather than the one it left behind.

**Which closes are worth retrying is decided by the close code, not by the fault
frame beside it** — a socket that dies mid-write delivers 1006 and nothing else.
Anything in the application range (4000–4999) is a refusal the host wrote on
purpose and would still be true a second later, so it stops; 1001, 1006, 1011 and
1012 are moments rather than verdicts, so they back off. The backoff is
`BASE + random() * (window − BASE)` with the window doubling to a ceiling, so
every delay lands inside 250 ms–4 s by construction and a host that restarts gets
its clients back as a smear rather than a spike. It gives up on a *deadline*
(`RECONNECT_WINDOW_MS`, 45 s) rather than an attempt count, because what decides
whether coming back is worth anything is the seat's thirty seconds and a count is
a bad proxy for it under jitter.

**Draining a deploy properly is not here.** A 1001 close is what makes a client
say "reconnecting" instead of "the connection dropped", and that half is this
ticket's; stopping the machine accepting connections, handing every peer
something that survives a machine swap, and waiting for the sockets is
GLAD-G41FQ9's `shutdown.ts`, described in the section below.

**Where the two meet, and it is three lines.** A `drain` frame that arrived
before the close changes what the redial does with all three of its fields: the
ticket goes on the URL beside the seat token, `retryAfterMs` becomes a floor
under the backoff (dialling a machine every 250 ms while it is being replaced is
load applied exactly when there is nothing to answer it), and the frame's own
message is left standing rather than overwritten with `disconnected (code
1001)`. The ticket is dropped the moment a welcome arrives, because everything
downstream reads a non-null drain as "a deploy is happening *now*".

And the other direction: **closing a room for a deploy is not a departure.** It
vacates no seat, starts no grace window and tells nobody their opponent left —
`Room.close` sets a `closing` flag that says so, and a test asserts the silence.
Without it a rolling deploy would forfeit every match it touched, which is the
one way to make a graceful drain worse than a hard kill.
### A deploy hands the score to the players, because there is nowhere else

`packages/server/src/shutdown.ts` and `resume.ts` (GLAD-G41FQ9). The registry
above has a consequence nobody wants and everybody has to live with: a room is a
live world in *this* process's memory, so a machine going away destroys it.
There is nothing on the next machine to reconnect *to*, which is why a reconnect
policy alone could never have been enough.

**So the score crosses and the world does not.** On SIGTERM every seated peer is
handed a `ServerDrain` frame carrying its room code, when to come back, and a
**resume ticket**: the room, the seat and the scoreline, HMAC-signed with a
deploy-wide `RESUME_SECRET`. The client comes back with
`?room=<code>&resume=<ticket>`, the next machine verifies it, rebuilds the room
under the same code, and starts the next round from spawn points like any other.
A resumed match is a duel continued, not a world restored — a world is not a
thing two peers can be handed halfway through and agree about afterwards.

**The ticket is signed for the same reason the round trip is measured on the
server.** A number that decides something must not come from the party it
decides for: an unsigned score crossing a machine inside a client would make
"resume me at 2-0" a button. The secret is shared by every machine of the app,
because the machine that reads a ticket is by construction never the one that
minted it, and a per-process fallback would pass every test and work in
production never.

**`/healthz` is readiness and `/livez` is liveness, and they are not the same
question.** The first is allowed to say no — draining, full, or the scheduler
has not run a frame in two seconds — and a `503` takes the machine out of
rotation for *new* connections while leaving the sockets already open alone.
The second never fails on purpose: the only correct response to it failing is to
kill the process, and killing a process because it is busy holding a duel is the
failure `health.ts` exists to prevent. Wakeup jitter over budget deliberately
does **not** make a machine unready — it is a machine class to change, not a
machine to take out of rotation.

**What the drain does not promise is to finish the round.** `kill_timeout` is
30 s and a best-of-five runs for minutes. What it promises is that nobody is cut
off silently: a 1001 rather than a 1006, and a ticket rather than a shrug. The
reconnect policy on the other side of that seam — backoff, grace window,
forfeit — is GLAD-DVDV6P's.

### Nothing but bytes crosses the loopback

`net/loopbackTransport.ts`. A string is UTF-8 encoded on send and decoded on
delivery; a `Uint8Array` is **copied**. The tempting implementation hands the
receiver the value the sender passed — shorter, faster, and it shares a mutable
reference between the two ends of a "network", so mutations propagate with no
serialisation, every test goes green, and the bug surfaces the first time there
is a real socket in the middle.

Delivery is a `queueMicrotask`, because a synchronous hand-off would let a
client's send re-enter the host mid-tick — a re-entrancy a socket cannot
produce, so nothing downstream is written to survive it.

Not a Web Worker, on purpose: at ~40 µs a tick the jank isolation buys nothing,
and it costs structured-clone marshalling, materially worse debugging, and — the
moment anyone reaches for `SharedArrayBuffer` — the COOP/COEP headers that break
every embed.

### Lag lives in the harness, never in the build

Zero RTT hides everything reconciliation exists for. The answer is
`net/laggedTransport.ts`: latency, jitter, loss, reordering and duplication from
a seeded PRNG, so a failure is a seed rather than an anecdote, and released by a
`pump(nowMs)` rather than a timer, so a latency matrix costs CI no wall-clock.

Jitter does **not** reorder — a WebSocket over TCP does not, so neither does the
model. Reordering is its own knob and turning it on is a deliberate violation of
the transport contract, offered so the cost of unreliable datagrams can be
measured rather than guessed at (`sim/src/transport.ts` lists what would break).

Single-player ships at ~0 ms. Do not put self-inflicted lag into the mode whose
selling point is feel.

### The client talks to a `Transport`, not to a socket

`packages/client/src/net/`: `client.ts` is written entirely against the
interface, `websocketTransport.ts` is the browser adapter, and
`listenServer.ts` is a `Room` in this tab behind a loopback pair. `?local=1`
boots one. There is no offline branch in the frame loop, because there is
nothing for one to be a branch *of*.

### The bot sits in the second seat, as a peer

`packages/client/src/net/botPeer.ts`. It opens a loopback of its own, `join`s
the room the listen server just built, sends a `hello`, and from then on sends
`cmds` frames like any other client. There is **no bot branch inside `Room`**,
no third kind of seat, and nothing the host can use to tell it from a browser on
the other end of a socket — which is the property that keeps single-player on
the multiplayer code path rather than beside it. A local callback invoked per
sub-step would have been shorter and would have skipped the input queue, the
frame guard and the admission rules; the second way input reaches the simulation
is always the one that drifts.

Three consequences worth knowing before changing it:

- **Its tick labels are its own, counted from one.** A command's label is "the
  peer's, not the world's" (`room.ts`, `join`), so the bot peer never reads
  `room.tick`. It emits exactly as many commands per beat as the host is about
  to run, which keeps its queue off both ends — starved, where the fallback
  would hold the bot's feet down, and past `MAX_BUFFERED_COMMANDS`.
- **It reads the host's `GameState` directly, and that is not a cheat.** The
  perception layer is the fairness boundary (see below), not the pipe the state
  arrived through; `tools/bot-arena.ts` hands it the same true state, and that
  is the harness its difficulty was tuned against.
- **It pays a frame of latency, deliberately.** A loopback delivers on a
  microtask, so a command decided during a beat is executed by the next one.
  That makes the bot fractionally slower rather than faster, and a human peer
  pays it too.

### Clock sync, and who holds the stopwatch

`packages/server/src/clockSync.ts`, `packages/client/src/net/clockSync.ts`, and
the two frames they speak in `sim/src/protocol.ts`. GLAD-5995PA.

Everything in this design is a shared tick number. The client simulates *ahead*
of the server so its commands land just before the server needs them, and the
server rewinds by the same measure to decide whether a railgun shot connected.
Both numbers are useless if the two ends disagree about what tick it is, and
nothing about a browser tab's `performance.now()` says anything about a Fly
machine's.

Three things are load-bearing, and the first is a security property rather than
an engineering one:

**The server pings and the client echoes.** Whoever sends the ping holds the
stopwatch, and the stopwatch has to be the server's — round-trip time decides
how far lag compensation rewinds the world (below), so a client that could
report its own RTT could report a bigger one and be handed extra rewind: it
would shoot at where you *were* and win duels it did not win. `ClientPong`
therefore carries **nothing but the id**, and there is deliberately no timestamp
field in it for anyone to helpfully add later. The residual cheat — answering
late — inflates your own RTT, lengthens your own lead and buffers more of your
own input before it executes, so it defends itself.

**One filter is a minimum and the other is a maximum, for the same reason.**
Jitter is one-sided: a packet can be delayed and cannot be hurried. So every RTT
sample is the truth plus something non-negative and the server takes the
**minimum** over a sliding window; every offset sample is the truth *minus*
something non-negative, and the client takes the **maximum**. An average is
dragged around by exactly the outliers worth ignoring. The client's estimate
then **floors** rather than rounds, because a tick counter is a step function of
wall-clock and rounding would sit half a tick ahead of the truth half the time —
free lead nobody measured.

**A correction is slewed, not jumped.** When the estimate moves, the client's
tick counter is wrong by some ticks. Jumping it means simulating several ticks in
one frame, and the camera is written from simulation state every frame, so that
jump is a jump the player *sees*. `slewMs` instead hands the frame accumulator a
few extra or fewer milliseconds, bounded to an eighth of the frame: the world
runs 12.5% fast for about 190 ms and closes a three-tick error, which is a rate
change rather than a discontinuity. Past `SNAP_TICKS` — 240 ms, which means a
backgrounded tab or a reconnect rather than drift — it snaps and admits the
lurch, because slewing that would be two seconds of a visibly fast world.

The client's lead is **feed-forward**: half the measured trip plus the jitter
buffer's target depth, and nothing else. It deliberately does *not* also steer on
the buffer depth the server reports, because the server already corrects depth
(below) and two controllers closing one loop with a round trip of dead time
between them is how you get an oscillation the player can feel.

### The input buffer policy

`packages/server/src/inputQueue.ts`. GLAD-5995PA. This is the single largest
determinant of how the game feels under a real network, so all of it is a
decision with a reason rather than an implementation accident. The executable
copy is that file's header; this is the short version, and the two must not
drift apart.

One queue per peer, drained **one command per server tick**. It holds
`JITTER_BUFFER_TICKS` (two) commands on purpose, so the next tick has something
to execute when the packet carrying it is 16 ms late. Deeper is not better:
every buffered command is latency the player paid for and cannot get back.

**The tick label admits a command; it does not schedule it.** The head of the
queue executes next, whatever it is labelled. Executing command T at server tick
T exactly would mean stalling whenever it was late — and a stall on one peer's
socket is a hitch in the *other* peer's game, which is the one failure this
policy will not accept.

| Arrives | Policy | Because |
| ------- | ------ | ------- |
| **duplicate** (tick already buffered) | dropped | the transport promises exactly-once; a second copy is a free tick of movement |
| **out of order** (below one buffered, not yet executed) | **kept**, inserted in tick order | it is still intent for a moment that has not happened |
| **late** (at or below the last executed) | dropped | applying it means rewinding the world for *input*; the world is only ever rewound for *hits* |
| **missing** | the fallback below | never a stall |

**The missing-command fallback is: repeat the last command with the trigger
cleared, for at most `MAX_REPEAT_TICKS` (62 ticks, ~0.5 s), then a command that
holds the angles and the weapon and zeroes everything else.** The three
candidates and what each costs:

- *Stall the tick* — refused outright, per above.
- *Insert an empty command* — zeroes `forwardMove` and `sideMove`, which are
  exactly the two numbers air control reads. A player mid strafe-jump drops out
  of the hop. One lost packet and the movement the whole game is built around
  visibly breaks.
- *Repeat the last command* — the player keeps holding what they were holding.
  Angles are absolute in a `UserCmd`, so a repeat holds the aim still rather than
  continuing to turn; only the movement axes and the buttons carry over, which is
  precisely the intent that was continuous.

Two clauses in that sentence are the whole decision. **The trigger is cleared**
because firing is an *edge* and movement is a *state*: repeating "still holding
forward" reproduces an intent the player still has, while repeating "still
holding fire" invents rockets they never asked for — and both weapons are fully
automatic, so it would keep inventing one every refire interval. Jump is left
alone, because `PM_CheckJump` latches on a held button and a repeat can only
preserve the state the player was in. **The repeat is bounded** because
repeat-last otherwise means a disconnected player keeps running; at half a second
the body comes to rest, so the connection lifecycle (GLAD-DVDV6P) inherits a body
that has stopped. That is this ticket's half of the disconnect policy — *when* a
silent peer is declared gone is that ticket's half, and 500 ms is deliberately
far shorter than any timeout it could reasonably pick, so the two cannot
disagree.

**Drift is corrected by consuming two commands in a tick, never by applying
two.** A client whose clock runs fast delivers more than one command per tick and
the buffer grows. When it is deeper than the target after a take, the take
consumes two and applies one, **merged**: the newer command's angles and axes,
with the buttons of both OR'd together. Applying both would advance that player
through two ticks of movement in one tick of the world, which is the speedhack.
Merging rather than discarding keeps a jump or a shot in the dropped command,
at worst 8 ms early.

**The rate limit is the actual anti-speedhack**, and it is in the only unit that
matters: commands per **wall-clock second**, on the server's clock, `TICK_RATE`
of them with a 32-command burst for a batch that arrived in a clump. Bounding the
buffer caps how far *ahead* a client can get; it does not by itself cap how much
of the world's time it can consume, because the drift correction would happily
keep consuming two per tick. A client sending 500 Hz of input has three of every
four commands refused at the door and moves at exactly the speed everyone else
does — `inputQueue.test.ts` measures that in units travelled, against a third
world simulated with no policy at all so the assertion has something to bite on.

### What a stranger is allowed to do

`packages/server/src/validate.ts`, `rateLimit.ts`, and the numbers `config.ts`
reads. GLAD-V7M6PQ. The operator's copy of every threshold is `docs/deploy.md`
under **Limits**; this is the shape of it and the four decisions inside it.

The endpoint is on the public internet and needs no account to reach. The origin
check at upgrade stops a browser on somebody else's page and *nothing else* — an
`Origin` header is a string a non-browser writes for itself. So the defence is
that the server is authoritative and distrusts everything it is handed.

**There are three limits on a connection and they answer three different
questions.** One frame's size (16 kB, both at `ws`'s `maxPayload` and in the
guard), frames per second (300, burst 60), and bytes per second (128 kB). The
second is not the command rate limit — that one is 125/s and stops a player
consuming more of the world's time than everyone else, and a client sending ten
thousand *empty* frames a second passes it trivially while spending a core on
`JSON.parse`. The third is not the size cap — 300 frames a second at 16 kB is
4.8 MB/s of individually legal traffic.

**It throttles before it disconnects, and the throttle is silent.** A frame over
the rate is dropped and not answered, because replying to a flood with one fault
per frame is answering a flood with a flood in our own direction. Only past a
hundred refusals is the connection told why and closed. An honest client at
240 Hz sends 245 frames a second and is never refused one.

**The door is a room's, not the Node edge's.** It lives under `room.ts` with
`nowMs` injected, so the listen server in a browser tab runs into exactly the
door the deployed server does — a limit that only existed on the socket path
would be a limit single-player never exercises.

**A guess at a room code costs a connection, so the guess rate is a number this
deploy chooses.** One connection a second per client address with a burst of
twenty, refused at the *upgrade* with a 429 rather than after a handshake,
because paying for a handshake per guess is paying for the attack. Behind Fly the
address is `Fly-Client-IP`, and an IPv6 one is bucketed by its /64 — a customer
handed a whole /64 would otherwise have eighteen quintillion fresh buckets. The
resulting numbers, and what a *distributed* attacker gets instead, are
`docs/deploy.md` under **How guessable one is**.

And the containment, which is the half that is not a limit at all: **a hostile
client can end its own session and must not be able to end anybody else's.** A
throw out of a `ws` handler unwinds through `EventEmitter.emit` and takes the
process, so `net/wsTransport.ts` catches at that boundary; a throw out of a
room's sub-step would leave every *other* room on the machine silently
un-ticked, so `rooms.ts` runs each room behind a try/catch and counts what it
caught as `rooms.faulted` on `/healthz`. Neither is expected to fire. That is
precisely the claim a hardening ticket cannot rest on.

The contents of a command are clamped in `sim/src/usercmd.ts` rather than out
here, because every constant that defines a legal value is in there and a clamp
on the other side of the package boundary would be a second opinion about all of
them. `sanitizeUserCmd` is total, every route in goes through it, and the one
field that *wraps* rather than clamping is yaw — 400 degrees is 40, and clamping
it would turn an overflowed spin counter into a view that teleports to due north.

---

## Prediction, reconciliation and interpolation

`packages/client/src/net/prediction.ts`, `reconcile.ts`, `interpolate.ts` and
`render/renderOffset.ts`. GLAD-6RT64L. These are the three techniques that make
an authoritative server feel local, and all three are only possible because the
two ends run the identical `tick()` — which is what the simulation boundary at
the top of this file exists to guarantee.

**The client predicts its own input immediately and keeps the unacknowledged
commands.** When a snapshot arrives it adopts the authoritative world and
*replays* everything the server has not seen, which lands it back where it
already thought it was. The wire form of a world is `sim/src/netstate.ts` and it
is the **whole** state — tick, PRNG position, next entity id, the match, every
entity — because a client that rebuilt only the entities would agree about the
picture and disagree about the hash forever, which turns the desync canary into
noise.

**Predicting means running the whole of `tick()`, so the client needs the whole
of the host's level data — not the part movement happens to touch.** `tick()`
takes a `CollisionWorld` *and* a `SpawnPlan` (**Level data sits beside the
state**, in the kernel section), and for a long time `prediction.ts` and
`reconcile.ts` passed the world and `null`. That is invisible in warmup, which
is every physics test and the walking skeleton, and fatal in a match: the
predicted world adopts the host's match phase along with everything else, so it
reaches the end of an intermission, and `advanceMatch` throws rather than
silently failing to start a round. The client died at the end of round one of
every match anyone played (GLAD-G42FEB). `client/src/map.ts` builds the plan
beside `CLIENT_MAP`, from the same artifact the server builds its own from, and
the spawn draw comes from `state.rng` — which is what makes both ends pick the
same pair rather than merely both being able to pick one.

**A frame that throws must not be able to end the client in silence.** The frame
loop in `main.ts` is the whole client — the host in this tab, prediction, the
renderer, every readout — and it re-armed `requestAnimationFrame` as its last
statement with no `catch` anywhere, so one exception stopped everything: no
frames, no ticks, no input, no menu, no message, and a canvas still holding
whatever it last drew. Reported, accurately, as a black screen with nothing on
it but a cursor. The loop now re-arms *outside* a `try` and a throw goes to a
panel that says what happened, quoting the reason rather than guessing at it
(`hud.ts`'s `fail`). `?fault=frame` causes one on purpose so the panel can be
checked in a browser, the way `?protocol=999` causes a version mismatch.

**A snapshot carries two tick numbers and they answer different questions.**
`state[0]` is how far the world has been advanced; `ServerSnapshot.ack` is how
much of *this peer's* input is in it. They came apart the moment a fixed-rate
scheduler started draining a jitter buffer: the world advances on the host's
clock and the ack advances on whatever that peer sent, and a client that
inferred one from the other would replay the wrong commands. Two peers in one
room have one `state[0]` between them and an `ack` each.

### The correction bands

| Distance | What happens |
| -------- | ------------ |
| `< 0.1 u` | nothing; below quantisation noise |
| `0.1 to 30 u` | adopt, and carry the delta in rendering for 100 ms |
| `30 to 120 u` | adopt, carry it for 200 ms, and log it |
| `> 120 u` | **hard snap**: no offset, and the frame accumulator is cleared |

120 is one splash radius, imported from `WEAPONS[0].splashRadius` rather than
written out — it is the largest displacement the game can legitimately hand a
player in a tick, so anything past it is a teleport, a telefrag or a desync.

The structural rule underneath all four rows: **the simulation always takes the
authoritative value immediately; only rendering lags.** A world left
half-corrected is the world the *next* replay starts from, so the error
compounds instead of decaying while every individual correction looks
reassuringly small. `render/renderOffset.ts` is the only place a correction is
allowed to be soft, it lives outside `GameState`, and it decays linearly so that
it is over exactly when it says it is.

### The opponent is never predicted

You have no knowledge of a remote player's future input, so they are drawn
80 ms in the past from real data, between two states the server actually
produced. The cost — you shoot at where they were — is paid back by lag
compensation rewinding them to exactly there (**Lag compensation, and predicted
self-splash**, below). The two are halves of one design, and the 80 ms is one
number in one place — `sim/src/lagcomp.ts` — because the host rewinds by exactly
what this draws by.

**The interpolation clock is its own clock and it is slewed.** Rendering at
`newestSnapshotTick - delay` directly is the classic mistake: the newest tick
advances in whatever lumps the network delivers, so mathematically correct
interpolation between correct states visibly stutters because the *clock* is
stuttering. `interpolate.ts` therefore advances a render tick by wall-clock and
*tracks* the target by running a few percent fast or slow — the same shape as
`clockSync.ts`'s slew, and bounded below zero so the clock can never reverse.
`interpolate.test.ts` measures the second derivative of the drawn track against
the same trajectory drawn from perfect knowledge, and against the naive
implementation as a control.

**The buffer covers jitter and reordering. It does not cover loss.** The
transport is a WebSocket, which is TCP, and TCP does not drop data — it
retransmits it, which stalls everything behind the missing frame for about a
round trip and then delivers the lot in a burst. What covers that is
extrapolation, capped at 250 ms, and then the honest admission that the
opponent's position is a guess. `laggedTransport.ts` models it that way:
`retransmitMs` is what a lost frame costs, and setting it to zero gives a
*datagram*, which is a deliberate violation of the transport contract kept for
the same reason `reorderChance` is.

### The lead, and the two clocks it takes to hold it

The client runs **ahead** of the host, by half the measured round trip plus the
jitter buffer's target depth, so its command for sub-step *T* is in the host's
buffer before the host gets there. Without that the two run at the same rate in
the same phase, every command arrives one one-way trip after the tick that
wanted it, and the host spends the match on the missing-command fallback. The
lead is closed by *slewing* — the frame accumulator is handed a few percent more
or fewer milliseconds — rather than by jumping, for the reasons `clockSync.ts`
argues at length.

**What is slewed is `commandTick`, and it is not `predictor.tick`.** A client
carries two tick numbers and conflating them is the trap:

| Number | Whose | Written by |
| ------ | ----- | ---------- |
| `predictor.tick` | the *server's* — a snapshot overwrites it sixty times a second | reconciliation |
| `commandTick` | the *client's* — free-running, and what a command goes out labelled | the frame loop |

Steering the first would be steering on a number the host keeps resetting: the
slew pushes forward, adoption pulls back to whatever the host has actually
executed, and the two fight until every command goes out under a label the host
has already run — which is exactly what happens, measurably, if you try it. The
second is nobody else's, so the lead it builds stays built. `predict(cmd, label)`
is where they part company, and the default is the first for a caller with no
clock estimate.

### What is measured, and where

`packages/client/src/net/netcode.test.ts` plays a minute at 60 frames a second
over LAN, 40, 80 and 180 ms links, all four with jitter and retransmitted loss,
against a real `Room` driven by the real scheduler in virtual time. It asserts
no hard snaps, no dropped commands, corrections over a unit inside each link's
budget, and — the containment mechanism — that after the network goes quiet the
client's world differs from the host's by **exactly the input the host has not
seen yet** and nothing else, having been overwritten and rebuilt sixty times a
second for a minute in between.

Lint catches the imports somebody anticipated; two worlds that have to end in
the same place catch the category — an engine collision routine, a camera read
back into the simulation, a stray `Math.random`, a field the wire codec forgot.
The exact codec claim, over a real socket, is `server/src/integration.test.ts`,
which decodes every snapshot and requires it to hash to what the host announced.

### What the numbers actually are, and the one that is not good enough

Measured over a minute per profile, with the fixed-rate scheduler and a two-tick
jitter buffer:

| Link | Host sub-steps on the fallback | Corrections over 1 qu |
| ---- | ------------------------------ | --------------------- |
| LAN | 0.05% | 0.13% |
| 40 ms | 1.1% | 1.4% |
| 80 ms | 4.5% | 4.9% |
| 180 ms | 26% | 30% |

The first three are inside the 5% the acceptance check names. **The fourth is
not**, and it is a property of the design rather than a bug in it: 180 ms round
trip with ±25 ms of jitter is ±3 sub-steps against a buffer that holds two on
purpose, and `inputQueue.ts` argues that depth at length — every buffered
command is latency the player paid for and cannot get back. Raising
`JITTER_BUFFER_TICKS` to five halves the 180 ms number and costs *every* player
24 ms of input latency on every link, which is the trade this game refuses.

The real answer is a buffer that adapts to the jitter the server already
measures, rather than a constant. That is a ticket of its own, and until it
exists the 180 ms budget in `netcode.test.ts` is a recorded number and a
regression gate rather than a target anybody is happy with.

### What is deliberately not here

**Two peers are still not measured through one harness.** `netcodeHarness.ts`
seats one, because what it exists to measure is *this* client's prediction
against an authoritative world, and a second peer would add a second
uncontrolled input stream to a comparison that is about one. Two peers in one
room over two real sockets, with a match played to a decision, is
`server/src/duel.test.ts`; entity interpolation is `interpolate.test.ts` against
a real simulated trajectory on a jittery delivery schedule.

---

## Lag compensation, and predicted self-splash

`packages/sim/src/lagcomp.ts` and `splash.ts` (the arithmetic and the two seams),
`packages/server/src/lagcomp.ts` (the history and the rewind),
`packages/client/src/net/rocketPredict.ts` (the predicate). GLAD-5QGO11.

The section above ends with a cost: the opponent is drawn 80 ms in the past, so
you shoot at where they were. This is where that is paid back, and where the one
thing a client is allowed to guess about its own rocket is bounded.

### `TickHooks` — the third thing `tick()` is handed and never writes

Beside the `CollisionWorld` and the `SpawnPlan`, and unlike both of them: those
are functions of the *map*, and this is a function of **who you are**.

| Hook | Who fills it in | What it is for |
| ---- | --------------- | -------------- |
| `rewind` | the host | put the world back the way the shooter saw it, for one hitscan trace |
| `selfSplash` | a predicting client | decline to be thrown by a rocket it cannot vouch for |

Neither peer can do the other's, and neither is something the simulation could
decide for itself. `null` — the default everywhere — is the simulation exactly as
it was before any of this existed, which is why adding the parameter moved no
hash in `determinism.test.ts`.

### How far back, and why it is that number

```
viewTime = serverNow - clamp(rtt / 2 + INTERP_DELAY_MS, 0, MAX_REWIND_MS)
```

Half the round trip is how stale the newest snapshot the shooter had was; the
interpolation delay is how much further back they were drawing it. Together they
are the age of the picture that was aimed at.

**`INTERP_DELAY_MS` lives in `packages/sim`.** It used to be
`client/net/interpolate.ts`'s private constant and stopped being one the moment
the host started rewinding by it — `packages/server` may not import the client,
so two copies would drift apart by one edit and the symptom would be rails that
miss by a fixed amount nobody could account for.

**The round trip is the server's measurement and there is no path for any
other.** `ClientPong` carries nothing but an id, on purpose (`protocol.ts`): a
client that could report its own round trip could report a bigger one, be
rewound further, and win duels by shooting at where you used to be. The 300 ms
cap is a second line behind that one — at 120 ms a strafe-jumping target is 42
units from where they are drawn, and past about a third of a second "I was behind
cover" and "I was shot" stop being distinguishable to the person who was hit.

Three details in the implementation are decisions rather than mechanics:

- **The sample is interpolated, not snapped.** `rewindTicksFor` is deliberately
  fractional and the ring reads between the two entries either side of it.
  Snapping to the nearest recorded tick throws away up to half a sub-step of the
  target's motion — 1.28 units at run speed, more than twice that on a strafe
  jump — for a lerp that costs nothing.
- **Only the target moves, and only `origin`.** The shooter is predicting
  themselves and is effectively in the present. Health, velocity and the
  knockback timer are *effects* of the shot and belong to it; restoring them
  would be undoing the shot.
- **The restore is a `finally`, and the seam's shape is what forces it.**
  `HitscanRewind` takes the shot as a function rather than being a `begin`/`end`
  pair, so there is exactly one place a rewind can be left half-undone. An
  exception escaping mid-trace would not crash anything — it would quietly play
  the rest of the match with one body 200 ms in the past.

**A rocket is compensated in where and when it is born, and never again.** The
muzzle is the shooter's own position at the sub-step their command executed and
`spawnTick` is that sub-step, so both peers evaluate the identical closed form
(`projectile.ts`). It is never forward-simulated by the shooter's latency — at
900 qu/s, 150 ms would teleport it 135 units, past its own splash radius and
through thin geometry — and the players it flies at are never rewound, or you
would be hit by rockets that visibly passed behind you.

### The one thing a client may guess about its own rocket

Quake 3 predicts no self-knockback at all: a rocket jump launches you one round
trip late. This client can do better, because it runs the identical `tick()` and
already knows what its own rocket is about to do — but only when the flight is
genuinely unobstructed, and **that clause is load-bearing**.

You draw the opponent 80 ms in the past, so your rocket can pass through empty
space on your screen and clip them on the host, which detonates it short,
somewhere your splash never reaches. You predicted a 500 qu/s launch and the
authoritative world gives you none of it; at 150 ms the accumulated error reaches
about 115 units, a whisker under the hard-snap threshold. The failure mode is not
a small rubber band — it is *the player teleporting out of the air*, on the one
manoeuvre they were concentrating hardest on.

So: **predict self-splash only when the rocket's path stayed more than 32 units
clear of every opponent hitbox over its entire flight.** Otherwise that one
rocket falls back to server-only, which is a delay rather than a lie.

- **The clearance is measured by fattening the target's box**, not by a
  segment-to-box distance: "did this come within 32 units" becomes "would a
  rocket with a 32-unit hull have hit it", which is `rayBoxFraction` — the same
  code the real rocket is tested against, so the two cannot fall out of step. It
  over-approximates at the corners, and that error is deliberately in the
  direction that refuses a prediction rather than allows one.
- **It is a fold over the flight, not a forecast.** The opponent's future
  positions are exactly what a client does not have; it does not need them,
  because self-splash is applied at *detonation*, by which time every segment has
  already been checked against where the opponent actually was.
- **The answer is frozen once given.** Reconciliation re-flies a rocket every
  time a snapshot lands and the opponent has moved in between, so a re-evaluated
  predicate would make a launch appear and disappear over successive frames —
  a worse artefact than the one it prevents.
- **Only the shooter's share is deferred.** Everybody else in the blast is
  damaged as normal (`radiusDamage`'s `deferredId`); the uncertainty is about a
  launch, not about the explosion.

**The knockback window has no clock in it.** `knockbackTicks` is set by the
detonation tick and carried in the wire state, so a client that predicted the
launch arms it on the same tick the host does, and a client that deferred it
adopts the host's number and counts it down by exactly the sub-steps it replays
on top. Nothing anywhere in that path is a duration in milliseconds.

**A suppressed splash is a deliberate, bounded disagreement with the host**, and
it will show up in the hash echo for the ticks between the detonation and the
snapshot that corrects it. That is what the fallback *is*.

**Two counters, and they answer opposite questions.** *Deferred* is how often the
predicate declined to predict a launch — the mechanism working — and only
`rocketPredict.ts` can know it. *Mispredicted* is how often a launch that *was*
predicted turned out to be one the host disagreed with, and that is
`net/mispredict.ts`'s (GLAD-2E6PUO): it compares the vitals this client
predicted for a tick against the vitals the snapshot for that tick carries, which
is exact, rather than blaming a correction band that happened to land nearby.
There is deliberately only one mispredict counter — two, one exact and one a
guess, both called the same thing, is the drift the top of this file exists to
prevent. The diagnostics row prints both, because deferrals climbing means the
predicate is protecting the player and mispredicts climbing means it is not
conservative enough.

---

## The bot's navigation data

`packages/bot/src/nav/`, authored in `maps/*.nav.ts`, baked by `pnpm nav:bake`
to `maps/baked/*.nav.json`. Reasoning lives in `nav/schema.ts`; this is the
shape of it.

**A hand-placed waypoint graph, not a navmesh, and not AAS.** Quake 3's AAS was
built to need zero authoring across thirty shipped maps plus every map a
stranger would ever make, and it cost 626 areas and 88 seconds of compile on a
duel map this size. Gladiator has one arena and sixty-odd meaningful positions.
The deciding argument is not the compile time: **the link types are the
design**. "This gap is a jump", "you drop off here and cannot get back up" is
level-design intent, and a generator can only discover what the geometry
happens to admit.

**Links are directed and there are four kinds** — `walk`, `jump`, `drop`,
`teleport` — each mapping to exactly one traversal controller in the bot's
movement (`packages/bot/src/travel/`). `rocketjump` is a v2 kind. Until it exists the
positions only a rocket reaches are tagged `perch` rather than `ground`, and
nothing routes to them. That is the data telling the truth; linking them with a
jump the movement cannot make would make the routing guarantee pass and the bot
walk into a wall.

**Every `ground` node routes to every other one, and the bake refuses a graph
where one does not.** It is the same rule `map/reachability.ts` enforces for the
map, at the level the bot actually uses, and it is what makes "the bot can
always get there" a property rather than a hope.

**A path query is one array read.** Floyd-Warshall runs once at bake time over
seventy nodes and its next-hop and cost tables are committed; so is a
node-by-node visibility bitset, which turns "can I see that position" — the
lookup underneath *breaking* line of sight — into a bit test. Nothing in
`nav/query.ts` may contain a loop whose length depends on the node count;
`query.test.ts` proves it by counting table reads on a four-node graph and a
seventy-node one and requiring the same number.

**The artifact carries the map's hash.** Every claim in a nav graph is a claim
about where the geometry is, and all of them expire the instant a brush moves.
`loadNav` takes the loaded map's hash and refuses a mismatch, which is the
difference between a sentence at startup and a bot pathing into a wall that
used to be a doorway.

**A `walk` link is validated by walking it.** `nav/validate.ts` runs the real
`pmove` from one node to the other and checks that it arrives. A swept box
would be cheaper and it is the wrong instrument: the collision world expands a
brush's own planes by the player box, which is exact for an axis-aligned brush
and over-approximates at the top edge of a ramp, where the expanded slope juts
a few units into the air above the surface. `StepSlideMove` steps over that and
a static sweep at a fixed height does not.

---

## The bot's perception, and the fairness boundary

`packages/bot/src/perception/`, `brain.ts`, `bot.ts`. GLAD-V7CMHR. The argument
lives in `perception/worldModel.ts`; this is the shape of it and the three
things that hold it up.

**Only the perception layer touches ground truth. Everything above it reads
`bot.worldModel`.** That is what makes "the bot is not omniscient" a property a
test can assert rather than a promise in a comment — and the test is
`perception/fairness.test.ts`, which perturbs state the model deliberately does
not carry (the opponent's health, armour, refire timer, view angles, weapon
while unseen, position while unseen, and the world's own PRNG) and requires the
bot's `UserCmd` stream to come out **bit-identical**. Binary, and un-gameable in
the way a correlation threshold is not. Two positive controls move the opponent
somewhere the bot *can* see and require the stream to differ, so it cannot pass
by the bot standing still.

The static half is `GROUND_TRUTH_BANS` in `eslint.config.js`: nothing in
`packages/bot` outside `perception/` may name `GameState`, `EntityState`,
`findPlayer` or `.entities`. Those are the *carriers* — an opponent's vitals
cannot be reached without one — so banning them is a complete ban on the leaves
without having to ban `.health`, which the bot legitimately reads about itself.
`scripts/guardrails.mjs` writes the same probe on both sides of that line and
requires a failure and a pass, because an exemption nobody has watched is a hole.

### The gap in Quake 3 this exists to close

Q3's `BotFindEnemy` applies a distance-scaled field of view at *acquisition*,
and then `BotAimAtEnemy` calls the visibility check with a **360-degree** FOV.
So once a Q3 bot has seen you it tracks you through walls, forever, with nothing
to decay. That single asymmetry is the actual source of "the bot knew where I
was". Here there is one entry point (`perception/sight.ts`), acquisition and
maintenance are two thresholds on the *same* number, and everything after the
last observation is 2.2 seconds of decay.

### The four channels

| Channel | What it gives | What it deliberately does not |
| ------- | ------------- | ----------------------------- |
| **sight** | an exact position and velocity | anything outside a 100-degree cone, past 3000 units, or behind geometry |
| **sound** | a bearing wrong by up to 22 degrees and a range wrong by a quarter | a position — that would be a wallhack with a nicer name |
| **damage** | the attacker's *direction*, off the knockback | a range; the state carries no attacker at all |
| **memory** | the last belief, dead-reckoned and blurring | anything after 2.2 seconds — the contact is *cleared*, not faded to a small number |

Three things in there are decisions rather than details:

- **The visibility fraction's three rays are weighted an eighth, a half and
  three eighths** — feet, chest, eyes. Equal thirds would make "at least a
  quarter visible" and "at least something visible" the same predicate, and one
  of the two thresholds would be dead code. Weighted, a pair of legs under a
  railing is 0.125: not enough to *spot* somebody, enough to keep tracking one.
- **Footsteps stop below 140 qu/s**, which is the player's stealth option and
  the reason it is a threshold on speed rather than a constant `true`. `UserCmd`
  has no walk bit yet; the day it grows one, this becomes the speed it caps you
  at.
- **The sound channel draws from the PRNG strictly after its range gate has
  passed.** A draw taken on a sound the bot could not hear would advance the
  stream by an amount that depends on where the opponent is — a leak arriving
  through the one door the mutation test does not look at.

### Two clocks

Perception runs every sub-step; the decision layer runs every six of them
(`brain.ts`, 20.8 Hz — 125 is not divisible by 20 and a fractional interval is a
phase that drifts). Quake's 10 Hz brain is visibly a beat behind at these
speeds. Turning the standing decision into a command happens every sub-step,
because a turn is a *rate* and a rate sampled at 20 Hz is a staircase.

**The bot's PRNG is seeded and it is not the sim's.** The bot is a client
producing input, not a peer producing a world, so it is not required to be
bit-identical with the server — which is exactly why it lives in `packages/bot`
and may use `Math.atan2`, banned inside `packages/sim`. It is *seeded* rather
than ambient so a headless bot match replays.

`BotDecision` is the seam the rest of the bot is built on: `decide` fills in `aim`
and `goal`, the movement layer below turns `goal` into a route and a stick position
(GLAD-TSED8V), and aim, weapon choice and firing fill in `weapon` and `buttons`
(GLAD-HK3ATM). Neither reaches past it.

---

## The bot's movement

`packages/bot/src/movement/`, `travel/` and `stuck.ts`. GLAD-TSED8V. The argument
lives in `movement/move.ts`; this is the shape of it.

**The bot emits exactly the struct a human emits.** Buttons, yaw, pitch, two move
axes on `-1/0/+1`, once per sub-step, through the door the network uses. There is no
"move to point P" available anywhere in this package, which is what makes movement a
*controller*: the question is which of nine stick positions, given the yaw the aim
controller chose, produces velocity towards P under the friction and acceleration
model. `tools/bot-writes.test.ts` is the static half of that claim — no bot module
may call `pmove`, `tick` or anything else that writes a body, and none may assign a
position, a velocity or a vital to a record it does not own.

It costs real work and it is worth it three times over: players detect impossible
motion long before they detect good aim; bot-versus-bot matches exercise the real
movement, so a bug in air acceleration shows up as bots failing to clear a gap
rather than as a mystery; and a bot match records as a command stream that replays
exactly.

### One controller per link kind, and the set is closed by the type

`travel/` — `walk`, `jump`, `drop`, `teleport`, dispatched through a table that
`satisfies Record<NavLinkKind, Traveller>`. A fifth kind (`rocketjump` is the one
coming) fails to compile until it has a controller, which is the difference between
a closed set and one nobody has added to yet. A controller answers two questions —
which direction, and whether to press jump — and reports whether the hop is done. It
does not choose the link and it does not touch the ledge guard.

### The three runtime guards

1. **Ledge guard** (`movement/ledge.ts`). Before committing forward movement, trace
   a *point* down at the projected position; if there is no floor within a step, try
   the direction rotated 45 and then 90 degrees either way, and brake against the
   velocity if every one of them is a hole. The lookahead is a **stopping distance**
   rather than a constant, because releasing the stick does not stop a body at 380
   ups. It is switched on by the follower and off for exactly `drop` and `jump` —
   the two kinds that mean "there is supposed to be nothing under you".
2. **Link ownership.** The bot is on **exactly one** link and keeps it until the
   controller says it arrived, the bot is displaced off it, the hop runs out of
   `navLinkBudget`, or the goal moves while it is on the ground on a `walk`. It
   deliberately does *not* re-ask the graph every sub-step: `nodeNear` flips to the
   far node halfway along a link, so a follower that re-derived every tick would cut
   corners — and a cut corner is a straight line across geometry nothing validated.
   Falling while the link is a `walk` is a **bug and a test assertion**, not
   something fixed up at run time.
3. **Airborne recovery.** The axes are latched at take-off and held. Air
   acceleration is a tenth of the ground figure, so a stick oscillating mid-air buys
   nothing and reads as a machine; the only two things that change a latched heading
   are the circle jump's bounded offset window and a single permitted correction when
   the flight is carrying the bot away from where it was going.

**No two consecutive commands carry `BUTTON_JUMP`.** `PMF_JUMP_HELD` is cleared
only by a sub-step with the button up (`pmove/index.ts`), so a bot that held jump
would jump once and never again. Quake has a second reason and this game does not:
`pmove/cmdscale.ts` excludes the jump axis on purpose, so there is no 320-to-226
wishspeed tax to avoid.

### v1 does not strafe-jump

Continuous strafe-jumping needs the yaw coupled to the current speed, and the yaw
belongs to the aim controller — a bot that strafe-jumps cannot aim while it
accelerates. So v1 takes **one circle jump at the start of a straight run**:
`movement/circleJump.ts` holds the wish 45 degrees off the direction of travel for
24 sub-steps, which measured 369 ups and 29 units of drift down `arena1`'s south
lane, and leans into whichever way the route bends next so the drift pre-turns a
corner the route was taking anyway. Four hops in five land over run speed; the
remaining one clips geometry mid-flight, which is why the test asserts the
distribution rather than the slowest landing.

Three preconditions, and each is a reason not to hop: the run has to be 320 units
of straight *route* (not of link — `arena1`'s links are 140 to 210, and hopping per
link is a bot bouncing), the bot has to already be at 280 ups, and its velocity has
to be within 37 degrees of where it is going. That last one was missing at first and
it mattered: the trigger fires on the sub-step after a corner, where the bot has 320
ups pointing the way it came, and the hop launched it backwards into the wall.

### Being stuck

`stuck.ts`. One anchor and one clock: 32 units of progress resets them, three
seconds without it starts a bounded recovery (back off, then go around with one jump
in it, alternating sides between episodes), and four seconds emits `NAV_STUCK` with
the position in it — a seam a host fills in, like `onSpeedClamp`, because this
package has no `console`. The clock only runs while there is something to walk
towards, which is what stops it firing at a bot holding an angle, a dead one, or an
intermission.

**It never writes a position.** Nudging the body out of the wall is four lines and
works every time and is a teleport, which is the one thing no human can do.

### Search behaviour, and why the bot is never idle

`movement/roam.ts`. `decide` stops setting a goal once a contact is inside
`ENGAGE_RANGE`, and that means *stop closing* rather than *stop moving* — so the
absence of a goal is answered with a `ground` node drawn from the bot's seeded
stream. Uniform rather than biased towards the opponent, because a search that
leaned towards where they *are* would be reading ground truth through the choice of
where to look. Standing still needs a flag on `BotDecision`, so that it is always a
decision somebody took rather than a gap in the ladder; nothing wants one today.

### What is measured, and where

`tools/bot-arena.ts` runs two bots through the real `tick()` and measures the world
rather than the bot's own bookkeeping — the stall clock in particular is the
harness's own, because asking the detector whether it thinks it is working is not a
test. `pnpm bot:soak` is 200 matches of 2 minutes (3,000,000 sub-steps, 45 s of
wall-clock) and `maps/arena1.bot.test.ts` is four of twenty seconds through the same
`soakFailures`. Over the full soak: nothing outside the map AABB, nothing landing
below a walk link, the worst stall 414 of 563 permitted sub-steps, and the view
never turning faster than `MAX_TURN_UNITS`.

One trap in that harness is worth knowing before writing another one: a bot's
`MoveState` is computed from the body's position **before** the sub-step, so reading
the two after `tick()` compares a decision against a position it never saw. On a
ramp that reads as a 30-unit fall and looks exactly like the bug the soak is looking
for. `actBotArena` and `advanceBotArena` are split so a watcher can sit between
them.

---

## The bot's aim, and its combat

`packages/bot/src/aim/` and `combat/`. GLAD-HK3ATM. The arguments live in
`aim/error.ts` (why it misses) and `combat/rocketAim.ts` (why it aims at the
floor); this is the shape of it and the five things that are decisions rather
than implementation.

### A bang-bang servo, explicitly not Quake 3's integrator

`aim/controller.ts` carries an angle *and an angular rate*, and drives the rate
at the acceleration limit in whichever direction the switching curve says. That
one choice produces the shape a human aim has: a hard flick that runs out to the
turn rate, a brake that starts before the target, and a settle with no bounce.
Three limits — acceleration (`AIM_ACCEL_TICKS`, 80 ms to full rate), rate
(`MAX_TURN_UNITS`), and one angle unit of quantisation — and a short correction
is governed entirely by the first while a 180 spends most of its time on the
second, out of the same two lines.

Q3's `BotChangeViewAngles` is *not* transcribed, unlike every Quake physics
number in this repo: its `speed += (speed - desired)` has the wrong sign, which
is where the characteristic Q3 crosshair shiver comes from. It is a bug, not a
design.

**The braking distance is `v^2/2a - v/2`, not `v^2/2a`.** The sub-step order is
decelerate-then-move, so the discrete distance is half a sub-step's travel less
than the continuous formula — and using the continuous one made the servo
overshoot by a fifth of its travel and then hunt back across the target, which is
the Q3 artefact arrived at from the other direction. `stopDistance` is the closed
form; `aim/controller.test.ts` asserts no overshoot at five distances.

### Three error sources, and each answers a different question

| Source | What it models | Where |
| ------ | -------------- | ----- |
| **the track** | how long it takes to notice a change of direction | `AimTrack` |
| **displacement error** | how much harder aiming at empty space is | `errorRadius` |
| **motor error** | hands | `AimNoise.motor` |

**The reaction is an interpolation, not a delay.** Freeze-then-snap makes a bot
*perfect* the instant the timer expires; what a person does is keep tracking
their stale prediction and blend onto the fresh one. `AimTrack` is a
constant-velocity belief, dead-reckoned every sub-step and pulled towards the
perceived one by `1 / reaction` of the difference — so a straight-line runner is
tracked with **no lag at all** and somebody who cuts costs a full reaction time.
Both halves are asserted, because either alone would pass for the wrong model.

**Error is proportional to displacement from the reference point**, and the
reference is the believed body centre — what the bot can actually see. A rail at
a visible body is exact; a splash at the feet is 24 units off and so 6 units
wrong; a 200-unit lead is 50 units wrong. "Aim is harder when you are guessing"
therefore needs no skill table and no per-weapon accuracy, and a bot that stops
leading stops paying for it.

The reaction is *also* a hard gate on the trigger, armed by acquisition:
becoming visible after more than `SIGHT_HOLD_TICKS` out of sight draws a fresh
one. Under that window it does not re-arm, or a target flickering behind a
railing would be worth more than cover is.

**Every draw is gated on the model.** The error is aged on every sub-step the bot
is alive and on no other condition, so the number of draws taken cannot depend on
anything unperceived — the same argument `perception/perceive.ts` makes about the
sound channel, and the thing `perception/fairness.test.ts` would catch.

### Splash-at-the-feet is the primary rocket mode, and it is a comparison

`combat/rocketAim.ts` evaluates two candidate aim points every decision — the
body, and a floor or wall point beside it — and takes the better one under
`combat/damage.ts`'s expected damage. That is deliberately not a rule: against
somebody standing still at point-blank range the direct shot genuinely is better,
and the same two lines say so.

The objective function is a closed form over one number, the **miss radius**: the
aim error above, plus how far the target could get to that the reckoning did not
predict (their speed times the flight time times how unpredictable they have
been). Expected damage is then the linear falloff integrated over a uniform disc
of that radius, and a direct hit is the share of the disc the 30x56 silhouette
covers. As the radius grows the direct expectation collapses *quadratically* and
the splash decays *linearly*, and that gap is the whole argument.

Leading is the intercept quadratic with two corrections and a refusal. The lag
term is **negative and derived** — `MISSILE_PRESTEP_MS` is 50 ms of head start
and the command costs one sub-step, so a rocket arrives 42 ms sooner than
`distance / speed` says. It is clamped to half a second, past which linear
extrapolation of a duellist is fantasy. And **a jittering target is not led at
all**: net displacement over path length under 0.45 means strafing in place
rather than travelling, and their velocity says nothing about where they will be.

### The self-damage guard is two-sided

A bot that refused every rocket which could splash it backs away from close
range and plays visibly timid, so `combat/selfDamage.ts` is an **allowance**
(25 points at full health) that shrinks with health until it is a veto. The
prediction is where the rocket will actually *burst* — the world and the one body
the bot believes in, whichever the trace reaches first — not where the crosshair
points, which is the difference between a rocket at somebody's feet across a room
and the same aim with a pillar 40 units in front of the muzzle.

The bound is taken against `SelfDamage.Full` with no armour, the harshest mode,
because the `WorldModel` does not carry which mode the match is running and is
not going to: that would be a field added for the bot's convenience rather than
because a channel would have told a player. Under `armor_only` the bot is
conservative by exactly what its armour would have absorbed; under the default
`health_only` the bound is exact, because that mode charges half the splash to
the health and never touches the armour.

The rocket-jump exemption is a **parameter** rather than a flag on a state, so
both answers are visible at the call site. Nothing asks for one in v1 — the nav
graph has no `rocketjump` kind — and `selfDamage.test.ts` exercises both branches
so the seam is not a comment.

### A rail is a resource; a dodge is a perception problem

**Rails wait for the aim to settle** (`combat/railDiscipline.ts`): 1500 ms of
refire is most of an exchange, and a bot that only takes settled rails reads as
disciplined where one that only takes snap rails reads as lucky. "Settled" is two
numbers — the crosshair is on them, *and* it has stopped moving — and the second
produces a range behaviour nobody wrote down: a target strafing at run speed
subtends 27 angle units per sub-step at 1000 units and 67 at 400, so the bot
rails across the arena and switches to rockets in a close fight, out of one
threshold rather than a range table.

**A dodge reads `worldModel.threats` and can read nothing else.** `.entities` is
banned in `combat/` by `GROUND_TRUTH_BANS`, so a rocket fired outside the bot's
field of view is simply not in the list — the guarantee is structural rather than
a check somebody remembered. The threat is charged the same reaction the trigger
is, the test is a *closest approach* against a splash radius plus a margin
(a rocket aimed at the wall beside you is the one that kills you), and every
candidate direction is swept with the real player box first, because a rocket
landing on the wall you just backed into does more damage than one landing where
you were. Perpendicular first, then the other side, then two diagonals that lean
away; nothing runs back down the rocket's axis.

**A rocket is a resource too, and that was missed the first time.**
`combat/rocketDiscipline.ts`, GLAD-KN4QRJ. The rail's argument above — 1500 ms
of refire makes a shot worth thinking about — applies to the rocket for a reason
the rail's own file states and nobody followed up: **both weapons share one
timer**, so a rocket that was never going to hurt anybody buys 800 ms during
which the better shot arriving 200 ms later cannot be taken. The floor is on the
expected damage `combat/damage.ts` already computes and `rocketAim.ts` already
uses to pick between the two aim points — and, until this ticket, discarded
immediately afterwards.

It is deliberately **not** the angular firing tolerance, and measuring is what
settled that: tightening `rocketToleranceMaxDegrees` from four degrees to one and
a half suppressed 3.5% of rockets and moved no hit rate at all. A tolerance asks
whether the crosshair arrived at the aim point; on this map it nearly always has.
The wasted rocket is the one aimed *perfectly* at a point worth nothing, because
range and evasion blew the miss radius out to two splash radii before the wrist
did anything wrong — and an angular gate is structurally blind to that.

Two things about where it lives are load-bearing. It is at the **trigger**, not
in `planRocket`: a plan of `none` also sends `aimCombat` to `holdAim`, so a bot
that declined a shot would stop tracking the target it declined to shoot. And it
runs **before** the self-damage guard, because what a shot is worth is arithmetic
already sitting on the plan while what it costs the bot is four traces.

**A held rocket is not a lost one**, which is the thing to know before tuning it.
Holding fire does not spend the refire timer, so a suppressed shot is mostly
re-taken a decision or two later once the geometry improves. Measured, a floor of
50 points refuses 39% of rockets at the instant they are planned and reduces the
number actually fired by 12%. That is why the row it moves most is the hit rate
and the row it moves least is time-to-kill.

**A dodge arrives at the movement layer as a goal**, not as a stick position —
`BotDecision.evade` becomes a point `DODGE_PROBE` units away, so routing, the
ledge guard and the arrival test all apply to it unchanged. The only thing it
suppresses is the circle jump, because air acceleration is a tenth of the ground
figure and a hop commits the bot to a heading for a quarter of a second.

### What is measured, and where

`packages/bot/src/combat/reaction.test.ts` is the acceptance check itself: a
thousand acquisitions through the real perception layer, clock starting on the
sub-step sight first reports the opponent and stopping on the sub-step
`BUTTON_ATTACK` first appears. `maps/arena1.combat.test.ts` re-derives the
self-damage prediction and the settle predicate from every command two bots
actually sent over four minutes of duelling — from the `UserCmd`, not from the
bot's own bookkeeping, for the reason `tools/bot-arena.ts` gives about the stall
clock.

Since this ticket the bots kill each other, so rounds end on a death rather than
on the clock. Two things in the movement harness follow from that and are not
tuning: a spawn's yaw is adopted rather than turned to, so a yaw delta across a
round boundary is not a turn and is not measured; and a circle jump that took a
rocket mid-flight is not a measurement of the circle jump.

---

## Tuning the bot

`packages/bot/src/tuning.json`, `tuning.ts`, and the two harnesses that decide
whether the numbers in them are right: `tools/bot-bands.ts` and
`tools/bot-sweep.ts`. GLAD-6BIYFQ, which was time-boxed on purpose — hitting a
target distribution has no upper bound on iterations, so the box is the
deliverable. It expired with three rows a point under their floors; GLAD-KN4QRJ
closed them, and **all ten rows are inside their bands** on the committed sample.

What closed them was a knob rather than more search, which is the part worth
remembering. Coordinate descent moves one parameter at a time, and the move that
was needed was two at once — a rocket the bot declines to fire raises the hit
rates and lengthens the round together, but it also stretches the ladder, so the
floor and the skill dial had to move in the same step. A search that can only
walk one axis cannot see a diagonal.

`pnpm bot:bands` plays the sample and prints the table; `pnpm bot:sweep` searches
for a better one and `--write`s it. Both are the same code as
`tools/bot-bands.test.ts`, and the only difference between the three is `n`.

### One blob, one dial, and every number carried per bot

Every constant the tuning moved is in the JSON, and `deriveSkill(skill)` resolves
it into a `BotSkill` that rides on the bot. That is not decoration. Two bots in
one process may be at two different skills — which is what the ladder is — and a
sweep has to try a value *without restarting the process*, which a module
constant read at import cannot do.

Not in the blob: perception ranges, field of view, memory decay, the nav costs.
There is no value of any knob here that lets the bot see further, which is the
strong version of the fairness fence. Also not in it: the turn rate and the aim
acceleration, which are the **arm** rather than the skill and are shared by every
bot.

### The axis is anchored on the two rungs, not on the ends of the dial

The one structural thing this ticket got wrong first, and it is worth knowing
before touching the file. `skill` runs `[0, 1]`, the ladder is 0.45 and 0.80, and
those two rungs span **35% of the dial**. Anchoring each band on the dial's ends
therefore meant the rungs only ever differed by 35% of whatever the ends said:
measured, the shipped bot beat the novice rung 62/38 and lost to the expert rung
43/57 no matter how the ends were set, and the band table asks for 75/25 both
ways. Making the rungs far apart demanded ends that were not numbers — a negative
tremor, a reaction faster than a person's.

So a `SkillBand`'s `novice` and `expert` are the values **at 0.45 and at 0.80**,
the line runs off past them, and `deriveSkill` clamps each value where it stops
meaning anything. Those clamps are facts rather than tuning: no difficulty is
ever faster off the mark than 140 ms, and a motor multiplier that could go
negative is a wrist that pushes the wrong way.

### Skill is a decision as much as it is a wrist

The axis started as five things the hands do, and the ladder would not separate.
A duel at these speeds is decided by rockets, and whether a rocket lands depends
far more on **when the other player started moving** and on **whether the shooter
shot where they were going** than on a fraction of a degree of aim. So
`dodgeHorizonSeconds` and `leadStraightness` are on the axis too, and they are
what make the rungs mean something.

`rocketDamageFloor` joined them in GLAD-KN4QRJ, and it is on the axis for a
sharper reason than the other two: it had to be. As a fixed number it *stretched*
the ladder rather than leaving it alone — an expectation is already a function of
how good the bot is, so one threshold in absolute points refuses most of a
novice's rockets and almost none of an expert's, and raising it moved the two
ladder rows out of opposite ends of their bands at once. On the axis, with the
novice held to a lower floor than the expert, each refuses a comparable share of
its own shots. `combat/rocketDiscipline.ts` has the measurements.

A weaker bot still sees, hears and remembers exactly what the shipped one does.

### The tremor, and the turret it exists to stop

`aim/error.ts` had three error sources and all three vanish at steady state: a
rail at a visible body has zero displacement so the error radius is zero, the
servo's arrival clause lands the view exactly, and the motor error multiplies an
acceleration that has nothing left to multiply. Measured, the bot landed **two
rails in three**. Nobody does that.

What was missing is that a crosshair somebody is holding still is not still. The
tremor is an angular wobble on the servo's target, re-rolled on the reaction
period. **Angular** is the load-bearing half: a fixed angle is a lateral miss
proportional to range, so long rails are harder than close ones for the reason
they are actually harder, and the band table's two railgun rows are one mechanism
rather than a range table. It sits *inside* the settle test — the servo chases
the wobbling point and arrives — so the bot is not firing sloppily; it is firing
at where it believes the crosshair is.

### What the band table measures, and the one row that had to be interpreted

Everything is measured from the world. Shots come off `lastFireTick`, which the
sim writes when a shot actually leaves rather than when the trigger was asked
for; hits come through `onDamage`, the third observation seam
(`packages/sim/src/damage.ts`), because a rail, a direct rocket and a rocket at
somebody's feet all take exactly 100 points and two of those are separate rows;
line of sight is a ray against the map rather than the bot's own `WorldModel`,
because a perception leak would be invisible to a check that asked the perception
layer.

Two definitions are judgement calls and are written down where they are made:

- **"Meaningfully dodged"** is a counterfactual, and the first version of it was
  wrong in a way worth remembering: comparing the rocket's line against where the
  target *was* threw away every led shot, so the denominator filled up with the
  shooter's misses. Both bodies move — closest approach of two constant-velocity
  points — and the rocket counted as dodged is the one that would have landed had
  the target not changed anything.
- **The splash row counts directs too.** Quake declines to charge splash to
  somebody it already hit directly (`radiusDamage`'s `ignoreId`), which is damage
  bookkeeping rather than a statement about where the rocket went. Treating the
  two rows as disjoint would demand that 58–82% of every rocket lands on a
  duellist who is actively dodging it, and a bot that did would end a round in
  four seconds rather than the nine to sixteen the row above asks for.

The ticket is also honest that **bot-versus-identical-bot at 50% is 50% by
symmetry** and passes on a bot that stands still. It is kept as a spawn-and-side
fairness check under that name.

### The test asserts monotonicity, the CLI asserts the bands

`tools/bot-bands.test.ts` runs a hundred matches, not five hundred. Eight of the
ten rows have thousands of shots behind them either way and are asserted exactly.
The two win-rate rows have a standard error of about five points at that size
against a fourteen-point band, so asserting the band would fail about one run in
six for no reason — and a test that fails one run in six teaches people to
re-run. At the default size those two are asserted as what the acceptance check
actually claims: **the axis is monotone**. `GLADIATOR_BANDS_MATCHES=500` asserts
every row against its band instead, and that is what `pnpm bot:bands` does.

---

## The HUD

`packages/client/src/ui/`. Four modules and one rule, and the rule is the
reason there are four.

**The HUD reads a copy of the world and can reach nothing else.**
`ui/hudModel.ts` projects a deeply-readonly `HudModel` out of `GameState` — the
same trick, for the same reason, as `render/animState.ts`'s `playerNetState` —
and it is the *only* file down here that names `GameState` at all.
`ui/crosshair.ts`, `ui/feedback.ts` and `ui/hud.ts` take the copy. That is not
a convention: `ui/purity.test.ts` runs the whole pipeline over a `GameState`
whose every write throws, checks the state hash either side of it, and scans
the sources to prove the door is one function wide.

Three more things are worth knowing before changing anything in there:

- **It is drawn every frame, and the diagnostics panel beside it is not.** The
  10 Hz throttle on `client/src/hud.ts` is measured and real — a dozen
  `textContent`s a frame dirties the overlay and costs a recomposite over the
  canvas. The in-match HUD escapes it by comparing before it writes: health
  does not change sixty times a second, and the two values that do (the
  cooldown ring, the hurt flash) are quantised so that they mostly do not
  either. If you add a value here, write it through the `set*` guards.
- **Feedback is a fold over the models, keyed off the tick.** "You hit them" is
  their health going down; "you were hit" is your own health *plus armour*
  going down; where it came from is the negated knockback, kept as a world
  bearing and re-projected against the current yaw. No `performance.now()`
  anywhere — feedback that decayed against wall-clock would decay at a
  different rate on a machine whose frames are late.
- **`?hud=demo` is `dummyOpponent.ts` for the readout.** Nothing starts a match
  yet, so a landed hit, a damage arc and a round result are unreachable on a
  page today. `ui/demo.ts` scripts them, as a pure function of the tick, so the
  half of hit feedback that only a person can judge is a URL rather than a
  promise.

Layout is checked rather than eyeballed: every element carrying `data-hud-box`
is measured by `pnpm run e2e` at 16:9, 21:9 and 4:3, and must be on screen and
overlapping nothing. That set includes the diagnostics panel and the pointer
prompt, because "nothing overlaps" has to mean nothing.

---

## The menus

`packages/client/src/ui/menu.ts`, `roomFlow.ts`, `settings.ts`,
`unsupported.ts`, and the browser matrix in
[`docs/browser-support.md`](./docs/browser-support.md). Five things to know
before changing any of it.

**A page opens on a menu and connects to nothing.** The socket used to be dialled
at boot from whatever was in the query string; a menu is exactly the thing that
cannot work that way. `main.ts` now holds a `Session | null` — a `NetClient` and,
for single-player, the host in this tab — and every mode is one of three calls
into it. Before there is one, `mustHoldStill` is true and the world does not
advance, which is the same rule that already covered a socket that has not
opened yet.

That is also where the redial now lives ("The connection lifecycle" above): a
session over a socket is opened with one, built from the join URL it dialled, so
a reconnect asks for the room the player asked for even if the welcome never
arrived. A single-player session is opened without one, because a closed
loopback means the tab is going away and there is nothing on the far side of it
to come back to.

**The room code lives in the query string and nowhere else.** `?room=H7K2Q9` is
the whole lobby: it is what a host sends, what a reload rejoins on, and what the
address bar is rewritten to the moment the host mints one. A code is folded by
the *server's* `normalizeRoomCode` — imported, never restated — because a client
with its own copy of the alphabet is a second opinion to keep in step, and the
failure mode is a player being told a perfectly good code does not exist.

**Four URLs skip the menu, and they are siblings of `?shot=1`.** `?local=1` is
single-player, `?host=1` opens a room and goes straight in, `?room=` joins one,
and `?queue=1` asks for a stranger ("Quick match is a line of rooms" above).
`?host=1` is what `scripts/e2e.mjs` drives so the browser test measures the game
rather than a menu; a player never types it, they press "create a match", which
is the same call with the menu still on screen.

Each is read once, at boot, and turned into the same `startBotMatch` or
`startRemoteMatch` call a button makes — `matchIntent` in `roomFlow.ts` for the
first three and `quickMatchRequested` for the queue, which is why a page
carrying both a code and `?queue=1` joins the code: the queue is reached only
from the `menu` intent, which is the one that means "nothing was asked for".
`joinUrl` applies the same precedence again on the wire, where the host applies
it a third time. The queue has no button of its own yet, and `?queue=1` shows no
menu screen at all: the wait is `ui/queue.ts`'s panel, and a menu over it would
cover the only thing that URL exists to show.

**Sensitivity is cm/360 and it never leaves the machine.** Centimetres of mouse
travel per full turn, converted through the mouse's own counts per inch, because
a *distance* is what transfers between shooters and a multiplier is not.
`controller.test.ts` measures a full turn through the real accumulation rather
than restating the arithmetic. Settings are `localStorage` and presentation
only: the server receives angles, already quantised, and has no opinion about the
hand that produced them — a client that could tell the host its FOV is a client
that could ask for a wider one.

**Raw mouse input has three answers, not two.** `granted`, `refused` and
`unknown`, because a browser on the events-only Pointer Lock specification takes
the option, ignores it, and never says — and a game that guessed "granted" would
be a game whose cm/360 quietly means something else. The fallback warning covers
`unknown` too. Escape is the browser's: it drops the lock, the pause screen goes
up over a match that is still running, and getting back in is a *fresh click*,
never a timer — every engine refuses to re-lock straight after the default
unlock gesture, transient activation or not.

And one that is not about the menus at all: **somebody will open the room link on
a phone.** `ui/unsupported.ts` bounces them, before the renderer and before any
socket, with the code and the link still in their hands. It detects
capabilities — pointer lock, `(pointer: fine)` — and never the user-agent
string, and it lets through anything it cannot classify.

---

## Observability

GLAD-2E6PUO. Four instruments, and one rule they share: **an instrument that
costs what it measures is not an instrument.** Nothing below reads back from the
GPU, none of it is on by default in a way a player pays for, and the two that
run every frame write only when a value changed.

### Demos: the command stream, not the state stream

`packages/sim/src/demo.ts` is the format and the playback; `Room` records
(`RoomOptions.recorder`); `packages/server/src/demoFile.ts` is the disk;
`pnpm demo` is the program. `packages/server/src/demoTool.test.ts` plays a duel
through a real host, writes the file, reads it back and requires the replayed
hash trace to equal the recorded one.

**A demo is the inputs, because the world is a function of them.** That is what
`tick()` being deterministic *means*, and it is why a minute of duel is 120 KB
rather than 40 MB. Recording states would also record the *answer*, which makes
a demo useless as a determinism check — so a demo carries a hash trace on
exactly the schedule `replay.ts` samples, and "this replays" is `verifyDemo`
rather than a claim.

Two things are not in the command stream and are recorded separately, because
both are decisions the *host* takes between sub-steps: the seed and rules
(which decide the spawn draw and when a round ends), and the ticks `startMatch`
fired on. A replay that dropped the second would run the whole recording in
warmup and still look plausible.

Capture is off unless somebody asks: `GLADIATOR_DEMO_DIR` on the server,
`?dev=1` beside `?local=1` in a tab (and then `window.__gladiator.demo()`).

### The two counters that should never move

`packages/sim/src/counters.ts` installs both observation seams and tallies them.
The sim has no `console` and no counters, so each is a seam a host fills in —
`onSpeedClamp` in `pmove/index.ts`, `onSelfSplash` in `damage.ts`.

There is a **third** seam and `counters.ts` deliberately does not install it.
`onDamage` (`damage.ts`, GLAD-6BIYFQ) reports every hit that reaches a body along
with what delivered it, because a rail, a direct rocket and a rocket at somebody's
feet all take exactly 100 points and nothing outside the tick can tell them
apart. It fires several times a second in a live duel, which makes it an
*instrument* rather than a canary — the two below are here precisely because any
non-zero value is a sentence somebody has to explain, and an ordinary event does
not belong beside them. Its consumer is `tools/bot-bands.ts`.

- **The speed clamp** is a 3000 qu/s rail on a game whose best rocket jump peaks
  near 1000, and Quake has no clamp at all. Ours firing means something upstream
  produced a velocity movement cannot.
- **Self-splash mispredicts** (`client/src/net/mispredict.ts`) are the sharper
  canary, and the reason is that self-splash is a **predicate** rather than a
  trajectory: you either ate your own rocket or you did not. A correction
  distance is continuous and always non-zero, so a prediction that missed an
  explosion looks like a prediction that is 0.4 units out until it is far enough
  along to hard-snap. The ledger compares the local player's health and armour
  at a tick against the authoritative state for that tick, and attributes the
  difference to a splash only when one is close enough to explain it.

### Structured logs

`packages/server/src/log.ts`. One JSON object per line, and **`room` and `tick`
on every entry, including the entries that have neither** — null rather than
absent, so a consumer never has to branch on whether the key is there. A bug
report arrives as "room 7QK4M2, about a minute in", and those are the two
coordinates that turns into. The tick is read at write time from the room's live
world, which is why `scopeToRoom` takes a function.

It is on the isomorphic side of the line (`room.ts` imports it), so the sink and
the wall-clock are injected: `console.log` and `Date.now` in `index.ts`, an
array in a test, and nothing at all in a browser tab.

### The dev HUD, and the latency budget

`?dev=1` mounts `packages/client/src/ui/devHud.ts`: tick, round trip, pending
commands, the last predicted-versus-server error in units, snapshot bytes per
second, frame pacing, and the two counters. Opt-in and deliberately unmarked —
it carries no `data-hud-box`, because the aspect-ratio check in
`scripts/e2e.mjs` is about the readout a *player* sees.

`docs/latency.md` is the input-to-photon budget and `pnpm latency` is the
measurement, inside `pnpm run ci` so the number is in a log somebody can read.
Three of its six stages are ours and are measured; three are the player's
hardware and are declared. The one worth knowing before touching the frame loop:
**the drawn world trails wall-clock by exactly one sub-step**, by construction,
because the accumulator holds precisely the time the simulation has not run
(`client/src/loop.test.ts` proves it). The other: input is sampled once per
frame, so the wait for it is length-biased and its tail is the *frame-time*
tail — which makes frame pacing, not frame rate, the lever on how the game
feels.

---

## Assets

Full reasoning: [`docs/assets.md`](./docs/assets.md). Four things that decide
whether a change belongs here at all:

**Sources go in `assets/`, artifacts in `packages/client/public/`, and both are
committed.** Same arrangement as `maps/baked/`: the sources so the artifacts can
be reproduced, the artifacts so a build needs no encode step in front of it.
`pnpm assets:build --check` re-runs it in memory and fails on a stale artifact.
Authoring files — `.blend`, `.psd`, `.wav` — are gitignored.

**`credits.json` is the registry, and everything else about credits is
generated.** `CREDITS.md` and `packages/client/public/credits.json` both come
out of it, so the human-readable credits and the machine-readable ones cannot
disagree. Adding an asset means adding an entry: a committed file under either
directory with no entry fails the build, and so does an entry naming a file that
is not committed. **Content is CC0 only** — not CC-BY — and Mixamo is rejected
by hostname, because its licence forbids redistributing the raw files.

**A lightmap samples through the second UV set: `TEXCOORD_1` in glTF, `uv2` in
Babylon, `coordinatesIndex = 1` on the texture.** Getting it wrong renders a
plausible picture or a black one and looks like a broken bake.
`render/lightmap.test.ts` pins the whole chain against the real loader, and
`applyLightmap` is the only thing that should ever assign `lightmapTexture`.

**The arena's second UV set is computed, not exported.** Its surfaces are cut
from the collision brushes, so there is no model for Blender to unwrap;
`packages/sim/src/map/lightmapUv.ts` packs one atlas rectangle per brush face,
and it lives in the simulation package because `tools/bake-lightmap.ts` and
`render/mapMesh.ts` both call it and must not disagree about where a face's
light is.

**A `.ktx2` bigger than its `.png` is not a regression.** PNG is a transmission
format decoded to 32 bits per texel before it reaches the GPU; KTX2 is 8 bits
per texel *in video memory*, which is the constraint. Compare against
`width x height x 4`. The two Babylon settings that would undo all of it are
turned off in `render/ktx2.ts`, and proved to matter in `ktx2.test.ts`.

---

## The look

Full reasoning: [`docs/renderer.md`](./docs/renderer.md) §12 and §13.

**The arena has no run-time light at all.** Its light is baked
(`pnpm lightmap:bake`, `assets/textures/*_lightmap.png`) and its materials have
`disableLighting` on, so the biggest object on screen costs no light loop. There
is one hemispheric fill left in the scene and the arena is *excluded* from it —
it exists for the two things a bake cannot cover, the opponent's model and your
own hands. A map's `lights` are read only by the baker now, which is why
`arena1` may carry seven of them.

The arena's albedo rides in `emissiveColor` rather than `ambientColor`. That is
deliberate and documented in `render/materials.ts`: `vAmbientColor` is a
*scene*-wide multiplier the player models are tuned against, and running the
level's albedo through it would couple two things that have no business moving
together.

**The effects are a fold over netstate, like the sounds.** `render/fx.ts` is
`audio/cues.ts`'s twin: a rocket detonating is a rocket id that disappeared, a
shot is `lastFireTick` changing, and something seen for the first time produces
nothing. Every particle ages against `tick + alpha` rather than a wall clock,
which is why they are ours and not Babylon's `ParticleSystem`.

**The post-processing chain is empty and both ends are locked.** ESLint refuses
the names, `scripts/guardrails.mjs` proves it fires, and
`render/postprocess.test.ts` asserts the built scene carries no pass. A look
that needs a chain loses; the budget is spent on the bake instead.

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
