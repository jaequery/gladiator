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

**Round** — one life each. Ends when a player dies or the round timer expires.

**Match** — a sequence of rounds, first to *N*. Rules in GLAD-L4SYN9.

**Arena** — the map a match is played on. Gladiator ships one: `arena1`,
"Crucible" (GLAD-B8DI4J).

**Self-damage** — taking splash from your own rocket. Gladiator supports three
modes because the choice changes the skill ceiling, not just the numbers
(GLAD-L4SYN9).

**Rocket jump** — firing a rocket at your feet and riding the splash impulse.
The reason self-damage exists.

**Strafe jump** — gaining speed by holding a strafe key and turning into it
mid-air, exploiting how Quake's `pmove` projects acceleration onto velocity.
Along with rocket-jumping, the skill ceiling of the movement.

**Telefrag** — spawning inside another player and killing them by arrival.
Spawn selection has to have a policy about it (GLAD-AKODBZ).

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

## The network

**Listen server** — a server running inside the client process. How
single-player works: the bot match runs the real server code over a loopback
transport, so there is one code path, not two (GLAD-4G4W2T).

**Loopback transport** — a `Transport` implementation that hands messages
straight to the other end with no socket in between.

**Room** — one match's worth of server state, addressed by a room code.

**Room code** — the short string a player sends a friend to be dueled by.

**Prediction** — the client simulating its own input immediately rather than
waiting for the server, so movement feels instant (GLAD-6RT64L).

**Reconciliation** — replaying unacknowledged inputs on top of an authoritative
server state when it arrives, correcting prediction without a visible snap.

**Entity interpolation** — rendering the *opponent* slightly in the past,
between two received states, so their motion is smooth rather than stepped.

**Lag compensation** — the server rewinding other players to where the shooter
saw them when deciding whether a shot hit (GLAD-5QGO11).

**Weapon** — which of the two an entity is holding, as a netstate field
(`packages/sim/src/weapon.ts`). Behaviour is GLAD-0QWRYK's; the field exists
because an opponent's weapon is something you *read*, one snapshot after the
server changed it. Paired with **`lastFireTick`** — the tick they last fired
on, carried as state rather than sent as an event so it survives a dropped
snapshot.

**Netstate / snapshot** — the serialised slice of sim state the server sends to
clients each tick.

**Clock sync** — agreeing on tick numbering between client and server, and the
input buffer policy that absorbs jitter (GLAD-5995PA).

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
