/**
 * Which of your own rockets you are allowed to be thrown by, and what it costs
 * when the answer is "not this one".
 *
 * Three claims live here, and the third is the one the ticket is really about:
 * the predicate refuses a rocket that flew near somebody; a refused rocket
 * leaves the player exactly where an unfired one would have; and the knockback
 * window that eventually arrives is measured in *ticks from the detonation the
 * snapshot describes*, never from when the packet happened to land.
 */
import {
  BUTTON_ATTACK,
  EntityKind,
  MAX_PITCH_UNITS,
  NULL_CMD,
  SKELETON_SEED,
  WEAPONS,
  Weapon,
  createMapState,
  findPlayer,
  knockbackTicksFor,
  projectilePosition,
  snapshotFrame,
  spawnEntity,
  tick as simTick,
  vec3,
  type EntityState,
  type GameState,
  type UserCmd,
  type Vec3,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { CLIENT_MAP } from '../map.ts'
import { createPredictor } from './prediction.ts'
import { CorrectionBand, type Correction } from './reconcile.ts'
import {
  SELF_SPLASH_WINDOW_TICKS,
  createRocketPredictor,
  type RocketPredictor,
} from './rocketPredict.ts'

const LOCAL_SLOT = 0
const OPPONENT_SLOT = 1

/** Firing straight down at your own feet: the rocket jump. */
const ROCKET_AT_FEET: UserCmd = {
  ...NULL_CMD,
  pitch: MAX_PITCH_UNITS,
  buttons: BUTTON_ATTACK,
  weapon: Weapon.RocketLauncher,
}

const IDLE: UserCmd = { ...NULL_CMD, weapon: Weapon.RocketLauncher }

function world(): GameState {
  return createMapState(CLIENT_MAP.source, SKELETON_SEED)
}

function self(state: GameState): EntityState {
  const player = findPlayer(state, LOCAL_SLOT)
  if (player === null) throw new Error('no local player in this world')
  return player
}

/** Stand an opponent `offset` units to the side of the local player. */
function opponentBeside(state: GameState, offset: number): EntityState {
  const player = self(state)
  return spawnEntity(state, {
    kind: EntityKind.Player,
    slot: OPPONENT_SLOT,
    origin: vec3(player.origin[0], player.origin[1] + offset, player.origin[2]),
    health: 100,
    armor: 100,
    weapon: Weapon.RocketLauncher,
  })
}

/** Every opponent's origin, as the frame loop supplies it. */
function opponentsOf(state: GameState): () => readonly Vec3[] {
  return () =>
    state.entities
      .filter((entity) => entity.kind === EntityKind.Player && entity.slot !== LOCAL_SLOT)
      .map((entity): Vec3 => [entity.origin[0], entity.origin[1], entity.origin[2]])
}

function trackerOver(state: GameState, log?: (line: string) => void): RocketPredictor {
  return createRocketPredictor({
    slot: LOCAL_SLOT,
    opponents: opponentsOf(state),
    ...(log === undefined ? {} : { log }),
  })
}

describe('the predicate, through a real rocket jump', () => {
  it('predicts the launch when nobody is anywhere near', () => {
    const state = world()
    const tracker = trackerOver(state)
    const predictor = createPredictor({
      state,
      world: CLIENT_MAP.world,
      slot: LOCAL_SLOT,
      hooks: { selfSplash: tracker },
    })

    predictor.predict(ROCKET_AT_FEET)

    expect(tracker.stats.predicted).toBe(1)
    expect(tracker.stats.suppressed).toBe(0)
    expect(self(state).velocity[2]).toBeGreaterThan(400)
  })

  it('refuses it when an opponent stands inside the clearance', () => {
    // Twenty units to the side is well inside the 32-unit clearance, so the
    // host may have detonated this rocket somewhere the client did not — which
    // is precisely the case where predicting a 500 qu/s launch would be
    // inventing one.
    const state = world()
    const tracker = trackerOver(state)
    const predictor = createPredictor({
      state,
      world: CLIENT_MAP.world,
      slot: LOCAL_SLOT,
      hooks: { selfSplash: tracker },
    })
    opponentBeside(state, 20)

    predictor.predict(ROCKET_AT_FEET)

    expect(tracker.stats.suppressed).toBe(1)
    expect(tracker.stats.predicted).toBe(0)
    expect(self(state).velocity[2]).toBeLessThan(1)
  })

  it('leaves the player exactly where a rocket nobody fired would have', () => {
    const suppressed = world()
    const tracker = trackerOver(suppressed)
    const predictor = createPredictor({
      state: suppressed,
      world: CLIENT_MAP.world,
      slot: LOCAL_SLOT,
      hooks: { selfSplash: tracker },
    })
    opponentBeside(suppressed, 20)
    predictor.predict(ROCKET_AT_FEET)

    const unfired = world()
    opponentBeside(unfired, 20)
    simTick(unfired, [IDLE], CLIENT_MAP.world)

    expect(self(suppressed).velocity).toEqual(self(unfired).velocity)
    expect(self(suppressed).health).toBe(self(unfired).health)
    expect(self(suppressed).armor).toBe(self(unfired).armor)
  })

  it('says so out loud, on its own line', () => {
    const lines: string[] = []
    const state = world()
    const tracker = trackerOver(state, (line) => lines.push(line))
    const predictor = createPredictor({
      state,
      world: CLIENT_MAP.world,
      slot: LOCAL_SLOT,
      hooks: { selfSplash: tracker },
    })
    opponentBeside(state, 20)

    predictor.predict(ROCKET_AT_FEET)

    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('self-splash clearance')
  })
})

describe('the decision, once taken', () => {
  it('is the same answer every time a replay asks for it', () => {
    // Reconciliation re-flies a rocket every time a snapshot lands, and the
    // opponent has moved in between. Two answers for one rocket would make the
    // launch appear and disappear over successive frames.
    const state = world()
    const at = self(state).origin
    // At the shooter's own feet, or this explosion owes them nothing and the
    // question does not arise.
    const rocket = spawnEntity(state, {
      kind: EntityKind.Projectile,
      origin: vec3(at[0], at[1], at[2]),
      ownerId: self(state).id,
      weapon: Weapon.RocketLauncher,
    })
    const near: Vec3 = [at[0], at[1] + 20, at[2]]
    const moving: Vec3[] = [near]
    const tracker = createRocketPredictor({ slot: LOCAL_SLOT, opponents: () => moving })

    tracker.observe(state, rocket, at, [at[0], at[1], at[2] + 40])
    expect(tracker.allow(state, rocket)).toBe(false)

    // The opponent has now walked a long way off. The answer does not move.
    moving[0] = [at[0], at[1] + 4000, at[2]]
    tracker.observe(state, rocket, at, [at[0], at[1], at[2] + 40])
    expect(tracker.allow(state, rocket)).toBe(false)
    expect(tracker.stats.suppressed).toBe(1)
  })

  it('is not a decision at all for a rocket that went off across the map', () => {
    // Nothing to predict and nothing to defer, so nothing is counted — and no
    // phantom entry lands in the window a correction is blamed against.
    const state = world()
    const at = self(state).origin
    const rocket = spawnEntity(state, {
      kind: EntityKind.Projectile,
      origin: vec3(at[0] + 900, at[1], at[2]),
      ownerId: self(state).id,
      weapon: Weapon.RocketLauncher,
    })
    const tracker = createRocketPredictor({
      slot: LOCAL_SLOT,
      opponents: () => [[at[0] + 900, at[1], at[2]]],
    })

    tracker.observe(state, rocket, at, [at[0] + 900, at[1], at[2]])
    expect(tracker.allow(state, rocket)).toBe(true)
    expect(tracker.stats.suppressed).toBe(0)
    expect(tracker.stats.predicted).toBe(0)
  })

  it('is not asked about anybody else — their rocket is always allowed', () => {
    const state = world()
    const theirs = spawnEntity(state, {
      kind: EntityKind.Projectile,
      origin: vec3(0, 0, 0),
      ownerId: 9999,
      weapon: Weapon.RocketLauncher,
    })
    const tracker = createRocketPredictor({ slot: LOCAL_SLOT, opponents: () => [[0, 0, 0]] })

    tracker.observe(state, theirs, [0, 0, 0], [100, 0, 0])
    expect(tracker.allow(state, theirs)).toBe(true)
    expect(tracker.stats.tracked).toBe(0)
  })
})

describe('counting mispredicts', () => {
  const correction = (band: CorrectionBand, predictedTick: number): Correction => ({
    band,
    distance: band === CorrectionBand.Snap ? 200 : 60,
    offset: [0, 0, 0],
    replayed: 0,
    tick: predictedTick,
    predictedTick,
  })

  function predictedAt(tick: number): { tracker: RocketPredictor; lines: string[] } {
    const lines: string[] = []
    const state = world()
    const tracker = trackerOver(state, (line) => lines.push(line))
    const predictor = createPredictor({
      state,
      world: CLIENT_MAP.world,
      slot: LOCAL_SLOT,
      hooks: { selfSplash: tracker },
    })
    for (let i = 0; i < tick; i += 1) predictor.predict(i === tick - 1 ? ROCKET_AT_FEET : IDLE)
    expect(tracker.stats.predicted).toBe(1)
    return { tracker, lines }
  }

  it('blames a large correction that lands inside the knockback window', () => {
    const { tracker, lines } = predictedAt(4)
    tracker.note(correction(CorrectionBand.Loud, 4 + 3))

    expect(tracker.stats.mispredicted).toBe(1)
    expect(lines.some((line) => line.includes('self-splash mispredict'))).toBe(true)
  })

  it('does not blame one that lands after it', () => {
    const { tracker } = predictedAt(4)
    tracker.note(correction(CorrectionBand.Loud, 4 + SELF_SPLASH_WINDOW_TICKS + 1))
    expect(tracker.stats.mispredicted).toBe(0)
  })

  it('does not blame an ordinary correction at all', () => {
    const { tracker } = predictedAt(4)
    tracker.note(correction(CorrectionBand.Soft, 5))
    tracker.note(correction(CorrectionBand.None, 5))
    expect(tracker.stats.mispredicted).toBe(0)
  })

  it('counts nothing when there was no predicted launch to blame', () => {
    const state = world()
    const tracker = trackerOver(state)
    tracker.note(correction(CorrectionBand.Snap, 40))
    expect(tracker.stats.mispredicted).toBe(0)
  })

  it('is a window derived from the knockback the splash arms', () => {
    expect(SELF_SPLASH_WINDOW_TICKS).toBe(knockbackTicksFor(WEAPONS[0].splashDamage))
  })
})

describe('a rocket, once it exists', () => {
  it('is the same trajectory on both peers, evaluated rather than integrated', () => {
    // The rocket half of the ticket, stated as an assertion. A rocket is
    // compensated in *where and when it is born* — the muzzle is the shooter's
    // own position at the sub-step their command executed, and `spawnTick` is
    // that sub-step — and after that both ends evaluate the identical closed
    // form. Nothing scales it by anybody's latency: at 900 qu/s, 150 ms of
    // forward simulation would teleport it 135 units, past its own splash
    // radius and through thin geometry.
    const authoritative = world()
    // Level, not at the feet, so the rocket is still in the air when the
    // snapshot is taken.
    const acrossTheRoom: UserCmd = { ...NULL_CMD, buttons: BUTTON_ATTACK, weapon: Weapon.RocketLauncher }
    simTick(authoritative, [acrossTheRoom], CLIENT_MAP.world)

    const flying = authoritative.entities.find(
      (entity) => entity.kind === EntityKind.Projectile,
    )
    expect(flying).toBeDefined()
    if (flying === undefined) throw new Error('unreachable')

    const state = world()
    const predictor = createPredictor({ state, world: CLIENT_MAP.world, slot: LOCAL_SLOT })
    predictor.accept(snapshotFrame(authoritative, 1))

    const adopted = state.entities.find((entity) => entity.kind === EntityKind.Projectile)
    expect(adopted).toBeDefined()
    if (adopted === undefined) throw new Error('unreachable')

    // The three numbers a peer needs, and the tick they are measured from.
    expect(adopted.spawnTick).toBe(flying.spawnTick)
    expect([...adopted.trBase]).toEqual([...flying.trBase])
    expect([...adopted.velocity]).toEqual([...flying.velocity])

    // And therefore the identical position at every tick afterwards, bit for
    // bit rather than approximately.
    const here: Vec3 = [0, 0, 0]
    const there: Vec3 = [0, 0, 0]
    for (const at of [1, 2, 5, 13, 40]) {
      projectilePosition(here as [number, number, number], adopted, at)
      projectilePosition(there as [number, number, number], flying, at)
      expect(here).toEqual(there)
    }
  })
})

describe('the knockback window', () => {
  /** The host: the same `tick()`, with no hooks and nothing to be unsure of. */
  function host(commands: readonly UserCmd[]): GameState {
    const state = world()
    for (const cmd of commands) simTick(state, [cmd], CLIENT_MAP.world)
    return state
  }

  it('is armed on the same tick on both peers when the launch is predicted', () => {
    // The acceptance check's first half. Both ends run the identical `tick()`
    // over the identical command, so the timer is set by the *detonation tick*
    // and lands on the same number — there is no wall clock anywhere in it.
    const state = world()
    const tracker = trackerOver(state)
    const predictor = createPredictor({
      state,
      world: CLIENT_MAP.world,
      slot: LOCAL_SLOT,
      hooks: { selfSplash: tracker },
    })

    const authoritative = host([IDLE, IDLE, ROCKET_AT_FEET])
    predictor.predict(IDLE)
    predictor.predict(IDLE)
    predictor.predict(ROCKET_AT_FEET)

    expect(state.tick).toBe(authoritative.tick)
    expect(self(state).knockbackTicks).toBe(knockbackTicksFor(WEAPONS[0].splashDamage))
    expect(self(state).knockbackTicks).toBe(self(authoritative).knockbackTicks)
  })

  it('arrives from the snapshot, counted down by the ticks replayed on top', () => {
    // The second half, and the one the predicate makes necessary: with the
    // launch refused, the client has *no* knockback until the host says so —
    // and what it then has is the host's number for the host's tick, less
    // exactly the sub-steps it replayed on top of it. Nothing in that sentence
    // is a duration in milliseconds.
    const state = world()
    const tracker = trackerOver(state)
    const predictor = createPredictor({
      state,
      world: CLIENT_MAP.world,
      slot: LOCAL_SLOT,
      hooks: { selfSplash: tracker },
    })
    opponentBeside(state, 20)

    predictor.predict(ROCKET_AT_FEET, 1)
    expect(self(state).knockbackTicks).toBe(0)
    expect(tracker.stats.suppressed).toBe(1)

    // Two more sub-steps this tab has sent and the host has not seen.
    predictor.predict(IDLE, 2)
    predictor.predict(IDLE, 3)

    const authoritative = world()
    opponentBeside(authoritative, 20)
    simTick(authoritative, [ROCKET_AT_FEET], CLIENT_MAP.world)
    const armed = self(authoritative).knockbackTicks
    expect(armed).toBe(knockbackTicksFor(WEAPONS[0].splashDamage))

    predictor.accept(snapshotFrame(authoritative, 1))

    // Adopted, then replayed forward by the two unacknowledged commands — so
    // the window is `armed - 2`, which is what the host will also have two
    // sub-steps later. The client is not late; it is in step.
    expect(self(state).knockbackTicks).toBe(armed - 2)
    expect(self(state).velocity[2]).toBeGreaterThan(0)
  })

  it('does not depend on when the snapshot was handed over', () => {
    // The same frame, adopted by two clients that did nothing else in between,
    // produces the same state — because there is no clock in the path at all.
    const authoritative = host([ROCKET_AT_FEET])
    const frame = snapshotFrame(authoritative, 1)

    const first = world()
    createPredictor({ state: first, world: CLIENT_MAP.world, slot: LOCAL_SLOT }).accept(frame)
    const second = world()
    createPredictor({ state: second, world: CLIENT_MAP.world, slot: LOCAL_SLOT }).accept(frame)

    expect(self(first).knockbackTicks).toBe(self(authoritative).knockbackTicks)
    expect(self(second).knockbackTicks).toBe(self(authoritative).knockbackTicks)
  })
})
