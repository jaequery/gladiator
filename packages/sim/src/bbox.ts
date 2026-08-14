/**
 * The player bounding box. Normative copy: `docs/physics-spec.md` §0.2.
 *
 * Quake's player is a box, not a capsule and not a mesh, and every movement
 * constant in this repo was measured against *this* box. It is 30 units wide
 * and 56 tall, which is Quake 3's `(-15,-15,-24)..(15,15,32)` — the same solid,
 * written against a different origin.
 *
 * ## The origin is the feet
 *
 * Quake 3 puts the origin at the middle of the box and carries `mins[2] = -24`.
 * Gladiator puts it on the soles, so `mins[2] = 0` and `maxs[2] = 56`. The box
 * is identical; only the number the state carries changes.
 *
 * That is a deliberate choice and it is worth one paragraph, because it is the
 * kind of thing that is cheap now and expensive in six months:
 *
 * - `origin[2]` is then literally the floor height a player is standing on, so
 *   a spawn point, a ledge and a step read as the same number in the map file,
 *   the debugger and the level editor.
 * - Crouching shrinks `maxs[2]` and leaves `mins[2]` alone, so the feet stay
 *   planted. With a centred origin, crouching has to move the origin as well,
 *   and getting the two half-steps out of order is the classic "crouch in a
 *   doorway and fall through the floor" bug.
 *
 * The cost is that Quake 3 source ported verbatim needs 24 added or subtracted
 * at the seam. That conversion happens where a constant is transcribed — here —
 * and never at runtime.
 *
 * Ducking itself is GLAD-0B1GDS's; the numbers are not stated here so that
 * there is only ever one place they could be wrong.
 */

import type { Vec3 } from './axis.ts'

/**
 * Half the width of the player box, in Quake units.
 *
 * 15, not 16. It is Quake 3's `15`, and the two-unit difference in overall
 * width decides whether a 32-unit gap is a corridor or a wall.
 */
export const PLAYER_HALF_WIDTH = 15

/** Height of the standing player box, in Quake units. Quake 3's `32 - (-24)`. */
export const PLAYER_HEIGHT = 56

/**
 * Eye height above the feet, in Quake units.
 *
 * Quake 3's `DEFAULT_VIEWHEIGHT` is 26 above a centred origin, which is 50
 * above the soles. The camera lives 6 units below the top of the head.
 */
export const PLAYER_VIEW_HEIGHT = 50

/** The low corner of the standing player box, relative to the origin. */
export const PLAYER_MINS: Vec3 = [-PLAYER_HALF_WIDTH, -PLAYER_HALF_WIDTH, 0]

/** The high corner of the standing player box, relative to the origin. */
export const PLAYER_MAXS: Vec3 = [PLAYER_HALF_WIDTH, PLAYER_HALF_WIDTH, PLAYER_HEIGHT]

/**
 * A point, for traces that sweep no volume at all — a railgun shot, a
 * line-of-sight query, a rocket that is treated as a point.
 *
 * A zero-extent box is not a special case in the trace: it is the same code
 * with an empty Minkowski offset, which is why there is no separate ray
 * routine to keep in step with the box one.
 */
export const POINT_MINS: Vec3 = [0, 0, 0]

/** See {@link POINT_MINS}. */
export const POINT_MAXS: Vec3 = [0, 0, 0]
