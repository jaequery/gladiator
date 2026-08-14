/**
 * The authoring vocabulary. What a map file is written in.
 *
 * A map is TypeScript rather than a data format, and that is a deliberate
 * trade. The editor autocompletes surface names, a typo in a rise axis is a red
 * squiggle rather than a bake failure, and a corridor can be a `for` loop
 * instead of forty pasted objects. The cost is that a map has to be *baked*
 * before anything can load it — which is `pnpm map:bake`, and which is also
 * where the validation lives.
 *
 * Everything here is Quake frame, Quake units, whole numbers:
 * `+x` forward, `+y` left, `+z` up. `docs/physics-spec.md` §0.3.
 *
 * These helpers do exactly two things beyond naming their arguments: they fill
 * in defaults, and they convert authored degrees into the angle units the
 * simulation carries. No validation happens here — the baker validates, once,
 * so that a rule cannot be true of hand-written maps and false of generated
 * ones.
 */

import {
  type MapBoxBrush,
  type MapBrush,
  type MapLight,
  type MapProp,
  type MapRampBrush,
  type MapSource,
  type MapSpawn,
  type MapSurface,
  type RampRise,
  type RampSlope,
  type Vec3,
  yawUnitsFromDegrees,
} from '@gladiator/sim'

/** The two escape hatches, and nothing else. See `map/schema.ts`. */
export type BrushFlags = {
  /** Drawn, not collided. */
  readonly nonSolid?: boolean
  /** Collided, not drawn — a clip brush. */
  readonly noRender?: boolean
}

// `exactOptionalPropertyTypes` means an explicit `nonSolid: undefined` is not
// the same as an absent one, and only the absent one survives a JSON round trip
// with its hash intact. So the flags are spread in, never assigned.
function flagsOf(flags: BrushFlags): BrushFlags {
  return {
    ...(flags.nonSolid === true ? { nonSolid: true } : {}),
    ...(flags.noRender === true ? { noRender: true } : {}),
  }
}

/** A named material. `tint` is linear RGB, and defaults to white. */
export function surface(
  name: string,
  material: string,
  tint: readonly [number, number, number] = [1, 1, 1],
): MapSurface {
  return { name, material, tint }
}

/** An axis-aligned box. The workhorse: floors, walls, ledges, pillars. */
export function box(surfaceName: string, mins: Vec3, maxs: Vec3, flags: BrushFlags = {}): MapBoxBrush {
  return { kind: 'box', surface: surfaceName, mins, maxs, ...flagsOf(flags) }
}

/**
 * A box whose top face is one sloped plane.
 *
 * `rise` is the direction the surface climbs; `slope` is its gradient as
 * `rise:run`. The box below the slope is the plinth, and it wants to be sunk
 * into whatever the ramp stands on — a ramp that stops exactly at floor level
 * has a zero-height vertical face at its foot, and a player running at it flush
 * with the ground clips against *that* instead of walking up the slope.
 *
 * The bake rejects a box too shallow to hold its own slope, with the arithmetic
 * in the message.
 */
export function ramp(
  surfaceName: string,
  mins: Vec3,
  maxs: Vec3,
  rise: RampRise,
  slope: RampSlope,
  flags: BrushFlags = {},
): MapRampBrush {
  return { kind: 'ramp', surface: surfaceName, mins, maxs, rise, slope, ...flagsOf(flags) }
}

/**
 * Where a player starts, and which way they are looking.
 *
 * `origin` is the player's **feet** (`bbox.ts`, §0.2), so a spawn standing on a
 * floor whose top is at `z = 0` is written `[x, y, 0]`.
 *
 * `facing` is in degrees because a human is typing it; it is converted here,
 * once, into the angle units a `UserCmd` carries. 0 looks along `+x`, 90 along
 * `+y` — anticlockwise seen from above, like every other angle in Quake.
 */
export function spawn(origin: Vec3, facingDegrees: number): MapSpawn {
  return { origin, yaw: yawUnitsFromDegrees(facingDegrees) }
}

/** A point light. Carried by the format, ignored by the simulation. */
export function light(
  origin: Vec3,
  color: readonly [number, number, number],
  intensity: number,
  radius: number,
): MapLight {
  return { origin, color, intensity, radius }
}

/**
 * A decorative model. Carried by the format, **never** parsed by the simulation.
 *
 * This is where a torch bracket goes. Putting it in a brush instead would mean
 * either colliding with it or reaching for `nonSolid` on real geometry, and the
 * second habit is what stops the brush list from describing the world.
 */
export function prop(model: string, origin: Vec3, facingDegrees: number, scale = 1): MapProp {
  return { model, origin, yaw: yawUnitsFromDegrees(facingDegrees), scale }
}

/** What a map file's default export is built with. Lights and props are optional. */
export type MapSpec = {
  readonly name: string
  readonly title: string
  readonly author: string
  readonly surfaces: readonly MapSurface[]
  readonly brushes: readonly MapBrush[]
  readonly spawns: readonly MapSpawn[]
  readonly lights?: readonly MapLight[]
  readonly props?: readonly MapProp[]
}

/** Assemble a map. The baker looks for this as a module's default export. */
export function defineMap(spec: MapSpec): MapSource {
  return {
    name: spec.name,
    title: spec.title,
    author: spec.author,
    surfaces: spec.surfaces,
    brushes: spec.brushes,
    spawns: spec.spawns,
    lights: spec.lights ?? [],
    props: spec.props ?? [],
  }
}
