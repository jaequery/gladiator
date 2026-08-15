# Gladiator physics specification

The numbers that decide whether the movement feels like Quake. Everything here
is normative: if the code and this document disagree, one of them is a bug, and
which one is a decision to be made deliberately rather than discovered during a
duel.

Sections are numbered so they can be cited from code comments and commit
messages. Most of them are still to be written:

| §   | Topic                                        | Owner        |
| --- | -------------------------------------------- | ------------ |
| 0.1 | Units, tick rate and the fixed timestep       | **below**    |
| 0.2 | Player bounding box and eye height            | **below**    |
| 0.3 | Coordinate systems and the axis map           | **below**    |
| 1.x | `pmove`: friction, acceleration, snapping     | **below**    |
| 2.x | Tracing: swept AABB, `SlideMove`, step-up     | **below**    |
| 3.x | Weapons: rockets, splash, railgun             | **below**    |
| 4.x | The map format, its baker and its validator   | **below**    |
| 5.x | Reachability: the climbs a level is built around | **below**  |

---

## §0.1 Units, tick rate and the fixed timestep

### Units

| Quantity | Unit | Notes |
| -------- | ---- | ----- |
| Distance | Quake unit (qu) | ~ 0.75 inch, but the conversion is never applied. Kept because every constant below was measured in it. |
| Time     | second | The simulation counts *ticks* and multiplies by `TICK_DT`; it has no clock. |
| Velocity | qu/s | |
| Acceleration | qu/s² | |
| Angles   | angle units | 1/65536 of a turn. `[pitch, yaw, roll]`, Quake frame, pitch positive **downward**. Integers, so an angle survives the network and the state hash exactly. Degrees appear only where a human authors or reads one. |

### The timestep

| Constant | Value | Source |
| -------- | ----- | ------ |
| `TICK_RATE` | 125 | `packages/sim/src/tick.ts` |
| `TICK_INTERVAL_MS` | 8 | |
| `TICK_DT` | 0.008 s = `1 / 125` | |
| `MAX_HOST_FRAME_MS` | 250 | scheduler policy, not physics |
| `GRAVITY` | 800 qu/s² | `packages/sim/src/pmove.ts` |
| `JUMP_VELOCITY` | 270 qu/s | |
| `RUN_SPEED` | 320 qu/s | |

The simulation advances in sub-steps of **exactly 8.000 ms**. Not "about 8" and
not "one host frame": the step length is a *feel* constant, and the next
section is why.

### Why 8 ms is not a performance knob

Quake's `pmove` snaps velocity to whole units every step. Gravity costs
`GRAVITY · TICK_DT` = **6.4 qu/s** of vertical velocity per sub-step, and the
snap rounds that to the nearest integer, which is **6** — every step, in both
directions, because a whole number minus 6.4 always has a fractional part of
0.6 and always rounds up.

So the gravity a player *feels* is not 800. It is

```
6 qu/s per step / 0.008 s = 750 qu/s²
```

and the apex of a jump is

```
JUMP_VELOCITY² / (2 · 750) = 270² / 1500 = 48.6 qu
```

Change the sub-step and that arithmetic changes: at 10 ms gravity costs 8.0 per
step and rounds to exactly 8, giving an effective 800 and an apex of 45.6 qu —
a jump three units shorter, which is the difference between clearing a ledge
and not. **The 8 ms step is load-bearing.** `determinism.test.ts` asserts the
whole derivation so that editing a constant fails a test rather than quietly
re-tuning every jump in the game.

Velocity snapping itself is implemented in GLAD-0B1GDS. The normative choice
here is *round to nearest* (`Math.round`), not truncation: truncation would
give a constant decrement of 7 and an effective gravity of 875.

### Why sub-stepping, rather than a 125 Hz loop

The host — a browser's `requestAnimationFrame`, or the server's tick scheduler
— wakes up when it wakes up, reports how much wall-clock has passed, and the
kernel converts that into a whole number of exact 8.000 ms sub-steps, carrying
the remainder into the next frame. `advanceHost(dtMs)` runs exactly
`floor((remainder + dtMs) / 8)` sub-steps.

Driving the simulation from 125 timer wakeups per second instead would put the
step length at the mercy of a scheduler nobody controls. Node's timers have
millisecond granularity, a shared vCPU has real steal, and the wakeups would
arrive late and in bursts — so the sim would end up correcting for jitter that
sub-stepping simply absorbs. Quake's own `Pmove()` sub-steps for the same
reason.

`TICK_INTERVAL_MS` being **8, a power of two**, is what makes the accumulator
exact rather than approximate: `r / 8`, `Math.floor(r / 8)` and `steps * 8` are
all exact in IEEE 754, so the carried remainder is the true remainder and never
drifts, however many frames go by.

### Time is ticks

`GameState.tick` is the number of sub-steps simulated, and it is the *only*
notion of time inside `packages/sim`. Wall-clock milliseconds are an input to
the scheduler and never to the simulation — which is why `Date.now()` and
`performance.now()` are lint errors in that package. A tick converts to
milliseconds by multiplying by `TICK_INTERVAL_MS`, and that conversion belongs
to whatever is displaying or scheduling, not to the sim.

---

## §0.2 Player bounding box and eye height

The player is a box. Not a capsule, not a mesh, not a cylinder — a box, and an
axis-aligned one that does not rotate with the view. Every movement constant in
§0.1 and §1.x was measured against this solid, and every trace in §2 sweeps it.

| Constant | Value | Source |
| -------- | ----- | ------ |
| `PLAYER_HALF_WIDTH` | 15 qu | `packages/sim/src/bbox.ts` |
| `PLAYER_HEIGHT` | 56 qu | |
| `PLAYER_VIEW_HEIGHT` | 50 qu | |
| `PLAYER_MINS` | `(-15, -15, 0)` | relative to the origin |
| `PLAYER_MAXS` | `(15, 15, 56)` | |

30 units wide and 56 tall. This is Quake 3's `(-15,-15,-24)..(15,15,32)`: the
same solid, written against a different origin.

### The origin is the feet

Quake 3 puts the origin at the middle of the box and carries `mins[2] = -24`.
Gladiator puts it on the soles, so `mins[2] = 0` and `maxs[2] = 56`.

Two reasons, and both are about what a number *reads* as six months later:

- `origin[2]` is then literally the floor height a player is standing on, so a
  spawn point, a ledge and a step are the same number in the map file, in the
  debugger and in the level editor.
- Crouching shrinks `maxs[2]` and leaves `mins[2]` alone, so the feet stay
  planted. With a centred origin, crouching has to move the origin *as well* as
  resize the box, and getting those two half-steps out of order is the classic
  "crouch in a doorway, fall through the floor" bug.

The cost is that Quake 3 source ported verbatim needs 24 added or subtracted at
the seam. That conversion happens once, where a constant is transcribed into
`bbox.ts`, and never at runtime.

Ducking dimensions belong to GLAD-0B1GDS and are deliberately not stated here,
so that there is only ever one place they could be wrong.

---

## §0.3 Coordinate systems and the axis map

Gladiator carries two coordinate systems and exactly one conversion between
them. The conversion is stated here as a matrix, because prose about axes is
how handedness bugs get shipped: everyone agrees on the sentence and disagrees
about the signs.

### The two frames

**Quake frame** (`q`) — the frame the movement code thinks in, because the
constants it inherits were measured in it.

| Axis | Direction |
| ---- | --------- |
| `+qx` | forward   |
| `+qy` | left      |
| `+qz` | up        |

Right-handed. Distances are Quake units.

**Engine frame** (`e`) — the frame the renderer draws in.

| Axis | Direction              |
| ---- | ---------------------- |
| `+ex` | right                  |
| `+ey` | up                     |
| `+ez` | backward (`-ez` is forward) |

Right-handed, Y-up, `-Z` forward — the glTF/OpenGL convention.

### The map

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

Basis vectors, which is the form worth checking against by hand:

| Quake                | Engine        |
| -------------------- | ------------- |
| `(1, 0, 0)` forward  | `(0, 0, -1)`  |
| `(0, 1, 0)` left     | `(-1, 0, 0)`  |
| `(0, 0, 1)` up       | `(0, 1, 0)`   |

### Why the determinant is written down

`det(M) = +1` says `M` is a pure rotation: both frames are right-handed and the
world is not mirrored. That is the whole content of the constraint, and it is
the one property that is cheap to assert and expensive to debug.

The trap is that the axis *names* alone suggest a transcription with one minus
sign instead of two. Drop either one and the determinant becomes `-1`:

```
| 0   1  0 |            |  0  -1   0 |
| 0   0  1 |  det = -1  |  0   0   1 |  det = -1
| -1  0  0 |            |  1   0   0 |
```

A determinant of `-1` is a rotation composed with a mirror. The game still
runs. Movement still feels roughly right in a straight line. But every
rocket-jump curves the wrong way, strafe-jumping accelerates when it should not,
and no amount of tuning the constants will recover it — because the constants
were never wrong.

### Consequences

- The Babylon scene runs right-handed (`scene.useRightHandedSystem = true`).
  A left-handed scene would need `det(M) = -1`, which contradicts the above.
- `packages/sim` never applies `M`. The simulation is entirely in the Quake
  frame; the conversion happens at the renderer boundary, in one place.

### Executable copy

`packages/sim/src/axis.ts` holds `QUAKE_TO_ENGINE` and `determinant3`, and
`axis.test.ts` asserts both the determinant and the basis-vector table above.
That test is what stops this document, `AGENTS.md` and the code from drifting
apart.

---

## §1 `pmove`

The movement. Ported from Quake 3's `bg_pmove.c`, in
`packages/sim/src/pmove/`, and measured by `pmove/pmove.test.ts` — every number
in §1.7 is a reading taken off the running code rather than an identity.

### §1.1 The constants

| Constant | Value | Quake 3 name | Source |
| -------- | ----- | ------------ | ------ |
| `GRAVITY` | 800 qu/s² | `g_gravity` | `pmove/index.ts` |
| `RUN_SPEED` | 320 qu/s | `g_speed`, `ps->speed` | |
| `JUMP_VELOCITY` | 270 qu/s | `JUMP_VELOCITY` | |
| `PM_ACCELERATE` | 10 | `pm_accelerate` | `pmove/accelerate.ts` |
| `PM_AIR_ACCELERATE` | 1 | `pm_airaccelerate` | |
| `AIR_STOP_ACCELERATE` | 2.5 | CPMA's `pm_airstopaccelerate` | |
| `AIR_CONTROL` | **0** | CPMA's `pm_airControl` | |
| `PM_FRICTION` | 6 | `pm_friction` | `pmove/friction.ts` |
| `PM_STOPSPEED` | 100 qu/s | `pm_stopspeed` | |

VQ3 throughout, with exactly one borrowing from Challenge ProMode — see §1.8.

### §1.2 `PM_CmdScale`, and the jump axis that is not in it

A diagonal must not be faster than a straight line. Holding W and D produces a
wish vector of length `sqrt(2)`, and the scale is what turns that back into 320:

```
max   = max(|forwardmove|, |rightmove|)
total = sqrt(forwardmove^2 + rightmove^2)
scale = speed * max / total
```

Quake's own version divides by `127.0 * total`, because its move axes are
`signed char` and 127 is full deflection. A `UserCmd` here carries -1/0/+1, so
the full-scale divisor is 1 and drops out. The arithmetic is otherwise
identical.

**The jump axis is excluded, and Quake includes it.** Quake counts `upmove` in
`total`, where it contributes to the denominator but never to the wish
*vector*, which is horizontal. So holding jump cuts air wishspeed from 320 to
`320 / sqrt(2)` = 226, and holding jump plus a diagonal cuts it to
`320 * sqrt(2/3)` = 261.

That is not a mechanic. It is a tax on input hardware: the players who beat it
are the ones whose keyboard or script releases jump for a tick between hops,
not the ones with better movement. Gladiator drops it, so air wishspeed is 320
whether or not jump is down.

### §1.3 `PM_Friction`

```
speed   = |velocity| , with z zeroed while walking
if speed < 1: velocity.xy = 0 and return
control = max(speed, PM_STOPSPEED)
drop    = control * PM_FRICTION * dt          (only while walking)
velocity *= max(0, speed - drop) / speed
```

At the 8 ms sub-step that is **4.8% of your speed per tick**, and above
`PM_STOPSPEED` it is exactly 4.8% because the drop is proportional. Below 100
ups the floor makes it a flat 4.8 qu/s per tick, which is what makes a player
stop in finite time rather than creeping toward zero forever.

Two gates decide everything the player feels:

- **`walking` only.** There is no air friction at all. That is why speed
  carried into a jump survives it, and why strafe-jumping compounds.
- **`knockbackTicks === 0`.** A player still being knocked back pays no ground
  friction, so the floor cannot file a rocket jump's speed off in the ticks
  before they have left it. Quake's `PMF_TIME_KNOCKBACK`.

### §1.4 `PM_Accelerate` — the mechanic

```
currentspeed = dot(velocity, wishdir)
addspeed     = wishspeed - currentspeed
if addspeed <= 0: return
accelspeed   = min(accel * dt * wishspeed, addspeed)
velocity    += wishdir * accelspeed
```

The gate is on the **projection** of the velocity onto the wish direction, not
on its magnitude. The question it asks is not "are you already doing 320?" but
"are you already doing 320 *in the direction you are asking for*?". Turn 85
degrees away from your velocity and the projection collapses toward zero, the
gate swings open however fast you are travelling, and the acceleration that
lands is mostly perpendicular — which lengthens the vector rather than
replacing it. Do that every tick while airborne and speed compounds.

id shipped this deliberately: the alternative is in `bg_pmove.c` behind
`#if 0`, commented *"proper way (avoids strafe jump maxspeed bug), but feels
bad"*. **It is the mechanic, not a bug.** `pmove.test.ts` asserts that
accelerating *perpendicular* to the velocity increases total speed, so that a
future refactor which "fixes" it fails a test rather than a playtest.

### §1.5 The phase order

One sub-step, Quake 3's `PmoveSingle`:

```
release the jump latch  ->  drop timers  ->  §2.6 speed rail
  ->  PM_GroundTrace  ->  PM_WalkMove | PM_AirMove  ->  PM_GroundTrace
  ->  SnapVector
```

and inside `PM_WalkMove`:

```
PM_CheckJump  ->  (jumped? PM_AirMove, and return)  ->  PM_Friction  ->  ...
```

**`PM_CheckJump` running before `PM_Friction` is the entire bunny hop.** A
successful jump clears `walking`, so friction finds nothing to charge and a
frame-perfect landing-then-jump costs *exactly zero* speed. Miss the tick by one
and it costs 4.8%. Swapping the two calls leaves a game that still runs, still
looks right, and quietly has no movement ceiling.

Two more things in here are deliberate:

- **The jump assigns `velocity[2] = 270`** rather than adding to it.
  QuakeWorld's additive form lets a player stack a jump onto rising velocity —
  off a ramp, out of an explosion — and stack it again.
- **Jump must be released before it fires again** (Quake 3's `PMF_JUMP_HELD`),
  which is the only piece of movement state that survives between sub-steps. It
  is carried as an `EntityFlag`, so it is hashed and encoded like everything
  else: a client whose reconciliation restored everything *except* that bit
  would re-jump on a tick the server did not.

### §1.6 Velocity snapping

Every component of the velocity is rounded to the nearest whole unit at the end
of every sub-step. **Round to nearest, never truncate** — §0.1 has the
derivation, and the short version is that rounding makes gravity behave like
750 and puts the jump apex at 48.6 units, while truncating would make it 875
and 41.6.

Snapping is not free, and the place it shows is §1.7's strafe-jump number. The
acceleration a tick applies is small (2.56 qu/s in the air), so rounding the
*result* is very nearly rounding the acceleration itself — and it is rounded on
the world axes rather than along the velocity. A player turning smoothly gets
slightly less than the continuous model predicts; one turning to the lattice can
get slightly more. Both are Quake, and both are in the test.

### §1.7 The gates

Measured by `packages/sim/src/pmove/pmove.test.ts`, sampled **after `pmove`
returns** — after the second ground trace and after the snap. Tolerances are two
ticks, because a one-tick tolerance would be encoding an unstated decision about
where inside `PmoveSingle` the reading was taken.

| Measurement | Value |
| ----------- | ----- |
| Flat-ground jump apex | 48.53 qu above the take-off (48.60 ± 0.5) |
| 0 -> 320 ups, holding W | 19 ticks = **152 ms** |
| 320 -> 0 ups, no input | 44 ticks = **352 ms** (360 ± 2 ticks) |
| Frame-perfect landing-then-jump | **0%** speed lost |
| One tick late | **4.8%** speed lost |
| Air time per jump | 90 accelerating ticks (89 airborne + the take-off tick) |
| Four chained perfect jumps from 320, W+D | **794–883 ups**, see below |

The last row is a band rather than a number, and the band is the honest answer.
The continuous model — each air tick adds a constant
`2a(wishspeed - a) + a^2` to `v^2`, with `a = 2.56` — predicts **832 ups** after
four 90-tick jumps, and that is the figure the movement was specified against.
Velocity snapping (§1.6) turns it into a range:

| Turning | Reaches |
| ------- | ------- |
| smoothly, ignoring the snap lattice | 794 ups |
| tuned to the snap lattice, to 1/65536 of a turn | 883 ups |

A human approximates the lower bound; only a bot can extract the upper. 832 sits
between them, and `pmove.test.ts` asserts exactly that — both bounds, and the
continuous model that produces 832 — so the discrepancy stays legible instead of
becoming a mystery for whoever reads the number next.

### §1.8 What is deliberately not here

**`airControl` is 0 and the CPM strafe path is cut.** CPMA rotates velocity
toward the wish direction when the player holds W alone, which makes a second,
easier acceleration technique discoverable — but it accelerates at roughly half
the rate of the diagonal path it is meant to teach, so a player who finds it
first learns the slower movement and then has to unlearn it. One movement
vocabulary, not two.

**`airStopAccelerate` is the one thing borrowed from CPMA**, at 2.5, and it
applies **if and only if** `dot(velocity, wishdir) < 0`. VQ3's air control is
otherwise so weak that a mistimed jump cannot be corrected at all — you commit
to a trajectory at take-off and ride it into a wall. 2.5 gives an airborne
player enough authority to kill speed they did not want, and none to gain speed
they did not earn: by construction it can only ever act against the current
heading.

**Ducking is not implemented.** `UserCmd` has no crouch button yet
(`usercmd.ts` names it as arriving with its own ticket), so there is nothing to
drive `PM_CheckDuck` with. §0.2's note assigning the ducked dimensions to this
ticket is deferred to whichever ticket adds that button — the dimensions are
still deliberately unstated, so there is still only one place they could be
wrong.

**Water, ladders, flight and the grapple are not implemented**, and are not
planned: Gladiator has one arena, two weapons and no items.

---

## §2 Tracing

### §2.1 The world is a brush list

Level geometry is a list of **brushes**: convex solids, each defined by the
outward-facing planes that bound it. A plane is `dot(normal, x) <= dist` with
`normal` a unit vector pointing *out* of the solid, so a point is inside a
brush when it is behind every one of its planes.

Convex-and-plane-bounded is what makes §2.2 a closed-form interval
intersection rather than a search. A brush is *not* required to be
axis-aligned: the 45-degree ramp in §2.4 has one non-axial plane, and an
AABB-only world cannot express it.

Brush bounds are **derived**, never authored — `brush()` enumerates the
corners (every triple of planes, keeping the solutions inside all the others)
and rejects a brush that runs to infinity in any direction. Bounds one unit
too small do not fail loudly; they make one brush invisible to the trace from
one direction, and a player falls through the world once every few rounds.

The broadphase is a uniform grid, stored as one flat index array plus per-cell
offsets. Candidates come back sorted by brush index rather than by the order
the grid visited them, so a trace's answer does not depend on the cell size.

`packages/sim/src/collide.ts`.

### §2.2 The swept AABB trace

| Constant | Value | Source |
| -------- | ----- | ------ |
| `SURFACE_CLIP_EPSILON` | 0.125 qu | `packages/sim/src/trace.ts` |

**Traces are swept, never point tests.** At the §2.6 speed clamp a body covers
24 units in one 8 ms tick; a rocket at 900 qu/s covers 7.2 and a rocket-jumping
player covers about 8. Those are large fractions of a 30-unit player box and
larger than plenty of real geometry, so a discrete endpoint test misses walls
that a continuous one cannot.

The box is folded into the geometry rather than carried through it. For each
plane, the plane is pushed out by the box's support distance along its normal —
the Minkowski sum of box and solid — leaving a *ray* against a fattened convex
volume:

```
offset  = ( n.x < 0 ? maxs.x : mins.x,  n.y < 0 ? maxs.y : mins.y,  n.z < 0 ? maxs.z : mins.z )
dist'   = plane.dist - dot(offset, n)
```

The ray-vs-convex test is then interval intersection: walk the planes
accumulating the latest entry fraction and the earliest exit fraction, and the
brush is entered exactly when entry still precedes exit.

A trace stops `SURFACE_CLIP_EPSILON` short of contact. This is not a fudge
factor. Landing *exactly* on a plane leaves the next tick's trace starting on
the boundary, where a rounding error either way decides whether the body is
inside solid — and being inside solid is unrecoverable in a way that being an
eighth of a unit clear of it is not. An eighth is exactly representable in
binary floating point, so the gap is the same gap on every machine.

A consequence worth stating: **a box resting exactly on a surface counts as
inside it.** A body at rest on the floor sits at `z = 0.125`, not `z = 0`.

`traceRay` is `traceBox` with a zero-extent box, deliberately the same code
path, so hitscan and movement cannot disagree about the epsilon.

`packages/sim/src/trace.ts`.

### §2.3 `PM_ClipVelocity` and `OVERCLIP`

| Constant | Value | Source |
| -------- | ----- | ------ |
| `OVERCLIP` | 1.001 | `packages/sim/src/slidemove.ts` |

```
backoff = dot(v, n)
backoff = backoff < 0 ? backoff * OVERCLIP : backoff / OVERCLIP
out     = v - n * backoff
```

100.1% of the velocity into a surface is removed, not 100%, and the extra tenth
of a percent is the whole point: removing exactly the normal component leaves
the body travelling *along* the plane, which means resting on it, which means
re-contacting it every tick until it grinds to a stop. Reflecting a whisker past
parallel pushes it off instead.

The asymmetry — multiply going in, *divide* coming out — is Quake's. A velocity
already leaving the surface is nudged very slightly back towards it, which damps
the one case where the reflection would compound.

Two numbers a player feels, and both are asserted in `slidemove.test.ts`:

- **Landing at 500 qu/s downward leaves +0.5 qu/s upward.** Imperceptible, and
  it is what keeps you from sticking.
- **A 45-degree ramp at 700 qu/s horizontal comes off at (349.6, 350.4).** The
  speed is *rotated*, not spent: 350 qu/s of climb out of a run, against
  `JUMP_VELOCITY`'s 270. That is the ramp jump, which is why this constant is
  not a tunable.

### §2.4 `SlideMove`

| Constant | Value | Source |
| -------- | ----- | ------ |
| `MAX_BUMPS` | 4 | `packages/sim/src/slidemove.ts` |
| `MAX_CLIP_PLANES` | 5 | |

Trace, clip the velocity to what was hit, repeat — up to four times. Two of the
five clip-plane slots are spoken for before the first trace: the ground plane
(so a move never turns down into the floor) and the normalised direction of
travel (so a move never reverses into the velocity it started with).

When a move runs into a plane, three cases, in this order:

1. **One plane.** Clip to it. A wall; you slide along it. Common case, stops
   here.
2. **Two planes.** If the slide runs into a second plane, clip to both. If the
   doubly-clipped velocity now points back into the first, the two clips are
   fighting, and alternating between them is the classic corner jitter. Stop
   treating them as two surfaces: slide along the **crease**,
   `normalize(cross(p_i, p_j))`, projecting the original velocity onto it.
3. **Three planes.** If the crease itself runs into a third plane, there is no
   direction left. **Stop dead** — set the velocity to exactly zero and return.
   Not "clip again", not "zero the horizontal component". Anything else jitters
   in the corner of a room forever, and the acceptance gate asserts `=== 0`
   rather than a tolerance.

A velocity counts as running into a plane when `dot(v, n) < 0.1` qu/s. Sliding
along a wall gives a dot product of zero to within rounding, and without a
threshold every such tick would re-clip against a surface it is parallel to.

Hitting a plane already in the set (`dot > 0.99`) nudges the velocity out along
its normal rather than adding a duplicate, which would burn a clip-plane slot.
Exhausting all five stops the body dead. So does a trace reporting `allsolid`,
except that the horizontal velocity is kept so the body can be walked out.

**The knockback restore.** While a body's knockback timer is running,
`SlideMove` restores the velocity it started the move with — every clip
performed along the way is discarded. This is Quake's `ps->pm_time` behaviour
and it is not a bug: it is what makes a rocket jump keep the speed the
explosion gave it even while scraping along a wall, instead of having it filed
off by the geometry it is sliding past.

**Gravity is a half-step.** When gravity is on, the move integrates with the
velocity at the *midpoint* of the tick while the endpoint velocity is carried
separately and clipped by the same planes; the endpoint velocity is what the
body keeps. Quake's trick for making a jump arc independent of the tick rate.

### §2.5 `StepSlideMove` and the ground trace

| Constant | Value | Source |
| -------- | ----- | ------ |
| `STEP_SIZE` | 18 qu | `packages/sim/src/slidemove.ts` |
| `MIN_WALK_NORMAL` | 0.7 | |
| `GROUND_TRACE_DEPTH` | 0.25 qu | |
| kick-off speed | 10 qu/s | |

`StepSlideMove` runs `SlideMove`; if that hit anything, it lifts the body by
`STEP_SIZE`, runs the move again from up there, and pushes it back down by
however far it actually got lifted. Landing on top of the obstruction is what
climbing a step is, and it is why stairs work without a ramp under them.

**You never step up while rising.** A body with upward velocity that is not
standing on a walkable surface is jumping, and letting a jump take an 18-unit
free ride at the apex turns ledges that should need a rocket jump into ledges
you can mantle.

The ground trace is a 0.25-unit downward sweep of the body's own box. A quarter
of a unit because §2.2's epsilon leaves a resting body an eighth of a unit clear
of the floor, so anything shorter would report a stationary player as airborne
every other tick.

```
onGround = trace hit something
walking  = onGround && trace.normal.z >= MIN_WALK_NORMAL
```

`MIN_WALK_NORMAL = 0.7` is a hair under `cos(45deg)`, so the 45-degree ramp of
§2.3 is walkable and anything steeper is not — the ramp that gives you a ramp
jump is also one you can stand on.

**The kick-off rule.** A body moving upward with
`dot(velocity, plane.normal) > 10` qu/s is not standing on that plane, even
though the trace still finds it an eighth of a unit below. Without it the tick a
jump starts on still counts as grounded, friction is applied to a player who has
already left the floor, and every jump comes out shorter than the last in a way
no constant will fix.

### §2.6 The speed clamp

| Constant | Value | Source |
| -------- | ----- | ------ |
| `MAX_MOVE_SPEED` | 3000 qu/s | `packages/sim/src/slidemove.ts` |

Not physics — a safety clamp, and the number comes from the geometry rather
than from the feel. At 3000 qu/s a body covers 24 units in one tick, still under
the 30-unit width of a player, so a sweep spans at most two broadphase cells per
axis and the four-bump budget has room to resolve a corner. Nothing in normal
play approaches it; a good rocket jump peaks around 1000.

It exists because velocity is an *input* from elsewhere — splash damage, a
knockback, a malicious client's reconciliation — and one absurd value should not
be able to put a body outside the world. It scales the whole vector rather than
each axis, so the direction of travel survives; per-axis clamping (Quake 1's
`sv_maxvelocity`) turns a fast diagonal into a differently-aimed one.

### §2.7 The gate

`packages/sim/src/property.test.ts` walks a player-shaped body through a
committed arena for 10,000 ticks from a committed seed, driving it with random
impulses up to the clamp, and asserts after every tick that it is penetrating
solid geometry by no more than **0.03 qu**. The geometry, the seed, the
iteration count and the tolerance are all in the repository, because a fuzz test
whose inputs are not committed is a different test every time it runs.

---

## §3 Weapons

Two of them, and there will never be a third. Rocket Arena took the item
scramble out of deathmatch so a duel would be decided by movement and aim; a
third weapon is a third thing to balance in exchange for no skill anybody
learns.

Code: `packages/sim/src/weapon.ts` (which weapon an entity is *holding* — an
identity small enough to cross the network, which the renderer reads),
`weapons.ts` (what the weapons *do*: the table, the muzzle, the fire phase and
the railgun), `projectile.ts` (a rocket in flight), `damage.ts` (what a hit
does).

### §3.1 The table

| | Rocket launcher | Railgun |
| --- | --- | --- |
| delivery | `TR_LINEAR` projectile, 900 qu/s | hitscan, 8192 qu |
| direct damage | 100 | 100 |
| splash | 100 falling off linearly over 120 qu | none |
| refire | 800 ms (100 sub-steps) | 1500 ms (188 sub-steps) |
| knockback | 5 x damage, biased upward | 500 qu/s along the shot |
| ammo | unlimited | unlimited |

**There is no ammunition state.** Not a large number — none: `GameState` carries
no count, nothing decrements, and the only thing between two shots is the
refire timer. A match cannot end because somebody ran out, and the bot cannot
be accused of having more shots than a human.

Both weapons are fully automatic and share **one** refire timer
(`EntityState.nextFireTick`, Quake 3's `ps->weaponTime`), so switching weapons
is never a way to fire sooner than either weapon allows. There is no raise or
drop delay: with two weapons and a shared timer, the switch already costs
whatever is left of the last shot's interval.

Refire is stated in milliseconds — Quake's numbers — and converted to whole
sub-steps by rounding **up**. The two directions are not equally harmless:
rounding down is free damage per second, and rounding up costs at most one 8 ms
sub-step nobody can perceive. 800 ms is exactly 100 ticks; 1500 ms is 187.5 and
becomes 188.

A shot leaves the **muzzle**: eye height (§0.2), 14 units along the aim, snapped
to whole units — Quake 3's `CalcMuzzlePoint`. The 14 is load-bearing rather than
cosmetic, and §3.2 says why.

### §3.2 A rocket is a trajectory, not a position

A rocket's origin at any tick is a closed form of three numbers fixed when it
was fired:

```
pos(t) = trBase + (t_ms - trTime_ms) * 0.001 * trDelta
trTime_ms = spawnTick * TICK_INTERVAL_MS - MISSILE_PRESTEP_MS
```

`trBase` is the muzzle, `trDelta` is the velocity, and nothing accumulates. That
is what lets the wire tell a peer about a rocket **exactly once**: a client that
received the spawn can evaluate where it is on every tick afterwards, a dropped
packet cannot leave a rocket hanging in the air, and prediction and authority
cannot drift apart because neither is integrating.

`trDelta` is **snapped to whole units** at the muzzle (Quake's
`SnapVector( bolt->s.pos.trDelta )`, "to save net bandwidth"). Both peers
therefore evaluate the identical expression from identical integer inputs. It
also means a rocket does not travel at exactly 900 — a diagonal shot leaves at
899.44 — and that is Quake rather than a rounding bug.

**The 50 ms prestep.** `trTime` starts 50 ms *in the past*, which is Quake's
`MISSILE_PRESTEP_TIME`, so on the tick it is fired a rocket is already 45 units
downrange and the sweep from the muzzle covers those 45 units immediately.
Every close-range rocket depends on it. Aimed at your feet, the muzzle is 14
units below your eye with 36 units of floor beneath it — inside the 45 — so the
rocket detonates on the frame you fire it. Without the prestep the splash lands
a tick late, and a tick of delay costs about four units of rocket-jump height.

Rockets take **no gravity and no drag**, expire after 15 seconds, and *explode*
when the fuse runs out rather than being quietly removed — a rocket that stopped
existing on one peer a tick before the other is a desync with a fuse on it.

### §3.3 Damage, splash and knockback

Quake 3's `g_combat.c`. Three details decide how the game plays.

**Splash distance is measured to the nearest point on the target's box**, not to
its centre. A rocket at your feet is at distance *zero* and deals the full 100,
which is what makes a rocket jump a fixed, learnable 500 qu/s. Falloff is
linear: `points = damage * (1 - dist / radius)`.

**Damage is truncated to an integer before knockback is derived from it.**
Quake's `(int)points`. A rocket 48 units to your side is 33 units from the side
of your box, which is 72.5 points, which is **72** — and the push is derived
from the 72, so it is 360 qu/s rather than 362.5. Knockback is a function of the
damage the player *sees*.

**Self-damage is halved after the knockback has been computed.** Rocket jumping
lives in the gap between those two statements: 500 qu/s for 50 health, not
250 qu/s for 50 health. GLAD-L4SYN9 chooses between three self-damage modes and
passes its own scale in; every number here assumes the default half.

The push itself:

```
|dv| = g_knockback * min(damage, 200) / mass = 1000 * min(damage, 200) / 200
     = 5 * damage
```

**added** to the current velocity, never assigned. Two rockets on one tick throw
you twice as far, and a rocket you jump into keeps the jump.

Splash is aimed from the explosion at the target with **two** 24s added to its
`z`, and they are different numbers that happen to be equal:

- one converts this repo's feet-origin (§0.2) to the middle of the box Quake
  measures `r.currentOrigin` from;
- one is Quake's deliberate `dir[2] += 24`, whose source comment is "push the
  center of mass higher than the origin so players get knocked into the air
  more".

Together they are why a rocket 48 units to your side pushes you at exactly
**45 degrees** rather than at 27. A railgun hit instead pushes along the
shooter's **aim**, so wherever on the box it lands, the target goes the way the
shooter was pointing.

Splash is **occlusion-tested** and does not pass through walls: five rays, one
to the middle of the box and four to the corners of a 30-unit square around it,
which is Quake's `CanDamage`. It is optimistic by construction — a pillar
narrower than the spread lets a corner ray past — and that optimism is Quake's.

A **direct hit does not also splash the player it hit** (Quake's comment: "splash
damage doesn't apply to person directly hit"), so a rocket in the chest is 100
and not 200. Everyone else in the radius, the shooter included, takes the
falloff.

The knockback **timer** — `clamp(2 * min(damage, 200), 50, 200)` ms, rounded to
the nearest sub-step, so 25 ticks for a full hit — suppresses ground friction,
swaps ground acceleration for air acceleration, and makes `slideMove` restore
the velocity a move started with (§1, `EntityState.knockbackTicks`). That window
is why a rocket jump cannot be cancelled the instant you touch the ground. Quake
only arms it when it is not already running, so a stream of small hits cannot
hold a player up indefinitely.

### §3.4 What a rocket jump actually reaches

§5.4 designs ledges around **166** for a standing rocket jump and **395** for a
jump-plus-rocket, both floors of `v^2 / (2 * 750)` for launches of 500 and 770.
Measured against a real rocket rather than an assigned velocity
(`weapons.test.ts`):

| | closed form | measured apex |
| --- | --- | --- |
| standing rocket jump | 166.67 | **166.53** |
| jump plus rocket | 395.27 | **380.94** |

The standing figure lands where §5.4 says. The jump-plus-rocket is **3.6%
short**, and both reasons are the price of the splash being a rocket rather than
a number:

- the jump has already spent one sub-step of gravity by the time the explosion
  lands — 270 becomes 264 — because firing happens *after* the movement phase,
  and it has to (see §3.5);
- that same sub-step lifts the player's feet 2.1 units off the floor the rocket
  detonates against, which costs two points of splash and ten qu/s of push.

`264 + 490 = 754`, and `754^2 / 1500 = 379`.

**The 395 design bound is still right**, and §5.5 already says why: step-up
applies on the way *down*, so a player arriving at a ledge face while falling
mantles up to `STEP_SIZE` above their apex. `weapons.test.ts` drives a real
player with a real rocket at a ledge of exactly 395 and asserts they get on to
it. What is *not* true is the reading that a jump-plus-rocket peaks at 395 in
open air; it peaks at 381, and a map that needs the last 14 units of that is
relying on the mantle.

### §3.5 Firing happens after moving, and rockets move after both

The tick phase order (`kernel.ts`) is:

```
advance the PRNG -> move players -> fire weapons -> move rockets -> expire
```

Two of those adjacencies are mechanics rather than bookkeeping.

**Players move before they fire.** `PM_CheckJump` *assigns* `velocity[2]`
(§1.5), so splash that landed before the movement phase would simply be
overwritten by the jump it was meant to add to, and there would be no such thing
as a rocket jump. Quake's order is the same: `PM_Weapon` raises the fire event
inside `Pmove`, and `ClientEvents` acts on it immediately afterwards.

**Rockets move after both.** A rocket fired this tick is swept this tick, which
is what the 50 ms prestep (§3.2) is for.

---

## §4 Maps

The format level geometry is authored in, the tool that compiles it, and the
rules that tool refuses to compile. The arena itself is GLAD-B8DI4J; this
section is the machinery under it.

Code: `packages/sim/src/map/` (schema, collision bridge, derived geometry,
validator, loader), `maps/` (authoring helpers and the maps themselves),
`tools/bake-map.ts` (the baker).

### §4.1 The format

A map is a list of **brushes** — axis-aligned boxes and constrained ramps —
plus the spawns, surfaces, lights and props that hang off them. It is
hand-authored in TypeScript under `maps/`, compiled to JSON by `pnpm map:bake`,
and loaded identically by a browser and by a headless Node process.

Quake frame, Quake units, **whole numbers**. Integers are exact in binary
floating point, so every plane distance a brush produces is exact too and two
peers derive identical planes by arithmetic rather than by both rounding the
same way. It is also what every brush-based level editor since 1996 has snapped
to. The bake rejects a fractional coordinate.

A spawn's `origin` is the player origin, which is **at the feet** (§0.2), so a
spawn standing on a floor whose top is at `z = 0` is written `z = 0`. Its `yaw`
is in angle units; `maps/helpers.ts` takes degrees from the author and converts
once, at authoring time.

### §4.2 Visual geometry is derived, not authored

**One brush list, two consumers.** The sim turns it into trace structures
(`map/collide.ts`); the client turns it into merged render meshes
(`map/geometry.ts`) — from the *same planes*, by clipping a large quadrilateral
on each plane against all the others, which is Quake's winding algorithm.

So what you can walk on is what you can see **by construction**. The bug where a
wall looks solid and is not, or is solid and looks like air, is a shape the
format cannot express.

Two escape hatches exist, both named, both visible in a diff:

| Flag       | Effect                                          |
| ---------- | ----------------------------------------------- |
| `nonSolid` | drawn, not collided — glass, a decorative grate  |
| `noRender` | collided, not drawn — Quake's clip brush         |

Decoration that must affect neither goes in `props[]`, a list of glTF references
the sim never parses. That valve matters: the moment an author cannot add a
torch bracket without also adding collision, they start reaching for `nonSolid`
on real geometry, and the one brush list stops describing the world.

Geometry comes out in the **Quake frame**, like everything else the sim
produces; `QUAKE_TO_ENGINE` is applied once, by the renderer (§0.3). Its
determinant is `+1`, so triangle winding survives the conversion.

### §4.3 Ramps

A ramp is an AABB with its top face replaced by one analytic sloped plane. The
plane meets the box's top face at the **high** end of the run and descends from
there; the box below it is the plinth, and it wants to be sunk into whatever the
ramp stands on — a ramp that stops exactly at floor level has a zero-height
vertical face at its foot, and a body running at it flush with the ground clips
against *that* instead of walking up the slope.

Exactly two gradients, written as `rise:run`:

| Slope | Angle   | Unit normal `z`      | Why this one                              |
| ----- | ------- | -------------------- | ----------------------------------------- |
| `1:1` | 45°     | `1/√2` = 0.7071      | a hair over `MIN_WALK_NORMAL`: the steepest thing a player can walk up |
| `1:2` | 26.57°  | `2/√5` = 0.8944      | the gentle ramp you take at full speed    |

Both have integer normals before normalisation — `(-1, 0, 1)` and `(-1, 0, 2)` —
so the unit normal is whatever `Math.sqrt` says it is on both peers rather than
whatever a human rounded it to.

Arbitrary angles are deliberately unavailable. Every one of them is a new
interaction with step-up, with `clipVelocity` and with the walkable-normal
threshold, and an author reaching for 31 degrees is reaching for a physics
decision they cannot see the consequences of.

The bake rejects a box too shallow to hold its own slope, with the arithmetic in
the message.

### §4.4 What the bake refuses

| Constant | Value | Source |
| -------- | ----- | ------ |
| `MIN_SPAWN_HEADROOM` | 96 qu | `packages/sim/src/map/schema.ts` |
| `MIN_SPAWN_SEPARATION` | 512 qu | |

Every rule below is one that, unchecked, produces a bug that only shows up in a
live round. Diagnostics carry a stable `code`, a path into the map and a
sentence the author reads; the bake reports all of them at once rather than the
first.

| Code | Refused because |
| ---- | --------------- |
| `spawn-in-solid` | a player standing there is inside geometry — measured with `boxPenetration` and the real player box, not a point |
| `spawn-headroom` | under `MIN_SPAWN_HEADROOM` of clear space above the feet: the 56-unit player plus 40 of ceiling, because everyone jumps on the first frame of a round |
| `spawn-separation` | two spawns closer than `MIN_SPAWN_SEPARATION`, about two seconds of running |
| `inverted-extents` | `maxs` not strictly greater than `mins` on some axis — a brush that is not there |
| `unreferenced-surface` | a surface no brush uses; dead content is how a map file stops describing the map |
| `unknown-surface` | a brush naming a surface that does not exist |
| `ramp-too-shallow` | the slope runs out before the end of the box |
| `off-grid` | a coordinate that is not a whole Quake unit (§4.1) |
| `too-few-spawns` | fewer than two: it is a duel map |
| `invisible-and-intangible` | both `nonSolid` and `noRender`, which does nothing at all |

The validator lives in `packages/sim`, not in `tools/`, because it is the sim
that has to survive the result. A rule enforced by the baker alone protects only
maps that went through the baker.

Two passes, and the order matters: structural rules first, then the geometric
ones. `boxBrush` throws on inverted extents, and a stack trace out of the
collision code is a much worse error message than
`brushes[7]: maxs.x (64) is not greater than mins.x (128)`.

### §4.5 The map hash

`BakedMap.hash` is eight lowercase hex digits: FNV-1a over a canonical encoding
of the map's content, raw IEEE 754 bytes, strings length-prefixed so that
`["ab", "c"]` and `["a", "bc"]` cannot collide. `MAP_FORMAT_VERSION` is folded
in first.

It is **recomputed** at load and checked against what the artifact claims. A
hash trusted from the file it describes proves nothing — it would agree with a
hand-edited artifact, which is exactly the case worth catching.

The client and the server exchange it in the handshake (`ClientHello.mapHash`,
`ServerWelcome.mapHash`) and the server refuses the session with a
`map_mismatch` frame and close code 4004 if they differ. `PROTOCOL_VERSION`
covers the shape of the messages; this covers the world they describe, and a map
can change without the protocol changing.

The failure it exists for is a deploy race: the client ships to Vercel and the
server to Fly, never at the same instant, so for a minute or two after every
deploy a browser holding yesterday's bundle can open a socket to today's server.
Without this check the two simulate different worlds from identical inputs, and
every symptom of that — a player standing in a wall, a rocket that hits nothing,
a state hash that will not settle — points at the netcode.

### §4.6 The baked artifacts are committed

`maps/baked/*.json` is in the repository, which is what lets `pnpm build` and a
Vercel deploy work with no bake step in front of them. `tools/bake-map.test.ts`
re-bakes every map in memory and fails if what is committed is stale, so the
tree cannot hold a map nobody can reproduce. `pnpm map:bake --check` is the same
question from the command line.

---

## §5 Reachability

Four numbers, and the machine check that holds a level to them.

A duel arena is designed *around* the movement or it is decoration with a
player in it. This section states how high the movement climbs, where each
number comes from, and how `pnpm map:bake` refuses a map with a ledge outside
them.

Code: `packages/sim/src/map/reachability.ts` (the metrics and the analysis),
`packages/sim/src/map/validate.ts` (the rule), `maps/arena1.ts` (the arena built
to it, GLAD-B8DI4J).

### §5.1 A climb is measured from the feet, in whole units

The quantity a level designer needs is: **how far above the surface I am
standing on can the next surface be, and still be one I can get on to.**

- Measured at the **feet**, because the origin is the feet (§0.2) and a ledge's
  height in a map file is the `z` of its top face. Nothing here is measured at
  the eye or at the middle of the box.
- Rounded **down** to a whole unit. A map is authored in whole units (§4.1), and
  a ledge at the apex to three decimal places is a ledge nobody lands on twice.
- Stated as the **apex**: how high the feet get. Step-up is not counted, and
  §5.5 says why that slack is deliberately left on the table.

### §5.2 Everything closed-form uses the *felt* gravity, 750

`GRAVITY` is 800 and no player has ever experienced 800. `GRAVITY * TICK_DT` is
6.4 qu/s of downward velocity per sub-step; `snapVelocity` rounds the result to
a whole number every tick, and a whole number minus 6.4 always rounds up, so the
velocity actually lost is **6**, every tick, in both directions (§1.6).

```
FELT_GRAVITY = round(GRAVITY * TICK_DT) / TICK_DT = 6 / 0.008 = 750
```

It is `pmove/index.ts`'s `FELT_GRAVITY`, derived rather than typed, so a change
to the timestep or to the snapping carries it. Every closed form below is
written in terms of it:

| Quantity | Closed form | Why it is that one |
| -------- | ----------- | ------------------ |
| apex of a launch `v` | `v² / (2g)` | how high the feet get |
| horizontal reach at climb `h` | `RUN_SPEED * (v + √(v² − 2gh)) / g` | the *later* root: the last moment the ledge is still below you is the last moment you can land on it |

The horizontal reach is worth one line of sanity check: at `h = 0` it is the
whole flight, and at the apex it is exactly half of it. Both fall out of the
formula, and `reachability.test.ts` asserts them.

### §5.3 The rocket jump launches at 500 qu/s

Quake 3's arithmetic, transcribed. `G_Damage` pushes the victim by
`g_knockback * knockback / mass` — `1000 * knockback / 200` — and a rocket that
lands under your own feet does its full 100 points of splash, so the push is
`100 * 5 = 500` qu/s straight up.

A jump *assigns* `velocity[2] = 270` (§1.5), it does not add, so a jump and a
rocket on the same tick compose to `270 + 500 = 770` rather than to 500.

`ROCKET_JUMP_LAUNCH` is now **derived** in `weapons.ts` — the splash damage in
the weapon table, through the knockback formula (§3.3) — and re-exported by
`map/reachability.ts`, which is what needs it. So the day the splash damage
changes is the day the reachability tests fail and every ledge height in `maps/`
is re-checked, which is the point of the indirection.

What a real rocket measurably reaches, as opposed to what the closed form
predicts, is §3.4. The standing number lands; the jump-plus-rocket apex comes in
3.6% under, and the 395 climb survives on the step-up slack §5.5 describes.

### §5.4 The four climbs

| Climb | Technique | Launch | Where the number comes from |
| ----- | --------- | ------ | --------------------------- |
| **18** | a step | — | `STEP_SIZE`. `StepSlideMove` lifts a blocked move by this and retries (§2.5) |
| **48** | a jump | 270 | `⌊270² / 1500⌋` = ⌊48.6⌋ |
| **166** | a standing rocket jump | 500 | `⌊500² / 1500⌋` = ⌊166.67⌋ |
| **395** | a jump-plus-rocket | 770 | `⌊770² / 1500⌋` = ⌊395.27⌋ |

`reachability.test.ts` measures every one of them against the real `pmove`
rather than against this table: it launches a body, records the highest its feet
get, and asserts the floor of the measurement is the number above. It then puts
a ledge of exactly that height in a world and drives a running player at it.

> The rocket-jump number is **166**, not the 167 you get by rounding 166.67 to
> nearest. The apex the simulation actually reaches is 166.657, so a ledge at
> 167 is one unit too tall. Rounding a reachability bound up is how a map ships
> with a ledge that is reachable in the spreadsheet and not in the game.

Two notes on the last row. It assumes the splash lands on the **same tick** as
the jump, which is the best case; every tick of delay between the two costs
about four units of apex. And nothing in play goes higher — a jump-plus-rocket
peaks a little over 1000 qu/s of total speed, which is why `MAX_MOVE_SPEED`
(§2.6) sits at three times that and has never fired.

### §5.5 What the bake checks

`analyzeReachability` samples every place in a map a player can stand, joins the
ones a player can walk between, floods out from the spawns, and labels
everything left over with the cheapest of the four techniques that gets on to
it. A surface no technique reaches is `unreachable-ledge` and the bake refuses
it (§4.4).

**Standing** is asked with the real player box and the real trace — the box has
to be clear, and the box has to be *dropped* on to the surface rather than
placed on it. Those are not the same on a slope: an axis-aligned box rests on
its uphill edge, so its origin sits half a box-width's worth of rise above the
plane under it, 7.5 units on a 1:2 ramp and 15 on a 1:1. Placing the sample on
the analytic surface instead puts it inside the geometry and makes every ramp in
every map read as unwalkable.

**Samples are 16 units apart**, which is not a resolution knob: a 1:1 ramp — the
steepest thing the format has — climbs exactly 16 across that, which is under
`STEP_SIZE`, so a ramp is a run of ordinary walk edges rather than a special
case. Adjacency reaches **two** columns, because the player is 30 units wide:
the sample one column short of a riser is one where the box is already inside
it, so the last standable sample below a step and the first one above it are 32
apart.

**Dropping does not count as reaching.** The flood uses walk edges and climbs,
never falls. That is stricter than the movement, on purpose: with no items and
no teleporters, a ledge you can only fall on to is a ledge you can only leave,
and a player who takes it is stuck there until somebody kills them.

What it proves is that the *geometry* is inside the movement's envelope. It does
not trace the arc, so a pillar in the middle of a jump is not modelled, and it
assumes `RUN_SPEED` horizontally, which is the slowest a moving player goes.
Both make it optimistic about a jump that is possible and awkward; neither lets
an unreachable ledge through.

The slack that makes designing to the bare apex safe is **step-up on the way
down**. `StepSlideMove` refuses to step while rising — deliberately, or a jump
would grab a free 18 units at the apex — but it steps happily while falling, so
a player arriving at a ledge face on the way down mantles up to `STEP_SIZE`
above their apex. That is measured, not assumed: the test asserts each technique
gets on to a ledge of exactly its height and fails on one
`STEP_SIZE + 8` above it.
