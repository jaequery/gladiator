/**
 * Which weapon an entity is holding, and when it last fired.
 *
 * Gladiator ships two weapons and no pickups, so "which one is in your hands"
 * is a single small integer that never has to be reconciled against an
 * inventory. What the weapons *do* — damage, splash, fire rate, the rail's
 * instant trace — is GLAD-0QWRYK's; this file is only their identity, because
 * identity is what crosses the network.
 *
 * ## Why the renderer needs this and why it lives here
 *
 * In a duel you read the opponent's weapon off their silhouette and change what
 * you do about it: you strafe differently against a rail than against a rocket.
 * That makes the weapon part of the *netstate*, not part of the shooting code —
 * the client has to know it for an opponent it does not control, one snapshot
 * after the server changed it. So it is a field on `EntityState` (`state.ts`),
 * encoded and hashed with everything else, and the renderer reads it and
 * nothing else (GLAD-PWCON8).
 *
 * ## `lastFireTick` is state, not an event
 *
 * "This player fired" could have been a message. It is a tick number instead,
 * for the same reason `Snapshot` carries state rather than events: a client
 * that misses one snapshot and receives the next has lost a frame of
 * interpolation and nothing else. A fire *event* dropped in transit is a muzzle
 * flash that never happens; a fire *tick* is still there in the next snapshot,
 * and the animation works out for itself whether the flash is still on screen.
 */

/** The arsenal. Numeric so it encodes in one byte. */
export const Weapon = {
  /** Holding nothing — a spectator, a corpse, a projectile. */
  None: 0,
  RocketLauncher: 1,
  Railgun: 2,
} as const

export type Weapon = (typeof Weapon)[keyof typeof Weapon]

/** `lastFireTick` for an entity that has not fired since it spawned. */
export const NEVER_FIRED = -1

/** Whether `value` is one of the weapons. The door for anything off the wire. */
export function isWeapon(value: number): value is Weapon {
  return value === Weapon.None || value === Weapon.RocketLauncher || value === Weapon.Railgun
}
