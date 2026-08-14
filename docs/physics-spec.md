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
| 3.x | Weapons: rockets, splash, railgun             | GLAD-0QWRYK  |

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
