# The renderer

Settings, and why each of them is what it is. Conventions are in
[`AGENTS.md`](../AGENTS.md); the physics numbers and the axis map are in
[`docs/physics-spec.md`](./physics-spec.md).

The renderer is `packages/client/src/render/`. It draws simulation state and it
does nothing else: it decides no position, owns no clock, and is never read
from. Almost every decision below exists to keep that sentence true under
pressure, because Babylon is a general-purpose engine whose defaults assume the
opposite.

---

## §1 The camera is a puppet

The camera transform is written from simulation state every frame and never
read back. Three concrete consequences, each of which is a bug avoided:

**No `attachControl`, and no camera input of any kind.** Yaw and pitch are
authoritative float state the input controller owns, because they go into the
`UserCmd` the server simulates and lag-compensates against. A camera that read
the mouse itself would make the renderer the source of truth for aim, and the
server would be reconciling against a number the client derived from a
rendering artefact.

**`inertia = 0`.** Babylon's cameras default to `0.9` — a low-pass filter on
camera movement, applied once per *frame*. It would make the transform depend
on the frame rate, and it would smooth over exactly the corrections
reconciliation makes: a rubber-band would arrive late and soft instead of on
time and sharp.

**`position` and `rotation` are assigned, never `setTarget`ed.**
`TargetCamera.setTarget` nudges `position.z` by an epsilon when the eye and the
target share it — which happens at exactly the yaw where the view is
perpendicular to the engine's `z` axis. A camera that moves itself is not a
puppet.

`render/view.ts` is the whole of the transform, as pure functions. Position is
interpolated between the previous tick and the current one by the accumulator's
remainder; the *view angle* is not interpolated, because it is sampled from the
mouse once per frame and interpolating it would add a frame of latency to aim.

### The one thing added to the eye, and why it is not a filter

`render/renderOffset.ts` (GLAD-6RT64L) adds a vector to the interpolated
position: the difference a server correction moved the player, decayed linearly
to zero over 100 ms. It is the reason `inertia = 0` above does not simply mean
"corrections arrive as a jolt".

It is not the low-pass filter that paragraph rejects, and the difference is
worth stating precisely. `inertia` is a filter on the camera's *own* previous
output — per-frame state, read back, frame-rate dependent, and lagging every
correction including the ones that have already landed. This is a pure function
of corrections that have *already happened*: it is pushed by
`net/reconcile.ts`, it decays on wall-clock at a rate that makes the total
journey the same at 60 Hz and 240 Hz, and it is never read by anything that
computes a simulation value. The simulation has taken the authoritative
position in full by the time this vector exists — which is the rule
`net/reconcile.ts` states, and the reason a half-corrected world never gets to
be the world the next replay starts from.

Past one splash radius it is cleared rather than pushed: there is no honest way
to smooth a teleport, and carrying two hundred units of offset would draw the
player somewhere they demonstrably are not.

### Babylon's Euler angles are Quake's angles

`camera.rotation = (pitch, yaw, 0)`, in radians, unchanged from the simulation.
That is not a coincidence: Babylon composes the rotation as `Rx(pitch)·Ry(yaw)`
applied to its forward vector `(0, 0, -1)`, and running that through
`QUAKE_TO_ENGINE` gives exactly Quake's `(cos p cos y, cos p sin y, sin p)`.
`view.test.ts` asserts it against a real Babylon camera under `NullEngine`
rather than trusting the derivation.

---

## §2 Absolutely no engine collision, and no physics engine

`mesh.checkCollisions`, `camera.applyGravity`, `camera.ellipsoid` and
`moveWithCollisions()` need no plugin, no dependency and no ceremony, and they
are the canonical Babylon first-person-controller recipe that every tutorial,
every forum answer and every autocomplete will offer.

Using one would not break the game. It would produce movement that is *almost*
right — a client that disagrees with the server by a few units a second, which
looks like a network problem, gets diagnosed as a network problem, and is not
one.

Two locks, because this is the mistake that would be hardest to find later:

| Lock | Where | Catches |
| ---- | ----- | ------- |
| ESLint `no-restricted-syntax` over `packages/client` | `eslint.config.js` | the four collision calls, `attachControl`, `enablePhysics`, `PhysicsAggregate`, `PhysicsBody` |
| `pnpm run no-physics` over `pnpm-lock.yaml` | `scripts/no-physics-plugin.mjs` | Havok, Rapier, Cannon, Ammo, Oimo and friends, however they are reached |

Both are proved to fire by `scripts/guardrails.mjs`, which writes deliberately
violating code — and a lockfile with Havok in it — and fails if the check
accepts either.

That is also how the lockfile check reaches CI: `guardrails` is a step in the CI
job, and one of its cases runs `no-physics-plugin.mjs` over *this repository's*
lockfile and requires it to pass. A named `No physics plugin` step beside it
would read better in a build log and is worth adding the next time
`.github/workflows/ci.yml` is touched; the gate holds either way, and
`pnpm run ci` runs it directly.

---

## §3 WebGPU first, WebGL2 everywhere else

`render/engine.ts` tries WebGPU and falls back to WebGL2 on any failure at all —
unsupported, adapter refused, `initAsync` threw. WebGPU's draw submission costs
a fraction of WebGL's per call, and a duel is a scene the CPU has to re-record
every frame while also simulating, predicting and reconciling.

The WebGPU module is behind an `await import()`, so a browser that will never
use it does not download the WGSL shader processor, the bind-group cache or the
render-bundle machinery. Vite emits it as its own chunk.

Nothing else in the renderer knows which one came up. The HUD says so, and
`window.__gladiator.snapshot().render.backend` reports it to the smoke test.

**The reference screenshot pins itself to WebGL** (`?shot=1` passes
`forceWebGL`), so the committed image does not depend on whether the machine
that took it happened to offer WebGPU.

### CI gates on WebGL2; WebGPU is verified by hand

Headless Chromium under SwiftShader has no `navigator.gpu`, so
`WebGPUEngine.IsSupportedAsync` is false and the smoke test exercises the
fallback — which is the path most players will take anyway, and the one whose
breakage would be silent. The test asserts that *a* modern context came up
(`webgpu` or `webgl2`) rather than which, so it will start covering WebGPU the
day the runner grows a GPU without needing to be rewritten.

The WebGPU path is therefore verified by opening the deployed page in a browser
that has it and reading the backend off the HUD. That is a deliberate trade:
gating on a headless WebGPU implementation would be gating on the emulator's
bugs.

---

## §4 Pixel ratio is the quality dial

At this scene complexity the bottleneck is fill rate, not draw calls, so the
number of pixels is the knob with the most travel.

- **Clamped on the way in** to `MAX_PIXEL_RATIO = 2`. A 3× phone display asks
  for nine times the fragments of a 1× one for a difference nobody can see at
  arm's length.
- **Stepped down under load**, one rung at a time along a coarse ladder, when
  the **median** frame misses the budget; stepped back up when it is
  comfortably inside it. The hysteresis is a pure function (`nextPixelRatio`)
  so it can be tested without a GPU.

  With a 15% tolerance over the budget, because the measured interval on a
  60 Hz display is 16.7 ms and one 60 Hz frame is 16.667: without it, every
  60 Hz machine reads as permanently over budget and softens its own image
  while hitting every single frame.

  The median rather than the percentile, deliberately: a percentile measures
  smoothness and a median measures cost, and only one of them is something
  fewer pixels can fix. A tail of stalls caused by the operating system
  descheduling the tab does not improve at half the resolution, so a dial
  driven by p99 would walk the image down to nothing chasing a number it has no
  influence over.

Softening the image slightly at a steady frame rate beats a crisp one that
hitches. Everything else — the geometry, the lighting, the texture filtering —
is sacrificed only after this.

---

## §5 The post-processing chain is empty

Every full-screen pass is input-to-photon latency, paid on every frame, to make
a still frame prettier. Tone mapping is the one exception and it is not a pass:
with `applyByPostProcess` left off, Babylon folds ACES into each material's
fragment shader, so it costs a few instructions rather than a round trip
through a render target.

**The agreed count is zero, and it is locked from both ends.** ESLint refuses
the names in `packages/client` — `PostProcess`, `DefaultRenderingPipeline`,
`FxaaPostProcess` and the rest — with the reason in the message, and
`scripts/guardrails.mjs` writes a file that uses them and fails if lint accepts
it. `render/postprocess.test.ts` then asserts the *built* scene: no pass on the
camera, no pass on the scene, no rendering pipeline registered, and
`applyByPostProcess` still off. The first stops a pass being imported; the
second stops one being attached by something that was.

The look is bought somewhere else instead. §12.

Other settings worth knowing:

| Setting | Value | Why |
| ------- | ----- | --- |
| `scene.useRightHandedSystem` | `true` | `det(QUAKE_TO_ENGINE) = +1`. A left-handed scene would need `-1`: a mirrored world. Set **before** the camera is constructed, which reads it. |
| `camera.fov` | `2·atan(0.75)` | Quake's `fov 90` is 90° *horizontally at 4:3* — 73.74° vertically. Fixing the vertical angle is "hor+": a wider monitor shows more world, rather than the same world squeezed. |
| `minZ` / `maxZ` | 4 / 8192 | Quake's near plane; an arena is 1024 across. |
| anisotropy | up to 8 | Floors seen at a grazing angle — most of the floor, in a shooter — stop smearing. |
| `mesh.sideOrientation` | `CounterClockWise` | See §7. |

---

## §6 Shaders are pre-warmed

`scene.isReady(true)` is awaited before play, and it is the real loading gate:
it forces every material's shader to compile now, behind the loading screen,
rather than the first time something is drawn. The classic version of this bug
is a multi-hundred-millisecond stall the first time an explosion is drawn,
which is a lost duel.

`window.__gladiator.snapshot().render.ready` reports it, and the smoke test
waits on it.

---

## §7 The winding, and the bug it hid

`mapGeometry` emits triangles counter-clockwise seen from *outside* the solid,
and `QUAKE_TO_ENGINE` has determinant `+1`, so they still are after the frame
change. Babylon does not assume that: a `Mesh` built by hand defaults to
`ClockWiseSideOrientation`, which in a right-handed scene reverses the cull
face.

The symptom was not an obviously broken picture. It was a *plausible* one: from
inside a sealed room you go on seeing a room, because the near face of every
wall is culled and the far face of the same wall is drawn sixty-four units
behind it, lit from the wrong side. What gave it away was a pillar that was
drawn and could not be seen.

`mapMesh.ts` sets the orientation explicitly and `mapMesh.test.ts` pins it.
This is the class of bug §8 exists for.

---

## §8 The reference screenshot

A committed PNG (`packages/client/reference/testbed.png`) of a fixed pose in
`maps/testbed.ts`, compared in the browser smoke test within a perceptual
threshold.

`?shot=1` is a page with nothing moving in it: no socket, no simulation, no
HUD, no adaptive quality, one device pixel per CSS pixel, WebGL pinned, and the
camera nailed to `REFERENCE_VIEW`. Everything a screenshot could otherwise
differ by is held still, so a difference is a rendering change.

The comparison happens *inside the page* — `fetch` the reference,
`createImageBitmap`, draw both into a 2D canvas, compare — which is what lets
this repository diff PNGs without adding a PNG decoder to it.

**Re-shoot deliberately.** A renderer change or a Babylon upgrade that
legitimately changes the picture should ship its new reference in the same
commit:

```
pnpm run e2e -- --update-reference
```

A re-shoot in a commit that was not supposed to change the picture is the
question the gate exists to ask.

---

## §9 Frame pacing is measured, not felt

`render/frameStats.ts`. The number a frame counter reports is an average, and
an average is exactly the statistic that hides what players notice: a frame
graph that runs at 144 fps and drops one 30 ms frame every two seconds averages
142 fps and stutters visibly twice a second.

So the verdict has two halves:

- **p99 under budget** catches sustained slowness — a scene that is simply too
  expensive.
- **hitch rate under tolerance** catches rare stalls, and it has to exist,
  because p99 alone provably cannot see them. Thirty seconds at 144 fps is 4320
  frames; one hitch every two seconds is 15 of them; the top 1% is 43. The
  hitches fit *inside* the top 1%, so the percentile reports a healthy 6.9 ms.

The shipping budget is one 60 Hz frame. `frameStats.test.ts` runs the
pathological case above through the verdict and asserts it fails — and asserts
that a mean-based check would have passed it.

The browser smoke test measures a real thirty-second window at a small viewport,
which takes the software rasteriser's fill rate out of the measurement and
leaves the thing that actually regresses: the game loop. Its budget carries
headroom for a shared CI runner; `--frame-budget` holds a machine you are not
sharing to the real number.

---

## §10 Raw mouse input

Pointer lock is requested with `unadjustedMovement: true`
(`input/pointerLock.ts`, sixty lines that are ours). By default the browser
hands a page the deltas the desktop gets, with the operating system's pointer
acceleration already applied: move the mouse faster and the same physical
distance turns you further. That is correct for a cursor and disqualifying for
a shooter — a flick is a learned physical gesture, and if the same gesture
produces a different angle depending on how fast the wrist moved, the skill
that separates two players is the mouse driver's.

Where the browser refuses the flag, the request is retried without it, because
accelerated input is much better than no game. `PointerLock.raw` says which
happened, so the settings screen (GLAD-NPCTU8) can be honest about it.

---

## §11 The player, and the hands

Two things the renderer draws that the camera does not: the opponent's body,
and the weapon in your own. `render/animState.ts`, `render/playerModel.ts`,
`render/viewmodel.ts`.

### Animation is a fold over netstate, not a reading of the scene

The tempting way to animate an opponent is from what the renderer can see: run
when the mesh moves, land when it stops falling, flash a muzzle when a rocket
appears. Every one of those is a guess about a simulation that is authoritative
somewhere else, and each guess fails in its own way under packet loss — the
mesh stops moving because a snapshot was late, not because the player stopped.

So the input is `PlayerNetState`: a **copy** of the fields of `EntityState` the
representation is allowed to read, deeply `readonly`. The copy matters as much
as the `readonly` does — `tick()` mutates entities in place and keeps the same
objects, so a held reference would quietly become a reference to the present.

`advanceAnim(previous, net, tick)` is a pure fold. It takes the previous frame
because exactly one animation needs history: **landing**. `EntityState` says
whether a player is on the ground and not whether they arrived this tick, and
it cannot be inferred, because `pmove` clips the velocity against the floor
plane in the same sub-step that sets `OnGround` — on the landing tick the
vertical velocity is already zero. The missing bit is "were they airborne last
time", and the fold carries it and nothing else.

The priority order is chosen for what a duellist has to read first: death,
then firing, then airborne, then landing, then run/idle. Firing outranks
airborne on purpose — a rocket jump draws as a shot, because the jump is
obvious from the trajectory and the shot is what is about to hurt you.

Both firing poses are distinct states rather than one `fire`, and the run
carries a direction relative to *facing*, because at arena distance an opponent
is a few dozen pixels and what you need off them is which way they are moving
and which weapon just went off.

### Silhouette over fidelity, and no asset licence

The model is boxes: a wide chest, a small head, limbs that swing visibly, and
two weapons whose outlines cannot be confused. Polygon count buys nothing here
that a clearer outline does not buy more of — and placeholder geometry that
this repository authored has no licence attached to it, which a downloaded rig
very often turns out to.

The pipeline that replaces those boxes is [`docs/assets.md`](./assets.md):
`pnpm assets:build` compresses a glTF and its textures into
`packages/client/public/`, `render/gltf.ts` loads the result behind an
`await import()`, and `render/ktx2.ts` decides what a compressed texture is
allowed to be transcoded to. Three of its rules bind anything drawn here — a
lightmap samples through `uv2` and nothing but `applyLightmap` may attach one,
content is CC0 or it does not ship, and every committed asset is in
`credits.json` or the build fails.

The body is sized to sit **inside** the simulation's 30x30x56 box, and
`playerModel.test.ts` asserts it, so what a player aims at and what they see
line up. The weapon and the arm holding it stick out in front, exactly as
Quake's models always have. Nothing about the rig is ever read by anything that
decides a hit: hitboxes are the sim's AABBs and are never derived from a mesh
or a bone.

Every animation clock is `tick + alpha` — the simulation's clock and the
accumulator's remainder — so two clients drawing the same tick at 60 Hz and at
240 Hz draw the same pose. The stride is paced by *distance travelled* rather
than by time, which is why a player skimming out of a rocket jump reads as
moving fast rather than as a film played faster.

### The viewmodel is camera-parented

GLAD-PWCON8 left this open; the answer is a child node of the camera, written
only with *local* offsets. A mesh in world space positioned from the same
`CameraPose` would be two pieces of code computing one transform from the same
numbers, and the failure mode of that is a viewmodel that is correct at every
yaw except one. Parenting makes the agreement structural.

It does not weaken §1. The camera is still written and never read: the
viewmodel writes `position` and `rotation` on a *child* and never reads the
parent's.

It draws in rendering group 1 with the depth buffer cleared in front of it, so
a gun held 24 units from the eye cannot poke through a wall 20 units away. The
viewmodel is not in the world; it is a diagram of what your hands are doing,
drawn over the top of the world.

### Nothing here is in the reference screenshot

`RenderView.players` and `RenderView.self` are both optional, and
`REFERENCE_VIEW` carries neither, so `?shot=1` draws the arena and nothing
else. That is deliberate: §8's whole argument is a page with nothing moving in
it, and a bobbing viewmodel is the most moving thing on screen.

`?dummy=1` is the other half of that trade — a scripted opponent
(`dummyOpponent.ts`) who runs a circle, jumps, fires, switches weapons and
dies, so every animation state can be watched in a real browser. Snapshots do
now arrive (GLAD-6RT64L) and `net/interpolate.ts` draws whatever is in them, so
the stand-in is only reached when the buffer holds no other player — which is a
page with nobody on the other end of it, and will stay reachable until a room
can seat two peers (GLAD-FHKBN8). It produces `EntityState` and goes through the
same interpolation path a real snapshot pair does, and it never touches
`GameState` — so the client and the server go on agreeing about the world
exactly as they did before.

---

## §12 The light is baked, so the arena has none

The single biggest thing in this renderer's budget was, until this ticket, a
light loop running over every fragment of the biggest object on screen. The
arena is static and small, so all of that can be computed once, offline, and
read back out of a texture for nothing.

`pnpm lightmap:bake` traces `maps/baked/*.json` into
`assets/textures/*_lightmap.png`, which `pnpm assets:build` compresses to a
`.ktx2`. Both are committed, the same arrangement and for the same reason as
`maps/baked/`. What goes into the trace is in `tools/bake-lightmap.ts`; three
things about the *result* bind everything else in this directory.

**The arena's materials have `disableLighting` on.** Babylon skips the light
loop entirely — no attenuation, no `N·L`, no per-light uniform rebind — because
every photon is already in the atlas. There is exactly one real-time light left
in the game, a hemispheric fill, and the arena is **excluded from it**: it is
there for the two things a bake cannot cover, which are the opponent's model
and your own hands.

**The albedo rides in `emissiveColor`.** This looks like a mistake and is not.
Babylon computes `finalDiffuse = clamp(diffuseBase·diffuseColor + emissiveColor
+ vAmbientColor)·baseColor`, and `vAmbientColor` is
`scene.ambientColor · material.ambientColor` — a *scene*-wide multiplier the
player models and the viewmodel are also tuned against. Putting the arena's
albedo through it would mean that re-grading how a model reads in shadow
silently re-graded every wall in the level. `emissiveColor` reaches the same sum
and is per-material, so the two are decoupled. With the light loop off it is not
emission in any physical sense; it is simply the term that survives. The whole
chain is then Quake's:

```
colour = albedo x detail texture x lightmap
```

**A map may now carry as many lights as it likes.** Before the bake the renderer
drew the first four and silently dropped the rest, so a map's `lights` list was
a budget. Now nothing reads it at run time and it is a description:
`maps/arena1.ts` has seven, and four of them exist to light *vertical* surfaces,
which a ceiling lamp cannot — a single overhead light leaves every wall at `N·L`
of nearly zero and the tower in the middle of the arena goes black.

### The materials

`render/materials.ts` is the catalogue: five looks — `concrete`, `metal`,
`trim`, `glass`, `light` — behind the logical names a map writes in
`MapSurface.material`. A lightmapped world is a world of albedo, so what a
material *is* here is which detail texture tiles across it, how much of the
map's tint reaches it, whether it is see-through and whether it makes its own
light. Gloss and specular are not knobs any more, because there is no run-time
light for a highlight to answer to.

`light` is the one surface the bake does not touch. Nothing lights a light: a
lightmap multiplies what it is attached to, so a lamp panel in an otherwise dark
corner would be baked *dark*. `takesLightmap` is where that decision lives and
`MapMesh.lightmapped` is the list the renderer hands to `applyLightmap`.

### The atlas is shared code, not a shared convention

Where each face's light lives is `packages/sim/src/map/lightmapUv.ts`, and it is
in the simulation package on purpose: the baker and the browser both call it, so
they cannot disagree about which wall a texel belongs to. That failure mode is
`docs/assets.md` §3's — a *plausible* picture rather than a broken one — and one
function imported twice is the only fix that survives someone in a hurry.

The unwrap gives every brush face its own rectangle, packed on shelves, at eight
Quake units per texel. Two details are load-bearing: a face's extremes map to the
**centres** of the first and last texel of its rectangle, so a bilinear tap can
never reach the neighbour packed against it; and the atlas *height* is derived
rather than authored, so the artifact carries no rows of black texels nobody has
a use for.

---

## §13 The effects, which are a fold and not a callback

`render/fx.ts`. Three effects and a mark: a rocket trail, an explosion, a rail
beam, and the scorch each one leaves.

It is `audio/cues.ts`'s twin, built the same way and for the same reason. The
tempting shortcut is to spawn an explosion where one is *caused* — in the weapon
code, in the input handler — and every version of that is a guess about a
simulation that is authoritative somewhere else. So the input is what the
renderer is already drawing, and the output is a list of events:

- **a rocket detonated** is a rocket id that was in the last frame's list and is
  not in this one's. `GameState` removes a rocket on the tick it explodes and
  sends nothing else, so its absence *is* the event.
- **somebody fired** is `lastFireTick` differing from the one last seen, which
  is the same edge the fire sound is played on.
- and a player or a rocket seen for the *first* time produces nothing at all,
  which is what stops a client joining mid-flight from detonating every rocket
  in the air at once.

The one thing the fold cannot derive is where a shot landed, because a railgun
is hitscan and leaves no entity behind. The trace comes in as a parameter, and
`main.ts` passes the simulation's own `traceRay` over the map the client is
ticking — so a beam stops at the wall the shot stopped at rather than at a wall
the renderer guessed.

### Ours, not Babylon's, because of the clock

Every particle ages against `tick + alpha` — the simulation's clock and the
accumulator's remainder — exactly like `animState.ts` and `viewmodel.ts`. Two
clients drawing the same tick at 60 Hz and at 240 Hz draw the same explosion.
Babylon's `ParticleSystem` ages itself from the engine's frame delta, which
would be a second clock in the one part of this program that is allowed none
(§1).

What is there instead is three meshes of camera-facing quads whose vertices are
rewritten each frame — one draw call per blend mode, no instancing extension,
and not a single allocation after construction. The pools are fixed and
round-robin, so a full pool evicts the *oldest* effect rather than dropping the
one that just happened.

A trail is paced by **distance travelled**, not by time, for the same reason
footsteps are: a rocket crossing the arena leaves the same trail at any frame
rate, and one that is barely moving does not pile smoke up on the spot.

### A mark is a quad, because every surface is a plane

There is no decal projection here and no clipping against the geometry. Every
surface in this world is cut from a brush plane (`map/geometry.ts`), so a quad
lying in that plane *is* the decal — computed once at the moment of impact and
never touched again. `MeshBuilder.CreateDecal` would allocate a mesh per impact,
in a frame, to solve a problem this world does not have.
