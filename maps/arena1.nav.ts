/**
 * `arena1.nav` — how the bot gets around **Crucible**.
 *
 * Sixty-three hand-placed positions and the traversals between them. Read this
 * next to `maps/arena1.ts`: every node here is somewhere on a surface in there,
 * and every link is a claim about the movement that `pnpm nav:bake` checks
 * against the real trace and the real player box before it will write anything.
 *
 * ## The shape of the graph is the shape of the arena
 *
 * ```
 *                              +y  (north)
 *      +-------------------------------------------------+
 *      | balcony-nw      |  ramp-n   |    lane-n / SPAWN B|
 *      |    (perch)      +-----------+                    |
 *      |  crate-nw   +-----------------------+            |
 *      | lane-w      |  mound ring  [tower]  |    lane-e  |   +x (east)
 *      |             +-----------------------+            |
 *      |                 +-----------+                    |
 *      | SPAWN A / lane-s|  ramp-s   |   balcony-se       |
 *      +-------------------------------------------------+
 *                              -y  (south)
 * ```
 *
 * Three concentric rings and four ways between them. The **wall lanes** are the
 * railgun's — long, straight, and the only places in the arena with seven
 * hundred units of clear line. The **mound ring** is the rocket launcher's — 96
 * units wide, a corner every quarter turn, and a 48-unit drop off the side of
 * it. The **inner floor arcs** are the ground you cross to get from one to the
 * other, which is where the fight is, and they are four separate arcs rather
 * than one ring because the staircases and the ramps interrupt the floor.
 *
 * ## What is `ground` and what is a `perch`
 *
 * Every `ground` node routes to every other one, and the bake refuses the graph
 * if that stops being true. The two balconies and the tower are tagged `perch`
 * instead, because the only way up to them is a rocket jump and `rocketjump` is
 * a v2 link kind (GLAD-OB46VC's constraints). They still carry the drops *off*
 * them, and they are still in the visibility bitset, so the bot knows what can
 * be seen from up there long before it can get up there.
 *
 * That is the honest encoding, and the alternative is worse: linking the
 * balconies with a `jump` they cannot make would make the routing guarantee
 * pass and the bot walk into a wall.
 *
 * ## Rotationally symmetric, like the map
 *
 * Every node at `(x, y)` has a twin at `(-x, -y)` and every link has a mirrored
 * twin, because `maps/arena1.ts` is the same map turned half a turn and a
 * routing graph that was not would hand one spawn better paths than the other.
 * `arena1.nav.test.ts` asserts it rather than trusting this paragraph.
 */

import { defineNav, drop, jump, node, walk, walkChain } from './nav-helpers.ts'

/* --------------------------------------------------------------------------
 * The heights, from `arena1.ts`. Named here so a node reads as a place rather
 * than as three numbers.
 * ----------------------------------------------------------------------- */

/** The open floor. */
const FLOOR = 0

/** The top of the mound, and of the third stair tread. */
const MOUND = 48

/** The top of a crate. A jump from the floor. */
const CRATE = 40

/** The top of a balcony. A standing rocket jump from the floor — v2. */
const BALCONY = 128

/** The tower's perch. A jump-plus-rocket off the mound — v2. */
const TOWER = 320

export default defineNav({
  map: 'arena1',

  nodes: [
    /* ---- the wall lanes: the railgun's ground -------------------------- */
    node('lane-sw', [-448, -448, FLOOR], 'ground'),
    node('lane-s-1', [-272, -448, FLOOR], 'ground'),
    node('lane-s-2', [-96, -448, FLOOR], 'ground'),
    node('lane-s-3', [96, -448, FLOOR], 'ground'),
    node('lane-e-1', [448, -256, FLOOR], 'ground'),
    node('lane-e-2', [448, -96, FLOOR], 'ground'),
    node('lane-e-3', [448, 96, FLOOR], 'ground'),
    node('lane-e-4', [448, 272, FLOOR], 'ground'),
    node('lane-ne', [448, 448, FLOOR], 'ground'),
    node('lane-n-1', [272, 448, FLOOR], 'ground'),
    node('lane-n-2', [96, 448, FLOOR], 'ground'),
    node('lane-n-3', [-96, 448, FLOOR], 'ground'),
    node('lane-w-1', [-448, 256, FLOOR], 'ground'),
    node('lane-w-2', [-448, 96, FLOOR], 'ground'),
    node('lane-w-3', [-448, -96, FLOOR], 'ground'),
    node('lane-w-4', [-448, -272, FLOOR], 'ground'),

    /* ---- where the round starts ---------------------------------------- */
    node('spawn-sw', [-352, -352, FLOOR], 'ground', 'spawn'),
    node('spawn-ne', [352, 352, FLOOR], 'ground', 'spawn'),

    /* ---- the inner floor, in four arcs --------------------------------- *
     * Not a ring: the staircases block it at east and west and the ramps at
     * north and south, so the only way round at floor level is out to a lane
     * and back. That is a fact about the arena, and the graph says it. */
    node('ring-ne-e', [240, 144, FLOOR], 'ground'),
    node('ring-ne', [240, 240, FLOOR], 'ground'),
    node('ring-ne-n', [144, 240, FLOOR], 'ground'),
    node('ring-nw-n', [-144, 240, FLOOR], 'ground'),
    node('ring-nw', [-240, 240, FLOOR], 'ground'),
    node('ring-nw-w', [-240, 144, FLOOR], 'ground'),
    node('ring-sw-w', [-240, -144, FLOOR], 'ground'),
    node('ring-sw', [-240, -240, FLOOR], 'ground'),
    node('ring-sw-s', [-144, -240, FLOOR], 'ground'),
    node('ring-se-s', [144, -240, FLOOR], 'ground'),
    node('ring-se', [240, -240, FLOOR], 'ground'),
    node('ring-se-e', [240, -144, FLOOR], 'ground'),

    /* ---- the feet of the four ways up ---------------------------------- */
    node('stair-e-foot', [368, 0, FLOOR], 'ground'),
    node('stair-w-foot', [-368, 0, FLOOR], 'ground'),
    node('ramp-n-foot', [0, 320, FLOOR], 'ground'),
    node('ramp-s-foot', [0, -320, FLOOR], 'ground'),
    node('floor-n-e', [144, 320, FLOOR], 'ground'),
    node('floor-n-w', [-144, 320, FLOOR], 'ground'),
    node('floor-s-e', [144, -320, FLOOR], 'ground'),
    node('floor-s-w', [-144, -320, FLOOR], 'ground'),

    /* ---- the staircases: 16 a tread, which is under a step ------------- */
    node('stair-e-1', [312, 0, 16], 'ground'),
    node('stair-e-2', [264, 0, 32], 'ground'),
    node('stair-e-3', [216, 0, MOUND], 'ground'),
    node('stair-w-1', [-312, 0, 16], 'ground'),
    node('stair-w-2', [-264, 0, 32], 'ground'),
    node('stair-w-3', [-216, 0, MOUND], 'ground'),

    /* ---- the ramps. Authored at the plane height and snapped by the bake
     * to where the box actually rests, which on a 1:2 slope is 7.5 higher. */
    node('ramp-n', [0, 240, 24], 'ground'),
    node('ramp-s', [0, -240, 24], 'ground'),

    /* ---- the mound ring: the rocket launcher's ground ------------------ */
    node('mound-n', [0, 144, MOUND], 'ground'),
    node('mound-ne', [144, 144, MOUND], 'ground'),
    node('mound-e', [144, 0, MOUND], 'ground'),
    node('mound-se', [144, -144, MOUND], 'ground'),
    node('mound-s', [0, -144, MOUND], 'ground'),
    node('mound-sw', [-144, -144, MOUND], 'ground'),
    node('mound-w', [-144, 0, MOUND], 'ground'),
    node('mound-nw', [-144, 144, MOUND], 'ground'),

    /* ---- the crates. A jump up, and nothing else on them --------------- */
    node('crate-se-foot', [160, -400, FLOOR], 'ground'),
    node('crate-se', [240, -400, CRATE], 'ground'),
    node('crate-nw-foot', [-160, 400, FLOOR], 'ground'),
    node('crate-nw', [-240, 400, CRATE], 'ground'),

    /* ---- perches: a rocket to get up, and a fall to get down ----------- */
    node('balcony-se-lip', [320, -320, BALCONY], 'perch'),
    node('balcony-se-back', [448, -448, BALCONY], 'perch'),
    node('balcony-nw-lip', [-320, 320, BALCONY], 'perch'),
    node('balcony-nw-back', [-448, 448, BALCONY], 'perch'),
    node('tower-top', [0, 0, TOWER], 'perch'),
  ],

  links: [
    /* ---- around the walls ---------------------------------------------- */
    walkChain('lane-sw', 'lane-s-1', 'lane-s-2', 'lane-s-3'),
    walkChain('lane-sw', 'lane-w-4', 'lane-w-3', 'lane-w-2', 'lane-w-1'),
    walkChain('lane-ne', 'lane-e-4', 'lane-e-3', 'lane-e-2', 'lane-e-1'),
    walkChain('lane-ne', 'lane-n-1', 'lane-n-2', 'lane-n-3'),

    /* The lanes are open at three corners and stop dead at the fourth: the
     * balcony fills the corner, so `lane-e-1` and `lane-w-1` are ends. Getting
     * past them means going inside, which is the whole point of the shape. */

    /* ---- off the spawn, four ways ------------------------------------- */
    walk('spawn-sw', 'lane-sw'),
    walk('spawn-sw', 'lane-s-1'),
    walk('spawn-sw', 'lane-w-4'),
    walk('spawn-sw', 'ring-sw'),
    walk('spawn-ne', 'lane-ne'),
    walk('spawn-ne', 'lane-n-1'),
    walk('spawn-ne', 'lane-e-4'),
    walk('spawn-ne', 'ring-ne'),

    /* ---- the four inner arcs ------------------------------------------- */
    walkChain('ring-ne-e', 'ring-ne', 'ring-ne-n'),
    walkChain('ring-nw-n', 'ring-nw', 'ring-nw-w'),
    walkChain('ring-sw-w', 'ring-sw', 'ring-sw-s'),
    walkChain('ring-se-s', 'ring-se', 'ring-se-e'),

    /* ---- each arc out to the lanes it touches -------------------------- */
    walk('ring-ne-e', 'lane-e-3'),
    walk('ring-ne', 'lane-e-4'),
    walk('ring-se-e', 'lane-e-2'),
    walk('ring-se', 'lane-e-1'),
    walk('ring-nw-w', 'lane-w-2'),
    walk('ring-nw', 'lane-w-1'),
    walk('ring-sw-w', 'lane-w-3'),
    walk('ring-sw', 'lane-w-4'),
    walk('ring-ne-n', 'floor-n-e'),
    walk('ring-nw-n', 'floor-n-w'),
    walk('ring-se-s', 'floor-s-e'),
    walk('ring-sw-s', 'floor-s-w'),

    /* ---- the north and south floor, and the ramp feet on it ------------ */
    walk('floor-n-e', 'ramp-n-foot'),
    walk('floor-n-w', 'ramp-n-foot'),
    walk('floor-s-e', 'ramp-s-foot'),
    walk('floor-s-w', 'ramp-s-foot'),
    walk('floor-n-e', 'lane-n-2'),
    walk('floor-n-w', 'lane-n-3'),
    walk('floor-s-e', 'lane-s-3'),
    walk('floor-s-w', 'lane-s-2'),

    /* ---- the stair feet, which sit outside the bottom tread ------------ */
    walk('stair-e-foot', 'lane-e-2'),
    walk('stair-e-foot', 'lane-e-3'),
    walk('stair-w-foot', 'lane-w-2'),
    walk('stair-w-foot', 'lane-w-3'),

    /* ---- up, on foot: two staircases and two ramps --------------------- */
    walkChain('stair-e-foot', 'stair-e-1', 'stair-e-2', 'stair-e-3', 'mound-e'),
    walkChain('stair-w-foot', 'stair-w-1', 'stair-w-2', 'stair-w-3', 'mound-w'),
    walkChain('ramp-n-foot', 'ramp-n', 'mound-n'),
    walkChain('ramp-s-foot', 'ramp-s', 'mound-s'),

    /* ---- round the tower ----------------------------------------------- *
     * A closed ring, so a bot circling the tower to break line of sight can
     * keep going in either direction rather than backing out the way it came. */
    walkChain(
      'mound-n',
      'mound-ne',
      'mound-e',
      'mound-se',
      'mound-s',
      'mound-sw',
      'mound-w',
      'mound-nw',
      'mound-n',
    ),

    /* ---- off the mound, at the corners --------------------------------- *
     * One-way, and that asymmetry is the design: you leave the high ground
     * anywhere you like and you come back up in exactly four places. */
    drop('mound-ne', 'ring-ne-e'),
    drop('mound-ne', 'ring-ne-n'),
    drop('mound-nw', 'ring-nw-n'),
    drop('mound-nw', 'ring-nw-w'),
    drop('mound-sw', 'ring-sw-w'),
    drop('mound-sw', 'ring-sw-s'),
    drop('mound-se', 'ring-se-e'),
    drop('mound-se', 'ring-se-s'),

    /* ---- the crates: a jump for the angle, not for the height ---------- */
    walk('lane-s-3', 'crate-se-foot'),
    walk('ring-se-s', 'crate-se-foot'),
    walk('lane-n-3', 'crate-nw-foot'),
    walk('ring-nw-n', 'crate-nw-foot'),
    jump('crate-se-foot', 'crate-se'),
    drop('crate-se', 'crate-se-foot'),
    jump('crate-nw-foot', 'crate-nw'),
    drop('crate-nw', 'crate-nw-foot'),

    /* ---- the perches: no way in, two ways out -------------------------- */
    walk('balcony-se-back', 'balcony-se-lip'),
    walk('balcony-nw-back', 'balcony-nw-lip'),
    drop('balcony-se-lip', 'ring-se'),
    drop('balcony-se-lip', 'lane-e-1'),
    drop('balcony-nw-lip', 'ring-nw'),
    drop('balcony-nw-lip', 'lane-w-1'),
    drop('tower-top', 'mound-n'),
    drop('tower-top', 'mound-e'),
    drop('tower-top', 'mound-s'),
    drop('tower-top', 'mound-w'),
  ],
})
