/**
 * Rockets in flight. `docs/physics-spec.md` §3.2.
 *
 * ## A rocket is a trajectory, not a position
 *
 * Quake 3's `TR_LINEAR`. A rocket's origin at any tick is a closed form of its
 * muzzle, its velocity and the tick it was fired on:
 *
 * ```
 * pos(t) = trBase + (t_ms - trTime_ms) * 0.001 * trDelta
 * ```
 *
 * Nothing about the flight accumulates. That is worth more than the arithmetic
 * it saves: a peer that is told about a rocket **once** — muzzle, delta, spawn
 * tick, three numbers and a clock — can compute where it is on every tick
 * afterwards, so the wire never has to carry a rocket's position and a dropped
 * packet cannot leave one hanging in the air. It is also why the client's
 * prediction and the server's authority cannot slowly disagree about where a
 * rocket is: they are not integrating, they are evaluating.
 *
 * `trDelta` is snapped to whole units at the muzzle (`weapons.ts`), so both
 * peers evaluate the identical expression from identical inputs.
 *
 * ## The 50 ms in the past
 *
 * `trTime` is the spawn tick **minus 50 ms**, which is Quake's
 * `MISSILE_PRESTEP_TIME`. So on the very first tick the rocket is evaluated
 * 45 units downrange, and the sweep from the muzzle to that point covers those
 * 45 units immediately.
 *
 * Every close-range rocket in the game depends on it. A rocket aimed at your
 * feet leaves the muzzle 14 units below your eye and has 36 units of floor to
 * reach; without the prestep it would still be in the air at the end of the
 * tick and the splash would land one tick late — and a tick of delay between a
 * jump and its explosion costs about four units of height. With it, point-blank
 * rockets and rocket jumps detonate on the frame you fire them.
 */

import { PLAYER_MAXS, PLAYER_MINS } from './bbox.ts'
import type { CollisionWorld } from './collide.ts'
import { applyDamage, radiusDamage } from './damage.ts'
import type { TickHooks } from './kernel.ts'
import { addScaledVec3, copyVec3, normalizeVec3, vec3 } from './math.ts'
import type { MutVec3 } from './math.ts'
import type { SelfSplashPolicy } from './splash.ts'
import { EntityFlag, EntityKind, NO_ENTITY, removeEntity } from './state.ts'
import type { EntityState, GameState } from './state.ts'
import { TICK_INTERVAL_MS } from './tick.ts'
import { createTrace, rayBoxFraction, traceRay } from './trace.ts'
import { weaponDef } from './weapons.ts'

/**
 * How far in the past a rocket's trajectory clock starts, in ms. Quake 3's
 * `MISSILE_PRESTEP_TIME`, with the source comment "move a bit on the very first
 * frame".
 *
 * At 900 qu/s it is 45 units of head start. See the header for why removing it
 * would quietly break the rocket jump rather than merely delay it.
 */
export const MISSILE_PRESTEP_MS = 50

/**
 * Where `projectile` is at `tick`, written into `out`.
 *
 * The `* 0.001` is Quake's millisecond-to-second conversion written the way
 * Quake writes it. It is not the tidiest way to spell a division by 1000, and
 * it stays because both peers evaluate this same expression: what matters is
 * not that the answer is the closest double to the real number, but that it is
 * the *same* double on both machines, which identical operations in identical
 * order guarantee.
 */
export function projectilePosition(out: MutVec3, projectile: EntityState, tick: number): MutVec3 {
  const deltaMs = (tick - projectile.spawnTick) * TICK_INTERVAL_MS + MISSILE_PRESTEP_MS
  return addScaledVec3(out, projectile.trBase, projectile.velocity, deltaMs * 0.001)
}

/**
 * Advance every rocket by one sub-step, and detonate the ones that arrived
 * somewhere. Quake 3's `G_RunMissile`.
 *
 * A rocket spawned earlier in *this* tick is moved by this phase, not by the
 * next one — which is the prestep doing its job, and the reason a rocket jump
 * lands on the tick the button was pressed.
 */
export function moveProjectiles(
  state: GameState,
  world: CollisionWorld,
  hooks: TickHooks | null = null,
): void {
  const policy = hooks?.selfSplash ?? null

  // Backwards, because detonating removes entities from the array being walked.
  for (let i = state.entities.length - 1; i >= 0; i -= 1) {
    const rocket = state.entities[i]
    if (rocket === undefined) continue
    if (rocket.kind !== EntityKind.Projectile) continue

    // A projectile with no delta has no trajectory to evaluate and no sweep to
    // perform. Nothing the weapons layer fires is like that — a rocket leaves
    // the muzzle at 900 — so this is a guard against a hand-built entity, not
    // a case the game produces.
    if (rocket.velocity[0] === 0 && rocket.velocity[1] === 0 && rocket.velocity[2] === 0) continue

    projectilePosition(nextOrigin, rocket, state.tick)

    // The world first, then every player, taking whichever comes sooner. The
    // shooter is skipped: Quake passes the owner to the trace as the entity to
    // pass through, which is what stops a rocket detonating in the face of the
    // player who fired it. Their own splash still reaches them.
    traceRay(flightTrace, world, rocket.origin, nextOrigin)
    let fraction = flightTrace.fraction
    let hit: EntityState | null = null

    for (const target of state.entities) {
      if (target.kind !== EntityKind.Player) continue
      if (target.id === rocket.ownerId) continue
      if ((target.flags & EntityFlag.Dead) !== 0) continue

      const at = rayBoxFraction(rocket.origin, nextOrigin, target.origin, PLAYER_MINS, PLAYER_MAXS)
      if (at < fraction) {
        fraction = at
        hit = target
      }
    }

    // Where this sub-step actually got to. `traceRay` already stopped
    // `SURFACE_CLIP_EPSILON` short of a surface, so an explosion against a wall
    // happens an eighth of a unit clear of it rather than inside it — where the
    // occlusion test would find the wall between the blast and everything in
    // the room.
    if (fraction === 1 && hit === null) {
      copyVec3(flightEnd, nextOrigin)
    } else if (hit === null) {
      copyVec3(flightEnd, flightTrace.endpos)
    } else {
      flightEnd[0] = rocket.origin[0] + (nextOrigin[0] - rocket.origin[0]) * fraction
      flightEnd[1] = rocket.origin[1] + (nextOrigin[1] - rocket.origin[1]) * fraction
      flightEnd[2] = rocket.origin[2] + (nextOrigin[2] - rocket.origin[2]) * fraction
    }

    // A predicting peer folds this segment into its answer about whether it may
    // trust its own splash (`splash.ts`). Offered before the origin moves, so
    // the pair is the segment that was swept, and offered on every sub-step
    // including this rocket's first — which carries the 45-unit prestep, and is
    // the whole flight of a rocket jump.
    if (policy !== null) policy.observe(state, rocket, rocket.origin, flightEnd)

    copyVec3(rocket.origin, flightEnd)

    if (fraction === 1 && hit === null) {
      // The fuse. A rocket that runs out of time *explodes* where it is rather
      // than being quietly removed, which is Quake's `G_ExplodeMissile` and is
      // also the only version that cannot be used as a way to make a rocket
      // stop existing on one peer a tick before the other.
      if (rocket.expireTick >= 0 && rocket.expireTick <= state.tick) {
        impactProjectile(state, world, rocket, null, policy)
      }
      continue
    }

    impactProjectile(state, world, rocket, hit, policy)
  }
}

/**
 * A rocket has stopped. Deal the direct hit if there was one, then the splash,
 * then remove it.
 *
 * The two damages are separate on purpose and in this order. A direct hit is
 * pushed along the **rocket's own velocity** — Quake evaluates the trajectory
 * delta for it — so a rocket to the chest shoves you the way it was flying.
 * The splash that follows deliberately **skips whoever was hit directly**
 * (Quake's own comment says so), which is why a rocket in the chest is 100
 * points and not 200, and why the way to do 200 to somebody is to hit them
 * twice rather than to hit them well.
 */
function impactProjectile(
  state: GameState,
  world: CollisionWorld,
  rocket: EntityState,
  hit: EntityState | null,
  policy: SelfSplashPolicy | null = null,
): void {
  const def = weaponDef(rocket.weapon)

  if (hit !== null && def.damage > 0) {
    normalizeVec3(impactDir, rocket.velocity)
    applyDamage(state, hit, rocket.ownerId, impactDir, def.damage)
  }

  if (def.splashDamage > 0) {
    // The one question a predicting client is allowed to answer differently
    // from the host, and it is asked about the shooter alone: everyone else in
    // the blast is damaged exactly as they always were, because the uncertainty
    // is about a launch this peer may be wrong to have predicted, not about the
    // explosion.
    const deferredId =
      policy === null || policy.allow(state, rocket) ? NO_ENTITY : rocket.ownerId

    radiusDamage(
      state,
      world,
      rocket.origin,
      def.splashDamage,
      def.splashRadius,
      rocket.ownerId,
      hit === null ? NO_ENTITY : hit.id,
      state.match.rules.selfDamage,
      deferredId,
    )
  }

  removeEntity(state, rocket.id)
}

/**
 * Detonate a rocket where it is, with no direct hit. Quake 3's
 * `G_ExplodeMissile`, which is what a rocket's fifteen-second fuse runs.
 *
 * Exported for the tests and for whatever ends a round with rockets still in
 * the air (GLAD-L4SYN9).
 */
export function explodeProjectile(
  state: GameState,
  world: CollisionWorld,
  rocket: EntityState,
  policy: SelfSplashPolicy | null = null,
): void {
  impactProjectile(state, world, rocket, null, policy)
}

/**
 * Scratch. Module scope so a tick with rockets in the air allocates nothing,
 * under the same single-threaded, synchronous guarantee as the rest of the sim.
 */
const nextOrigin: MutVec3 = vec3()
const flightEnd: MutVec3 = vec3()
const impactDir: MutVec3 = vec3()
const flightTrace = createTrace()
