/**
 * The committed brush corpus the collision fuzz gate runs against.
 *
 * A fuzz test without a committed corpus is not a regression test — it is a
 * different test every time someone edits it, and "it passed on my branch"
 * stops meaning anything. So the geometry lives here, in the repository, next
 * to the golden replay, and `property.test.ts` names it along with a fixed seed
 * and a fixed iteration count.
 *
 * The arena is sealed on all six sides, which is the property that makes the
 * fuzz loop a *walk* rather than 10,000 independent drops: a body that cannot
 * leave never has to be re-spawned, so every tick starts from a position the
 * previous tick produced, and a slow leak into geometry has 10,000 ticks to
 * show itself instead of one.
 *
 * Every feature in it is here to reach a specific branch of `slidemove.ts`:
 *
 * | Feature      | What it exercises                                       |
 * | ------------ | ------------------------------------------------------- |
 * | floor, walls | the common case, and the seal                           |
 * | `ramp`       | a walkable non-axial plane — the ramp jump              |
 * | `steps`      | `stepSlideMove`'s step-up, at 16 of the 18 units allowed |
 * | `pillar`     | outside corners, where two planes diverge               |
 * | `wedge`      | a 45-degree inside corner, so creases are not all 90     |
 * | `steep slab` | `groundPlane` without `walking` — a slope you slide off  |
 * | `overhang`   | a ceiling low enough to clip a jump                      |
 * | `thinWall`   | 8 units thick, less than a third of a tick's travel      |
 *
 * Coordinates are Quake frame, in Quake units, and `z = 0` is the floor
 * surface — the same plane a player's `origin` sits on (`bbox.ts` §0.2).
 */

import { boxBrush, brush, createCollisionWorld } from '../collide.ts'
import type { Brush, CollisionWorld } from '../collide.ts'

/** Half-width of the open floor, in Quake units. */
export const ARENA_HALF_EXTENT = 512

/** Height of the open volume, in Quake units. */
export const ARENA_CEILING = 512

/** How thick the shell is. Thick enough that nothing can be pushed through it. */
const SHELL = 64

const OUTER = ARENA_HALF_EXTENT + SHELL

/**
 * The brush list, in the order it is baked. The order is part of the fixture:
 * `trace.ts` reports the brush it hit by index, and the broadphase resolves
 * ties by ascending index.
 */
export const PROVING_GROUND_BRUSHES: readonly Brush[] = [
  /* The shell. */
  boxBrush([-OUTER, -OUTER, -SHELL], [OUTER, OUTER, 0]),
  boxBrush([-OUTER, -OUTER, ARENA_CEILING], [OUTER, OUTER, ARENA_CEILING + SHELL]),
  boxBrush([ARENA_HALF_EXTENT, -OUTER, -SHELL], [OUTER, OUTER, ARENA_CEILING + SHELL]),
  boxBrush([-OUTER, -OUTER, -SHELL], [-ARENA_HALF_EXTENT, OUTER, ARENA_CEILING + SHELL]),
  boxBrush([-OUTER, ARENA_HALF_EXTENT, -SHELL], [OUTER, OUTER, ARENA_CEILING + SHELL]),
  boxBrush([-OUTER, -OUTER, -SHELL], [OUTER, -ARENA_HALF_EXTENT, ARENA_CEILING + SHELL]),

  /* A 45-degree ramp rising in +x from x = 128 to x = 256, so `z = x - 128`.
   * The surface normal comes out at exactly (-1, 0, 1) / sqrt(2), whose z
   * component is 0.7071 — a hair over MIN_WALK_NORMAL, so it is walkable.
   *
   * The wedge is sunk 64 units into the floor rather than sitting on it. That
   * is how a ramp is built in a real map, and it matters: a wedge that stops at
   * z = 0 has a zero-area vertical face at its foot, and a body running at it
   * flush with the floor clips against *that* rather than against the slope. */
  brush([
    { normal: [0, 0, -1], dist: 64 },
    { normal: [1, 0, 0], dist: 256 },
    { normal: [0, 1, 0], dist: 128 },
    { normal: [0, -1, 0], dist: 128 },
    { normal: [-1, 0, 1], dist: -128 },
  ]),

  /* Three 16-unit steps climbing towards -x. Under STEP_SIZE, so a body walks
   * up them; the top one is 48 units, well over it, so it cannot be walked
   * up from the side. */
  boxBrush([-256, -256, 0], [-192, -64, 16]),
  boxBrush([-320, -256, 0], [-256, -64, 32]),
  boxBrush([-384, -256, 0], [-320, -64, 48]),

  /* A square column: four outside corners, where two clip planes diverge
   * rather than converge. */
  boxBrush([-64, -320, 0], [0, -256, 256]),

  /* The +x/+y corner cut off by a 45-degree wall, so the arena has an inside
   * crease that is not a right angle. */
  brush([
    { normal: [1, 0, 0], dist: ARENA_HALF_EXTENT },
    { normal: [0, 1, 0], dist: ARENA_HALF_EXTENT },
    { normal: [0, 0, 1], dist: 256 },
    { normal: [0, 0, -1], dist: 0 },
    { normal: [-1, -1, 0], dist: -640 },
  ]),

  /* A 53-degree slab, also sunk into the floor. Its normal is (0, -0.8, 0.6),
   * and 0.6 is under MIN_WALK_NORMAL — so a body touching it has a ground
   * plane but is not walking, and slides back off. */
  brush([
    { normal: [0, -1, 0], dist: 384 },
    { normal: [0, 1, 0], dist: -320 },
    { normal: [0, 0, -1], dist: 64 },
    { normal: [1, 0, 0], dist: 256 },
    { normal: [-1, 0, 0], dist: 256 },
    { normal: [0, -4, 3], dist: 1536 },
  ]),

  /* A ceiling slab leaving a 96-unit crawlspace — 40 units of headroom over a
   * 56-unit player, which a jump does not fit through. */
  boxBrush([-ARENA_HALF_EXTENT, 128, 96], [-256, 384, ARENA_CEILING]),

  /* Eight units thick. At the 3000 qu/s clamp a body covers 24 units in one
   * tick, so anything that resolves this wall by testing the endpoint has
   * already failed. */
  boxBrush([64, -192, 0], [72, 192, 192]),
]

/** The baked world. Built once; it is immutable level data. */
export function createProvingGround(): CollisionWorld {
  return createCollisionWorld(PROVING_GROUND_BRUSHES)
}

/**
 * A spot with nothing in it, on the floor, at the middle of the arena.
 *
 * Chosen by hand and asserted clear in `property.test.ts`, because "the fuzz
 * walk started inside a wall" is a failure mode that looks exactly like the one
 * the gate is meant to catch.
 */
export const PROVING_GROUND_SPAWN: readonly [number, number, number] = [-32, 320, 0]
