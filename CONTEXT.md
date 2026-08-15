# CONTEXT.md — the vocabulary

What words mean in this repo. Conventions are in [`AGENTS.md`](./AGENTS.md);
physics numbers are in [`docs/physics-spec.md`](./docs/physics-spec.md).

Where a term's precise definition is still being decided, the owning ticket is
named. Nothing here is a design decision — it is the shared dictionary that
lets the design decisions be written down unambiguously.

---

## The game

**Gladiator** — this project. A browser-native recreation of *Rocket Arena*.

**Rocket Arena** — a 1996 Quake mod that replaced deathmatch's item scramble
with round-based duels: spawn at full health and armour, no pickups on the map,
lose a round by dying. Gladiator reproduces its format, not its assets.

**Duel** — a 1v1 match.

**Round** — one life each. Ends when a player dies or the round timer expires;
both dying on the same sub-step is a draw. `docs/physics-spec.md` §7.4.

**Match** — a sequence of rounds, first to *N*. Three, by default — a
best-of-five. §7.

**Match phase** — where a match is in its life: `warmup`, `live`,
`intermission`, `over`. A player's commands reach their body in the first two
and not in the other two. `packages/sim/src/match/match.ts`; §7.3.

**Arena** — the map a match is played on. Gladiator ships one: `arena1`,
"Crucible" (GLAD-B8DI4J).

**Armour** — a second pool of 100 points, spawned with and never picked up. It
absorbs 66% of every hit, rounded up, until it runs out — which is why a duel
takes two rockets rather than one. §7.1.

**Self-damage** — taking splash from your own rocket. Three modes, because the
choice changes the skill ceiling and not just the numbers: `full` (Quake's
halving), **`armor_only`** (the default: the armour pays and the health
remainder is discarded), and `none`. The launch is 500 qu/s in all three, because
knockback is derived before any of them apply. §7.2.

**Rocket jump** — firing a rocket at your feet and riding the splash impulse.
The reason self-damage exists. Worth 500 qu/s standing and 770 with a jump on
the same tick; what that measurably climbs to is `docs/physics-spec.md` §3.4.

**Splash** — the damage an explosion does to everything near it, falling off
linearly to nothing at 120 units. Measured to the nearest point on a player's
**box**, not to its centre, so a rocket at your feet does its full 100.
`docs/physics-spec.md` §3.3.

**Knockback** — the velocity a hit imparts: five units of speed per point of
damage, **added** to the current velocity rather than replacing it. Splash is
biased upward; a railgun hit pushes along the shooter's aim. It also arms the
**knockback timer**, a window of up to 200 ms in which the ground neither
brakes you nor steers you — which is why you cannot cancel a rocket jump the
instant you land. `docs/physics-spec.md` §3.3.

**Trajectory** — how a rocket's position is known: `trBase`, `trDelta` and the
tick it was fired on, evaluated in closed form rather than integrated. It is
what lets the wire mention a rocket exactly once. `docs/physics-spec.md` §3.2.

**Refire** — the interval between shots, and the only thing that gates one.
800 ms for the rocket launcher, 1500 ms for the railgun, on a single timer both
weapons share. There is no ammunition anywhere in the simulation. Reset at a
round start: a refire interval is a cost inside a round, never across one.

**Strafe jump** — gaining speed by holding a strafe key and turning into it
mid-air, exploiting how Quake's `pmove` projects acceleration onto velocity.
Along with rocket-jumping, the skill ceiling of the movement.

**Telefrag** — spawning inside another player and killing them by arrival. The
policy is Quake's: the arrival lives and the occupant dies, so that camping a
spawn pad is the worst idea in the arena. `docs/physics-spec.md` §6.4.

**Spawn plan** — the pairs of a map's spawn points a round may start on: far
enough apart, and unable to see each other. Worked out once per map from the
geometry (`match/spawn.ts`), so that a round start is two draws from the seeded
PRNG and no tracing at all. §6.2.

**Spawn protection** — brief invulnerability after spawning. Gladiator has
**none**, deliberately: a round-based duel starts both players out of sight of
each other, so there is nothing for it to protect against. §6.4.

---

## The simulation

**Sim** — `packages/sim`. The deterministic core: the same inputs produce the
same world, bit for bit, in the browser and on the server. It has zero
dependencies and no access to a clock, a renderer, or the network. See
"The simulation boundary" in `AGENTS.md`.

**Tick** — one fixed-timestep advance of the world: exactly 8 ms, 125 a second.
The sim's only unit of time; it has no notion of wall-clock seconds.

**Sub-step** — a tick, seen from the host's point of view. The host frame runs
at whatever rate the browser or the server scheduler wakes up at, and is
advanced as a whole number of exact 8.000 ms sub-steps with the remainder
carried to the next frame. "Tick" and "sub-step" name the same 8 ms; which word
gets used says whose clock is being talked about. `docs/physics-spec.md` §0.1.

**Host frame** — one wake-up of whatever is driving the simulation. Its length
is measured, not chosen, and it is never a unit of simulation time.

**`UserCmd`** — one tick's worth of player intent: movement axes, view angles,
button bits. The *only* way anything gets into the simulation. A human's
keyboard produces these; so does the bot, which is what makes the bot fair.

**`pmove`** — the player movement function, ported from Quake: friction,
acceleration, jump, gravity and integer velocity snapping.
`packages/sim/src/pmove/`; `docs/physics-spec.md` §1.

**Trace** — a swept query: "move this box from A to B and tell me what it hit,
and when". The primitive all collision and hitscan is built on.
`packages/sim/src/trace.ts`; `docs/physics-spec.md` §2.2.

**Brush** — a convex solid, defined by the outward-facing planes that bound it.
A map is a list of them. Not necessarily a box: the one non-axial plane on a
brush is what makes a ramp a ramp. `docs/physics-spec.md` §2.1.

**`SlideMove` / `StepSlideMove`** — Quake's move-and-slide: trace, clip velocity
to the plane you hit, repeat; `StepSlideMove` additionally tries the move again
from a step-height above, which is why stairs work. `docs/physics-spec.md` §2.4.

**Crease** — the edge two clip planes share. A move wedged between them slides
along `normalize(cross(pi, pj))` rather than alternating between the two, which
is what a corner would otherwise do to you.

**`OVERCLIP`** — 1.001. `SlideMove` removes 100.1% of the velocity into a
surface rather than 100%, so a body leaves the surface instead of resting on it.
The reason a ramp rotates your speed instead of eating it.

**Swept AABB** — axis-aligned bounding box moved continuously, rather than
teleported and tested. Continuous, so nothing tunnels.

**State hash** — a cheap digest of the whole sim state at a tick: FNV-1a over a
canonical little-endian encoding of every field, raw bit patterns, nothing
rounded. Two peers comparing hashes find a desync at the tick it happened
rather than the minute it became visible.

**Golden replay** — a committed input stream plus the hash trace it is known to
produce, sampled every half second. The regression test for determinism itself:
a change to the physics moves the trace, and a change nobody meant to make
cannot ride along with one they did.

**Demo** — a recording of a real match: the command stream a host executed, the
seed and rules it ran under, the ticks `startMatch` fired on, and the hash trace
it produced. The inputs and not the states, because the world is a function of
them — which is what makes it small, and what makes replaying it a *check*
rather than a playback. `packages/sim/src/demo.ts`; `pnpm demo`.

**Transport** — the interface a WebSocket, the in-process loopback and (later)
WebTransport all satisfy. It moves bytes and knows nothing about what they
mean. Its contract requires reliable, ordered delivery, and records which parts
of the protocol actually depend on that.

**Seeded PRNG** — the only source of randomness the sim is allowed. Carried in
the state, advanced by the tick, identical on both peers. This is why
`Math.random()` is a lint error.

**Quake units** — the distance unit the movement constants are expressed in.
Kept rather than converted, because converting them is how the feel gets lost.

**Angle units** — the *angle* unit: 1/65536 of a turn, Quake's 16-bit angles.
Integers, so an angle is the same number on both peers by construction rather
than by luck, and hashes exactly. Degrees appear only where a human authors or
reads one.

**Quake frame / engine frame** — the two coordinate systems and the one matrix
between them. `docs/physics-spec.md` §0.3.

---

## The renderer

**Renderer** — `packages/client/src/render`. It draws simulation state and
decides nothing about it. Settings and reasoning: `docs/renderer.md`.

**Camera-as-puppet** — the rule that the camera transform is written from
simulation state every frame and never read back. No attached input, no
inertia, no engine collision. `docs/renderer.md` §1.

**Backend** — which graphics context actually came up: `webgpu`, `webgl2` or
`webgl1`. Tried in that order, reported on the HUD, and branched on nowhere.

**Frame budget** — how long a frame may take. One 60 Hz frame, defended by the
pixel-ratio dial rather than by hope.

**Hitch** — a frame that took half again its budget: a dropped frame at any
refresh rate. Counted as a *rate*, because a percentile cannot see something
that happens twice a second. `docs/renderer.md` §9.

**Effects fold** — `render/fx.ts`: the pure function that turns a frame of
netstates and rockets into the effects to start — a rocket that disappeared is
an explosion, a changed `lastFireTick` is a muzzle flash. `audio/cues.ts`'s twin
for eyes, and built the same way for the same reason. `docs/renderer.md` §13.

**Scorch mark** — the quad an impact leaves on the surface it hit. A quad and
not a projected decal, because every surface in this world is cut from a brush
plane, so a quad lying in that plane *is* the decal.

**Reference screenshot** — a committed PNG of a fixed pose, compared in the
browser smoke test within a perceptual threshold. A renderer change that
legitimately moves the picture ships the new image in the same commit.

**Player model** — the opponent's body: a rig of boxes sized to sit inside the
simulation's player box, posed from netstate. `docs/renderer.md` §11.

**Netstate-driven animation** — the rule that what an opponent's model is doing
is derived from `EntityState` and the tick, never from what the renderer can
see happening. `packages/client/src/render/animState.ts`; `docs/renderer.md`
§11.

**Animation state** — one of `idle`, `run`, `jump`, `land`, `fire-rocket`,
`fire-rail`, `death`. Carries a **move direction** — travel relative to facing
— so a strafe reads as a strafe.

**Viewmodel** — the weapon in your own hands, drawn as a child of the camera in
its own depth range. `docs/renderer.md` §11.

---

## The audio

**Feedback bus** — the non-positional path: source, gain, out. Your own weapon,
your hit confirmation, the damage you took. No panner, no distance model, least
possible latency. `packages/client/src/audio/feedback.ts`; `docs/audio.md` §1.

**World bus** — the positional path, HRTF-panned and distance-attenuated.
Everything that happened out there: their weapons, explosions, their footsteps.
`audio/positional.ts`; §1.

**HRTF** — head-related transfer function: panning by convolving with a measured
impulse response, so front, back and elevation are distinguishable rather than
just left and right. What `equalpower` cannot do, and the reason the world bus
costs what it costs. §2.

**Cue** — one sound to play, produced by folding a netstate against the last one
seen. `audio/cues.ts` is `render/animState.ts`'s twin: same input, same rule
that a first sighting is silent, ears instead of eyes. §7.

**Stride** — the 128 Quake units of ground travel between footsteps. Distance,
not time, so the rate is a property of the player rather than of the frame rate.
§7.

**Onset** — how long after a voice is scheduled its first audible sample is, in
an offline render. Half of the "audible within one frame" measurement; the
device's `baseLatency` is the other half. §5.

---

## The HUD

**HUD model** — the deeply-readonly *copy* of everything the readout is allowed
to know, projected out of `GameState` once a frame. `render/animState.ts`'s
`playerNetState` for the readout instead of the model, and the only door in:
`packages/client/src/ui/hudModel.ts`.

**In-match HUD** — the player-facing readout: health, armour, weapon, cooldown,
round score, crosshair and hit feedback. `ui/hud.ts`. Distinct from the
**diagnostics panel** in the top-left (`client/src/hud.ts`), which is the
netcode's instrument and the browser test's.

**Hit confirmation** — the mark that says a shot landed, derived from the
opponent's health going down on the frame the state says it did. `ui/feedback.ts`;
its ears are `audio/cues.ts`.

**Damage indicator** — the arc that says where a hit came from, derived from the
*knockback* rather than from an attacker position the state does not carry.
Stored as a world bearing and re-projected against the current yaw, so it stays
pinned to the attacker as the player turns. `ui/feedback.ts`.

**Cooldown ring** — the refire interval drawn round the crosshair. Scaled by
`nextFireTick - lastFireTick`, which is the interval of the weapon that *fired*
rather than the one now in hand — the two weapons share one timer.

**HUD box** — an element marked `data-hud-box`: part of the set the browser test
measures at 16:9, 21:9 and 4:3 and requires to be on screen and not overlapping
anything else. `scripts/e2e.mjs`.

**Dev HUD** — the `?dev=1` performance panel: tick, round trip, pending
commands, the last prediction error in units, snapshot bytes per second, frame
pacing, and the two counters below. Deliberately not a **HUD box** — it is an
instrument, not part of the layout a player sees. `ui/devHud.ts`.

---

## Observability

**Self-splash mispredict** — the client predicted taking its own splash damage
and the server disagreed, or the reverse. A far sharper determinism canary than
a correction distance, because self-splash is a *predicate* — you either ate
your own rocket or you did not — where a position is continuous and always a
little wrong. `packages/client/src/net/mispredict.ts`.

**Speed clamp** — the 3000 qu/s safety rail in `pmove`, a collision and netcode
guard rather than physics; Quake has none. Nothing in play approaches it, so a
clamp is a report about something upstream. §2.6.

**Observation seam** — a function the simulation calls to say something happened
(`onSpeedClamp`, `onSelfSplash`). It exists because `packages/sim` has no
`console` and no counters; it is purely observational, so two peers with
different observers still produce the same world. Tallied by
`packages/sim/src/counters.ts`.

**Structured log** — one JSON object per event, one line each, with `room` and
`tick` on every entry — null where there is no room, never absent.
`packages/server/src/log.ts`.

**Input to photon** — the wall-clock between a hand moving and the screen
showing a world that moved. Six stages, three of them this project's; the budget
and the measurement are `docs/latency.md` and `pnpm latency`. Distinct from
every netcode number, which is about the *opponent*.

---

## The network

**Host** — whatever is authoritative over a world: `packages/server/src/room.ts`
and the modules it reaches. Runs unchanged behind a WebSocket on Fly and inside
a browser tab behind a loopback, which is why `@gladiator/server` is a
dependency of the client and not only of the deploy.

**Listen server** — a host running inside the client process
(`packages/client/src/net/listenServer.ts`). How single-player works: the bot
match runs the real host over a loopback transport, so there is one code path,
not two (GLAD-4G4W2T). `?local=1` boots one today.

**Loopback transport** — a `Transport` implementation that hands messages to the
other end with no socket in between. It still runs the real codec — a string is
UTF-8 encoded and decoded, a `Uint8Array` is copied — because sharing a mutable
reference across a "network" is the one failure the pattern has. Delivery is a
`queueMicrotask`, so a send can never re-enter a tick.

**Lagged transport** — a decorator that puts the network back for tests:
latency, jitter, loss, reordering and duplication from a seeded PRNG, released
by a `pump(nowMs)` rather than a timer. Test harness only; single-player ships
at ~0 ms.

**Clock** — wall-clock as an injected value (`packages/server/src/clock.ts`). A
host reads one to notice a peer that has gone quiet, and never to decide how far
to advance the world: a room's world is a function of the commands it received,
which is what makes one recorded input stream produce one hash over a socket and
in-process.

**Room** — one match's worth of host state, addressed by a room code. Seats two
peers, owns one `GameState`, holds no timer and opens no socket. Advanced by
`advance(steps)`, which runs exactly the sub-steps it is handed and never reads
a clock to decide how many. `packages/server/src/room.ts`.

**Room registry** — every room on the machine, as a `Map` from code to room
(`packages/server/src/rooms.ts`). One machine, on purpose: two players in a room
must reach the same process. Mints codes, answers to the ones a human typed, and
reaps a room nobody has been in for a minute so codes do not leak.

**Room code** — the short string a player sends a friend to be dueled by. Six
characters of Crockford base32 — the digits and the letters minus I, L, O and U
— which is exactly 30 bits. Read leniently and written strictly:
`packages/server/src/roomCode.ts`; the guess rate at this deploy's concurrency
is `docs/deploy.md`.

**Tick scheduler** — the one timer on the machine
(`packages/server/src/scheduler.ts`). Wakes ~62.5 times a second aiming at
absolute boundaries rather than sleeping an interval, folds the elapsed
wall-clock into whole 8 ms sub-steps, and hands the count to every room.
Measures how late its own wakeups are and holds them to `WAKEUP_BUDGET_MS`, one
tick at the 99th percentile.

**Host frame** — one wakeup of the scheduler: 16 ms, which is exactly two
sub-steps when it arrives on time. A tab's host frame is the animation frame,
folded by the same `stepsFor`.

**Command tick** — the label a client puts on a command, counted by the client
and free-running. Not the tick of the world the client predicted, which a
snapshot overwrites sixty times a second; the two are separate so the lead can
be steered on one without the other fighting it. `ServerSnapshot.ack` is in this
numbering.

**Prediction** — the client simulating its own input immediately rather than
waiting for the server, so movement feels instant
(`packages/client/src/net/prediction.ts`). It keeps the commands the server has
not acknowledged, because reconciliation is what it does with them.

**Reconciliation** — replaying unacknowledged inputs on top of an authoritative
server state when it arrives, correcting prediction without a visible snap.
`packages/client/src/net/reconcile.ts`.

**Correction band** — which of four things a reconciliation does about the
distance between what was predicted and what the server says: ignore it under
0.1 u, carry it in rendering for 100 ms under 30 u, the same for 200 ms and a
log line under 120 u, and hard-snap past that. 120 is one splash radius. The
rule underneath all four: the simulation takes the authoritative value
immediately, and only rendering lags.

**Render offset** — the difference a correction moved the player, held outside
`GameState` and decayed to zero over a tenth of a second, so the camera travels
rather than teleports. The only place a correction is allowed to be soft.
`packages/client/src/render/renderOffset.ts`.

**Entity interpolation** — rendering the *opponent* slightly in the past,
between two received states, so their motion is smooth rather than stepped. 80 ms
behind, extrapolating at most 250 ms when the snapshots stop.
`packages/client/src/net/interpolate.ts`.

**Interpolation clock** — the render tick entity interpolation draws at, which
advances by wall-clock and *tracks* `newestSnapshotTick - 80 ms` by running a few
percent fast or slow. It exists because rendering at that target directly makes
correct interpolation between correct states stutter: the target moves in
whatever lumps the network delivers. Same shape as the clock-sync **slew**,
pointed at the picture instead of at the simulation.

**Wire state** — a whole `GameState` as a flat array of numbers
(`packages/sim/src/netstate.ts`), in the same field order `encodeExact` walks.
The *whole* state, because a client that rebuilt only the entities could draw
the world and could not reproduce its hash.

**Lag compensation** — the server rewinding other players to where the shooter
saw them when deciding whether a hitscan shot hit. The distance back is
`clamp(rtt / 2 + interpDelay, 0, 300 ms)` — half the round trip because that is
how stale the shooter's newest snapshot was, plus the **interpolation delay**
because that is how much further back they were drawing it. The arithmetic and
its two constants are `packages/sim/src/lagcomp.ts`, so client and server cannot
hold different opinions about them; the history buffer and the rewind are
`packages/server/src/lagcomp.ts`. GLAD-5QGO11.

**Rewind seam** — how a rewind reaches the simulation: `TickHooks.rewind`, a
function that is handed the shot to take and owns the `finally` that puts every
hitbox back. Only the *target* moves, only for the length of one hitscan trace,
and only `origin` — the damage the shot dealt belongs to the present. A rocket
is never rewound at all: it is compensated in where and when it is *born* and
collides against present-tick hitboxes for the rest of its flight.

**Predicted self-splash** — a client applying its own rocket's splash to itself
before the host has confirmed it, so a rocket jump launches on the frame the
button was pressed instead of one round trip later. Allowed only for a rocket
whose flight stayed more than 32 units clear of every opponent hitbox
(`packages/sim/src/splash.ts`); otherwise that one rocket falls back to
server-only, which is what Quake 3 does for every rocket. The client's half is
`packages/client/src/net/rocketPredict.ts`. GLAD-5QGO11.

**Weapon** — which of the two an entity is holding, as a netstate field
(`packages/sim/src/weapon.ts`). What they *do* is `weapons.ts` and
`docs/physics-spec.md` §3; the field exists because an opponent's weapon is
something you *read*, one snapshot after the server changed it. Paired with
**`lastFireTick`** — the tick they last fired on, carried as state rather than
sent as an event so it survives a dropped snapshot.

**Netstate / snapshot** — the state the server sends a client: a **wire state**
plus the last command of that client's the world has executed
(`ServerSnapshot`). State rather than an event, so a client that misses one and
receives the next has lost nothing but a frame of interpolation.

**Clock sync** — agreeing on tick numbering between client and server. The
server pings and the client echoes (`ServerPing` / `ClientPong`), so the round
trip is measured on the server's clock and never reported by the client; the
client estimates the offset from those pings and works out which tick it is
predicting into. `packages/server/src/clockSync.ts`,
`packages/client/src/net/clockSync.ts`; the argument is `AGENTS.md` under **Clock
sync, and who holds the stopwatch** (GLAD-5995PA).

**Lead** — how far ahead of the server a client simulates: half the measured
round trip, rounded up, plus the **jitter buffer** depth. Feed-forward from the
RTT alone, deliberately not steered on the buffer depth the server reports.

**Slew** — correcting the client's clock by handing the frame accumulator a few
extra or fewer milliseconds, bounded to an eighth of the frame, rather than
jumping the tick counter. A jump is a jump the player sees, because the camera is
written from simulation state every frame. Past `SNAP_TICKS` it snaps instead.

**Input queue** — the per-peer jitter buffer in front of the server's tick
(`packages/server/src/inputQueue.ts`). Holds `JITTER_BUFFER_TICKS` commands on
purpose, drains one per tick, and never stalls: a stall on one peer's socket
would hitch the other peer's game. The four failure modes and what each costs are
`AGENTS.md` under **The input buffer policy**.

**Repeat-last** — the missing-command policy: when nothing is buffered, the last
command runs again with the trigger cleared, for at most half a second. It is
what keeps a lost packet from dropping a player out of a strafe-jump; the bound
is what keeps a disconnected one from running off the map.

**Command rate limit** — commands a peer may have executed per **wall-clock
second**, measured on the server's clock. Without it a client sends 500 Hz of
input and moves faster than everyone else.

---

## The bot

**Bot** — `packages/bot`. Single-player opposition. It plays by emitting
`UserCmd`s, exactly like a human, which is both the fairness guarantee and the
reason it lives on the same deterministic side of the boundary as the sim.

**WorldModel** — what the bot believes about the world: what it can see (FOV,
line of sight), what it has heard, and what it remembers, decaying over time. It
is deliberately *not* the sim state (GLAD-V7CMHR).

**Navigation data** — precomputed routing baked from the map, so the bot's
pathfinding is a lookup rather than a search (GLAD-OB46VC).

**Nav graph** — the navigation data as authored: `maps/<map>.nav.ts`, a list of
nodes and the directed links between them, hand-placed rather than generated.
`packages/bot/src/nav/schema.ts` argues why.

**Nav node** — one place worth standing, at the player's feet. The bake *drops*
it on to the surface underneath, because an axis-aligned box rests on its
uphill edge and a coordinate read off a ramp in the map file is always a little
wrong.

**Link kind** — how a body gets from one nav node to the next: `walk`, `jump`,
`drop` or `teleport`. Directed, always — a ledge you can drop off and cannot
climb back on to is the commonest shape in an arena and an undirected graph
cannot say it. Each kind maps to exactly one traversal controller in the bot's
movement (GLAD-TSED8V). `rocketjump` is a v2 kind.

**Ground / perch** — the two routing classes a nav node can be in. Every
`ground` node has to route to every other one and the bake refuses a graph
where one does not; a `perch` is a position no v1 link reaches — a balcony, the
tower — which the bot can see from and fall off but not route to.

**Next-hop table** — the all-pairs routing Floyd-Warshall computes at bake
time. `nextHop[from][to]` is where to move *now*, so a path follower asks again
every time it arrives and recovers from being knocked off its route without
replanning.

**Visibility bitset** — which nav nodes can see which, eye to eye, computed
once and stored a bit per pair. Symmetric by construction. It is what makes
breaking line of sight an O(1) question (GLAD-V7CMHR).

**Fairness harness** — the tests that assert the bot cannot see, hear or aim
better than the rules allow.

---

## The build

**Package boundary** — the rule that `packages/sim` can import nothing. See
`AGENTS.md`; it is enforced by resolution, by the typechecker and by lint, in
that order of strength.

**Guardrail** — a deliberately-violating probe written by
`scripts/guardrails.mjs` to prove a check actually rejects what it claims to.

**Baker** — a build-time tool that turns authored content (a map, navigation
data) into the compact form the sim loads (GLAD-G2M8QQ, GLAD-OB46VC).

**Baked map** — what `pnpm map:bake` writes: `maps/baked/<name>.json`, carrying
the format version, the map, and the content hash. Committed, so a build needs
no bake step in front of it. `docs/physics-spec.md` §4.

**Baked nav** — what `pnpm nav:bake` writes: `maps/baked/<name>.nav.json`,
carrying the graph, the routing and visibility tables, and **two** hashes — its
own, and the hash of the map it was baked against. The second one is what stops
a graph that describes yesterday's geometry from loading (GLAD-OB46VC).

**Baked sound** — what `pnpm audio:bake` writes: `packages/client/public/audio/*.wav`,
synthesised from arithmetic by `tools/synth-audio.ts` rather than downloaded.
Committed, bit-reproducible, and CC0 because nobody else made it. `docs/audio.md`
§8; every file has an entry in `credits.json`.

**Asset registry** — `credits.json`: every asset this repository ships, with its
author, its source URL, its licence, and — for a texture — its class.
`CREDITS.md` and the credits screen's `credits.json` are both generated from it,
so the two cannot drift. `docs/assets.md` §6.

**Texture class** — what a texture is *for*, which is what decides how it is
compressed: `albedo` and `normal` get UASTC, `srgb` and `linear` get ETC1S.
Declared per entry in the registry, never inferred from a filename.
`docs/assets.md` §2.

**Transcode target** — the compressed GPU format a `.ktx2` is turned into in the
browser, chosen per texture from the engine's capabilities. Two Babylon defaults
would pick *uncompressed* RGBA on an integrated GPU; both are off, and
`render/ktx2.test.ts` proves it over every capability combination.
`docs/assets.md` §5.

**Second UV set** — the lightmap unwrap. `TEXCOORD_1` in glTF, `uv2` in Babylon,
`coordinatesIndex = 1` on the texture. The first set tiles a material; the
second gives every triangle a unique patch of one atlas, and confusing them
renders a level lit from the wrong wall or renders it black. `docs/assets.md`
§3.

**Baked lightmap** — what `pnpm lightmap:bake` writes:
`assets/textures/<map>_lightmap.png`, one atlas per map, traced from the map's
own lights with shadow rays, occluded ambient and one bounce. It multiplies the
arena's albedo and is the *only* light the arena has, which is what lets its
materials run with no light loop at all. `docs/renderer.md` §12.

**Luxel** — one texel of a lightmap, and the unit the bake is measured in. Eight
Quake units across, so a 64-unit wall panel is eight of them.
`packages/sim/src/map/lightmapUv.ts`.

**Lightmap atlas** — where every brush face's luxels live: one rectangle per
face, packed on shelves, computed by `lightmapUnwrap` in the *simulation*
package because the baker and the browser both read it and must not disagree.
Its height is derived from the packing rather than authored.

**Surface material** — the logical name a map writes on a surface (`concrete`,
`metal`, `trim`, `glass`, `light`), resolved to a look by
`render/materials.ts`. The map never names a file or a shading model. A
lightmapped world is a world of albedo, so a look is a detail texture, a tint
gain, an alpha and whether the surface is self-lit — never a gloss.

**Self-lit** — a surface that makes its own light and therefore takes no
lightmap, because a bake *multiplies* and a lamp baked dark is not a lamp. The
one such material is `light`, and `takesLightmap` is the seam.

**Asset budget** — 5 MB per committed file and 24 MB across all of them, checked
by `pnpm assets:budget` over `git ls-files`. Git has no forget, so the check has
to run before the commit lands. `docs/assets.md` §7.

**Ramp** — a brush that is an axis-aligned box with its top face replaced by one
sloped plane. Exactly two gradients exist, `1:1` (45°) and `1:2` (26.57°), so
that a level designer cannot make a physics decision by typing an angle. §4.3.

**Surface** — a named material a brush's faces are drawn with. Declared once per
map and referenced by name; a surface no brush uses fails the bake.

**`nonSolid` / `noRender`** — the two escape hatches that let a brush be drawn
without being collided, or collided without being drawn. Everything else is
both, by construction. §4.2.

**Prop** — a glTF reference in a map's `props[]`: decoration that affects
neither collision nor the derived render mesh, and that the sim never parses.

**Ledge** — a patch of surface a player can stand on: the box fits, the ground
under it is walkable, and there is arena above it rather than sky. What a map is
checked ledge by ledge for is *reachability*.

**Climb** — how far up it is from one standable surface to the next. The
movement makes exactly four: **18** stepped, **48** jumped, **166**
rocket-jumped, **395** with a jump and a rocket. Every ledge in a map has to be
within one of them of something below it. `docs/physics-spec.md` §5.4.

**Reachability** — the bake-time question "can a player get to every ledge in
this map, from a spawn, without falling on to it". Answered by sampling the map
with the real player box and flooding out from the spawns
(`map/reachability.ts`); a map with an answer of no does not bake. §5.5.

**Felt gravity** — 750 qu/s², what `GRAVITY` (800) becomes once velocity
snapping has rounded 6.4 down to 6 every tick. The number every closed form
about the movement is written in. §5.2.

**Map hash** — eight hex digits over a baked map's content, recomputed at load
and exchanged in the handshake. Two peers that disagree about it refuse to play
rather than simulate two different worlds. §4.5.
