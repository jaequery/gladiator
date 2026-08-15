/**
 * The map format. `docs/physics-spec.md` §4.1.
 *
 * A map is a list of **brushes** — axis-aligned boxes and constrained ramps —
 * plus the spawns, surfaces, lights and props that hang off them. It is
 * hand-authored in TypeScript under `maps/`, compiled to JSON by
 * `pnpm map:bake`, and loaded identically by a browser and by a headless Node
 * process.
 *
 * ## Visual geometry is derived, not authored
 *
 * There is one brush list and there are two consumers. The sim turns it into
 * trace structures (`map/collide.ts`); the client turns it into merged render
 * meshes (`map/geometry.ts`, from the *same planes* the trace uses). So what
 * you can walk on is what you can see **by construction**: the bug where a wall
 * looks solid and is not, or is solid and looks like air, is unreachable rather
 * than merely tested for.
 *
 * The two escape hatches are named, and both show up in a diff:
 *
 * | Flag        | Effect                                                    |
 * | ----------- | --------------------------------------------------------- |
 * | `nonSolid`  | drawn, not collided — glass, a decorative grate            |
 * | `noRender`  | collided, not drawn — Quake's clip brush                   |
 *
 * Decoration that must affect neither goes in {@link MapProp}, a glTF reference
 * the sim never parses.
 *
 * ## Frame and units
 *
 * Quake frame (`+x` forward, `+y` left, `+z` up), Quake units, integers. The
 * renderer applies `QUAKE_TO_ENGINE` once at its own boundary; nothing in a map
 * file is ever in the engine frame, and nothing anywhere is in metres.
 */

import type { Vec3 } from '../axis.ts'

/**
 * Bumped when the shape below changes in a way a previously baked map would
 * not survive. It is folded into the map hash, so an old artifact and a new
 * loader disagree loudly at the handshake instead of quietly in the geometry.
 */
export const MAP_FORMAT_VERSION = 1

/**
 * Minimum clear vertical space above a spawn's feet, in Quake units.
 *
 * 96 is the 56-unit player plus 40 of ceiling. Anything less and a player who
 * spawns and immediately jumps — which is everyone — cracks their head on the
 * first frame of the round, and it reads as the movement being wrong rather
 * than the map being wrong.
 */
export const MIN_SPAWN_HEADROOM = 96

/**
 * Minimum distance between any two spawns, in Quake units.
 *
 * 512 is about two seconds of running. Closer than that and the round is
 * decided by who happened to be facing the right way, which is the opposite of
 * what a duel format is for.
 *
 * It is the floor, not the rule. Spawn *selection* — `match/spawn.ts` — holds a
 * pair to this distance **and** to being out of each other's sight, and a map
 * where no pair clears both does not bake. `docs/physics-spec.md` §6.
 */
export const MIN_SPAWN_SEPARATION = 512

/** Which way a ramp climbs. The surface rises along this axis. */
export type RampRise = '+x' | '-x' | '+y' | '-y'

/**
 * A ramp's gradient, written as `rise:run`.
 *
 * Two of them, on purpose. `1:1` is 45 degrees, whose normal has a `z` of
 * 0.7071 — a hair over `MIN_WALK_NORMAL`, so it is the steepest thing a player
 * can walk up. `1:2` is 26.57 degrees, the gentle ramp you take at full speed.
 * Both have exactly representable integer normals before normalisation
 * (`(-1, 0, 1)` and `(-1, 0, 2)`), so the plane a peer computes is the plane
 * every other peer computes.
 *
 * Arbitrary angles are deliberately not available. Every one of them is a new
 * interaction with step-up, with `clipVelocity` and with the walkable-normal
 * threshold, and a map author reaching for 31 degrees is reaching for a
 * physics decision they cannot see the consequences of.
 */
export type RampSlope = '1:1' | '1:2'

/** The integer rise and run behind each {@link RampSlope}. */
export const RAMP_SLOPES = {
  '1:1': { rise: 1, run: 1, degrees: 45 },
  '1:2': { rise: 1, run: 2, degrees: 26.57 },
} as const satisfies Record<RampSlope, { rise: number; run: number; degrees: number }>

/** What both brush kinds carry. */
type MapBrushCommon = {
  /** Name of a {@link MapSurface}. Required even on a `noRender` brush. */
  readonly surface: string
  /** Low corner, Quake frame, integer Quake units. */
  readonly mins: Vec3
  /** High corner. Strictly greater than `mins` on every axis. */
  readonly maxs: Vec3
  /** Drawn, not collided. See the table at the top of this file. */
  readonly nonSolid?: boolean
  /** Collided, not drawn. See the table at the top of this file. */
  readonly noRender?: boolean
}

/** An axis-aligned box. Most of a map is these. */
export type MapBoxBrush = MapBrushCommon & {
  readonly kind: 'box'
}

/**
 * A box with its top face replaced by one sloped plane.
 *
 * The plane meets the box's top face at the **high** end of the run and
 * descends from there at {@link RampSlope}; the box below it is the plinth, and
 * it is normally sunk into the floor so the ramp has no zero-area vertical face
 * at its foot for a player to clip against. The bake rejects a box too shallow
 * to hold its own slope, which is the only way to get this wrong.
 */
export type MapRampBrush = MapBrushCommon & {
  readonly kind: 'ramp'
  readonly rise: RampRise
  readonly slope: RampSlope
}

export type MapBrush = MapBoxBrush | MapRampBrush

/**
 * A named material.
 *
 * `material` is a logical name the renderer resolves — never a file path, so
 * the sim can carry it without knowing an asset pipeline exists (GLAD-PGS73O).
 * `tint` is linear RGB in `[0, 1]`, which is enough to tell a floor from a wall
 * before there are any textures at all.
 */
export type MapSurface = {
  readonly name: string
  readonly material: string
  readonly tint: readonly [number, number, number]
}

/**
 * Where a player starts.
 *
 * `origin` is the player origin, which is **at the feet** (`bbox.ts`, §0.2), so
 * a spawn standing on the floor at `z = 0` is written `z = 0`. `yaw` is in
 * angle units, because that is what a `UserCmd` carries; `maps/helpers.ts`
 * takes degrees and converts once, at authoring time.
 */
export type MapSpawn = {
  readonly origin: Vec3
  readonly yaw: number
}

/**
 * A point light. Carried by the schema, ignored by the sim.
 *
 * Lighting is the renderer's business (GLAD-0IDR6J) and the visual-polish
 * budget's (GLAD-O5ZQ5S). It lives here so that a map is one file rather than
 * one file and a lighting file that can drift out of step with it.
 */
export type MapLight = {
  readonly origin: Vec3
  readonly color: readonly [number, number, number]
  readonly intensity: number
  /** Falloff radius, in Quake units. */
  readonly radius: number
}

/**
 * A decorative model. Carried by the schema, **never** parsed by the sim.
 *
 * This is the pressure valve that keeps the derived-geometry rule honest: the
 * moment a map author cannot add a torch bracket without also adding collision,
 * they will start reaching for `nonSolid` on real geometry instead, and the one
 * brush list stops describing the world.
 */
export type MapProp = {
  /** A glTF reference the client resolves. The sim treats it as an opaque string. */
  readonly model: string
  readonly origin: Vec3
  readonly yaw: number
  readonly scale: number
}

/** A map, as authored. */
export type MapSource = {
  /** Lowercase identifier; the baked artifact is `maps/baked/<name>.json`. */
  readonly name: string
  /** What a human sees on the scoreboard. */
  readonly title: string
  readonly author: string
  readonly surfaces: readonly MapSurface[]
  readonly brushes: readonly MapBrush[]
  readonly spawns: readonly MapSpawn[]
  readonly lights: readonly MapLight[]
  readonly props: readonly MapProp[]
}

/**
 * What `pnpm map:bake` writes, and what a client and a server load.
 *
 * `hash` is eight lowercase hex digits over the canonical encoding of `map` —
 * see `map/load.ts`. It is stored rather than only computed so that a
 * hand-edited artifact fails at load with "this map has been edited" instead of
 * disagreeing with the other peer twenty seconds into a round.
 */
export type BakedMap = {
  readonly format: number
  readonly hash: string
  readonly map: MapSource
}
