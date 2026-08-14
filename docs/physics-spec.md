# Gladiator physics specification

The numbers that decide whether the movement feels like Quake. Everything here
is normative: if the code and this document disagree, one of them is a bug, and
which one is a decision to be made deliberately rather than discovered during a
duel.

Sections are numbered so they can be cited from code comments and commit
messages. Most of them are still to be written:

| §   | Topic                                        | Owner        |
| --- | -------------------------------------------- | ------------ |
| 0.1 | Units, tick rate and the fixed timestep       | GLAD-OOELC5  |
| 0.2 | Player bounding box and eye height            | GLAD-3SCN0U  |
| 0.3 | Coordinate systems and the axis map           | **below**    |
| 1.x | `pmove`: friction, acceleration, air control  | GLAD-0B1GDS  |
| 2.x | Tracing: swept AABB, `SlideMove`, step-up     | GLAD-3SCN0U  |
| 3.x | Weapons: rockets, splash, railgun             | GLAD-0QWRYK  |

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
