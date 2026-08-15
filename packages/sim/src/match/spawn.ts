/**
 * Spawning: which point each player gets, which way they face, and what
 * happens when somebody is already standing on it.
 *
 * A map carries a list of spawn points and the bake proves each one is a legal
 * place to stand (`map/validate.ts`). None of that says which two of them a
 * round starts on, and "the first two, every time" is the answer that ships if
 * nobody writes one down — along with the round where both players appear on
 * the same pad.
 *
 * ## The three policies, decided
 *
 * **Telefrag.** Arriving on an occupied point kills the occupant, not the
 * arrival. That is Quake's answer and it is the right one for a reason worth
 * stating: the alternative — refusing the spawn, or nudging the arrival aside —
 * makes standing on a spawn pad a *tactic*, and a player who can deny an
 * opponent their spawn has won the round without firing. Killing the squatter
 * makes camping a spawn the worst idea in the arena. See {@link spawnPlayer}.
 *
 * In a duel it is also, by construction, unreachable at round start:
 * {@link spawnRound} places both players at two points that are at least
 * {@link MIN_SPAWN_SEPARATION} apart, in the same instant, after moving both
 * bodies. Telefrag is the policy for the spawns that happen at any *other*
 * moment — a reconnect (GLAD-DVDV6P), or a mode with more than two players.
 *
 * **Spawn protection: none.** {@link SPAWN_PROTECTION_TICKS} is zero, and the
 * format is why. Rocket Arena rounds start both players at a known instant, out
 * of each other's sight, half an arena apart — there is no spawn to camp and no
 * spawn to be killed on, so invulnerability would protect nobody and would
 * instead hand whoever charges first a free approach. The seam is
 * {@link isSpawnProtected} rather than a comment, so that if playtesting
 * disagrees the change is one number and not a new rule scattered through the
 * damage code.
 *
 * **Respawn timing.** {@link RESPAWN_DELAY_TICKS} — the gap between a round
 * ending and the next round's bodies appearing. The *state machine* that counts
 * it down belongs to the round rules (GLAD-L4SYN9); the number belongs here,
 * next to the code that does the spawning.
 *
 * ## Selection is a plan plus two dice rolls
 *
 * The expensive half — which pairs of spawn points are far enough apart and
 * cannot see each other — is geometry, and geometry does not change between
 * rounds. {@link buildSpawnPlan} does it once per map and hands back the list
 * of pairs a round may legally start from. A round start is then two draws from
 * the seeded PRNG in `GameState`: which pair, and which end each player gets.
 *
 * That split is what makes a replay reproduce a match exactly. The draws come
 * from `state.rng`, which is carried in the state, hashed by `encodeExact` and
 * rewound by reconciliation — so two peers that agree about the map and the
 * seed agree about the spawns without exchanging a byte.
 */

import type { Vec3 } from '../axis.ts'
import { PLAYER_HALF_WIDTH, PLAYER_HEIGHT, PLAYER_MAXS, PLAYER_MINS, PLAYER_VIEW_HEIGHT } from '../bbox.ts'
import type { CollisionWorld } from '../collide.ts'
import { createMapWorld } from '../map/collide.ts'
import { MIN_SPAWN_SEPARATION } from '../map/schema.ts'
import type { MapSource, MapSpawn } from '../map/schema.ts'
import { copyVec3, setVec3, vec3 } from '../math.ts'
import type { MutVec3 } from '../math.ts'
import { rngInt } from '../rng.ts'
import type { RngHolder } from '../rng.ts'
import { EntityFlag, EntityKind, NEVER_EXPIRES, findPlayer, spawnEntity } from '../state.ts'
import type { EntityState, GameState } from '../state.ts'
import { TICK_RATE } from '../tick.ts'
import { SURFACE_CLIP_EPSILON, createTrace, traceRay } from '../trace.ts'

/* --------------------------------------------------------------------------
 * The policies, as numbers
 * ----------------------------------------------------------------------- */

/**
 * Health a player stands up with.
 *
 * Rocket Arena's whole thesis in one constant: everyone starts every round with
 * the same thing, and nothing on the map can change that. Armour and the three
 * self-damage modes are GLAD-L4SYN9's; this is the number the spawn applies.
 */
export const SPAWN_HEALTH = 100

/**
 * Sub-steps of invulnerability after spawning. **Zero, deliberately.**
 *
 * See the module header: in a round-based duel there is nothing for spawn
 * protection to protect against, and a player who cannot be hurt for the first
 * half-second is a player who can walk into a rocket for free. Raising this is
 * a one-line change, and {@link isSpawnProtected} is the only place that has to
 * know it happened.
 */
export const SPAWN_PROTECTION_TICKS = 0

/**
 * Sub-steps between a round ending and the next round's bodies appearing.
 *
 * Three seconds. Long enough to see how you died and read the score, short
 * enough that a first-to-nine match is not mostly waiting. Written in *ticks*
 * rather than milliseconds because both peers count it in ticks — a delay
 * measured against a wall clock is a delay the two of them disagree about.
 *
 * GLAD-L4SYN9 owns the state machine that counts this down; this is the number
 * it counts.
 */
export const RESPAWN_DELAY_TICKS = 3 * TICK_RATE

/** The two player slots a duel is played in. */
export const DUEL_SLOTS: readonly [number, number] = [0, 1]

/* --------------------------------------------------------------------------
 * Line of sight
 * ----------------------------------------------------------------------- */

/** Inset of a sight target from the face of the player box, in Quake units. */
const SIGHT_INSET = SURFACE_CLIP_EPSILON

/** Half-width of the box the sight targets sit on the corners of. */
const SIGHT_HALF_WIDTH = PLAYER_HALF_WIDTH - SIGHT_INSET

/**
 * The points on a player's box that a sightline is tested against: the eight
 * corners, pulled in by the trace epsilon so a corner is not sitting exactly on
 * the plane of the floor it stands on, plus the eye.
 *
 * Testing eye-to-eye alone is the version everyone writes first, and it calls
 * two spawns blind when one player's shoulder is in plain view around a pillar.
 * The corners are where a partial sightline appears first, so they are what is
 * asked about. It is a *sampling* and not a proof — a world concave enough to
 * show only the middle of a box would fool it — but it is the same question the
 * railgun asks (can a hitscan from my eye reach any part of you), asked with the
 * same trace, which is the property that matters.
 *
 * Offsets from the player's origin, which is at the feet (`bbox.ts`).
 */
export const SIGHT_TARGETS: readonly Vec3[] = [
  [0, 0, PLAYER_VIEW_HEIGHT],
  [-SIGHT_HALF_WIDTH, -SIGHT_HALF_WIDTH, SIGHT_INSET],
  [-SIGHT_HALF_WIDTH, SIGHT_HALF_WIDTH, SIGHT_INSET],
  [SIGHT_HALF_WIDTH, -SIGHT_HALF_WIDTH, SIGHT_INSET],
  [SIGHT_HALF_WIDTH, SIGHT_HALF_WIDTH, SIGHT_INSET],
  [-SIGHT_HALF_WIDTH, -SIGHT_HALF_WIDTH, PLAYER_HEIGHT - SIGHT_INSET],
  [-SIGHT_HALF_WIDTH, SIGHT_HALF_WIDTH, PLAYER_HEIGHT - SIGHT_INSET],
  [SIGHT_HALF_WIDTH, -SIGHT_HALF_WIDTH, PLAYER_HEIGHT - SIGHT_INSET],
  [SIGHT_HALF_WIDTH, SIGHT_HALF_WIDTH, PLAYER_HEIGHT - SIGHT_INSET],
]

/** Reused by the plan builder. Nothing here runs inside a sub-step. */
const sightTrace = createTrace()
const sightFrom: MutVec3 = [0, 0, 0]
const sightTo: MutVec3 = [0, 0, 0]

/** Straight-line distance between two spawn points, in Quake units. */
export function spawnSeparation(a: MapSpawn, b: MapSpawn): number {
  const dx = b.origin[0] - a.origin[0]
  const dy = b.origin[1] - a.origin[1]
  const dz = b.origin[2] - a.origin[2]
  // Not `Math.hypot`: it is implementation-approximated and banned here.
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/** Can a player standing at `from` see any part of a player standing at `to`? */
function canSee(world: CollisionWorld, from: MapSpawn, to: MapSpawn): boolean {
  sightFrom[0] = from.origin[0]
  sightFrom[1] = from.origin[1]
  sightFrom[2] = from.origin[2] + PLAYER_VIEW_HEIGHT

  for (const target of SIGHT_TARGETS) {
    sightTo[0] = to.origin[0] + target[0]
    sightTo[1] = to.origin[1] + target[1]
    sightTo[2] = to.origin[2] + target[2]
    traceRay(sightTrace, world, sightFrom, sightTo)
    if (sightTrace.fraction === 1) return true
  }
  return false
}

/**
 * Neither player can see the other from these two points.
 *
 * Asked in both directions rather than once. Sight is symmetric between two
 * *points* and these are not points — the eye is 50 units up and the body it is
 * looking for is 56 tall, so a ledge can hide one of them and not the other.
 */
export function spawnsAreBlind(world: CollisionWorld, a: MapSpawn, b: MapSpawn): boolean {
  return !canSee(world, a, b) && !canSee(world, b, a)
}

/* --------------------------------------------------------------------------
 * The plan
 * ----------------------------------------------------------------------- */

/** Two indices into a map's `spawns`, ascending. */
export type SpawnPair = readonly [number, number]

/**
 * Every pair of spawn points a round may legally start from, worked out once.
 *
 * Held beside a `LoadedMap` rather than inside `GameState`: it is a function of
 * the map alone, so it needs no cloning for reconciliation, no hashing and no
 * place in a snapshot — the same argument `CollisionWorld` gets in `kernel.ts`.
 */
export type SpawnPlan = {
  readonly spawns: readonly MapSpawn[]
  /** Ascending by first index, then second. Possibly empty; see `map/validate.ts`. */
  readonly pairs: readonly SpawnPair[]
}

/**
 * Work out which pairs of a map's spawns a round may start from.
 *
 * Two rules, and only the second is new. Separation is
 * {@link MIN_SPAWN_SEPARATION}, the same floor the bake already holds every
 * pair of spawns to — restated here rather than assumed, because a `MapSource`
 * that never went through the baker is exactly the one that would sneak past.
 * Mutual blindness is this ticket's rule: a duel that opens with a free railgun
 * shot was decided by the spawn, not by the players.
 *
 * Costs `spawns² × SIGHT_TARGETS` traces, which for the two-spawn arena is
 * eighteen. Call it once per map, at load.
 */
export function buildSpawnPlan(
  map: MapSource,
  world: CollisionWorld = createMapWorld(map),
): SpawnPlan {
  const pairs: SpawnPair[] = []

  for (let i = 0; i < map.spawns.length; i += 1) {
    const a = map.spawns[i]
    if (a === undefined) continue
    for (let j = i + 1; j < map.spawns.length; j += 1) {
      const b = map.spawns[j]
      if (b === undefined) continue
      if (spawnSeparation(a, b) < MIN_SPAWN_SEPARATION) continue
      if (!spawnsAreBlind(world, a, b)) continue
      pairs.push([i, j])
    }
  }

  return { spawns: map.spawns, pairs }
}

/** The point at `index`, or a thrown error naming the plan that lacks it. */
function pointOf(plan: SpawnPlan, index: number): MapSpawn {
  const point = plan.spawns[index]
  if (point === undefined) {
    throw new RangeError(
      `gladiator: spawn point ${index} does not exist; this map has ${plan.spawns.length}.`,
    )
  }
  return point
}

/**
 * Draw the pair of points this round starts on. Advances `rng`.
 *
 * Uniform over the legal pairs, which is the fair choice when the map is the
 * only thing that distinguishes them — and `arena1` is rotationally symmetric
 * precisely so that it stays the fair choice.
 *
 * Throws when there is no legal pair at all. That is a broken map rather than a
 * broken round, and `map/validate.ts` refuses to bake one, so reaching this is
 * a map that was hand-assembled or hand-edited past the baker.
 */
export function selectSpawnPair(plan: SpawnPlan, rng: RngHolder): SpawnPair {
  if (plan.pairs.length === 0) {
    throw new RangeError(
      'gladiator: this map has no two spawn points that are far enough apart and out of each other’s sight, so a round cannot start on it.',
    )
  }
  const pair = plan.pairs[rngInt(rng, plan.pairs.length)]
  // Unreachable: `rngInt` returns `[0, count)`. Written out because the
  // alternative is a non-null assertion, and this file would rather throw a
  // sentence than trust one.
  if (pair === undefined) throw new RangeError('gladiator: spawn pair draw fell outside the plan.')
  return pair
}

/* --------------------------------------------------------------------------
 * Standing a player up
 * ----------------------------------------------------------------------- */

/** What one player's arrival did. */
export type SpawnEvent = {
  readonly slot: number
  /** Index into the map's `spawns`. */
  readonly point: number
  /**
   * Ids of the players killed by arriving here, ascending. Empty on a clean
   * spawn, which at a round start is every spawn.
   */
  readonly telefragged: readonly number[]
}

/**
 * Do these two players' boxes share any volume?
 *
 * Touching is not overlapping: two players standing exactly 30 units apart are
 * shoulder to shoulder, not inside one another, so the comparison is strict.
 * Exported because the telefrag rule and the test that the rule leaves nothing
 * overlapping have to mean the same thing by the same code.
 */
export function playersOverlap(a: EntityState, b: EntityState): boolean {
  return (
    a.origin[0] + PLAYER_MINS[0] < b.origin[0] + PLAYER_MAXS[0] &&
    b.origin[0] + PLAYER_MINS[0] < a.origin[0] + PLAYER_MAXS[0] &&
    a.origin[1] + PLAYER_MINS[1] < b.origin[1] + PLAYER_MAXS[1] &&
    b.origin[1] + PLAYER_MINS[1] < a.origin[1] + PLAYER_MAXS[1] &&
    a.origin[2] + PLAYER_MINS[2] < b.origin[2] + PLAYER_MAXS[2] &&
    b.origin[2] + PLAYER_MINS[2] < a.origin[2] + PLAYER_MAXS[2]
  )
}

/** Is this entity a player who is still in the round? */
function isLivePlayer(entity: EntityState): boolean {
  return entity.kind === EntityKind.Player && (entity.flags & EntityFlag.Dead) === 0
}

/**
 * Stand the entity for `slot` on `point`, creating it if this is its first
 * round.
 *
 * The entity is **reused** across rounds. Ids are never reused for a *new*
 * entity, and keeping the same one for the same player across a match is what
 * lets a client interpolate and animate an opponent through a round boundary
 * (GLAD-PWCON8, GLAD-6RT64L) instead of watching one model vanish and another
 * appear. Every field that carries a previous life is reset, including the
 * flags — `JumpHeld` surviving a respawn would let a player who died holding
 * space re-jump on their first frame.
 *
 * The feet go `SURFACE_CLIP_EPSILON` above the floor rather than on it: a spawn
 * point names a floor height, a resting body sits an eighth of a unit clear of
 * it (`docs/physics-spec.md` §2.2), and placing the feet exactly on the surface
 * would start the round one rounding error inside the world.
 */
function placeAt(state: GameState, point: MapSpawn, slot: number): EntityState {
  const origin = vec3(point.origin[0], point.origin[1], point.origin[2] + SURFACE_CLIP_EPSILON)
  // Pitch level, yaw from the map, no roll. The map decides which way a player
  // is looking when the round starts, which in an arena with one thing worth
  // looking at is not a detail. Note that the kernel overwrites `angles` from
  // the next `UserCmd`, so a client has to *adopt* this yaw into its own view
  // (`packages/client/src/main.ts`) — the state carries the instruction, and
  // the peer with a mouse on it is the one that has to obey it.
  const angles = vec3(0, point.yaw, 0)

  const existing = findPlayer(state, slot)
  if (existing === null) {
    return spawnEntity(state, {
      kind: EntityKind.Player,
      slot,
      origin,
      angles,
      health: SPAWN_HEALTH,
    })
  }

  copyVec3(existing.origin, origin)
  copyVec3(existing.angles, angles)
  setVec3(existing.velocity, 0, 0, 0)
  existing.flags = 0
  existing.health = SPAWN_HEALTH
  existing.knockbackTicks = 0
  existing.ownerId = 0
  existing.spawnTick = state.tick
  existing.expireTick = NEVER_EXPIRES
  return existing
}

/**
 * Kill everyone `arriving` landed on. Returns their ids, ascending.
 *
 * Walks `state.entities`, which is ordered by id and stays that way, so two
 * peers kill the same players in the same order — which matters the moment a
 * kill is worth a point.
 */
function telefrag(state: GameState, arriving: EntityState): number[] {
  const killed: number[] = []
  for (const other of state.entities) {
    if (other === arriving) continue
    if (!isLivePlayer(other)) continue
    if (!playersOverlap(arriving, other)) continue
    other.health = 0
    other.flags |= EntityFlag.Dead
    setVec3(other.velocity, 0, 0, 0)
    killed.push(other.id)
  }
  return killed
}

/**
 * Put one player on one point, killing whoever is standing there.
 *
 * The single-spawn primitive: a reconnect, a mode with more than two players,
 * a test. A round start is {@link spawnRound}, which places both players before
 * either of them is allowed to telefrag anything.
 */
export function spawnPlayer(
  state: GameState,
  plan: SpawnPlan,
  point: number,
  slot: number,
): SpawnEvent {
  const arriving = placeAt(state, pointOf(plan, point), slot)
  return { slot, point, telefragged: telefrag(state, arriving) }
}

/**
 * Start a round: both players, two legal points, facing where the map says.
 *
 * Two draws from `state.rng`, in this order — which pair, then which end. The
 * second one is not decoration: without it the same pair always seats the same
 * player in the same corner, and a map that is only *nearly* symmetric would
 * hand one of them a small permanent advantage. It is a coin flip rather than
 * an alternation because alternation is a rule a player can count rounds
 * against.
 *
 * Both bodies are moved before either telefrags anything. A player still
 * standing where the last round left them is not an occupant of this round's
 * spawn — they are a body that has not been moved yet, and killing them for it
 * would score a point for arriving.
 */
export function spawnRound(state: GameState, plan: SpawnPlan): readonly [SpawnEvent, SpawnEvent] {
  const pair = selectSpawnPair(plan, state)
  const flipped = rngInt(state, 2) === 1
  const points: SpawnPair = flipped ? [pair[1], pair[0]] : pair

  const first = placeAt(state, pointOf(plan, points[0]), DUEL_SLOTS[0])
  const second = placeAt(state, pointOf(plan, points[1]), DUEL_SLOTS[1])

  return [
    { slot: DUEL_SLOTS[0], point: points[0], telefragged: telefrag(state, first) },
    { slot: DUEL_SLOTS[1], point: points[1], telefragged: telefrag(state, second) },
  ]
}

/**
 * Is this player still inside their spawn protection?
 *
 * `false`, always, while {@link SPAWN_PROTECTION_TICKS} is zero — which is the
 * decision, not an accident. Damage code (GLAD-L4SYN9, GLAD-5QGO11) asks this
 * rather than asking the constant, so that turning protection on later is one
 * number and not an audit of every place a player can be hurt.
 *
 * It needs no new field on `EntityState`: `spawnTick` is already carried,
 * encoded and hashed, and "how long have I been alive" is the same question.
 */
export function isSpawnProtected(state: GameState, entity: EntityState): boolean {
  return state.tick - entity.spawnTick < SPAWN_PROTECTION_TICKS
}
