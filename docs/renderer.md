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
violating code and fails if the check accepts it.

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
