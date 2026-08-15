/**
 * Loading a baked map, and the hash that proves two peers have the same one.
 * §4.5.
 *
 * ## Why the hash exists
 *
 * The client is deployed to Vercel and the server to Fly, from the same commit
 * but never at the same instant. For a window of a minute or two after every
 * deploy, a browser holding yesterday's bundle can open a socket to today's
 * server. If the map moved in between, the two simulate different worlds from
 * identical inputs, and every symptom of that — a player standing in a wall, a
 * rocket that hits nothing, a state hash that will not settle — points at the
 * netcode rather than at the deploy.
 *
 * So both ends compute a hash over the map's *content* and exchange it in the
 * handshake, and a mismatch refuses the session with a sentence a player can
 * act on. This is the same trick `PROTOCOL_VERSION` plays for the message
 * shapes; the map needed its own because a map can change without the protocol
 * changing.
 *
 * ## Why it is recomputed rather than read
 *
 * `BakedMap.hash` is written by the baker and checked here against a fresh
 * computation over the map that came with it. A hash trusted from the file it
 * describes proves nothing at all — it would agree with a hand-edited artifact,
 * which is exactly the case worth catching, because hand-editing baked JSON is
 * what someone does when the bake is inconvenient at 2am.
 *
 * ## Why the parser is strict
 *
 * The JSON arrives as an `unknown` from a bundler, a `fetch`, or a file. The
 * sim's types say `Vec3` and `'box' | 'ramp'`; JSON says `number[]` and
 * `string`. Somewhere that gap has to be closed by looking, and the honest
 * place is here, once, rather than at the first trace that reads a `mins[2]`
 * that turned out to be a string.
 */

import { hashInit, hashString, hashUint32, hashFloat64, formatHash } from '../hash.ts'
import { createCollisionWorld } from '../collide.ts'
import type { CollisionWorld } from '../collide.ts'
import { vec3 } from '../math.ts'
import { EntityKind, createGameState, spawnEntity } from '../state.ts'
import type { GameState } from '../state.ts'
import { SURFACE_CLIP_EPSILON } from '../trace.ts'
import { Weapon } from '../weapon.ts'
import { mapCollisionBrushes } from './collide.ts'
import { MAP_FORMAT_VERSION } from './schema.ts'
import type {
  BakedMap,
  MapBrush,
  MapLight,
  MapProp,
  MapSource,
  MapSpawn,
  MapSurface,
  RampRise,
  RampSlope,
} from './schema.ts'

/* --------------------------------------------------------------------------
 * The hash
 * ----------------------------------------------------------------------- */

/**
 * Fold a string in, length first.
 *
 * The length prefix is what stops `["ab", "c"]` and `["a", "bc"]` from hashing
 * the same — the classic canonicalisation hole, and one that would let two
 * genuinely different maps agree at the handshake.
 */
function foldText(digest: number, text: string): number {
  return hashString(text, hashUint32(digest, text.length))
}

function foldPoint(digest: number, v: readonly number[]): number {
  let next = digest
  for (const n of v) next = hashFloat64(next, n)
  return next
}

/**
 * The content hash of a map, as a uint32.
 *
 * Every field the sim or the renderer reads is folded in, in a fixed order,
 * over raw IEEE 754 bytes — the same discipline as `hashState`, for the same
 * reason: a digest that rounded would call two maps equal when a brush had
 * moved by a thousandth of a unit, and a thousandth of a unit is a wall in a
 * different place.
 *
 * {@link MAP_FORMAT_VERSION} goes in first, so the same brushes read by two
 * different loaders hash differently and the mismatch is caught at the
 * handshake rather than in the geometry.
 */
export function hashMapSource(map: MapSource): number {
  let d = hashUint32(hashInit(), MAP_FORMAT_VERSION)
  d = foldText(d, map.name)
  d = foldText(d, map.title)
  d = foldText(d, map.author)

  d = hashUint32(d, map.surfaces.length)
  for (const surface of map.surfaces) {
    d = foldText(d, surface.name)
    d = foldText(d, surface.material)
    d = foldPoint(d, surface.tint)
  }

  d = hashUint32(d, map.brushes.length)
  for (const brushDef of map.brushes) {
    d = foldText(d, brushDef.kind)
    d = foldText(d, brushDef.surface)
    d = foldPoint(d, brushDef.mins)
    d = foldPoint(d, brushDef.maxs)
    d = hashUint32(d, (brushDef.nonSolid === true ? 1 : 0) | (brushDef.noRender === true ? 2 : 0))
    if (brushDef.kind === 'ramp') {
      d = foldText(d, brushDef.rise)
      d = foldText(d, brushDef.slope)
    }
  }

  d = hashUint32(d, map.spawns.length)
  for (const spawn of map.spawns) {
    d = foldPoint(d, spawn.origin)
    d = hashUint32(d, spawn.yaw)
  }

  d = hashUint32(d, map.lights.length)
  for (const light of map.lights) {
    d = foldPoint(d, light.origin)
    d = foldPoint(d, light.color)
    d = hashFloat64(d, light.intensity)
    d = hashFloat64(d, light.radius)
  }

  d = hashUint32(d, map.props.length)
  for (const prop of map.props) {
    d = foldText(d, prop.model)
    d = foldPoint(d, prop.origin)
    d = hashUint32(d, prop.yaw)
    d = hashFloat64(d, prop.scale)
  }

  return d >>> 0
}

/** The eight hex digits that go in the artifact, on the wire and on the HUD. */
export function mapHashOf(map: MapSource): string {
  return formatHash(hashMapSource(map))
}

/* --------------------------------------------------------------------------
 * The parser
 * ----------------------------------------------------------------------- */

/**
 * Refuse the map, saying where and why.
 *
 * `where` is a path into the artifact rather than a line number, because the
 * artifact is generated and its line numbers belong to nobody.
 */
function fail(where: string, detail: string): never {
  throw new Error(`gladiator: ${where}: ${detail}`)
}

function record(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(where, 'expected an object')
  }
  return value as Record<string, unknown>
}

function array(value: unknown, where: string): unknown[] {
  if (!Array.isArray(value)) fail(where, 'expected an array')
  return value
}

function text(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(where, 'expected a string')
  return value
}

function number(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(where, 'expected a finite number')
  return value
}

function integer(value: unknown, where: string): number {
  const n = number(value, where)
  if (!Number.isInteger(n)) fail(where, 'expected an integer')
  return n
}

function triple(value: unknown, where: string): [number, number, number] {
  const items = array(value, where)
  if (items.length !== 3) fail(where, `expected three numbers, got ${items.length}`)
  return [number(items[0], `${where}[0]`), number(items[1], `${where}[1]`), number(items[2], `${where}[2]`)]
}

function flag(value: unknown, where: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') fail(where, 'expected true, false, or nothing at all')
  return value
}

const RAMP_RISES: readonly RampRise[] = ['+x', '-x', '+y', '-y']
const RAMP_SLOPE_NAMES: readonly RampSlope[] = ['1:1', '1:2']

function parseBrush(value: unknown, where: string): MapBrush {
  const raw = record(value, where)
  const kind = text(raw['kind'], `${where}.kind`)
  const common = {
    surface: text(raw['surface'], `${where}.surface`),
    mins: triple(raw['mins'], `${where}.mins`),
    maxs: triple(raw['maxs'], `${where}.maxs`),
  }
  const nonSolid = flag(raw['nonSolid'], `${where}.nonSolid`)
  const noRender = flag(raw['noRender'], `${where}.noRender`)
  // Spread-if-present rather than `nonSolid: undefined`, so a round trip
  // through JSON produces the identical object and therefore the identical
  // hash. `exactOptionalPropertyTypes` is what makes that a type error to get
  // wrong rather than a silent difference.
  const flags = {
    ...(nonSolid === undefined ? {} : { nonSolid }),
    ...(noRender === undefined ? {} : { noRender }),
  }

  if (kind === 'box') return { kind: 'box', ...common, ...flags }
  if (kind !== 'ramp') fail(`${where}.kind`, `expected "box" or "ramp", got "${kind}"`)

  const rise = text(raw['rise'], `${where}.rise`)
  const slope = text(raw['slope'], `${where}.slope`)
  if (!RAMP_RISES.includes(rise as RampRise)) {
    fail(`${where}.rise`, `expected one of ${RAMP_RISES.join(', ')}, got "${rise}"`)
  }
  if (!RAMP_SLOPE_NAMES.includes(slope as RampSlope)) {
    fail(`${where}.slope`, `expected one of ${RAMP_SLOPE_NAMES.join(', ')}, got "${slope}"`)
  }
  return { kind: 'ramp', ...common, ...flags, rise: rise as RampRise, slope: slope as RampSlope }
}

function parseSurface(value: unknown, where: string): MapSurface {
  const raw = record(value, where)
  return {
    name: text(raw['name'], `${where}.name`),
    material: text(raw['material'], `${where}.material`),
    tint: triple(raw['tint'], `${where}.tint`),
  }
}

function parseSpawn(value: unknown, where: string): MapSpawn {
  const raw = record(value, where)
  return {
    origin: triple(raw['origin'], `${where}.origin`),
    yaw: integer(raw['yaw'], `${where}.yaw`),
  }
}

function parseLight(value: unknown, where: string): MapLight {
  const raw = record(value, where)
  return {
    origin: triple(raw['origin'], `${where}.origin`),
    color: triple(raw['color'], `${where}.color`),
    intensity: number(raw['intensity'], `${where}.intensity`),
    radius: number(raw['radius'], `${where}.radius`),
  }
}

function parseProp(value: unknown, where: string): MapProp {
  const raw = record(value, where)
  return {
    model: text(raw['model'], `${where}.model`),
    origin: triple(raw['origin'], `${where}.origin`),
    yaw: integer(raw['yaw'], `${where}.yaw`),
    scale: number(raw['scale'], `${where}.scale`),
  }
}

/** Parse a `MapSource` out of whatever JSON handed us. Throws on anything else. */
export function parseMapSource(value: unknown, where = 'map'): MapSource {
  const raw = record(value, where)
  return {
    name: text(raw['name'], `${where}.name`),
    title: text(raw['title'], `${where}.title`),
    author: text(raw['author'], `${where}.author`),
    surfaces: array(raw['surfaces'], `${where}.surfaces`).map((s, i) =>
      parseSurface(s, `${where}.surfaces[${i}]`),
    ),
    brushes: array(raw['brushes'], `${where}.brushes`).map((b, i) =>
      parseBrush(b, `${where}.brushes[${i}]`),
    ),
    spawns: array(raw['spawns'], `${where}.spawns`).map((s, i) =>
      parseSpawn(s, `${where}.spawns[${i}]`),
    ),
    lights: array(raw['lights'], `${where}.lights`).map((l, i) =>
      parseLight(l, `${where}.lights[${i}]`),
    ),
    props: array(raw['props'], `${where}.props`).map((p, i) => parseProp(p, `${where}.props[${i}]`)),
  }
}

/** Parse a baked artifact. Checks the format version; does not check the hash. */
export function parseBakedMap(value: unknown): BakedMap {
  const raw = record(value, 'baked map')
  const format = integer(raw['format'], 'baked map.format')
  if (format !== MAP_FORMAT_VERSION) {
    fail(
      'baked map.format',
      `this build reads map format ${MAP_FORMAT_VERSION} and the artifact is format ${format}. Re-run pnpm map:bake.`,
    )
  }
  const hash = text(raw['hash'], 'baked map.hash')
  if (!/^[0-9a-f]{8}$/.test(hash)) fail('baked map.hash', 'expected eight lowercase hex digits')
  return { format, hash, map: parseMapSource(raw['map']) }
}

/* --------------------------------------------------------------------------
 * The loaded map
 * ----------------------------------------------------------------------- */

/** A map, ready to trace against. Immutable level data. */
export type LoadedMap = {
  readonly source: MapSource
  /** Eight hex digits, verified against a fresh computation. */
  readonly hash: string
  readonly world: CollisionWorld
  /** `world.brushes[i]` was built from `source.brushes[sourceBrush[i]]`. */
  readonly sourceBrush: Int32Array
}

/**
 * Parse, verify and build.
 *
 * The one function a client, a server or a test calls. It does not validate
 * the map's *design* — spawn separation and the rest are the baker's job, and
 * re-running trace-based checks on every boot would cost a browser a frame for
 * an answer that cannot have changed since the bake.
 */
export function loadMap(value: unknown): LoadedMap {
  const baked = parseBakedMap(value)
  const computed = mapHashOf(baked.map)
  if (computed !== baked.hash) {
    fail(
      `map "${baked.map.name}"`,
      `its contents hash to ${computed} and it claims ${baked.hash}. The artifact has been edited by hand, or written by a different build. Re-run pnpm map:bake.`,
    )
  }
  const { brushes, sourceBrush } = mapCollisionBrushes(baked.map)
  return {
    source: baked.map,
    hash: baked.hash,
    world: createCollisionWorld(brushes),
    sourceBrush,
  }
}

/**
 * One player, spawned into a map's first spawn point.
 *
 * The counterpart to `arena.ts`'s `createSkeletonState`, for the world a client
 * and a server actually load. It lives in the simulation rather than in either
 * of them because the two peers hash the *whole* state at every tick: a spawn
 * point computed twice, in two packages, is a desync waiting for someone to
 * change one of them.
 *
 * Spawn *policy* — which of a map's points, facing where, and what to do about
 * a telefrag — is GLAD-AKODBZ. This is the placeholder it replaces: the first
 * point, every time.
 *
 * The feet go `SURFACE_CLIP_EPSILON` above the floor rather than on it. A spawn
 * point names a *floor height*, and a body resting on a floor sits an eighth of
 * a unit clear of it (`docs/physics-spec.md` §2.2); placing the feet exactly on
 * the surface would start the player one rounding error inside the world.
 */
export function createMapState(map: MapSource, seed: number): GameState {
  const spawn = map.spawns[0]
  if (spawn === undefined) {
    fail(`map "${map.name}"`, 'it has no spawn points, so there is nowhere to put a player.')
  }
  const state = createGameState(seed)
  spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    origin: vec3(spawn.origin[0], spawn.origin[1], spawn.origin[2] + SURFACE_CLIP_EPSILON),
    health: 100,
    // Rocket Arena hands you both weapons at full ammo; the launcher is the one
    // in your hands when the round starts. Selection is GLAD-0QWRYK's.
    weapon: Weapon.RocketLauncher,
  })
  return state
}
