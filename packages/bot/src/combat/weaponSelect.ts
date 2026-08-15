/**
 * Which of the two. GLAD-HK3ATM.
 *
 * There is no third weapon and there never will be (`weapons.ts`), and there is
 * no ammunition, so the choice is not about resources — it is about which
 * delivery mechanism suits the target. Three rules, in the order they are asked:
 *
 * 1. **A target the bot cannot see gets a rocket.** A railgun is a line drawn
 *    instantly to a point, and pointing one at a remembered position is firing
 *    at a guess with the weapon least able to survive being wrong. A rocket's
 *    splash is 120 units of forgiveness, which is exactly what a guess needs.
 * 2. **An airborne target gets a rail.** This is the one the prior art gets
 *    right, and it is right for a mechanical reason rather than a stylistic one:
 *    a player in the air has no lateral control worth the name — air
 *    acceleration is a tenth of the ground figure (`pmove/accelerate.ts`) — so
 *    where they will be half a second from now is a parabola rather than a
 *    decision. Somebody who cannot dodge is somebody to hitscan.
 * 3. **A distant target gets a rail.** At {@link RAIL_MIN_RANGE} a rocket is a
 *    second in the air, which is long enough for a duellist to be somewhere else
 *    entirely; a rail is there before the sound of it is.
 *
 * Everything else is a rocket, which is most of a duel.
 *
 * ## Switching is free, and that is why this can be re-asked every decision
 *
 * Both weapons share one refire timer and there is no raise animation
 * (`weapons.ts`), so changing your mind costs nothing but whatever is left of
 * the last shot's interval. The weapon rides on every `UserCmd` rather than
 * being a switch event, so the bot asks the question again at 20 Hz and the
 * answer simply becomes true.
 *
 * ## Wanting a rail is not taking one
 *
 * This file says which weapon is in the bot's hands. Whether the trigger is
 * pulled is `combat/railDiscipline.ts`, and it will refuse a rail the aim has
 * not settled on — so "rail a strafing target across the arena" and "rail a
 * strafing target at close range" resolve to the same choice here and to
 * different behaviour there, which is the split that keeps both files short.
 */

import { POINT_MAXS, POINT_MINS, Weapon, createTrace, traceBox, vec3 } from '@gladiator/sim'
import type { CollisionWorld, MutVec3, TraceResult, Vec3 } from '@gladiator/sim'

import { NAV_MAX_STEP } from '../nav/schema.ts'
import type { WorldModel } from '../perception/worldModel.ts'

/**
 * The range past which a rocket is too slow to be the right answer, in units.
 *
 * Nine hundred is exactly one second of rocket flight (`ROCKET_SPEED`), which is
 * why it is that number: a second is far longer than the reaction the bot itself
 * is held to, so a target that has heard the launch has time to be somewhere the
 * splash cannot reach. `maps/arena1.ts` is about 2000 units across, so this is a
 * threshold that separates "across the arena" from "in this fight".
 */
export const RAIL_MIN_RANGE = 900

/**
 * How far below the believed feet the bot looks for a floor before calling
 * somebody airborne, in units.
 *
 * One step (`nav/schema.ts`), imported rather than restated: a body within a
 * step of the floor is one the movement can put back on it this sub-step, and is
 * not somebody committed to a parabola.
 */
export const AIRBORNE_DROP = NAV_MAX_STEP

/* Scratch. Single-threaded and synchronous; see `perception/sight.ts`. */
const probeFrom: MutVec3 = vec3()
const probeTo: MutVec3 = vec3()
const probe: TraceResult = createTrace()

/**
 * Is there nothing under the body at `origin`?
 *
 * A **point** trace, for the reason `movement/ledge.ts` gives: the player box
 * bridges a narrow slot and reports floor over a hole it is merely straddling.
 * `startsolid` is a probe that began inside geometry, which is a body standing
 * in a riser rather than one in the air.
 */
export function airborneAt(world: CollisionWorld, origin: Vec3): boolean {
  probeFrom[0] = origin[0]
  probeFrom[1] = origin[1]
  probeFrom[2] = origin[2] + 1
  probeTo[0] = origin[0]
  probeTo[1] = origin[1]
  probeTo[2] = origin[2] - AIRBORNE_DROP

  traceBox(probe, world, probeFrom, probeTo, POINT_MINS, POINT_MAXS)
  return !probe.startsolid && probe.fraction === 1
}

/**
 * The weapon to hold this decision.
 *
 * `world` may be `null` — a bot handed no level data cannot tell whether
 * somebody is standing on anything, and answers the question it can, which is
 * the range one.
 */
export function selectWeapon(model: WorldModel, world: CollisionWorld | null): Weapon {
  const contact = model.enemy
  if (contact.source === 'none' || !contact.visible) return Weapon.RocketLauncher

  if (world !== null && airborneAt(world, contact.origin)) return Weapon.Railgun

  const dx = contact.origin[0] - model.self.origin[0]
  const dy = contact.origin[1] - model.self.origin[1]
  const dz = contact.origin[2] - model.self.origin[2]
  if (dx * dx + dy * dy + dz * dz > RAIL_MIN_RANGE * RAIL_MIN_RANGE) return Weapon.Railgun

  return Weapon.RocketLauncher
}
