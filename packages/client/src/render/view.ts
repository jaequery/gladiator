/**
 * The camera is a puppet, and this file is the string.
 *
 * Everything here is a **pure function of simulation state**. No clock, no
 * previous frame, no Babylon object read back. That is the whole property the
 * renderer has to have, and it is worth stating as code rather than as a
 * comment: given the same two simulation states and the same interpolation
 * alpha, this produces the same camera transform on a 60 Hz display and on a
 * 240 Hz one, bit for bit. `view.test.ts` asserts exactly that at two render
 * cadences.
 *
 * Three consequences fall out of it, and each is a bug this repo would
 * otherwise have to find the hard way:
 *
 *   - **No smoothing.** Babylon's cameras carry an `inertia` (0.9 by default),
 *     which is a low-pass filter on position. A filter is per-frame state, so
 *     the transform would depend on the frame rate — and worse, it would fight
 *     reconciliation by lagging behind a correction that has already landed.
 *   - **No `attachControl`.** Yaw and pitch are ours: they go into the
 *     `UserCmd` the server simulates and lag-compensates against. Reading them
 *     back out of a camera makes the renderer the source of truth for aim,
 *     which is backwards.
 *   - **The frame conversion happens once, here.** The simulation is entirely
 *     in the Quake frame; `QUAKE_TO_ENGINE` is applied at this boundary and
 *     nowhere else. `docs/physics-spec.md` §0.3.
 *
 * ## Position is interpolated; the view angle is not
 *
 * The simulation advances 125 times a second and the display does not, so
 * drawing the newest position directly is visibly stepped. Position is
 * therefore interpolated between the previous tick and the current one by the
 * accumulator's remainder.
 *
 * The *view angle* is deliberately not interpolated. It is sampled from the
 * mouse once per frame, so the freshest value is the one the player just
 * produced — interpolating it would add a frame of latency to aim in exchange
 * for smoothing something that is already smooth. Quake has done it this way
 * since 1996.
 */
import {
  PLAYER_VIEW_HEIGHT,
  type Vec3,
  angleUnitsToRadians,
  pitchUnitsFromDegrees,
  quakeToEngine,
  yawUnitsFromDegrees,
} from '@gladiator/sim'

/** The slice of a simulation tick the renderer reads. */
export type RenderState = {
  /** Player origin — the **feet** — in the Quake frame. `bbox.ts`. */
  readonly origin: Vec3
}

/** One frame's worth of "where the player is and where they are looking". */
export type RenderView = {
  /** Feet, Quake frame, already interpolated. */
  readonly origin: Vec3
  /** View yaw in angle units — the integer the `UserCmd` carries. */
  readonly yawUnits: number
  /** View pitch in angle units. */
  readonly pitchUnits: number
}

/**
 * A camera transform, in the form Babylon consumes it.
 *
 * `rotation` is Babylon's Euler triple `(x = pitch, y = yaw, z = roll)`. That
 * the Quake angles go in unchanged is not luck: Babylon composes the rotation
 * as `Rx(pitch) · Ry(yaw)` applied to its forward vector `(0, 0, -1)`, and
 * running that through `QUAKE_TO_ENGINE` gives exactly Quake's
 * `(cos p cos y, cos p sin y, sin p)`. `view.test.ts` asserts it against a real
 * Babylon camera rather than trusting the derivation.
 */
export type CameraPose = {
  /** Eye position, engine frame. */
  readonly position: Vec3
  /** `(pitch, yaw, roll)` in radians, engine frame. */
  readonly rotation: Vec3
}

/** Linear interpolation. Written out so the rounding is obvious. */
export function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha
}

/**
 * Position at `alpha` of the way from `previous` to `current`.
 *
 * `alpha` comes from the accumulator (`loop.ts`), so it is a function of
 * simulation time and never of wall-clock time directly.
 */
export function interpolateOrigin(previous: RenderState, current: RenderState, alpha: number): Vec3 {
  return [
    lerp(previous.origin[0], current.origin[0], alpha),
    lerp(previous.origin[1], current.origin[1], alpha),
    lerp(previous.origin[2], current.origin[2], alpha),
  ]
}

/**
 * The camera transform for a view. Pure, total, and allocation-light enough to
 * run every frame.
 */
export function cameraPose(view: RenderView): CameraPose {
  const [x, y, z] = view.origin
  return {
    // The eye is 50 units above the feet, not at them. `bbox.ts`.
    position: quakeToEngine([x, y, z + PLAYER_VIEW_HEIGHT]),
    rotation: [
      angleUnitsToRadians(view.pitchUnits),
      angleUnitsToRadians(view.yawUnits),
      // No roll, ever. A rolled view is a Quake death-camera effect and it
      // would make the horizon lie about which way gravity points.
      0,
    ],
  }
}

/**
 * Quake's unit forward vector for a view, in the Quake frame.
 *
 * Only the renderer's tests use it — `pmove` derives its own basis from the
 * command inside the simulation — but it is the definition both agree on, so
 * it lives beside the camera rather than being written out twice.
 */
export function viewForwardQuake(yawRadians: number, pitchRadians: number): Vec3 {
  const cosPitch = Math.cos(pitchRadians)
  return [
    Math.cos(yawRadians) * cosPitch,
    Math.sin(yawRadians) * cosPitch,
    Math.sin(pitchRadians),
  ]
}

/**
 * The pose the committed reference screenshot is taken from.
 *
 * A fixed vantage in `maps/testbed.ts`: standing on the south-west spawn,
 * looking north-east across the room so that the pillar, both ramps, the
 * stepped ledge and the pane of `nonSolid` glass are all in frame. Fixed,
 * because a reference screenshot of a moving camera is a reference to nothing.
 */
export const REFERENCE_VIEW: RenderView = {
  origin: [-384, -384, 0],
  yawUnits: yawUnitsFromDegrees(45),
  pitchUnits: pitchUnitsFromDegrees(-8),
}
