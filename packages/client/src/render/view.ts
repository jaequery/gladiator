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
  ANGLE_UNITS,
  PLAYER_VIEW_HEIGHT,
  type Vec3,
  angleUnitsToRadians,
  pitchUnitsFromDegrees,
  quakeToEngine,
  yawUnitsFromDegrees,
} from '@gladiator/sim'

import type { PlayerNetState } from './animState.ts'
import type { FxEvent, RocketView } from './fx.ts'

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
  /**
   * The simulation tick being drawn.
   *
   * Every animation clock in the renderer is derived from this and
   * {@link RenderView.alpha}, and from nothing else. Two clients drawing the
   * same tick at 60 Hz and at 240 Hz therefore draw the same pose — the same
   * property the camera has, extended to the things that move by themselves.
   */
  readonly tick?: number
  /** The accumulator's remainder, `[0, 1)`. `loop.ts`. */
  readonly alpha?: number
  /**
   * The other players, as interpolated netstates. See
   * {@link interpolateNetState}.
   *
   * Keyed on `id` by the renderer, which creates a rig the first time it sees
   * one and disposes it the first frame it does not.
   */
  readonly players?: readonly PlayerNetState[]
  /**
   * The local player, for the first-person viewmodel. Absent draws no hands —
   * which is what the reference screenshot and a spectator both want.
   */
  readonly self?: PlayerNetState
  /**
   * The rockets in the air, so each one can trail smoke behind it.
   *
   * Positions rather than entities: a rocket is a *trajectory* in the
   * simulation (`sim/projectile.ts`), evaluated in closed form, so the renderer
   * is handed the evaluation and never the trajectory.
   */
  readonly rockets?: readonly RocketView[]
  /**
   * What just happened, as effects to start. `render/fx.ts` folds these out of
   * the netstates above; they arrive here as data so that the frame's picture
   * and the frame's explosions come from one consistent moment.
   */
  readonly fx?: readonly FxEvent[]
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
 * Interpolate two angles the short way round.
 *
 * Angle units wrap at {@link ANGLE_UNITS}, so a player turning through north
 * goes from 65500 to 36 — and a plain `lerp` between those spins them 359
 * degrees the wrong way in one frame. Taking the shorter of the two arcs is the
 * whole of the fix, and it has to happen here rather than in the simulation,
 * which has no opinion about how a turn *looks*.
 */
export function lerpAngleUnits(a: number, b: number, alpha: number): number {
  const half = ANGLE_UNITS / 2
  let delta = (b - a) % ANGLE_UNITS
  if (delta > half) delta -= ANGLE_UNITS
  if (delta < -half) delta += ANGLE_UNITS
  return a + delta * alpha
}

/**
 * A netstate to draw, between two the simulation produced.
 *
 * Continuous fields — position, velocity, angles — are interpolated, because
 * 125 Hz motion on a 144 Hz display is visibly stepped. Discrete ones —
 * `flags`, `health`, `weapon`, `lastFireTick` — are taken from the *newer*
 * state and never blended: half a weapon switch is not a thing, and an
 * animation is either playing or it is not.
 *
 * The result is a drawing value, not a simulation one. It goes into the
 * renderer and stops there; `PlayerNetState` is deeply readonly and every field
 * of it is a copy, so there is no path from a value produced here back into
 * `GameState`.
 */
export function interpolateNetState(
  previous: PlayerNetState,
  current: PlayerNetState,
  alpha: number,
): PlayerNetState {
  return {
    id: current.id,
    slot: current.slot,
    origin: [
      lerp(previous.origin[0], current.origin[0], alpha),
      lerp(previous.origin[1], current.origin[1], alpha),
      lerp(previous.origin[2], current.origin[2], alpha),
    ],
    velocity: [
      lerp(previous.velocity[0], current.velocity[0], alpha),
      lerp(previous.velocity[1], current.velocity[1], alpha),
      lerp(previous.velocity[2], current.velocity[2], alpha),
    ],
    angles: [
      lerp(previous.angles[0], current.angles[0], alpha),
      lerpAngleUnits(previous.angles[1], current.angles[1], alpha),
      lerpAngleUnits(previous.angles[2], current.angles[2], alpha),
    ],
    flags: current.flags,
    health: current.health,
    weapon: current.weapon,
    lastFireTick: current.lastFireTick,
  }
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
 * `pmove` derives its own basis from the command inside the simulation, but
 * everything on this side of the boundary that needs to know which way the
 * player is facing takes it from here rather than writing it out again: the
 * renderer's tests, and the audio listener (`audio/positional.ts`), whose
 * forward vector has to agree with the camera's to the degree or the sound
 * field sits at an angle to the picture.
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
