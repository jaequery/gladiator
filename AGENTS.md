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
licence rules are in [`docs/assets.md`](./docs/assets.md). Asset licences are
recorded in [`credits.json`](./credits.json) and rendered to
[`CREDITS.md`](./CREDITS.md), and a file that is not in there does not ship.

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
| `pnpm run audio:verify`| the audio acceptance checks in a real browser — own CI job |
| `pnpm run assets:build` | compresses `assets/` into `packages/client/public/` and regenerates the credits (`--check` verifies) |
| `pnpm run assets:budget` | fails if a committed asset is over 5 MB, or all of them over 24 MB |
| `pnpm run ci`        | all seven, in that order — the whole gate in one command |
| `pnpm run e2e`       | the browser smoke test — needs Chromium, own CI job    |

Two more exist and are not part of `ci`, because both write files that are then
reviewed: `pnpm run assets:vendor` re-fetches the KTX2 transcoders on a Babylon
upgrade, and `pnpm run assets:placeholders` regenerates the stand-in art.
[`docs/assets.md`](./docs/assets.md).

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

And `pnpm run no-physics` fails if a physics engine ever appears in
`pnpm-lock.yaml` — the fence that cannot be walked around, because an engine
cannot be used without being installed. Both are proved to fire by
`scripts/guardrails.mjs`.

Two more rules that are not lintable and matter as much:

- **The camera is written from simulation state every frame and never read
  back.** `inertia = 0`, no input attached, `position` and `rotation` assigned
  rather than `setTarget`ed. `docs/renderer.md` §1.
- **`packages/client/reference/testbed.png` is a gate.** A renderer change that
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

**The client and the server simulate the map they draw.** Both load `testbed`,
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

The arena to play on is `maps/arena1.ts` — "Crucible", GLAD-B8DI4J. It bakes, it
is asserted against the movement in `maps/arena1.test.ts`, and the two
`import baked from '.../testbed.json'` lines in `packages/client/src/map.ts` and
`packages/server/src/map.ts` are what point the game at it. They still say
`testbed`, because which map a room plays on is a choice with an owner
(room-to-map assignment) and a reference screenshot behind it.

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
arrived.

Three things in there look like details and are rules:

- **Armour absorbs 66% of every hit, rounded up** (Quake's `CheckArmor`), which
  is what makes a duel take two rockets. **Knockback is derived before any of
  that**, so all three self-damage modes launch a rocket jump at the same
  500 qu/s and differ only in the bill. §7.2.
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

---

## The host

`packages/server/src/room.ts`, and everything it reaches. It is the
authoritative side of a duel, and it runs **unchanged** behind a WebSocket on
Fly and inside a browser tab behind a loopback (GLAD-4G4W2T). One host, not a
server and an offline mode that resemble each other — the listen-server pattern,
which is how Quake, Source and most engines have always done
single-player-on-multiplayer-code.

The value is that there is no second implementation of the rules, because the
second one is always the one with the bug. The cost is four constraints, and all
four are enforced rather than asked for.

### `Room` is isomorphic, and a test proves it

No `node:` import, no `process`, no `Buffer`, no `ws`, no `setInterval`, no
`Date.now()`. Everything from outside arrives as a constructor argument: the
map, a `Clock`, a peer-id generator, and every peer as a `Transport`.

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

A host reads its `Clock` to notice a peer that has gone quiet. It never reads
one to decide how far to advance the world: **a command batch advances the world
by exactly its own commands**. That is what makes one recorded input stream
produce the same state hash in-process and over a real socket, which is what
`net/parity.test.ts` asserts — and the moment wall-clock decided how many ticks a
batch was worth, the two would agree only by luck.

It is also why a test can run a whole match in the microseconds it takes rather
than the minute a timer would charge. The tick scheduler that will drive rooms
at a steady 125 Hz is GLAD-FHKBN8; the input-buffer policy in front of it is
**The input buffer policy** below. Both hang off this shape rather than
replacing it.

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
how far lag compensation rewinds the world (GLAD-5QGO11), so a client that could
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

**A snapshot carries two tick numbers and they answer different questions.**
`state[0]` is how far the world has been advanced; `ServerSnapshot.ack` is how
much of *this peer's* input is in it. They are equal only while a host advances
the world by exactly the batch it was handed, which is what it does today;
GLAD-FHKBN8's scheduler will come apart from that, and a client that had
inferred one from the other would replay the wrong commands.

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
compensation rewinding them to exactly there (GLAD-5QGO11). The two are halves
of one design.

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

### What is measured, and where

`packages/client/src/net/netcode.test.ts` plays a minute at 60 frames a second
over LAN, 40, 80 and 180 ms links, all four with jitter and retransmitted loss,
against a real `Room` in virtual time. It asserts no hard snaps, no desync, and
corrections over a unit on under 5% of ticks — and then that the client's
predicted hash matches a bare `tick()` loop on **every one of 7500 ticks**,
while its world is being overwritten and rebuilt sixty times a second.

That last assertion is the project's physics-engine containment mechanism. Lint
catches the imports somebody anticipated; a hash that has to match on every tick
of a minute catches the category — an engine collision routine, a camera read
back into the simulation, a stray `Math.random`, a field the wire codec forgot.

### What is deliberately not here

**The clock-sync slew is not wired into the frame loop yet**, and that is a
decision rather than an omission. A `Room` today advances its world by exactly
the batch it was handed, so the server's tick counter is a count of the client's
own commands rather than a clock. Steering the client's tick rate against it
would close a loop through itself: run 12.5% fast, the server ticks 12.5% faster,
the estimate follows, and the correction never converges. The consumer of
`ClientClockSync.errorTicks` therefore arrives with the fixed-rate scheduler that
makes the server's tick a clock (GLAD-FHKBN8). What *is* consumed today is the
part with no feedback in it — the round trip, for the readout — and the
interpolation clock, which tracks the snapshot stream and not the server's.

For the same reason the harness seats **one** peer: two peers in one room would
each advance the world by their own commands, so it would run at twice the rate
with each player moving on half the ticks. Entity interpolation is therefore
measured against a real simulated trajectory on a jittery delivery schedule
(`interpolate.test.ts`) rather than through a second socket.

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
movement (GLAD-TSED8V). `rocketjump` is a v2 kind. Until it exists the
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

**A `.ktx2` bigger than its `.png` is not a regression.** PNG is a transmission
format decoded to 32 bits per texel before it reaches the GPU; KTX2 is 8 bits
per texel *in video memory*, which is the constraint. Compare against
`width x height x 4`. The two Babylon settings that would undo all of it are
turned off in `render/ktx2.ts`, and proved to matter in `ktx2.test.ts`.

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
