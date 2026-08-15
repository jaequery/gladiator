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
 * ## What this counts, and what counts the other half
 *
 * Two numbers, and they answer opposite questions. This file owns the one only
 * it can know: how often the predicate **deferred** a launch, which is the
 * mechanism working as designed. Whether a launch this client *did* predict was
 * one the host agreed with is `net/mispredict.ts`, which answers it exactly —
 * by comparing the vitals it predicted for a tick against the vitals the
 * snapshot for that tick carries — rather than by blaming a correction band that
 * landed nearby. That is the sharper instrument and there is deliberately only
 * one of it: two counters both called "self-splash mispredicts", one exact and
 * one a guess, is the drift `AGENTS.md` is written to prevent.
 *
 * The two are read side by side, in `hud.ts` and in the dev readout: deferrals
 * going up is the predicate protecting the player, and mispredicts going up is
 * the predicate not being conservative enough.
 */
import {
  EntityKind,
  PLAYER_MAXS,
  PLAYER_MINS,
  distanceToBox,
  findPlayer,
  segmentClearsPlayer,
  weaponDef,
  type EntityState,
  type GameState,
  type SelfSplashPolicy,
  type Vec3,
} from '@gladiator/sim'

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
  /**
   * Detonations deferred to the host because the path was not provably clear.
   *
   * The mechanism working. Whether a *predicted* launch turned out to be wrong
   * is `net/mispredict.ts`'s number — see the header.
   */
  readonly suppressed: number
}

export type RocketPredictor = SelfSplashPolicy & {
  readonly stats: SelfSplashStats
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

  const stats = { tracked: 0, predicted: 0, suppressed: 0 }

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
   * launch to predict and none to defer, and counting one would make a player
   * who shoots at walls look like one whose predicate keeps firing. Measured
   * the way splash is measured, to the nearest point on the box (`damage.ts`).
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

      // Predicted, and from here on it is `net/mispredict.ts`'s business
      // whether the host agreed: the splash this is about to let through calls
      // `applyDamage` on the owner, which fires `onSelfSplash`, which is what
      // that ledger counts against the next snapshot's vitals.
      stats.predicted += 1
      return true
    },

    get stats(): SelfSplashStats {
      return { ...stats }
    },

    reset() {
      decisions.clear()
    },
  }
}
