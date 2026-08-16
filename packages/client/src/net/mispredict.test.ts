/**
 * The self-splash mispredict counter, forced.
 *
 * Two halves. The first drives the ledger directly and walks every case it can
 * be in, because the interesting cases — the client predicted an explosion the
 * server did not apply, and the reverse — are conditions a working link never
 * produces and so cannot be waited for. The second drives a real
 * {@link createPredictor} against a real snapshot in which the host disagrees
 * about the local player's vitals, so the wiring between prediction,
 * reconciliation and the ledger is asserted end to end rather than assumed.
 */
import {
  BUTTON_ATTACK,
  MAX_PITCH_UNITS,
  NULL_CMD,
  SKELETON_SEED,
  countSimEvents,
  createMapState,
  findPlayer,
  snapshotFrame,
  tick as simTick,
  type GameState,
  type UserCmd,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { CLIENT_MAP } from '../map.ts'
import { SPLASH_ATTRIBUTION_TICKS, createMispredictLedger, vitalsOf } from './mispredict.ts'
import { createPredictor } from './prediction.ts'

const ROCKET_AT_MY_FEET: UserCmd = {
  ...NULL_CMD,
  pitch: MAX_PITCH_UNITS,
  buttons: BUTTON_ATTACK,
}

function world(): GameState {
  return createMapState(CLIENT_MAP.source, SKELETON_SEED)
}

describe('the ledger', () => {
  it('counts a splash the server did not agree happened', () => {
    const ledger = createMispredictLedger(0)

    ledger.splash({ tick: 10, slot: 0, points: 100, absorbed: 33 })
    ledger.predicted(10, { health: 100, armor: 67 })
    // The host ran the same tick and the player is untouched: we predicted an
    // explosion that did not happen.
    ledger.authoritative(10, { health: 100, armor: 100 })

    expect(ledger.stats.selfSplash).toBe(1)
    expect(ledger.stats.vitals).toBe(1)
    expect(ledger.stats.worstPoints).toBe(33)
    expect(ledger.stats.lastTick).toBe(10)
  })

  it('counts the other direction too — a splash we missed', () => {
    const ledger = createMispredictLedger(0)
    ledger.splash({ tick: 40, slot: 0, points: 100, absorbed: 33 })
    ledger.predicted(41, { health: 100, armor: 100 })
    ledger.authoritative(41, { health: 100, armor: 67 })
    expect(ledger.stats.selfSplash).toBe(1)
  })

  it('says nothing when the two agree', () => {
    const ledger = createMispredictLedger(0)
    ledger.splash({ tick: 10, slot: 0, points: 100, absorbed: 33 })
    ledger.predicted(10, { health: 100, armor: 67 })
    ledger.authoritative(10, { health: 100, armor: 67 })
    expect(ledger.stats.compared).toBe(1)
    expect(ledger.stats.vitals).toBe(0)
    expect(ledger.stats.selfSplash).toBe(0)
  })

  it('does not blame a splash for damage that arrived long afterwards', () => {
    const ledger = createMispredictLedger(0)
    ledger.splash({ tick: 10, slot: 0, points: 100, absorbed: 33 })
    const later = 10 + SPLASH_ATTRIBUTION_TICKS + 1
    ledger.predicted(later, { health: 100, armor: 100 })
    ledger.authoritative(later, { health: 60, armor: 100 })

    // Being shot at is not a mispredict: an opponent's rocket is not something
    // this client has any business predicting (`prediction.ts`).
    expect(ledger.stats.vitals).toBe(1)
    expect(ledger.stats.selfSplash).toBe(0)
  })

  it('ignores the other seat’s rockets', () => {
    const ledger = createMispredictLedger(0)
    ledger.splash({ tick: 10, slot: 1, points: 100, absorbed: 33 })
    ledger.predicted(10, { health: 100, armor: 67 })
    ledger.authoritative(10, { health: 100, armor: 100 })
    expect(ledger.stats.predictedSplashes).toBe(0)
    expect(ledger.stats.selfSplash).toBe(0)
  })

  it('counts one splash per tick however many times it is replayed', () => {
    const ledger = createMispredictLedger(0)
    // A reconciliation replays the unacknowledged commands, so the same
    // explosion is simulated again — sometimes several times a second.
    for (let i = 0; i < 5; i += 1) {
      ledger.splash({ tick: 10, slot: 0, points: 100, absorbed: 33 })
    }
    expect(ledger.stats.predictedSplashes).toBe(1)
  })

  it('compares nothing for a tick it never predicted', () => {
    const ledger = createMispredictLedger(0)
    ledger.authoritative(99, { health: 10, armor: 0 })
    expect(ledger.stats.compared).toBe(0)
  })
})

describe('the counter, through a real predictor', () => {
  it('moves when the host disagrees about a rocket at our own feet', () => {
    const client = world()
    const predictor = createPredictor({ state: client, world: CLIENT_MAP.world, slot: 0 })

    // The sim's own seam, which is how a splash is noticed at all.
    const counters = countSimEvents({
      onSelfSplash: (splash) => predictor.mispredicts.splash(splash),
    })

    try {
      // Fire straight down, then let the rocket detonate and the damage land.
      predictor.predict(ROCKET_AT_MY_FEET, 1)
      for (let i = 2; i <= 8; i += 1) predictor.predict(NULL_CMD, i)

      expect(predictor.mispredicts.stats.predictedSplashes).toBe(1)
      const hurt = vitalsOf(client, 0)
      expect(hurt).not.toBeNull()
      // Health, not armour: under the default self-damage mode your own splash
      // never reaches the armour (`sim/match/selfDamage.ts`).
      expect(hurt?.health).toBeLessThan(100)

      // The host's world at the same tick, with the player *not* hurt: the
      // rocket never happened as far as it is concerned. That is exactly the
      // shape of a self-splash mispredict.
      const host = world()
      for (let i = 0; i < client.tick; i += 1) simTick(host, [NULL_CMD], CLIENT_MAP.world)
      const hostPlayer = findPlayer(host, 0)
      if (hostPlayer === null) throw new Error('no player on the host')
      hostPlayer.health = 100
      hostPlayer.armor = 100

      predictor.accept(snapshotFrame(host, 8))

      expect(predictor.mispredicts.stats.selfSplash).toBe(1)
      expect(predictor.mispredicts.stats.worstPoints).toBeGreaterThan(0)
    } finally {
      counters.stop()
    }
  })

  it('stays at zero when the two ends agree, which is every ordinary tick', () => {
    const client = world()
    const predictor = createPredictor({ state: client, world: CLIENT_MAP.world, slot: 0 })
    const counters = countSimEvents({
      onSelfSplash: (splash) => predictor.mispredicts.splash(splash),
    })

    try {
      const host = world()
      for (let i = 1; i <= 30; i += 1) {
        const cmd: UserCmd = i === 3 ? ROCKET_AT_MY_FEET : { ...NULL_CMD, forwardMove: 1 }
        predictor.predict(cmd, i)
        simTick(host, [cmd], CLIENT_MAP.world)
        predictor.accept(snapshotFrame(host, i))
      }

      // The splash happened on both ends, at the same tick, for the same
      // damage — which is what a shared `tick()` is *for*.
      expect(predictor.mispredicts.stats.predictedSplashes).toBeGreaterThan(0)
      expect(predictor.mispredicts.stats.compared).toBeGreaterThan(0)
      expect(predictor.mispredicts.stats.selfSplash).toBe(0)
      expect(predictor.mispredicts.stats.vitals).toBe(0)
    } finally {
      counters.stop()
    }
  })
})
