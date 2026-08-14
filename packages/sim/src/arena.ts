/**
 * The arena the simulation runs in — a box with a floor and four walls.
 *
 * **A placeholder, and a deliberately small one.** What lives here is the
 * walking skeleton's world expressed as *brushes* rather than as the
 * `Math.min`/`Math.max` clamp it used to be, so that the movement code has real
 * geometry to slide along, step up and land on from the day it lands — and so
 * that swapping in a baked map later is a different `CollisionWorld`, not a
 * different code path.
 *
 * It survives the map format landing (GLAD-G2M8QQ) because `packages/sim` cannot
 * import `maps/` — `rootDir` is `./src` and the package has no filesystem — so
 * the kernel's default world and the golden replay's world have to be written in
 * source, here.
 *
 * It is no longer what anything *ships*. The wider reason it used to survive was
 * that the renderer drew this and not a map; GLAD-0IDR6J made the renderer draw
 * the map's own brushes, so the client and the server now tick
 * `LoadedMap.world` and spawn through `createMapState` (`map/load.ts`). The
 * arena worth playing in is GLAD-B8DI4J.
 *
 * Sized to match what the renderer already draws: a 2048x2048 floor with its
 * surface at `z = 0`, walls tall enough that a jump cannot clear them.
 *
 * A body resting on this floor sits at `z = 0.125`, not `z = 0` — the trace
 * stops `SURFACE_CLIP_EPSILON` short of contact, on purpose, and
 * `docs/physics-spec.md` §2.2 is where that is argued.
 */

import type { Vec3 } from './axis.ts'
import { boxBrush, createCollisionWorld } from './collide.ts'
import type { Brush, CollisionWorld } from './collide.ts'
import { vec3 } from './math.ts'
import { EntityKind, createGameState, spawnEntity } from './state.ts'
import type { GameState } from './state.ts'
import { SURFACE_CLIP_EPSILON } from './trace.ts'

/**
 * Half the width of the arena floor, in Quake units.
 *
 * The renderer sizes its ground plane from this, so the thing a player can see
 * and the thing a player can stand on are the same number.
 */
export const PLANE_HALF_EXTENT = 1024

/** How thick the floor slab and the walls are, in Quake units. */
const SLAB_THICKNESS = 64

/**
 * How tall the walls are, in Quake units.
 *
 * Ten times the 48.6-unit jump apex, so "can I get out of the arena" is not a
 * question anyone has to answer with a number.
 */
const WALL_HEIGHT = 512

const OUTER = PLANE_HALF_EXTENT + SLAB_THICKNESS

/**
 * The one obstacle in the arena, so that the movement has something to be
 * legible against — and so that running into it proves the trace is wired up.
 *
 * The renderer draws its box from these two numbers rather than from a pair of
 * its own, because a landmark you can see and walk through is worse than no
 * landmark at all.
 */
export const LANDMARK_MINS: Vec3 = [448, 448, 0]

/** See {@link LANDMARK_MINS}. */
export const LANDMARK_MAXS: Vec3 = [576, 576, 256]

/** Floor slab, four walls and the landmark. Exported so a test can vary it. */
export const SKELETON_BRUSHES: readonly Brush[] = [
  // The floor. Its *top* is z = 0, so a spawn point at z = 0 is on the ground.
  boxBrush([-PLANE_HALF_EXTENT, -PLANE_HALF_EXTENT, -SLAB_THICKNESS], [
    PLANE_HALF_EXTENT,
    PLANE_HALF_EXTENT,
    0,
  ]),
  boxBrush([PLANE_HALF_EXTENT, -OUTER, 0], [OUTER, OUTER, WALL_HEIGHT]),
  boxBrush([-OUTER, -OUTER, 0], [-PLANE_HALF_EXTENT, OUTER, WALL_HEIGHT]),
  boxBrush([-PLANE_HALF_EXTENT, PLANE_HALF_EXTENT, 0], [PLANE_HALF_EXTENT, OUTER, WALL_HEIGHT]),
  boxBrush([-PLANE_HALF_EXTENT, -OUTER, 0], [PLANE_HALF_EXTENT, -PLANE_HALF_EXTENT, WALL_HEIGHT]),
  boxBrush(LANDMARK_MINS, LANDMARK_MAXS),
]

/**
 * The world every `tick()` runs against until a real map is loaded into one.
 *
 * Built once at module load. A `CollisionWorld` is level data — nothing in a
 * sub-step mutates it — so one shared instance is correct rather than merely
 * convenient.
 */
export const SKELETON_ARENA: CollisionWorld = createCollisionWorld(SKELETON_BRUSHES)

/**
 * The seed the walking skeleton's world runs on.
 *
 * Fixed, and shared by the client and the server, because they hash the *whole*
 * state at every tick and the PRNG stream is part of it. A real match derives
 * its seed from the room code (`hashString`), which is something both peers
 * already know — GLAD-FHKBN8.
 */
export const SKELETON_SEED = 0x6c6164

/**
 * One player, standing at the middle of the arena. What the client and the
 * server each start from, so that comparing their hashes means something.
 *
 * Spawned `SURFACE_CLIP_EPSILON` above the floor rather than on it. A spawn
 * point names a *floor height*, and a body resting on a floor sits an eighth of
 * a unit clear of it (`docs/physics-spec.md` §2.2) — placing the feet exactly
 * on the surface would start the player one rounding error inside the world.
 * Spawn *policy* — which point, facing where, and what to do about a telefrag —
 * is GLAD-AKODBZ; this is one hard-coded point.
 */
export function createSkeletonState(): GameState {
  const state = createGameState(SKELETON_SEED)
  spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    origin: vec3(0, 0, SURFACE_CLIP_EPSILON),
    health: 100,
  })
  return state
}
