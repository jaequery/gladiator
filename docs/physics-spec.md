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
| 0.2 | Player bounding box and eye height            | GLAD-3SCN0U  |
| 0.3 | Coordinate systems and the axis map           | **below**    |
| 1.x | `pmove`: friction, acceleration, air control  | GLAD-0B1GDS  |
| 2.x | Tracing: swept AABB, `SlideMove`, step-up     | GLAD-3SCN0U  |
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
