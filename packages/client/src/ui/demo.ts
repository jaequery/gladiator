/**
 * A scripted readout, for looking at.
 *
 * `?hud=demo`. Nothing calls `startMatch` yet — a `Room` holds one world in
 * warmup and leaves the round rules to whoever knows both players have arrived
 * (`server/src/room.ts`; GLAD-DVDV6P), and that is as true down a loopback
 * transport at `?local=1` as it is over a socket to Fly. So a page loaded today
 * sits on full health with nobody to shoot, and every interesting state this
 * HUD has is unreachable. Which is a problem, because one of this ticket's
 * acceptance checks is explicitly *"verified by a reviewer, not an
 * assertion"*: hit confirmation is a feel feature, and nobody can tell you
 * whether it reads in peripheral vision from a unit test.
 *
 * So this is `dummyOpponent.ts`'s trick for the HUD, and it earns its place the
 * same three ways:
 *
 *   - **It produces a {@link HudModel}.** Exactly what `hudModel()` projects out
 *     of a real world, so it goes through the same fold, the same crosshair and
 *     the same view. Nothing downstream knows it is not real.
 *   - **It is a pure function of the tick** (and the yaw you are holding), so
 *     the fold sees a coherent sequence of frames rather than a special case.
 *   - **It never touches `GameState`.** It is not simulated, not hashed and not
 *     sent anywhere; the client and the server go on agreeing about the world
 *     exactly as they did before.
 *
 * One turn of the loop reaches every state worth reviewing: both crosshairs,
 * both refire intervals, armour running out under a player who then goes
 * critical, four hits taken from four directions, three landed, a round won and
 * a match won. `demo.test.ts` asserts that, because a demo that quietly stopped
 * reaching one of them is a state nobody reviews.
 */
import {
  MatchPhase,
  NO_WINNER,
  SPAWN_ARMOR,
  SPAWN_HEALTH,
  TICK_INTERVAL_MS,
  TICK_RATE,
  Weapon,
  armorAbsorbed,
  knockbackSpeed,
  weaponDef,
} from '@gladiator/sim'

import { type HudModel, type HudPlayer, opponentSlot } from './hudModel.ts'

/** `?hud=demo` — drive the HUD from the script below instead of from the world. */
export function demoMode(search: string): boolean {
  return new URLSearchParams(search).get('hud') === 'demo'
}

/** Sub-steps in one round of the script. 1000 = 8 s. */
const ROUND_TICKS = 1000

/** Sub-steps of intermission between them. The real one, from the rules. */
const INTERMISSION_TICKS = 3 * TICK_RATE

/** How long the whole thing takes before it starts again: two rounds and a result. */
const OVER_TICKS = 3 * TICK_RATE

/** The whole loop, in sub-steps. Two rounds, two intermissions and a result. */
export const DEMO_CYCLE_TICKS = 2 * (ROUND_TICKS + INTERMISSION_TICKS) + OVER_TICKS

/** Rounds a demo match is played to, so the loop can reach "match won". */
const DEMO_ROUNDS_TO_WIN = 2

/**
 * How long a scripted shove lasts, in sub-steps. 12 = 96 ms.
 *
 * It has to be wider than one tick: the feedback fold compares consecutive
 * *frames*, and a frame at 60 Hz spans two sub-steps, so an impulse one tick
 * wide could fall between two samples and the arc would never point anywhere.
 * The real one comes from `knockbackTicksFor`, which is the same order.
 */
const SHOVE_TICKS = 12

type Shot = { readonly at: number; readonly weapon: Weapon }
type Blow = { readonly at: number; readonly points: number; readonly from: number }

/** When the demo player shoots, and with what. Both weapons, both intervals. */
const SHOTS: readonly Shot[] = [
  { at: 120, weapon: Weapon.RocketLauncher },
  { at: 300, weapon: Weapon.RocketLauncher },
  { at: 470, weapon: Weapon.Railgun },
  { at: 700, weapon: Weapon.Railgun },
  { at: 900, weapon: Weapon.RocketLauncher },
]

/** When a shot lands, and for how much. The last one ends the round. */
const LANDED: readonly Blow[] = [
  { at: 310, points: 40, from: 0 },
  { at: 480, points: 35, from: 0 },
  { at: 910, points: 100, from: 0 },
]

/**
 * When the demo player is hit, from which world bearing, and for how much.
 *
 * The four bearings are the four quadrants, so a reviewer sees the arc swing
 * right round the crosshair over one round. The damage adds up to armour gone
 * and health at 20 — the critical state — without killing them.
 */
const TAKEN: readonly Blow[] = [
  { at: 200, points: 40, from: 0 },
  { at: 520, points: 55, from: Math.PI / 2 },
  { at: 840, points: 60, from: Math.PI },
  { at: 930, points: 25, from: -Math.PI / 2 },
]

/** Health and armour after every blow up to `tick`, through the real armour rule. */
function poolsAt(tick: number): { readonly health: number; readonly armor: number } {
  let health = SPAWN_HEALTH
  let armor = SPAWN_ARMOR
  for (const blow of TAKEN) {
    if (blow.at > tick) break
    const saved = armorAbsorbed(blow.points, armor)
    armor -= saved
    health -= blow.points - saved
  }
  return { health, armor }
}

/** The opponent's health, likewise. Reaches zero on the last landed shot. */
function opponentHealthAt(tick: number): number {
  let health = SPAWN_HEALTH
  for (const blow of LANDED) {
    if (blow.at > tick) break
    health -= blow.points
  }
  return health < 0 ? 0 : health
}

/** The velocity a recent blow left behind, or nothing. See {@link SHOVE_TICKS}. */
function shoveAt(tick: number): readonly [number, number] {
  for (let i = TAKEN.length - 1; i >= 0; i -= 1) {
    const blow = TAKEN[i]
    if (blow === undefined) continue
    if (tick < blow.at || tick >= blow.at + SHOVE_TICKS) continue
    // A hit pushes you *away* from whatever caused it, which is the whole
    // signal `feedback.ts` recovers the direction from.
    const speed = knockbackSpeed(blow.points)
    return [speed * Math.cos(blow.from + Math.PI), speed * Math.sin(blow.from + Math.PI)]
  }
  return [0, 0]
}

/** The most recent shot at or before `tick`, or the first one as a resting pose. */
function shotAt(tick: number): { readonly shot: Shot; readonly fired: boolean } {
  let latest: Shot | undefined
  for (const shot of SHOTS) {
    if (shot.at <= tick) latest = shot
  }
  return latest === undefined
    ? { shot: SHOTS[0] ?? { at: 0, weapon: Weapon.RocketLauncher }, fired: false }
    : { shot: latest, fired: true }
}

function player(
  health: number,
  armor: number,
  weapon: Weapon,
  cooldownMs: number,
  cooldownFraction: number,
  velocity: readonly [number, number],
  yawUnits: number,
): HudPlayer {
  return {
    present: true,
    alive: health > 0,
    health,
    armor,
    healthFraction: Math.max(0, Math.min(1, health / SPAWN_HEALTH)),
    armorFraction: Math.max(0, Math.min(1, armor / SPAWN_ARMOR)),
    weapon,
    weaponName: weaponDef(weapon).name,
    cooldownMs,
    cooldownFraction,
    velocity: [velocity[0], velocity[1], 0],
    yawUnits,
  }
}

/**
 * Where the script is at `tick`: which round, and how far into its phase.
 *
 * Exported so `demo.test.ts` can walk the cycle by phase rather than by
 * rediscovering the arithmetic.
 */
export function demoPhaseAt(tick: number): {
  readonly phase: MatchPhase
  readonly round: number
  readonly into: number
  /** Rounds the viewer has won so far. They win both; the opponent wins none. */
  readonly won: number
} {
  const t = ((tick % DEMO_CYCLE_TICKS) + DEMO_CYCLE_TICKS) % DEMO_CYCLE_TICKS
  const leg = ROUND_TICKS + INTERMISSION_TICKS

  for (const round of [1, 2]) {
    const start = (round - 1) * leg
    if (t < start + ROUND_TICKS) {
      return { phase: MatchPhase.Live, round, into: t - start, won: round - 1 }
    }
    if (t < start + leg) {
      return { phase: MatchPhase.Intermission, round, into: t - start - ROUND_TICKS, won: round }
    }
  }
  return { phase: MatchPhase.Over, round: 2, into: t - 2 * leg, won: DEMO_ROUNDS_TO_WIN }
}

/**
 * The scripted readout at `tick`, seen by the player in `slot`, looking at
 * `yawUnits`.
 *
 * The yaw is the *live* one from the input controller rather than part of the
 * script, so a reviewer can turn on the spot and watch the damage arc stay
 * pinned to whatever hit them. That is the behaviour the indicator exists for
 * and it is the one thing a static mock could not show.
 */
export function demoModel(tick: number, slot: number, yawUnits: number): HudModel {
  const { phase, round, into, won } = demoPhaseAt(tick)
  const live = phase === MatchPhase.Live
  // Outside a round the bodies are frozen where the round left them, which is
  // what a real intermission looks like: nothing moves, the score is up.
  const at = live ? into : ROUND_TICKS

  const pools = poolsAt(at)
  const { shot, fired } = shotAt(at)
  const def = weaponDef(shot.weapon)
  const sinceShot = at - shot.at
  const remaining = fired ? Math.max(0, def.refireTicks - sinceShot) : 0

  const self = player(
    pools.health,
    pools.armor,
    shot.weapon,
    remaining * TICK_INTERVAL_MS,
    def.refireTicks > 0 ? remaining / def.refireTicks : 0,
    live ? shoveAt(at) : [0, 0],
    yawUnits,
  )

  const opponent = player(opponentHealthAt(at), 0, Weapon.Railgun, 0, 0, [0, 0], yawUnits)

  // `wins` is indexed by slot, so the viewer's tally goes in their own place
  // rather than always in the first one.
  const wins: [number, number] = [0, 0]
  wins[slot === 1 ? 1 : 0] = won
  wins[opponentSlot(slot) === 1 ? 1 : 0] = 0

  return {
    tick,
    slot,
    self,
    opponent,
    match: {
      phase,
      round,
      wins,
      roundsToWin: DEMO_ROUNDS_TO_WIN,
      remainingMs:
        phase === MatchPhase.Live
          ? (ROUND_TICKS - into) * TICK_INTERVAL_MS
          : phase === MatchPhase.Intermission
            ? (INTERMISSION_TICKS - into) * TICK_INTERVAL_MS
            : null,
      lastRoundWinner: won > 0 ? slot : NO_WINNER,
      winner: phase === MatchPhase.Over ? slot : NO_WINNER,
    },
  }
}
