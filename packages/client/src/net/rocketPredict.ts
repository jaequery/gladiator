/**
 * Which of your own rockets you are allowed to be thrown by before the host has
 * confirmed it.
 *
 * Quake 3 predicts nothing about self-knockback: you press the button, the
 * server decides, and the rocket jump launches you one round trip late. This
 * client can do better, because it runs the identical `tick()` and already knows
 * exactly what its own rocket is about to do — but only when the flight is
 * genuinely unobstructed. The argument for the predicate, and the geometry
 * behind it, are `sim/src/splash.ts`; this is the peer that answers it.
 *
 * ## The two places an opponent might be
 *
 * The predicate asks whether the rocket stayed clear of "the opponent", and a
 * client has two different honest answers to where that is:
 *
 * - the entity in the **predicted world**, which is the newest authoritative
 *   position carried forward — the closest thing this tab has to where the host
 *   has them *now*;
 * - the entity being **drawn**, `INTERP_DELAY_MS` in the past, which is where
 *   the player was actually aiming.
 *
 * Both are fed in, and either one coming close is enough to refuse. The band
 * between them *is* the uncertainty this predicate exists to guard, so treating
 * it as one region rather than picking a side is the only version that is
 * conservative for the right reason. `main.ts` supplies the union.
 *
 * ## The decision is taken once and then frozen
 *
 * Reconciliation replays a rocket's flight every time a snapshot lands, and the
 * opponent has moved in between, so the same rocket asked twice could get two
 * answers. That would make a launch appear and disappear over successive
 * frames, which is a worse artefact than the one this file prevents. So the
 * first time a rocket detonates the answer is recorded, and every replay after
 * that is handed the same one.
 *
 * ## What a mispredict is, and why it is a heuristic
 *
 * A snapshot carries the *result* of the host's splash, never its reasoning, so
 * there is nothing on the wire that says "your launch was refused". What there
 * is, is the correction that follows: a Loud or Snap band landing within the
 * knockback window of a launch this client predicted is that launch not having
 * happened. The attribution is not a proof — a hard snap in that window could be
 * something else entirely — and it is counted and logged **separately** from the
 * general correction counters precisely so that it can be read as the estimate
 * it is rather than folded into a number that means something else.
 */
import {
  EntityKind,
  PLAYER_MAXS,
  PLAYER_MINS,
  WEAPONS,
  distanceToBox,
  findPlayer,
  knockbackTicksFor,
  segmentClearsPlayer,
  weaponDef,
  type EntityState,
  type GameState,
  type SelfSplashPolicy,
  type Vec3,
} from '@gladiator/sim'

import { CorrectionBand, type Correction } from './reconcile.ts'

/**
 * How long after a predicted launch a large correction is blamed on it, in
 * sub-steps.
 *
 * The knockback window of a full splash — 200 ms, 25 sub-steps — derived from
 * the weapon table rather than written out. It is the interval during which a
 * predicted launch is still visibly driving the player, and therefore the
 * interval in which its absence is what a correction would be measuring.
 */
export const SELF_SPLASH_WINDOW_TICKS = knockbackTicksFor(WEAPONS[0].splashDamage)

/**
 * How many rockets' decisions are remembered.
 *
 * A duel fires one rocket every 800 ms per player and they live at most fifteen
 * seconds, so this is an order of magnitude more than can be in the air at once.
 * It is a bound rather than a target: what it guarantees is that a session that
 * runs for an hour costs what a session that runs for a minute does.
 */
export const DECISION_CAPACITY = 64

export type SelfSplashStats = {
  /** Rockets of ours whose flight this tracker has watched. */
  readonly tracked: number
  /** Detonations where the launch was predicted rather than waited for. */
  readonly predicted: number
  /** Detonations deferred to the host because the path was not provably clear. */
  readonly suppressed: number
  /**
   * Predicted launches the host appears not to have agreed with.
   *
   * Counted separately from every other correction statistic, and a heuristic —
   * see the header.
   */
  readonly mispredicted: number
}

export type RocketPredictor = SelfSplashPolicy & {
  readonly stats: SelfSplashStats
  /**
   * Offer a correction for attribution. Called once per reconciliation, from
   * wherever the correction is already being classified.
   */
  note(correction: Correction): void
  reset(): void
}

export type RocketPredictOptions = {
  /** The player slot this client steers. Only its rockets are tracked. */
  readonly slot: number
  /**
   * Everywhere an opponent might be, right now: the union described in the
   * header. Called once per rocket per sub-step of its flight, so it should be
   * a read of something already computed rather than a computation.
   */
  readonly opponents: () => readonly Vec3[]
  /** One line, already written for a human. `main.ts` passes `console.warn`. */
  readonly log?: (line: string) => void
  readonly capacity?: number
}

type Decision = {
  /** Whether every segment so far stayed clear. Sticky once false. */
  clear: boolean
  /** Whether {@link RocketPredictor.allow} has already answered for this one. */
  decided: boolean
}

export function createRocketPredictor(options: RocketPredictOptions): RocketPredictor {
  const capacity = options.capacity ?? DECISION_CAPACITY
  const log = options.log ?? (() => undefined)

  // Insertion-ordered, which is what makes the eviction below "the oldest" for
  // free. Keyed by entity id, which both peers agree about because it comes out
  // of the same `nextEntityId` in the same state.
  const decisions = new Map<number, Decision>()
  /** The ticks at which a launch was predicted, oldest first. */
  const launches: number[] = []

  const stats = { tracked: 0, predicted: 0, suppressed: 0, mispredicted: 0 }

  /** The local player, if this world has one. */
  const local = (state: GameState): EntityState | null => {
    const self = findPlayer(state, options.slot)
    return self === null || self.kind !== EntityKind.Player ? null : self
  }

  /** Is `rocket` one of ours? Anyone else's is not ours to be uncertain about. */
  const ours = (state: GameState, rocket: EntityState): boolean => {
    const self = local(state)
    return self !== null && rocket.ownerId === self.id
  }

  /**
   * Is this detonation close enough to owe its owner anything?
   *
   * A rocket that went off across the map is not a decision — there is no
   * launch to predict and none to defer, and counting one would put a phantom
   * entry in the window `note` blames corrections against. Measured the way
   * splash is measured, to the nearest point on the box (`damage.ts`).
   */
  const reachesOwner = (state: GameState, rocket: EntityState): boolean => {
    const self = local(state)
    if (self === null) return false
    const radius = weaponDef(rocket.weapon).splashRadius
    if (radius <= 0) return false
    return distanceToBox(rocket.origin, self.origin, PLAYER_MINS, PLAYER_MAXS) < radius
  }

  const remember = (id: number): Decision => {
    const held = decisions.get(id)
    if (held !== undefined) return held
    const fresh: Decision = { clear: true, decided: false }
    decisions.set(id, fresh)
    stats.tracked += 1
    while (decisions.size > capacity) {
      const oldest = decisions.keys().next()
      if (oldest.done === true) break
      decisions.delete(oldest.value)
    }
    return fresh
  }

  return {
    observe(state: GameState, rocket: EntityState, from: Vec3, to: Vec3) {
      if (!ours(state, rocket)) return
      const decision = remember(rocket.id)
      // Frozen after the answer has been given, and short-circuited once it is
      // false: the predicate only ever gets worse over a flight.
      if (decision.decided || !decision.clear) return

      for (const origin of options.opponents()) {
        if (segmentClearsPlayer(from, to, origin)) continue
        decision.clear = false
        return
      }
    },

    allow(state: GameState, rocket: EntityState): boolean {
      if (!ours(state, rocket)) return true
      // Nothing to predict and nothing to defer: this explosion does not reach
      // the person who fired it, so whether its flight was clear is moot.
      if (!reachesOwner(state, rocket)) return true

      const decision = remember(rocket.id)
      if (decision.decided) return decision.clear
      decision.decided = true

      if (!decision.clear) {
        stats.suppressed += 1
        log(
          `gladiator: rocket ${rocket.id} passed inside the self-splash clearance at tick ` +
            `${state.tick}; waiting for the server rather than predicting the launch`,
        )
        return false
      }

      stats.predicted += 1
      launches.push(state.tick)
      // Bounded by the attribution window rather than by a capacity, because
      // what it holds is "recent", and everything older can never be the answer
      // to the question `note` asks.
      while (launches.length > 0 && (launches[0] as number) < state.tick - SELF_SPLASH_WINDOW_TICKS) {
        launches.shift()
      }
      return true
    },

    note(correction: Correction) {
      if (correction.band !== CorrectionBand.Loud && correction.band !== CorrectionBand.Snap) {
        return
      }

      const at = correction.predictedTick
      const blamed = launches.some(
        (tick) => tick <= at && at - tick <= SELF_SPLASH_WINDOW_TICKS,
      )
      if (!blamed) return

      stats.mispredicted += 1
      log(
        `gladiator: self-splash mispredict — ${correction.distance.toFixed(0)} qu of ` +
          `${correction.band} correction at tick ${correction.tick}, within ` +
          `${SELF_SPLASH_WINDOW_TICKS} ticks of a predicted launch`,
      )
    },

    get stats(): SelfSplashStats {
      return { ...stats }
    },

    reset() {
      decisions.clear()
      launches.length = 0
    },
  }
}
