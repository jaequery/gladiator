/**
 * A scripted opponent, for looking at.
 *
 * Nothing sends snapshots yet — the server tick scheduler is GLAD-FHKBN8 and
 * entity interpolation is GLAD-6RT64L — so without this there is no way to see
 * the opponent model at all until two tickets that do not depend on this one
 * have landed. `?dummy=1` fills the gap: a second player who runs a circle,
 * jumps, fires, switches weapons, stands still and dies — every animation state
 * in one twenty-second loop, watchable in a real browser rather than only
 * asserted in a test.
 *
 * Three properties make it a stand-in for a snapshot rather than a special case
 * in the renderer:
 *
 *   - **It produces `EntityState`.** Exactly what a snapshot carries, so it
 *     goes through `playerNetState` and `interpolateNetState` like anything
 *     else. Nothing downstream knows it is not real.
 *   - **It is a pure function of the tick.** So the caller can evaluate it at
 *     the previous tick and the current one and interpolate between them,
 *     which is the same path a real snapshot pair takes.
 *   - **It never touches `GameState`.** It is not simulated, not hashed, and
 *     not sent anywhere, so the client and the server go on agreeing about the
 *     world exactly as they did before. That is the whole reason it is a
 *     separate function rather than an extra `spawnEntity`.
 */
import {
  EntityFlag,
  EntityKind,
  type EntityState,
  NEVER_EXPIRES,
  NEVER_FIRED,
  TICK_DT,
  type Vec3,
  Weapon,
  yawUnitsFromDegrees,
} from '@gladiator/sim'

/** Well clear of any id the simulation will hand out. */
export const DUMMY_ID = 9001

/** The slot it pretends to hold, so it is tinted as the second duellist. */
export const DUMMY_SLOT = 1

/** Radius of the circle it runs, in Quake units. */
const ORBIT_RADIUS = 224

/** How fast it runs it, in qu/s. Just under `RUN_SPEED`. */
const ORBIT_SPEED = 290

/** Sub-steps between shots. 150 = 1.2 s. */
const FIRE_PERIOD = 150

/** Sub-steps between weapon switches. 625 = 5 s. */
const SWITCH_PERIOD = 625

/** Sub-steps between jumps, and how long one lasts. */
const JUMP_PERIOD = 250
const JUMP_TICKS = 68

/**
 * The whole loop, and the two slices at the end of it: standing still, then
 * dead. 2500 sub-steps is 20 s.
 *
 * The standstill is not decoration — without it the loop never plays `idle`,
 * and `dummyOpponent.test.ts` asserts that one turn of the cycle reaches every
 * animation state, because reaching every state is the entire point of it.
 */
const CYCLE = 2500
const REST_AT = 2000
const DEATH_AT = 2250

/** Apex of the scripted hop, in Quake units. Roughly a real jump's 48. */
const JUMP_HEIGHT = 48

/** `?dummy=1` — draw the scripted opponent. */
export function dummyMode(search: string): boolean {
  return new URLSearchParams(search).get('dummy') !== null
}

/** Height above the floor at `airborneTicks` into a hop. A parabola. */
function hopHeight(airborneTicks: number): number {
  const t = airborneTicks / JUMP_TICKS
  return t <= 0 || t >= 1 ? 0 : 4 * JUMP_HEIGHT * t * (1 - t)
}

/**
 * The opponent at `tick`, orbiting `centre`.
 *
 * Faces the middle of its circle throughout, so the run reads as a *strafe* —
 * which is both what a duellist actually does and the case that catches a
 * mirrored direction, since a strafe drawn backwards is obvious and a forward
 * run drawn backwards is not.
 */
export function dummyOpponent(tick: number, centre: Vec3): EntityState {
  const phase = tick % CYCLE
  const dead = phase >= DEATH_AT
  const resting = !dead && phase >= REST_AT
  // Neither a standing player nor a corpse orbits, and the corpse has to lie
  // where the standstill left it rather than teleporting back onto the circle —
  // so both freeze the motion clock at the same moment.
  const motionTick = dead || resting ? tick - phase + REST_AT : tick
  const stopped = dead || resting

  const seconds = motionTick * TICK_DT
  const angle = (ORBIT_SPEED * seconds) / ORBIT_RADIUS
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)

  const airborneTicks = motionTick % JUMP_PERIOD
  const height = stopped ? 0 : hopHeight(airborneTicks)
  const airborne = height > 0

  const facing = Math.atan2(-sin, -cos) * (180 / Math.PI)
  const lastFire = Math.floor(motionTick / FIRE_PERIOD) * FIRE_PERIOD
  const weapon =
    Math.floor(motionTick / SWITCH_PERIOD) % 2 === 0 ? Weapon.RocketLauncher : Weapon.Railgun

  return {
    id: DUMMY_ID,
    kind: EntityKind.Player,
    slot: DUMMY_SLOT,
    flags: dead ? EntityFlag.Dead : airborne ? 0 : EntityFlag.OnGround,
    origin: [centre[0] + ORBIT_RADIUS * cos, centre[1] + ORBIT_RADIUS * sin, centre[2] + height],
    velocity: stopped ? [0, 0, 0] : [-ORBIT_SPEED * sin, ORBIT_SPEED * cos, airborne ? 100 : 0],
    // Pitch drifts a little so the head and torso are visibly driven by it.
    angles: [
      dead ? 0 : Math.round(Math.sin(seconds * 0.7) * 1400),
      yawUnitsFromDegrees(facing),
      0,
    ],
    health: dead ? 0 : 100,
    armor: dead ? 0 : 100,
    weapon,
    // No shooting while it stands there, so the standstill actually reads as
    // `idle` rather than as a firing pose held over a motionless body.
    lastFireTick: stopped || lastFire === 0 ? NEVER_FIRED : lastFire,
    knockbackTicks: 0,
    ownerId: 0,
    nextFireTick: 0,
    trBase: [0, 0, 0],
    spawnTick: 0,
    expireTick: NEVER_EXPIRES,
  }
}
