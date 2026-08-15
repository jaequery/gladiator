/**
 * The map validator. §4.4.
 *
 * Everything here is a rule that, left unchecked, produces a bug that only
 * shows up in a live round: a player who spawns inside the floor, two spawns
 * close enough that the round is decided before either player has moved, a
 * brush whose extents are the wrong way round and which therefore does not
 * exist. Each of those is cheap to detect at bake time and expensive to
 * diagnose at 125 Hz over a network, so the bake refuses rather than warns.
 *
 * It runs in two passes, and the order matters. The structural pass checks what
 * can be checked by reading the map — names, references, extents. Only if that
 * comes back clean does the geometric pass build a collision world and trace
 * against it, because `boxBrush` throws on inverted extents and a stack trace
 * out of the collision code is a much worse error message than
 * "brushes[7]: maxs.x (64) is not greater than mins.x (128)".
 *
 * The validator lives in the sim rather than in `tools/` because it is the sim
 * that has to survive the result. A rule enforced by the baker alone protects
 * only maps that went through the baker.
 */

import { PLAYER_HALF_WIDTH, PLAYER_MAXS, PLAYER_MINS } from '../bbox.ts'
import { boxPenetration } from '../collide.ts'
import { buildSpawnPlan } from '../match/spawn.ts'
import { createTrace, traceBox } from '../trace.ts'
import { createMapWorld, rampLowHeight } from './collide.ts'
import { MAX_CLIMB, TECHNIQUES, analyzeReachability } from './reachability.ts'
import { MIN_SPAWN_HEADROOM, MIN_SPAWN_SEPARATION, RAMP_SLOPES } from './schema.ts'
import type { MapSource } from './schema.ts'

/**
 * One reason a map was rejected.
 *
 * `code` is stable and machine-readable, so a test can assert on the rule
 * rather than on the prose; `where` is a JSON-ish path into the map so an
 * author can find the thing; `detail` is the sentence they read.
 */
export type MapDiagnostic = {
  readonly code: string
  readonly where: string
  readonly detail: string
}

/** A duel needs two ends of the arena. */
const MIN_SPAWNS = 2

/** `^[a-z0-9][a-z0-9-]*$` — the map name is also a filename and a URL fragment. */
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/

function isFinitePoint(v: readonly number[]): boolean {
  return v.length === 3 && v.every((n) => Number.isFinite(n))
}

function isIntegerPoint(v: readonly number[]): boolean {
  return v.length === 3 && v.every((n) => Number.isInteger(n))
}

const AXIS_NAMES = ['x', 'y', 'z'] as const

/**
 * Rules that need only the map itself.
 *
 * Returns everything it finds rather than the first thing: an author fixing one
 * typo at a time through six bake runs is an author who stops running the bake.
 */
function structuralDiagnostics(map: MapSource): MapDiagnostic[] {
  const found: MapDiagnostic[] = []

  if (!NAME_PATTERN.test(map.name)) {
    found.push({
      code: 'bad-name',
      where: 'name',
      detail: `"${map.name}" is not a usable map name — lowercase letters, digits and hyphens only, starting with a letter or a digit.`,
    })
  }

  /* ---- surfaces ---- */

  const declared = new Set<string>()
  for (let i = 0; i < map.surfaces.length; i += 1) {
    const surface = map.surfaces[i]
    if (surface === undefined) continue
    if (declared.has(surface.name)) {
      found.push({
        code: 'duplicate-surface',
        where: `surfaces[${i}]`,
        detail: `two surfaces are both called "${surface.name}"; a brush naming it would be ambiguous.`,
      })
    }
    declared.add(surface.name)
  }

  const referenced = new Set<string>()
  for (const brushDef of map.brushes) referenced.add(brushDef.surface)

  for (let i = 0; i < map.surfaces.length; i += 1) {
    const surface = map.surfaces[i]
    if (surface === undefined || referenced.has(surface.name)) continue
    // Dead content is how a map file stops describing the map. It is also the
    // fingerprint of a brush that was meant to use this surface and does not.
    found.push({
      code: 'unreferenced-surface',
      where: `surfaces[${i}]`,
      detail: `surface "${surface.name}" is declared and no brush uses it. Delete it, or find the brush that was meant to.`,
    })
  }

  /* ---- brushes ---- */

  if (map.brushes.length === 0) {
    found.push({
      code: 'no-brushes',
      where: 'brushes',
      detail: 'a map with no brushes is not a map.',
    })
  }

  for (let i = 0; i < map.brushes.length; i += 1) {
    const brushDef = map.brushes[i]
    if (brushDef === undefined) continue
    const where = `brushes[${i}]`

    if (!declared.has(brushDef.surface)) {
      found.push({
        code: 'unknown-surface',
        where,
        detail: `no surface is called "${brushDef.surface}".`,
      })
    }

    if (!isIntegerPoint(brushDef.mins) || !isIntegerPoint(brushDef.maxs)) {
      // Integers are exact in binary floating point, so every plane distance a
      // brush produces is exact too, and two peers derive identical planes by
      // arithmetic rather than by both rounding the same way. It is also what
      // every brush-based level editor since 1996 has snapped to.
      found.push({
        code: 'off-grid',
        where,
        detail: 'brush extents must be whole Quake units.',
      })
      continue
    }

    let inverted = false
    for (let axis = 0; axis < 3; axis += 1) {
      const lo = brushDef.mins[axis] ?? 0
      const hi = brushDef.maxs[axis] ?? 0
      if (hi > lo) continue
      inverted = true
      found.push({
        code: 'inverted-extents',
        where,
        detail: `maxs.${AXIS_NAMES[axis]} (${hi}) is not greater than mins.${AXIS_NAMES[axis]} (${lo}). A brush with its corners the wrong way round is a brush that is not there.`,
      })
    }
    if (inverted) continue

    if (brushDef.nonSolid === true && brushDef.noRender === true) {
      found.push({
        code: 'invisible-and-intangible',
        where,
        detail: 'a brush that is both nonSolid and noRender does nothing at all.',
      })
    }

    if (brushDef.kind === 'ramp') {
      const low = rampLowHeight(brushDef)
      if (low <= brushDef.mins[2]) {
        const slope = RAMP_SLOPES[brushDef.slope]
        found.push({
          code: 'ramp-too-shallow',
          where,
          detail: `a ${brushDef.slope} ramp rising along ${brushDef.rise} falls to z = ${low} across this footprint, at or below mins.z (${brushDef.mins[2]}). Raise maxs.z or lower mins.z so the ramp keeps a plinth: it needs more than ${slope.rise}/${slope.run} of its run in height.`,
        })
      }
    }
  }

  /* ---- spawns ---- */

  if (map.spawns.length < MIN_SPAWNS) {
    found.push({
      code: 'too-few-spawns',
      where: 'spawns',
      detail: `a duel map needs at least ${MIN_SPAWNS} spawns; this one has ${map.spawns.length}.`,
    })
  }

  for (let i = 0; i < map.spawns.length; i += 1) {
    const spawn = map.spawns[i]
    if (spawn === undefined) continue
    if (!isIntegerPoint(spawn.origin)) {
      found.push({
        code: 'off-grid',
        where: `spawns[${i}]`,
        detail: 'spawn origins must be whole Quake units.',
      })
    }
    if (!Number.isInteger(spawn.yaw)) {
      found.push({
        code: 'bad-angle',
        where: `spawns[${i}]`,
        detail: 'yaw is in angle units (1/65536 of a turn) and must be an integer.',
      })
    }
  }

  /* ---- lights and props: carried, never simulated, still has to be numbers ---- */

  for (let i = 0; i < map.lights.length; i += 1) {
    const light = map.lights[i]
    if (light === undefined) continue
    const finite =
      isFinitePoint(light.origin) &&
      isFinitePoint(light.color) &&
      Number.isFinite(light.intensity) &&
      Number.isFinite(light.radius)
    if (!finite) {
      found.push({
        code: 'bad-light',
        where: `lights[${i}]`,
        detail: 'every field of a light must be a finite number.',
      })
    }
  }

  for (let i = 0; i < map.props.length; i += 1) {
    const prop = map.props[i]
    if (prop === undefined) continue
    if (prop.model === '' || !isFinitePoint(prop.origin) || !Number.isFinite(prop.scale)) {
      found.push({
        code: 'bad-prop',
        where: `props[${i}]`,
        detail: 'a prop needs a model reference and finite numbers.',
      })
    }
  }

  return found
}

/**
 * Rules that need a collision world: is the spawn clear, and can you stand up
 * in it.
 *
 * Both are asked with the *same* trace the game asks with, against the *same*
 * player box, so a spawn that passes here is a spawn the simulation agrees is
 * legal. Reimplementing the test with a cheaper point check is how a map ships
 * with a spawn that is clear for a point and not for a 30-unit-wide player.
 */
function geometricDiagnostics(map: MapSource): MapDiagnostic[] {
  const found: MapDiagnostic[] = []
  const world = createMapWorld(map)
  const trace = createTrace()

  for (let i = 0; i < map.spawns.length; i += 1) {
    const spawn = map.spawns[i]
    if (spawn === undefined) continue
    const where = `spawns[${i}]`
    const at = `(${spawn.origin[0]}, ${spawn.origin[1]}, ${spawn.origin[2]})`

    const depth = boxPenetration(world, spawn.origin, PLAYER_MINS, PLAYER_MAXS)
    if (depth > 0) {
      found.push({
        code: 'spawn-in-solid',
        where,
        detail: `a player standing at ${at} is ${depth.toFixed(3)} units inside solid geometry. Remember the origin is the player's feet, not their middle.`,
      })
      // Headroom above a spawn that is already buried is a meaningless number.
      continue
    }

    // Lift a plate the size of the player's footprint, sitting on top of their
    // head, through the remaining `MIN_SPAWN_HEADROOM - PLAYER_HEIGHT`.
    //
    // A plate at the *feet* would be the obvious thing to sweep and it starts
    // flush with the floor, where a trace legitimately reports `startsolid` and
    // the answer stops meaning anything. Starting at the crown is boundary-free
    // — the standing box was already proven clear above — and measures exactly
    // the quantity the constant is written in terms of.
    const crown: [number, number, number] = [-PLAYER_HALF_WIDTH, -PLAYER_HALF_WIDTH, PLAYER_MAXS[2]]
    const reach = MIN_SPAWN_HEADROOM - PLAYER_MAXS[2]
    traceBox(
      trace,
      world,
      spawn.origin,
      [spawn.origin[0], spawn.origin[1], spawn.origin[2] + reach],
      crown,
      [PLAYER_HALF_WIDTH, PLAYER_HALF_WIDTH, PLAYER_MAXS[2]],
    )
    if (trace.fraction < 1) {
      const headroom = PLAYER_MAXS[2] + trace.fraction * reach
      found.push({
        code: 'spawn-headroom',
        where,
        detail: `${at} has ${headroom.toFixed(1)} units of headroom; a spawn needs ${MIN_SPAWN_HEADROOM}. The player is ${PLAYER_MAXS[2]} tall and jumps on the first frame of the round.`,
      })
    }
  }

  for (let i = 0; i < map.spawns.length; i += 1) {
    const a = map.spawns[i]
    if (a === undefined) continue
    for (let j = i + 1; j < map.spawns.length; j += 1) {
      const b = map.spawns[j]
      if (b === undefined) continue
      const dx = b.origin[0] - a.origin[0]
      const dy = b.origin[1] - a.origin[1]
      const dz = b.origin[2] - a.origin[2]
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
      if (distance >= MIN_SPAWN_SEPARATION) continue
      found.push({
        code: 'spawn-separation',
        where: `spawns[${i}]`,
        detail: `spawns[${i}] and spawns[${j}] are ${distance.toFixed(1)} units apart; the minimum is ${MIN_SPAWN_SEPARATION}. Two players who can shoot each other before they have moved are not duelling.`,
      })
    }
  }

  // Distance is a floor, not the rule. A round starts on a *pair* of points
  // that are far enough apart **and** cannot see each other, and a map where no
  // such pair exists cannot start a round at all — `selectSpawnPair` throws on
  // it. Better to find that out at the bake than at the first round.
  if (buildSpawnPlan(map, world).pairs.length === 0) {
    found.push({
      code: 'no-blind-spawn-pair',
      where: 'spawns',
      detail: `no two spawns are both at least ${MIN_SPAWN_SEPARATION} units apart and out of each other's sight, so there is no pair a round could start on. Put something in the line between two of them — the arena's own answer is a tower in the middle.`,
    })
  }

  return found
}

/**
 * Is there a way on to every ledge. `docs/physics-spec.md` §5, and
 * `reachability.ts` for the analysis this reads the answer out of.
 *
 * The rule is one sentence: every surface a player can stand on has to be one
 * they can get to from a spawn, by walking and by the four techniques the
 * movement actually has. A ledge that fails it is a room nobody visits, or —
 * worse, because it looks fine in the editor — a ledge a player can drop on to
 * and then cannot leave.
 */
function reachabilityDiagnostics(map: MapSource): MapDiagnostic[] {
  const analysis = analyzeReachability(map)
  const found: MapDiagnostic[] = []

  for (const ledge of analysis.unreachable) {
    // Rounded: a sample stands an epsilon clear of the surface it is on, and
    // "420.125" in an error message reads as precision the author does not have.
    const at = `(${Math.round(ledge.origin[0])}, ${Math.round(ledge.origin[1])}, ${Math.round(ledge.origin[2])})`
    const ways = TECHNIQUES.map((t) => `${t.height} (${t.label})`).join(', ')
    found.push({
      code: 'unreachable-ledge',
      where: 'brushes',
      detail: `a player can stand at ${at} and cannot get there. The climbs the movement makes are ${ways} — every ledge has to be within one of them of something below it, and dropping on to a ledge does not count as reaching it because a player who does cannot get back off. Nothing in this map climbs more than ${MAX_CLIMB} units.`,
    })
  }

  return found
}

/**
 * Everything wrong with a map. Empty means it bakes.
 *
 * @see structuralDiagnostics for why the two passes are not interleaved.
 *
 * Three passes now, and the third is the expensive one: reachability samples
 * the whole map and traces against it, which is worth a fraction of a second at
 * bake time and nothing at all at run time — `loadMap` never calls this.
 */
export function validateMap(map: MapSource): MapDiagnostic[] {
  const structural = structuralDiagnostics(map)
  if (structural.length > 0) return structural
  const geometric = geometricDiagnostics(map)
  if (geometric.length > 0) return geometric
  return reachabilityDiagnostics(map)
}

/** Diagnostics as the lines a baker prints. One per line, no trailing newline. */
export function formatDiagnostics(diagnostics: readonly MapDiagnostic[]): string {
  return diagnostics.map((d) => `  ${d.where}: ${d.detail} [${d.code}]`).join('\n')
}
