/**
 * `arena1` — **Crucible**, the first duel arena.
 *
 * Rocket Arena's shape: small, sealed, no pickups anywhere, two spawns that
 * cannot see each other on the first frame of the round. What is in here beyond
 * that is a level design, and the one thing a level design can be held to is
 * that its geometry is built around the movement rather than beside it.
 *
 * ## Every ledge is one of four heights
 *
 * `docs/physics-spec.md` §5.4 gives the four climbs the movement makes, and
 * `map/reachability.ts` checks this map against them at bake time. Each one has
 * a structure in here that needs it, so the arena teaches the movement by being
 * played:
 *
 * | Climb | Technique              | Where                                    |
 * | ----- | ---------------------- | ---------------------------------------- |
 * | 18    | a step                 | the two staircases and the two ramps on to the mound |
 * | 48    | a jump                 | the two crates, 40 up                    |
 * | 166   | a standing rocket jump | the two corner balconies, 128 up         |
 * | 395   | a jump-plus-rocket     | the tower, 272 above the mound it stands on |
 *
 * The bake refuses a ledge outside all four, and — because dropping on to a
 * ledge does not count as reaching it — refuses one a player could get on to
 * and not off. So the table above is not a claim about the map, it is a
 * property of it.
 *
 * ## The shape
 *
 * ```
 *                              +y
 *      +-------------------------------------------------+
 *      |  balcony 128    |    ramp 1:2   |   SPAWN B      |
 *      |                 +---------------+                |
 *      |         +---------------------------+            |
 *      |  stairs |   mound 48  [tower 320]   | stairs      |   +x
 *      |         +---------------------------+            |
 *      |                 +---------------+                |
 *      |  SPAWN A        |   ramp 1:2    |  balcony 128   |
 *      +-------------------------------------------------+
 *                              -y
 * ```
 *
 * Rotationally symmetric by half a turn: every brush at `(x, y)` has a twin at
 * `(-x, -y)`, so neither spawn owns better ground than the other and neither
 * player can learn an advantage that is not a skill. The tower in the middle is
 * what breaks the spawn-to-spawn sightline, which runs straight through it.
 *
 * The two long lanes along the walls are the railgun's — nearly seven hundred
 * units of clear line. The ring around the tower is the rocket launcher's: a
 * 96-unit walkway with a corner every quarter turn and a 48-unit drop off the
 * side of it, which is splash-damage country. Getting from one to the other is
 * the fight.
 *
 * ## Time-boxed
 *
 * This is the first arena and it is meant to be playtested rather than admired.
 * Twenty brushes, four ways up on to the mound, one perch worth the health it
 * costs to reach. Iterate after people have duelled on it.
 *
 * Quake frame, Quake units, whole numbers, everything on the 16-unit grid.
 */

import { box, defineMap, light, ramp, spawn, surface } from './helpers.ts'

/** Half-width of the open floor. The arena is 1024 units square. */
const HALF = 512

/** Height of the open volume. A jump-plus-rocket off the mound peaks at 443. */
const CEILING = 512

/** Shell thickness. Thick enough that nothing is ever pushed through it. */
const SHELL = 64

const OUT = HALF + SHELL
const TOP = CEILING + SHELL

/** Half-width of the raised centre. */
const MOUND = 192

/** How far up the mound is: three 16-unit risers, or one 1:2 ramp. */
const MOUND_TOP = 48

/** Half-width of the tower standing on it. Leaves a 96-unit ring to fight on. */
const TOWER = 96

/**
 * The perch. 272 above the mound — a jump-plus-rocket, and nothing less.
 *
 * A standing rocket jump from the balconies falls 26 units short of it on
 * purpose: the best position in the arena should cost a jump *and* a rocket,
 * which is to say about half your health.
 */
const TOWER_TOP = 320

/** The corner balconies. A standing rocket jump from the floor, 38 to spare. */
const BALCONY = 128

/** The crates. A jump from the floor, and a step towards a balcony. */
const CRATE = 40

/**
 * The wall light panels: where they sit, how big they are, and how far the
 * light itself stands out in front of one.
 *
 * They are `nonSolid` — drawn, never collided — because a fixture flush with a
 * wall has nothing to collide *with*: a solid brush eight units proud of the
 * wall is a ledge a rocket jump can catch on, and an invisible one is worse.
 * This is the case `nonSolid` exists for, and it is the only one in this map.
 */
const PANEL_LOW = 288
const PANEL_HIGH = 352
const PANEL_HALF = 128
const PANEL_DEPTH = 8
const PANEL_STANDOFF = 40

export default defineMap({
  name: 'arena1',
  title: 'Crucible',
  author: 'Gladiator',

  surfaces: [
    surface('floor', 'concrete', [0.3, 0.31, 0.33]),
    surface('wall', 'concrete', [0.22, 0.23, 0.26]),
    surface('metal', 'metal', [0.44, 0.41, 0.37]),
    // `trim`, not `metal`: the crates are the one thing on the floor a player
    // has to read at a glance from across the arena, and the trim look is the
    // catalogue's high-contrast one. `render/materials.ts`.
    surface('accent', 'trim', [0.5, 0.28, 0.22]),
    // The one surface the bake does not touch, because nothing lights a light.
    surface('lamp', 'light', [1, 0.94, 0.82]),
  ],

  brushes: [
    /* The shell: floor, ceiling, four walls. Sealed — a player who leaves the
     * arena is a bug in the collision, and there should be nowhere to leave. */
    box('floor', [-OUT, -OUT, -SHELL], [OUT, OUT, 0]),
    box('wall', [-OUT, -OUT, CEILING], [OUT, OUT, TOP]),
    box('wall', [HALF, -OUT, -SHELL], [OUT, OUT, TOP]),
    box('wall', [-OUT, -OUT, -SHELL], [-HALF, OUT, TOP]),
    box('wall', [-OUT, HALF, -SHELL], [OUT, OUT, TOP]),
    box('wall', [-OUT, -OUT, -SHELL], [OUT, -HALF, TOP]),

    /* The mound, and the tower on it. The tower is the map's one hard rule:
     * neither player can see the other until somebody moves. */
    box('floor', [-MOUND, -MOUND, 0], [MOUND, MOUND, MOUND_TOP]),
    box('wall', [-TOWER, -TOWER, MOUND_TOP], [TOWER, TOWER, TOWER_TOP]),

    /* Two staircases on to the mound, 16 up and 48 across per tread. Sixteen is
     * under STEP_SIZE so they are walked; 48 is wider than the player, so a
     * player can also stand on one, which a 16-deep tread would not allow. */
    box('metal', [-336, -64, 0], [-288, 64, 16]),
    box('metal', [-288, -64, 0], [-240, 64, 32]),
    box('metal', [-240, -64, 0], [-192, 64, MOUND_TOP]),
    box('metal', [288, -64, 0], [336, 64, 16]),
    box('metal', [240, -64, 0], [288, 64, 32]),
    box('metal', [192, -64, 0], [240, 64, MOUND_TOP]),

    /* Two 1:2 ramps on to it from the other axis — 96 of run for 48 of rise.
     * Sunk 32 into the floor so there is no zero-height face at the foot to
     * clip against, and taken at full speed, which is the point of the gradient. */
    ramp('metal', [-64, -288, -32], [64, -192, MOUND_TOP], '+y', '1:2'),
    ramp('metal', [-64, 192, -32], [64, 288, MOUND_TOP], '-y', '1:2'),

    /* The corner balconies. The railgun's ground: they look down both long
     * lanes, and the only way up is a rocket. */
    box('floor', [288, -HALF, 0], [HALF, -288, BALCONY]),
    box('floor', [-HALF, 288, 0], [-288, HALF, BALCONY]),

    /* A crate under each balcony. A jump gets you on it; from there the balcony
     * is 88, which is still a rocket — it buys you the angle, not the height. */
    box('accent', [192, -448, 0], [288, -352, CRATE]),
    box('accent', [-288, 352, 0], [-192, 448, CRATE]),

    /* Four light panels, one high on each wall, `nonSolid` so they change what
     * the arena looks like and nothing about how it plays. Each one has a light
     * standing in front of it — see `lights` below. */
    box('lamp', [HALF - PANEL_DEPTH, -PANEL_HALF, PANEL_LOW], [HALF, PANEL_HALF, PANEL_HIGH], {
      nonSolid: true,
    }),
    box('lamp', [-HALF, -PANEL_HALF, PANEL_LOW], [-HALF + PANEL_DEPTH, PANEL_HALF, PANEL_HIGH], {
      nonSolid: true,
    }),
    box('lamp', [-PANEL_HALF, HALF - PANEL_DEPTH, PANEL_LOW], [PANEL_HALF, HALF, PANEL_HIGH], {
      nonSolid: true,
    }),
    box('lamp', [-PANEL_HALF, -HALF, PANEL_LOW], [PANEL_HALF, -HALF + PANEL_DEPTH, PANEL_HIGH], {
      nonSolid: true,
    }),
  ],

  /* Opposite corners, each facing the middle. 995 units apart, and the tower
   * stands in the straight line between them. */
  spawns: [spawn([-352, -352, 0], 45), spawn([352, 352, 0], -135)],

  /*
   * Seven lights, and the arena can afford them because none of them is drawn.
   *
   * They are traced once by `pnpm lightmap:bake` into `arena1_lightmap.ktx2`
   * and the renderer never sees them: the arena's materials have no light loop
   * at all (`render/materials.ts`). Before the bake the renderer drew the first
   * four and silently dropped the rest, so this list was a budget; now it is a
   * description.
   *
   * The shape of it is one key and six fills, and the reason is what a bake
   * gets wrong if you let it. A single lamp on the ceiling lights every floor
   * in the map and no wall at all — every vertical surface sits at `N·L` of
   * nearly zero, the tower goes black, and a player cannot tell the near face
   * of a pillar from the far one. The four wall panels are what light the
   * verticals, and they are placed level with the tower's upper half so the
   * thing the whole map is built around is the thing best lit.
   */
  lights: [
    /* The key: high over the tower, warm, reaching every corner. */
    light([0, 0, 480], [1, 0.96, 0.88], 1, 1400),

    /* The balconies, cool, so the two best positions read as their own place. */
    light([352, -352, 320], [0.9, 0.85, 1], 0.8, 900),
    light([-352, 352, 320], [0.9, 0.85, 1], 0.8, 900),

    /* One in front of each wall panel. Warm, short-range, and standing off the
     * wall so the panel is lit rather than being a bright rectangle on a dark
     * one. */
    light([HALF - PANEL_STANDOFF, 0, 320], [1, 0.92, 0.78], 0.7, 800),
    light([-HALF + PANEL_STANDOFF, 0, 320], [1, 0.92, 0.78], 0.7, 800),
    light([0, HALF - PANEL_STANDOFF, 320], [1, 0.92, 0.78], 0.7, 800),
    light([0, -HALF + PANEL_STANDOFF, 320], [1, 0.92, 0.78], 0.7, 800),
  ],
})
