/**
 * `testbed` — the reference map the pipeline is proved against.
 *
 * **This is not the arena.** The duel arena is GLAD-B8DI4J, and level design is
 * a different skill from engine work. What this is, is one map that exercises
 * every feature of the format exactly once, so that the baker, the validator,
 * the collision bridge and the derived render geometry all have something real
 * to run against — and so that the client and the server have a map to disagree
 * about at the handshake if their builds ever drift apart.
 *
 * | Feature            | Why it is here                                     |
 * | ------------------ | -------------------------------------------------- |
 * | sealed shell       | a world a player cannot leave                       |
 * | `1:1` ramp         | 45 degrees — the steepest walkable slope            |
 * | `1:2` ramp         | 26.57 degrees — the one you take at full speed      |
 * | pillar             | outside corners, and something to break line of sight |
 * | ledge + steps      | step-up geometry under `STEP_SIZE`                  |
 * | `nonSolid` glass   | the drawn-not-collided escape hatch                 |
 * | `noRender` clip    | the collided-not-drawn escape hatch                 |
 * | two spawns         | far enough apart to satisfy `MIN_SPAWN_SEPARATION`  |
 * | a light, a prop    | the fields the sim carries and never reads          |
 *
 * Quake frame, Quake units, whole numbers. The room's floor is at `z = 0`, so
 * a spawn standing on it is written `z = 0`.
 */

import { box, defineMap, light, prop, ramp, spawn, surface } from './helpers.ts'

/** Half-width of the open floor. The room is 1024 units square. */
const HALF = 512

/** Height of the open volume. */
const CEILING = 512

/** How thick the shell is. Thick enough that nothing is ever pushed through it. */
const SHELL = 64

const OUT = HALF + SHELL
const TOP = CEILING + SHELL

export default defineMap({
  name: 'testbed',
  title: 'Testbed',
  author: 'Gladiator',

  surfaces: [
    surface('floor', 'concrete', [0.32, 0.33, 0.35]),
    surface('wall', 'concrete', [0.24, 0.25, 0.28]),
    surface('metal', 'metal', [0.45, 0.42, 0.38]),
    surface('glass', 'glass', [0.55, 0.7, 0.8]),
    // Quake's `common/clip`: a surface that exists so that clip brushes have a
    // name to point at, and so that a `noRender` brush is obvious in a diff.
    surface('clip', 'clip', [1, 0, 1]),
  ],

  brushes: [
    /* The shell: floor, ceiling, four walls. */
    box('floor', [-OUT, -OUT, -SHELL], [OUT, OUT, 0]),
    box('wall', [-OUT, -OUT, CEILING], [OUT, OUT, TOP]),
    box('wall', [HALF, -OUT, -SHELL], [OUT, OUT, TOP]),
    box('wall', [-OUT, -OUT, -SHELL], [-HALF, OUT, TOP]),
    box('wall', [-OUT, HALF, -SHELL], [OUT, OUT, TOP]),
    box('wall', [-OUT, -OUT, -SHELL], [OUT, -HALF, TOP]),

    /* A 45-degree ramp climbing towards +x, sunk 64 into the floor. Its run is
     * 128 and its box is 192 deep, so the slope falls from z = 128 at x = 128
     * to z = 0 at x = 0 and still leaves a plinth. */
    ramp('metal', [0, -192, -64], [128, -64, 128], '+x', '1:1'),

    /* A 26.57-degree ramp climbing towards -y: 192 of run for 96 of rise. */
    ramp('metal', [-192, 0, -64], [-64, 192, 96], '-y', '1:2'),

    /* A pillar in the middle, so a duel has something to break line of sight
     * around, and the trace has outside corners to resolve. */
    box('wall', [-64, -64, 0], [64, 64, 256]),

    /* A ledge reached by two 16-unit steps — under STEP_SIZE, so they are
     * walked up rather than jumped. */
    box('floor', [256, 128, 0], [320, 384, 16]),
    box('floor', [320, 128, 0], [384, 384, 32]),
    box('floor', [384, 128, 0], [448, 384, 48]),

    /* Drawn, not collided: you can walk through this and see it. */
    box('glass', [200, -8, 0], [328, 8, 128], { nonSolid: true }),

    /* Collided, not drawn: an invisible wall, the way Quake fences off a ledge
     * without putting a fence there. */
    box('clip', [-328, -8, 0], [-200, 8, 192], { noRender: true }),
  ],

  spawns: [
    spawn([-384, -384, 0], 45),
    spawn([384, 448, 0], -135),
  ],

  lights: [light([0, 0, 448], [1, 0.95, 0.85], 1, 1200)],

  props: [prop('props/brazier.glb', [0, -448, 0], 90)],
})
