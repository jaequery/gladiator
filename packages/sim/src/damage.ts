/**
 * Damage, splash and knockback. `docs/physics-spec.md` §3.3.
 *
 * Quake 3's `g_combat.c`, transcribed against this repo's origin-at-the-feet
 * box. Three things in here decide how the game plays, and all three are the
 * kind of detail that reads like a rounding accident until you know what it
 * buys:
 *
 * 1. **Splash distance is measured to the nearest point on the target's
 *    box**, not to its centre. A rocket at your feet is therefore at distance
 *    *zero* and deals its full 100 — which is what makes a rocket jump a fixed,
 *    learnable 500 qu/s rather than a number that depends on how tall the
 *    player model happens to be.
 * 2. **The damage is truncated to an integer before the knockback is derived
 *    from it.** So a rocket 48 units to your side deals 72, not 72.5, and
 *    pushes you at 360 qu/s, not 362.5. Knockback is a function of the damage
 *    the player *sees*.
 * 3. **The knockback is computed before anything is subtracted.** Rocket
 *    jumping exists in the gap: the push comes off the full 100, and only then
 *    is it decided what that 100 costs you. Which is why all three self-damage
 *    modes (`match/selfDamage.ts`) launch you at the same 500 qu/s and differ
 *    only in the bill.
 *
 * Knockback is always **added** to the velocity, never assigned. Two rockets
 * landing on the same tick throw you twice as far, and a rocket you jump into
 * keeps the jump.
 *
 * What a hit *costs* — how it is split between armour and health, and what your
 * own splash costs you — is not decided here. `match/selfDamage.ts` owns that,
 * as a pure function of numbers, and this file applies its answer.
 */

import type { Vec3 } from './axis.ts'
import { DAMAGE_ORIGIN_HEIGHT, PLAYER_MAXS, PLAYER_MINS } from './bbox.ts'
import type { CollisionWorld } from './collide.ts'
import { normalizeVec3, setVec3, vec3 } from './math.ts'
import type { MutVec3 } from './math.ts'
import { resolveDamage } from './match/selfDamage.ts'
import type { SelfDamageMode } from './match/selfDamage.ts'
import { isSpawnProtected } from './match/spawn.ts'
import { EntityFlag, EntityKind, NO_ENTITY } from './state.ts'
import type { EntityState, GameState } from './state.ts'
import { TICK_INTERVAL_MS } from './tick.ts'
import { createTrace, traceRay } from './trace.ts'

/* --------------------------------------------------------------------------
 * The constants
 * ----------------------------------------------------------------------- */

/** Quake 3's `g_knockback` cvar, at its default. */
export const G_KNOCKBACK = 1000

/** A player's mass, in Quake's arbitrary units. Quake 3's bare `200`. */
export const PLAYER_MASS = 200

/**
 * How much velocity one point of damage is worth, in qu/s. **5**.
 *
 * `g_knockback / mass`, derived rather than typed, because it is the whole of
 * Quake's push formula and every launch height in the game falls out of it: a
 * 100-point splash under your feet is 500 qu/s, and that is the number
 * `map/reachability.ts` designs ledges around.
 */
export const KNOCKBACK_PER_DAMAGE = G_KNOCKBACK / PLAYER_MASS

/**
 * The damage above which knockback stops growing, in points.
 *
 * Quake 3's `if ( knockback > 200 ) knockback = 200`. Nothing this game fires
 * reaches it — the largest single hit is 100 — so it is transcribed for the
 * sake of the formula being the formula rather than because it fires.
 */
export const KNOCKBACK_DAMAGE_CAP = 200

/**
 * How far up splash knockback is biased, in Quake units, before the direction
 * is normalised. Quake 3's `dir[2] += 24`, with the comment "push the center of
 * mass higher than the origin so players get knocked into the air more".
 *
 * Unconditional: a rocket that lands *above* you still has its push tilted
 * upward by this much. It is a game-feel constant and not a physical one, and
 * removing it does not make splash more realistic — it makes rockets shove
 * players along the floor instead of into the air.
 */
export const SPLASH_UP_BIAS = 24

/** The shortest knockback window, in ms. Quake 3's `if ( t < 50 ) t = 50`. */
export const MIN_KNOCKBACK_TIME_MS = 50

/** The longest knockback window, in ms. Quake 3's `if ( t > 200 ) t = 200`. */
export const MAX_KNOCKBACK_TIME_MS = 200

/**
 * The velocity a hit of `damage` points imparts, in qu/s.
 *
 * The one place the push formula is stated. `map/reachability.ts` builds the
 * rocket-jump climb out of this rather than out of a 500 written down twice.
 */
export function knockbackSpeed(damage: number): number {
  const capped = damage > KNOCKBACK_DAMAGE_CAP ? KNOCKBACK_DAMAGE_CAP : damage
  return KNOCKBACK_PER_DAMAGE * capped
}

/**
 * How many sub-steps of knockback timer a hit of `damage` points sets.
 *
 * Quake 3 states this in milliseconds — `clamp(2 * knockback, 50, 200)` — and
 * the simulation's only clock is the tick counter, so it is converted here by
 * rounding to the nearest whole sub-step. Rounding is safe because the timer is
 * a *window* rather than a deadline: what it does is suppress ground friction
 * and swap ground acceleration for air acceleration (`pmove/`), so being 4 ms
 * out at either end is not something a player can feel. A full 100-point splash
 * gives 200 ms, which is 25 ticks.
 */
export function knockbackTicksFor(damage: number): number {
  const capped = damage > KNOCKBACK_DAMAGE_CAP ? KNOCKBACK_DAMAGE_CAP : damage
  let ms = capped * 2
  if (ms < MIN_KNOCKBACK_TIME_MS) ms = MIN_KNOCKBACK_TIME_MS
  if (ms > MAX_KNOCKBACK_TIME_MS) ms = MAX_KNOCKBACK_TIME_MS
  return Math.round(ms / TICK_INTERVAL_MS)
}

/* --------------------------------------------------------------------------
 * The self-splash seam
 * ----------------------------------------------------------------------- */

/** A player taking their own splash: a rocket jump, or a rocket at their feet. */
export type SelfSplash = {
  /** The world tick it landed on. */
  readonly tick: number
  /** The player slot, or `NO_SLOT` for a body no peer is steering. */
  readonly slot: number
  /** The splash before the self-damage rule was consulted — what the push came from. */
  readonly points: number
  /** What it actually cost: armour plus health, which is 0 under `SelfDamage.None`. */
  readonly absorbed: number
}

/**
 * Called when a player takes damage from their own rocket.
 *
 * The same shape, and the same reason, as `pmove/index.ts`'s
 * `onSpeedClamp`: `packages/sim` has no `console` and no counters of its
 * own, so anything the outside world wants to *notice* is a seam the host
 * fills in.
 *
 * What the client does with it is the interesting part. Self-splash is the one
 * event whose prediction is a *predicate* rather than a trajectory — you either
 * ate your own rocket or you did not — so a client that predicted one the
 * server did not apply, or missed one it did, has had its prediction fail in a
 * way ordinary positional drift never shows. `client/src/net/mispredict.ts`
 * counts exactly that, and it is a far sharper determinism canary than a
 * correction distance. GLAD-2E6PUO.
 *
 * Purely observational: it cannot reach the state, nothing consults it, and two
 * peers with different observers still produce the same world. `null` removes
 * it.
 */
export function onSelfSplash(observer: ((splash: SelfSplash) => void) | null): void {
  selfSplashObserver = observer
}

let selfSplashObserver: ((splash: SelfSplash) => void) | null = null

/* --------------------------------------------------------------------------
 * The attribution seam
 * ----------------------------------------------------------------------- */

/**
 * What delivered a hit.
 *
 * Three, because there are three ways to lose health in this game and the
 * difference between them is not recoverable from outside: a rail and a direct
 * rocket both deal exactly 100, and a rocket detonating at somebody's feet deals
 * exactly 100 of *splash* — so a harness watching health go down cannot tell any
 * of the three apart, and "rocket direct-hit rate" and "rocket splash-damage
 * rate" are two different rows of GLAD-6BIYFQ's band table.
 */
export type DamageCause = 'rail' | 'direct' | 'splash'

/** One hit landing, as the tick that dealt it saw it. */
export type DamageEvent = {
  /** The world tick it landed on. */
  readonly tick: number
  readonly cause: DamageCause
  /** The entity that caused it — the same entity as the target, for self-damage. */
  readonly attackerId: number
  readonly targetId: number
  /** The target's player slot, or `NO_SLOT` for a body no peer is steering. */
  readonly targetSlot: number
  /** The damage before the self-damage rule was consulted — what the push came from. */
  readonly points: number
  /** What it actually cost: armour plus health. */
  readonly absorbed: number
  /** Whether this is the hit that killed. */
  readonly fatal: boolean
}

/**
 * Called for every hit that reaches a body, with what delivered it.
 *
 * The third observation seam, and the same shape as the other two
 * (`onSpeedClamp` in `pmove/index.ts`, {@link onSelfSplash} above): the
 * simulation has no counters, so anything the outside world wants to *notice* is
 * something a host fills in.
 *
 * It exists for the bot's band table (GLAD-6BIYFQ), which has to say what
 * fraction of rails hit and what fraction of rockets landed a direct rather than
 * a splash. Both are questions about *attribution*, and attribution is
 * information the tick has and the state does not keep — a health bar that went
 * down by 100 is the same health bar whichever of the three did it. Deriving it
 * from outside would mean re-tracing every rail and re-integrating every rocket
 * against a copy of this file, which is the kind of second implementation that
 * is right until the day it silently is not.
 *
 * Unlike {@link onSelfSplash} this is *not* installed by `counters.ts`. It fires
 * several times a second in a live duel, which makes it an instrument rather
 * than a canary: the two counters exist because any non-zero value is a sentence
 * somebody has to explain, and this one is ordinary by design.
 *
 * Purely observational, in both directions: it cannot reach the state, nothing
 * consults it, and two peers with different observers still produce the same
 * world. `null` removes it.
 */
export function onDamage(observer: ((event: DamageEvent) => void) | null): void {
  damageObserver = observer
}

let damageObserver: ((event: DamageEvent) => void) | null = null

/* --------------------------------------------------------------------------
 * G_Damage
 * ----------------------------------------------------------------------- */

/**
 * Apply `points` of damage to `target`, pushed along `dir`.
 *
 * `dir` need not be normalised — Quake normalises it here, and the callers rely
 * on that: `radiusDamage` hands over an unnormalised offset with 24 added to
 * its `z`, and the length of that vector is meaningless.
 *
 * `attackerId` is the entity that caused it, which is the same entity for
 * self-damage. `mode` is which self-damage rule is in force and defaults to the
 * match's own, so a caller inside a tick never has to thread it — the state
 * already knows (`match/match.ts`). It is still a parameter, because the tests
 * for the three modes want to state which one they mean.
 *
 * Returns the points the target actually absorbed — armour plus health — which
 * is zero for a hit that spawn protection or a self-damage mode threw away, and
 * is *not* `points` whenever either armour or the halving got involved.
 *
 * `cause` is carried for {@link onDamage} and for nothing else — no branch in
 * this function or below it reads it. It defaults to `'direct'` because that is
 * what a hit with nothing between the shooter and the target is, and it is what
 * both callers that do not name one are.
 */
export function applyDamage(
  state: GameState,
  target: EntityState,
  attackerId: number,
  dir: Vec3,
  points: number,
  mode: SelfDamageMode = state.match.rules.selfDamage,
  cause: DamageCause = 'direct',
): number {
  if (points <= 0) return 0
  if ((target.flags & EntityFlag.Dead) !== 0) return 0

  // The one gate every hit goes through, which is why spawn protection is
  // consulted here rather than at each of the three places a shot lands.
  // GLAD-AKODBZ decided the window is zero and left this as the seam; a seam
  // nothing calls is a comment, so this calls it. Your own splash is exempt —
  // protection that also cancelled a rocket jump would change the movement.
  if (target.id !== attackerId && isSpawnProtected(state, target)) return 0

  // The push is computed from the *full* damage, before anything below decides
  // what that damage costs. That ordering is Quake's, and it is the whole
  // reason a rocket jump is worth what it costs — and the reason all three
  // self-damage modes launch you identically.
  if (target.kind === EntityKind.Player) {
    const length = normalizeVec3(pushDir, dir)
    if (length > 0) {
      const speed = knockbackSpeed(points)
      target.velocity[0] += pushDir[0] * speed
      target.velocity[1] += pushDir[1] * speed
      target.velocity[2] += pushDir[2] * speed

      // Quake only arms the timer when it is not already running, so a stream
      // of small hits cannot hold a player in the air indefinitely.
      if (target.knockbackTicks === 0) {
        target.knockbackTicks = knockbackTicksFor(points)
      }
    }
  }

  const selfInflicted = target.id === attackerId
  const split = resolveDamage(mode, selfInflicted, points, target.armor)
  target.armor -= split.armor
  target.health -= split.health
  const fatal = target.health <= 0
  if (fatal) target.flags |= EntityFlag.Dead

  const absorbed = split.armor + split.health

  // After the state is written, so an observer that reads the entity sees the
  // world the tick left behind rather than a half-applied one. See
  // {@link onSelfSplash}.
  if (selfInflicted && target.kind === EntityKind.Player && selfSplashObserver !== null) {
    selfSplashObserver({ tick: state.tick, slot: target.slot, points, absorbed })
  }

  if (damageObserver !== null) {
    damageObserver({
      tick: state.tick,
      cause,
      attackerId,
      targetId: target.id,
      targetSlot: target.slot,
      points,
      absorbed,
      fatal,
    })
  }

  return absorbed
}

const pushDir: MutVec3 = vec3()

/* --------------------------------------------------------------------------
 * G_RadiusDamage
 * ----------------------------------------------------------------------- */

/**
 * The distance from `point` to the nearest point on the box
 * `[origin + mins, origin + maxs]`. Zero when `point` is inside it.
 *
 * Quake's per-axis clamp, and the reason a rocket at your feet does its full
 * 100: the explosion is inside the box, so every axis contributes nothing.
 */
export function distanceToBox(point: Vec3, origin: Vec3, mins: Vec3, maxs: Vec3): number {
  let dx = 0
  let dy = 0
  let dz = 0

  const lowX = origin[0] + mins[0]
  const highX = origin[0] + maxs[0]
  if (point[0] < lowX) dx = lowX - point[0]
  else if (point[0] > highX) dx = point[0] - highX

  const lowY = origin[1] + mins[1]
  const highY = origin[1] + maxs[1]
  if (point[1] < lowY) dy = lowY - point[1]
  else if (point[1] > highY) dy = point[1] - highY

  const lowZ = origin[2] + mins[2]
  const highZ = origin[2] + maxs[2]
  if (point[2] < lowZ) dz = lowZ - point[2]
  else if (point[2] > highZ) dz = point[2] - highZ

  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * Can an explosion at `point` see `target`? Quake 3's `CanDamage`.
 *
 * Five rays: one at the middle of the box, and four at the corners of a
 * 30-unit square around it. Quake's own comment admits the corner offsets
 * should be in the plane of projection rather than in world coordinates, and
 * they are transcribed as they are — the point of the test is that splash does
 * not travel through a wall, and five rays either side of a doorway answers
 * that well enough to have shipped for twenty-five years.
 *
 * The rays are traced against the world only. Players do not block splash from
 * each other, which is Quake (`MASK_SOLID`), and in a duel is also the only
 * answer that is not a coin toss about who was standing in front of whom.
 */
export function canDamage(world: CollisionWorld, target: EntityState, point: Vec3): boolean {
  setVec3(
    damageProbe,
    target.origin[0] + (PLAYER_MINS[0] + PLAYER_MAXS[0]) * 0.5,
    target.origin[1] + (PLAYER_MINS[1] + PLAYER_MAXS[1]) * 0.5,
    target.origin[2] + (PLAYER_MINS[2] + PLAYER_MAXS[2]) * 0.5,
  )
  if (traceRay(damageTrace, world, point, damageProbe).fraction === 1) return true

  const midX = damageProbe[0]
  const midY = damageProbe[1]
  const midZ = damageProbe[2]

  for (const corner of CAN_DAMAGE_CORNERS) {
    setVec3(damageProbe, midX + corner[0], midY + corner[1], midZ)
    if (traceRay(damageTrace, world, point, damageProbe).fraction === 1) return true
  }

  return false
}

/** Quake's four `+/- 15` offsets around the midpoint, in Quake units. */
const CAN_DAMAGE_CORNERS: readonly (readonly [number, number])[] = [
  [15, 15],
  [-15, 15],
  [15, -15],
  [-15, -15],
]

const damageProbe: MutVec3 = vec3()
const damageTrace = createTrace()

/**
 * Damage everything within `radius` of `point`. Quake 3's `G_RadiusDamage`.
 *
 * `ignoreId` is the entity that already took a direct hit — Quake's rule is
 * that splash *does not apply to the person directly hit*, which is why a
 * rocket to the chest deals 100 and not 200. Pass `NO_ENTITY` when there was no
 * direct hit.
 *
 * `deferredId` is a *second* entity this explosion must not reach, and it exists
 * for exactly one caller: a predicting client that could not prove its own
 * rocket's flight was clear passes the shooter's own id, which leaves that share
 * of the blast to arrive in the next snapshot instead of being guessed at
 * (`splash.ts`). It is `NO_ENTITY` on the authoritative host, which is never
 * uncertain about a splash it just computed. Two ids rather than one because
 * both can apply at once: a rocket that hit the opponent in the chest ignores
 * *them* for splash and may still owe its owner a launch.
 *
 * Returns the number of players it damaged.
 */
export function radiusDamage(
  state: GameState,
  world: CollisionWorld,
  point: Vec3,
  damage: number,
  radius: number,
  attackerId: number,
  ignoreId: number,
  mode: SelfDamageMode = state.match.rules.selfDamage,
  deferredId: number = NO_ENTITY,
): number {
  if (radius < 1) return 0

  let hits = 0

  for (const target of state.entities) {
    if (target.kind !== EntityKind.Player) continue
    if (target.id === ignoreId) continue
    if (target.id === deferredId) continue
    if ((target.flags & EntityFlag.Dead) !== 0) continue

    const dist = distanceToBox(point, target.origin, PLAYER_MINS, PLAYER_MAXS)
    if (dist >= radius) continue

    if (!canDamage(world, target, point)) continue

    // Linear falloff, then truncated toward zero. `(int)points` in the C, and
    // the truncation is load-bearing: the knockback below is derived from the
    // integer, so 72.5 points of splash is 72 damage and 360 qu/s.
    const points = Math.trunc(damage * (1 - dist / radius))

    // From the explosion to the target, biased upward twice over: once to
    // convert this repo's feet-origin to the middle of the box Quake measures
    // from, and once for Quake's deliberate `dir[2] += 24`. `bbox.ts` has the
    // note on why those two 24s are not the same number.
    setVec3(
      splashDir,
      target.origin[0] - point[0],
      target.origin[1] - point[1],
      target.origin[2] + DAMAGE_ORIGIN_HEIGHT - point[2] + SPLASH_UP_BIAS,
    )

    if (applyDamage(state, target, attackerId, splashDir, points, mode, 'splash') > 0) hits += 1
  }

  return hits
}

const splashDir: MutVec3 = vec3()
