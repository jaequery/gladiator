/**
 * The two weapons. `docs/physics-spec.md` §3.
 *
 * Which weapon an entity is *holding* is `weapon.ts` — an identity small
 * enough to cross the network, which is why it lives apart from this file
 * (GLAD-PWCON8 reads it to draw an opponent). This file is what the weapons
 * **do**.
 *
 * A rocket launcher and a railgun, both with unlimited ammo, and **nothing
 * else, ever**. That is not a scope note that will age out — it is the design.
 * Rocket Arena removed the item scramble so that a duel is decided by movement
 * and aim, and a third weapon would be a third thing to balance for no skill
 * anyone learns. {@link WEAPONS} is typed as a two-element tuple so that
 * "exactly two" is a fact the typechecker enforces rather than a comment.
 *
 * ## There is no ammo
 *
 * Not "a large number of rounds" — no ammunition state at all. `GameState`
 * carries none, `EntityState` carries none, and nothing anywhere decrements.
 * The only thing that gates a shot is {@link EntityState.nextFireTick}, so a
 * match cannot end because somebody ran out, and the fairness question the bot
 * raises later ("does it have more shots than I do?") has no room to exist.
 *
 * ## The two of them, side by side
 *
 * |              | Rocket launcher | Railgun |
 * | ------------ | --------------- | ------- |
 * | delivery     | 900 qu/s projectile | hitscan, 8192 qu |
 * | direct       | 100             | 100     |
 * | splash       | 100 over 120 qu | none    |
 * | refire       | 800 ms          | 1500 ms |
 * | knockback    | 5 x damage, splash-biased upward | 500 qu/s along the shot |
 *
 * The railgun having knockback at all is the entry most often got wrong. It is
 * in `Weapon_Railgun_Fire`: the shot is passed `forward` as its damage
 * direction, so a rail hit shoves the target 500 qu/s along the line it was
 * fired down, and arms the same 200 ms knockback timer a rocket does.
 */

import type { Vec3 } from './axis.ts'
import { PLAYER_MAXS, PLAYER_MINS, PLAYER_VIEW_HEIGHT } from './bbox.ts'
import type { CollisionWorld } from './collide.ts'
import { applyDamage, knockbackSpeed } from './damage.ts'
import type { TickInputs } from './kernel.ts'
import { addScaledVec3, angleVectors, snapVector, vec3 } from './math.ts'
import type { MutVec3 } from './math.ts'
import { EntityFlag, EntityKind, NO_SLOT, spawnEntity } from './state.ts'
import type { EntityState, GameState } from './state.ts'
import { TICK_INTERVAL_MS } from './tick.ts'
import { createTrace, rayBoxFraction, traceRay } from './trace.ts'
import { BUTTON_ATTACK, NULL_CMD } from './usercmd.ts'
import { Weapon, isWeapon } from './weapon.ts'

/* --------------------------------------------------------------------------
 * The table
 * ----------------------------------------------------------------------- */

/**
 * `ammo` for a weapon that never runs out.
 *
 * A sentinel rather than a large number, so that "unlimited" is a thing the
 * code says rather than a thing a reader infers from 999.
 */
export const AMMO_UNLIMITED = -1

export type WeaponDef = {
  readonly id: Weapon
  /** For diagnostics and the HUD. Never parsed. */
  readonly name: string
  /** Damage a direct hit does, in points. */
  readonly damage: number
  /** Damage at the centre of the explosion, in points. Zero for hitscan. */
  readonly splashDamage: number
  /** How far the explosion reaches, in Quake units. Zero for hitscan. */
  readonly splashRadius: number
  /** Time between shots, in milliseconds. The number Quake states. */
  readonly refireMs: number
  /** The same interval in whole sub-steps, which is what the sim counts. */
  readonly refireTicks: number
  /** Muzzle velocity in qu/s, or zero if the shot is instantaneous. */
  readonly speed: number
  /** How far a hitscan shot carries, in Quake units. Zero for a projectile. */
  readonly range: number
  /** How long a projectile lives before it detonates itself, in ms. */
  readonly lifetimeMs: number
  /** The same fuse in whole sub-steps, which is what the sim counts. */
  readonly lifetimeTicks: number
  /** Always {@link AMMO_UNLIMITED}. There is no other kind here. */
  readonly ammo: number
}

/**
 * A duration in milliseconds as whole sub-steps, rounded **up**.
 *
 * Up rather than to nearest, because for a refire interval the two roundings
 * are not equally harmless: rounding down would let a weapon fire fractionally
 * faster than its stated rate, which is free damage per second, while rounding
 * up costs at most one 8 ms sub-step of delay that nobody can perceive. The
 * rocket launcher's 800 ms is exactly 100 ticks either way; the railgun's
 * 1500 ms is 187.5, and this is why it becomes 188 and not 187.
 */
export function refireTicksOf(refireMs: number): number {
  return Math.ceil(refireMs / TICK_INTERVAL_MS)
}

/** How fast a rocket flies, in qu/s. Quake 3's `fire_rocket`. */
export const ROCKET_SPEED = 900

/**
 * How long a rocket lives if it never hits anything, in ms. Quake 3's
 * `bolt->nextthink = level.time + 15000`.
 *
 * Fifteen seconds is 13,500 units of travel, which is longer than any sight
 * line this game will ever have — it is a leak stopper, not a mechanic. It
 * exists because a rocket that escaped through a seam in the geometry would
 * otherwise be an entity in the state hash forever.
 */
export const ROCKET_LIFETIME_MS = 15000

/**
 * How far a railgun shot carries, in Quake units. Quake 3's `8192`.
 *
 * Eight times the width of the arena, so on this map it means "until it hits
 * something" — which is the point. It is transcribed rather than trimmed to the
 * map, because a range that depends on the map is a rule that changes when
 * somebody builds a bigger one.
 */
export const RAILGUN_RANGE = 8192

/**
 * The weapon table. Exactly two entries, and the tuple type is the enforcement.
 *
 * Not indexed by {@link Weapon} — `Weapon.None` is a real value there (a
 * corpse, a projectile, a spectator) and has no entry here, so the lookup goes
 * through {@link weaponDef} rather than through a subscript that would be
 * wrong for exactly one of the three.
 */
export const WEAPONS: readonly [WeaponDef, WeaponDef] = [
  {
    id: Weapon.RocketLauncher,
    name: 'rocket launcher',
    damage: 100,
    splashDamage: 100,
    splashRadius: 120,
    refireMs: 800,
    refireTicks: refireTicksOf(800),
    speed: ROCKET_SPEED,
    range: 0,
    lifetimeMs: ROCKET_LIFETIME_MS,
    lifetimeTicks: refireTicksOf(ROCKET_LIFETIME_MS),
    ammo: AMMO_UNLIMITED,
  },
  {
    id: Weapon.Railgun,
    name: 'railgun',
    damage: 100,
    splashDamage: 0,
    splashRadius: 0,
    refireMs: 1500,
    refireTicks: refireTicksOf(1500),
    speed: 0,
    range: RAILGUN_RANGE,
    lifetimeMs: 0,
    lifetimeTicks: 0,
    ammo: AMMO_UNLIMITED,
  },
]

/**
 * What a weapon id does. `Weapon.None` and anything unrecognised fall back to
 * the rocket launcher, which is what a player spawns holding.
 */
export function weaponDef(weapon: number): WeaponDef {
  return weapon === Weapon.Railgun ? WEAPONS[1] : WEAPONS[0]
}

/* --------------------------------------------------------------------------
 * The muzzle
 * ----------------------------------------------------------------------- */

/**
 * How far in front of the eye a shot leaves, in Quake units. Quake 3's `14`.
 *
 * Small, and load-bearing for the rocket jump. Aimed at your feet it puts the
 * muzzle 14 units *below* the eye, which is what lets the rocket's 45-unit
 * first-frame step (`projectile.ts`) reach the floor and detonate on the tick
 * you pressed the button. Move the muzzle back to the eye and a rocket jump
 * costs a tick, and a tick costs four units of height.
 */
export const MUZZLE_FORWARD = 14

/**
 * Where a shot leaves a player, written into `out`.
 *
 * Eye height up, 14 units along the aim, and then snapped to whole units — all
 * three are Quake's `CalcMuzzlePoint`. The snap is Quake saving network
 * bandwidth and is kept for the reason every other snap in this repo is kept:
 * the numbers downstream were measured through it.
 */
export function muzzlePoint(out: MutVec3, entity: EntityState, forward: Vec3): MutVec3 {
  out[0] = entity.origin[0] + forward[0] * MUZZLE_FORWARD
  out[1] = entity.origin[1] + forward[1] * MUZZLE_FORWARD
  out[2] = entity.origin[2] + PLAYER_VIEW_HEIGHT + forward[2] * MUZZLE_FORWARD
  snapVector(out)
  return out
}

/* --------------------------------------------------------------------------
 * The fire phase
 * ----------------------------------------------------------------------- */

/**
 * Fire every player who asked to and is allowed to. One tick's worth.
 *
 * Runs **after** the movement phase, which is Quake's order (`PM_Weapon` sets
 * the fire event inside `Pmove`, and `ClientEvents` acts on it immediately
 * afterwards) and is not interchangeable with the other one. A shot leaves the
 * muzzle the player has *this* tick, and — much more importantly — the splash
 * from your own rocket lands on a velocity the jump has already been written
 * into. Fire first and `PM_CheckJump`, which *assigns* `velocity[2]`, would
 * throw the explosion away and there would be no such thing as a rocket jump.
 */
export function fireWeapons(state: GameState, inputs: TickInputs, world: CollisionWorld): void {
  // Indexed, because firing appends rockets to the same array.
  const count = state.entities.length

  for (let i = 0; i < count; i += 1) {
    const entity = state.entities[i]
    if (entity === undefined) continue
    if (entity.kind !== EntityKind.Player) continue
    if ((entity.flags & EntityFlag.Dead) !== 0) continue

    const cmd = (entity.slot < 0 ? null : inputs[entity.slot]) ?? NULL_CMD

    // The held weapon follows the command every tick, and this is the only
    // place `EntityState.weapon` is written for a player — the renderer reads
    // it from there for both players (GLAD-PWCON8). There is no switch
    // animation and no raise delay: with two weapons and one shared refire
    // timer, a switch already costs whatever is left of the last shot's
    // interval, which is the only cost that changes what a player can do.
    entity.weapon = isWeapon(cmd.weapon) && cmd.weapon !== Weapon.None
      ? cmd.weapon
      : Weapon.RocketLauncher

    if ((cmd.buttons & BUTTON_ATTACK) === 0) continue
    if (state.tick < entity.nextFireTick) continue

    fireWeapon(state, world, entity, entity.weapon)
  }
}

/**
 * One shot, from `shooter`, now. Sets the refire timer.
 *
 * Exported because the bot's aim tests and the netcode's replay both want to
 * fire a shot without assembling a `UserCmd` and a tick around it.
 */
export function fireWeapon(
  state: GameState,
  world: CollisionWorld,
  shooter: EntityState,
  weapon: number,
): void {
  const def = weaponDef(weapon)

  // Both halves of the same event: `lastFireTick` looks back, for the muzzle
  // flash and the recoil the renderer derives from it (`weapon.ts`), and
  // `nextFireTick` looks forward, for the refire gate above.
  shooter.lastFireTick = state.tick
  shooter.nextFireTick = state.tick + def.refireTicks

  angleVectors(shooter.angles[0], shooter.angles[1], 0, aimForward, null, null)
  muzzlePoint(muzzle, shooter, aimForward)

  if (def.speed > 0) spawnProjectile(state, shooter, def, muzzle, aimForward)
  else fireRailgun(state, world, shooter, def, muzzle, aimForward)
}

/* --------------------------------------------------------------------------
 * Leaving the muzzle
 * ----------------------------------------------------------------------- */

/**
 * Put a rocket in the world, travelling `dir` at the weapon's speed.
 *
 * Two details are Quake's and both are about two machines agreeing:
 *
 * - **The delta is snapped to whole units.** `fire_rocket` does it "to save net
 *   bandwidth", and the side effect is the useful part here: a rocket's
 *   velocity is an integer vector, so the trajectory the client evaluates and
 *   the trajectory the server evaluates are computed from bit-identical inputs
 *   even if the two disagree in the last place about the aim that produced it.
 *   It also means a rocket does not travel at exactly 900 — a diagonal shot
 *   leaves at 899.4 — and that is Quake, not a rounding bug.
 * - **`trBase` is the muzzle and the clock is `spawnTick`.** Nothing about the
 *   flight is integrated tick by tick; `projectile.ts` evaluates a closed form
 *   from these two, which is what lets the wire tell a peer about a rocket
 *   exactly once.
 */
export function spawnProjectile(
  state: GameState,
  shooter: EntityState,
  def: WeaponDef,
  from: Vec3,
  dir: Vec3,
): EntityState {
  const delta = vec3(dir[0] * def.speed, dir[1] * def.speed, dir[2] * def.speed)
  snapVector(delta)

  return spawnEntity(state, {
    kind: EntityKind.Projectile,
    slot: NO_SLOT,
    origin: vec3(from[0], from[1], from[2]),
    velocity: delta,
    angles: vec3(shooter.angles[0], shooter.angles[1], 0),
    ownerId: shooter.id,
    weapon: def.id,
    trBase: vec3(from[0], from[1], from[2]),
    expireTick: state.tick + def.lifetimeTicks,
  })
}

/* --------------------------------------------------------------------------
 * The railgun
 * ----------------------------------------------------------------------- */

/**
 * A hitscan shot from the muzzle along the aim. Quake 3's
 * `Weapon_Railgun_Fire`.
 *
 * The damage direction is the **aim**, not the vector to the target, and that
 * is what makes rail knockback predictable: wherever on the box you hit
 * somebody, they go the way you were pointing, at 500 qu/s.
 *
 * Quake lets one shot pass through up to four players. This does not, because a
 * duel has one other player in it and a rule that can never fire is a rule that
 * is never right either.
 */
function fireRailgun(
  state: GameState,
  world: CollisionWorld,
  shooter: EntityState,
  def: WeaponDef,
  from: Vec3,
  dir: Vec3,
): void {
  addScaledVec3(shotEnd, from, dir, def.range)

  // The world first: geometry between the shooter and a target ends the shot,
  // and it also shortens the segment every player is then tested against.
  traceRay(shotTrace, world, from, shotEnd)
  let nearest = shotTrace.fraction
  let hit: EntityState | null = null

  for (const target of state.entities) {
    if (target.kind !== EntityKind.Player) continue
    if (target.id === shooter.id) continue
    if ((target.flags & EntityFlag.Dead) !== 0) continue

    const fraction = rayBoxFraction(from, shotEnd, target.origin, PLAYER_MINS, PLAYER_MAXS)
    if (fraction < nearest) {
      nearest = fraction
      hit = target
    }
  }

  if (hit !== null) applyDamage(hit, shooter.id, dir, def.damage)
}

/**
 * The launch a rocket under your own feet gives you, in qu/s. **500**.
 *
 * Derived, not typed: full splash damage through the knockback formula. It is
 * the number every rocket-jump height in `map/reachability.ts` is built from,
 * and deriving it here means the day the splash damage changes is the day every
 * ledge in `maps/` is re-checked by a failing test rather than by somebody
 * remembering to.
 */
export const ROCKET_JUMP_LAUNCH = knockbackSpeed(WEAPONS[0].splashDamage)

/**
 * Scratch. Module scope so a tick allocates nothing outside the rocket it
 * spawns, and safe for the same reason the rest of the sim's scratch is: this
 * package is single-threaded and synchronous, with `await` a lint error.
 */
const aimForward: MutVec3 = vec3()
const muzzle: MutVec3 = vec3()
const shotEnd: MutVec3 = vec3()
const shotTrace = createTrace()
