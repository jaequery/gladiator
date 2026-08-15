/**
 * The host's rewind, driven directly.
 *
 * The history is a second of the world's past and the rewind is a seam `tick()`
 * takes, so both can be asserted without a socket, a timer or a match — which
 * is what makes it possible to state the interesting claims (a rail that hits
 * where the player was drawn; a rewind that undoes itself when the trace
 * throws) as arithmetic rather than as an anecdote about a duel.
 */
import {
  INTERP_DELAY_MS,
  MAX_REWIND_MS,
  PROTOCOL_VERSION,
  TICK_INTERVAL_MS,
  Weapon,
  boxBrush,
  createCollisionWorld,
  createGameState,
  encodeCmd,
  fireWeapon,
  BUTTON_ATTACK,
  EntityKind,
  spawnEntity,
  vec3,
  yawUnitsFromDegrees,
  type CollisionWorld,
  type EntityState,
  type GameState,
  type TickHooks,
  type UserCmd,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { manualClock } from './clock.ts'
import { createLagCompensation, HISTORY_TICKS } from './lagcomp.ts'
import { SERVER_MAP, SERVER_MAP_HASH, SERVER_PLAN } from './map.ts'
import { createLoopbackPair, settleLoopback, type LoopbackPair } from './net/loopbackTransport.ts'
import { createRoom } from './room.ts'

/** A sealed box with the floor at z = 0. Nothing in it to block a rail. */
const WORLD: CollisionWorld = createCollisionWorld([
  boxBrush([-2048, -2048, -64], [2048, 2048, 0]),
  boxBrush([-2048, -2048, 1024], [2048, 2048, 1088]),
])

/** How fast the target runs across the shooter's view, in qu/s. */
const TARGET_SPEED = 320

/** Which sub-step the scene ends on. Comfortably inside the history. */
const NOW = 60

type Scene = {
  readonly state: GameState
  readonly shooter: EntityState
  readonly target: EntityState
  /** Where the target was at the (fractional) sub-step `at`. */
  yAt(at: number): number
}

/**
 * A shooter at the origin and a target running past them at `x = 400`, with a
 * second of history behind it.
 *
 * The target's track is a straight line in `y` at a constant speed, so "where
 * were they at tick *t*" has a closed-form answer and an assertion about a
 * rewind can name a position rather than a tolerance.
 */
function scene(): Scene {
  const state = createGameState(3)
  const shooter = spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    origin: vec3(0, 0, 0),
    health: 100,
    armor: 100,
    weapon: Weapon.Railgun,
  })
  const target = spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 1,
    origin: vec3(400, 0, 0),
    health: 100,
    armor: 100,
    weapon: Weapon.RocketLauncher,
  })

  const yAt = (at: number): number => (at * TICK_INTERVAL_MS * TARGET_SPEED) / 1000

  const lag = createLagCompensation({ rttMsForSlot: () => 200 })
  for (let at = 0; at <= NOW; at += 1) {
    state.tick = at
    target.origin[1] = yAt(at)
    lag.record(state)
  }

  return { state, shooter, target, yAt }
}

/** Point the shooter at `(x, y)` on the level plane through their eye. */
function aimAt(shooter: EntityState, x: number, y: number): void {
  const degrees = (Math.atan2(y - shooter.origin[1], x - shooter.origin[0]) * 180) / Math.PI
  shooter.angles[0] = 0
  shooter.angles[1] = yawUnitsFromDegrees(degrees)
}

/** Everything a hit costs, whichever pool it came out of. */
function pools(entity: EntityState): number {
  return entity.health + entity.armor
}

function historyFor(rttMs: number): ReturnType<typeof createLagCompensation> {
  return createLagCompensation({ rttMsForSlot: () => rttMs })
}

/** Refill a compensator with the same scripted track the scene recorded. */
function record(lag: ReturnType<typeof createLagCompensation>, scene_: Scene): void {
  const { state, target } = scene_
  const present = target.origin[1]
  for (let at = 0; at <= NOW; at += 1) {
    state.tick = at
    target.origin[1] = scene_.yAt(at)
    lag.record(state)
  }
  state.tick = NOW
  target.origin[1] = present
}

describe('the history buffer', () => {
  it('samples between the two ticks either side of a fractional one', () => {
    const it_ = scene()
    const lag = historyFor(200)
    record(lag, it_)

    const out: [number, number, number] = [0, 0, 0]
    expect(lag.sample(1, 37, out)).toBe(true)
    expect(out[1]).toBeCloseTo(it_.yAt(37), 9)

    // The one that matters: a shot lands halfway between two sub-steps, and
    // snapping to the nearer one would throw away 1.28 units of the target's
    // motion for a lerp that costs nothing.
    expect(lag.sample(1, 37.5, out)).toBe(true)
    expect(out[1]).toBeCloseTo(it_.yAt(37.5), 9)
    expect(out[1]).not.toBeCloseTo(it_.yAt(37), 3)
    expect(out[1]).not.toBeCloseTo(it_.yAt(38), 3)
  })

  it('holds a second of the world and answers nothing for a slot nobody has', () => {
    expect(HISTORY_TICKS * TICK_INTERVAL_MS).toBe(1000)
    expect(HISTORY_TICKS * TICK_INTERVAL_MS).toBeGreaterThan(MAX_REWIND_MS)

    const lag = historyFor(200)
    const out: [number, number, number] = [0, 0, 0]
    expect(lag.sample(0, 0, out)).toBe(false)
    record(lag, scene())
    expect(lag.sample(7, 30, out)).toBe(false)
  })
})

describe('a rail judged through the rewind', () => {
  it('hits the opponent where the shooter was drawing them at 200 ms', () => {
    // The acceptance check. At a 200 ms round trip the shooter's picture is
    // `rtt / 2 + INTERP_DELAY_MS` = 180 ms old, which is 22.5 sub-steps: the
    // target is drawn at tick 37.5 and is really at tick 60, 57.6 units — most
    // of two body widths — further down the track.
    const it_ = scene()
    const lag = historyFor(200)
    record(lag, it_)

    const drawnY = it_.yAt(NOW - (200 / 2 + INTERP_DELAY_MS) / TICK_INTERVAL_MS)
    expect(it_.target.origin[1] - drawnY).toBeCloseTo(57.6, 6)

    aimAt(it_.shooter, it_.target.origin[0], drawnY)
    fireWeapon(it_.state, WORLD, it_.shooter, Weapon.Railgun, { rewind: lag.rewind })

    expect(pools(it_.target)).toBeLessThan(200)
    expect(lag.stats.shots).toBe(1)
    expect(lag.stats.rewound).toBe(1)
  })

  it('misses the same shot when nothing is rewound', () => {
    // The control, and the reason the mechanism is not optional: this is the
    // shot a player lines up on their screen, and without compensation a
    // 1500 ms-cooldown weapon misses it purely from latency.
    const it_ = scene()
    const drawnY = it_.yAt(NOW - (200 / 2 + INTERP_DELAY_MS) / TICK_INTERVAL_MS)

    aimAt(it_.shooter, it_.target.origin[0], drawnY)
    fireWeapon(it_.state, WORLD, it_.shooter, Weapon.Railgun, null)

    expect(pools(it_.target)).toBe(200)
  })

  it('rewinds the target and never the shooter', () => {
    const it_ = scene()
    const lag = historyFor(200)
    record(lag, it_)

    const shooterBefore = [...it_.shooter.origin]
    let seenTargetY = Number.NaN
    let seenShooter: number[] = []
    lag.rewind(it_.state, it_.shooter, () => {
      seenTargetY = it_.target.origin[1]
      seenShooter = [...it_.shooter.origin]
    })

    expect(seenTargetY).toBeCloseTo(it_.yAt(37.5), 9)
    // The shooter is predicting themselves and is effectively in the present.
    expect(seenShooter).toEqual(shooterBefore)
  })

  it('never reaches further back than the cap, whatever the link is doing', () => {
    // A client cannot report its own round trip at all — `ClientPong` carries
    // nothing but the id — but a link that genuinely measures five seconds
    // still buys exactly `MAX_REWIND_MS` and not a millisecond more.
    const it_ = scene()
    const lag = historyFor(5000)
    record(lag, it_)

    let seenY = Number.NaN
    lag.rewind(it_.state, it_.shooter, () => {
      seenY = it_.target.origin[1]
    })

    expect(seenY).toBeCloseTo(it_.yAt(NOW - MAX_REWIND_MS / TICK_INTERVAL_MS), 9)
    expect(lag.stats.deepestTicks).toBe(MAX_REWIND_MS / TICK_INTERVAL_MS)
  })
})

describe('restoring the world', () => {
  it('puts every hitbox back exactly, on the ordinary path', () => {
    const it_ = scene()
    const lag = historyFor(200)
    record(lag, it_)

    const before = it_.state.entities.map((entity) => [...entity.origin])
    lag.rewind(it_.state, it_.shooter, () => undefined)
    expect(it_.state.entities.map((entity) => [...entity.origin])).toEqual(before)
  })

  it('puts every hitbox back exactly when the trace throws', () => {
    // The acceptance check, and the reason `HitscanRewind` is a function that
    // takes the shot rather than a `begin`/`end` pair: an exception escaping
    // mid-trace and leaving a player 200 ms in the past would not crash
    // anything. It would quietly play the rest of the match with one body in
    // the wrong place.
    const it_ = scene()
    const lag = historyFor(200)
    record(lag, it_)

    const before = it_.state.entities.map((entity) => [...entity.origin])
    expect(() => {
      lag.rewind(it_.state, it_.shooter, () => {
        throw new Error('the trace exploded')
      })
    }).toThrow('the trace exploded')

    expect(it_.state.entities.map((entity) => [...entity.origin])).toEqual(before)
  })

  it('restores positions and not the damage the shot dealt', () => {
    // Health, velocity and the knockback timer are *effects* of the shot and
    // belong to the present. Putting them back would be undoing the shot.
    const it_ = scene()
    const lag = historyFor(200)
    record(lag, it_)

    const drawnY = it_.yAt(NOW - (200 / 2 + INTERP_DELAY_MS) / TICK_INTERVAL_MS)
    const positionBefore = [...it_.target.origin]
    aimAt(it_.shooter, it_.target.origin[0], drawnY)
    fireWeapon(it_.state, WORLD, it_.shooter, Weapon.Railgun, { rewind: lag.rewind })

    expect([...it_.target.origin]).toEqual(positionBefore)
    expect(pools(it_.target)).toBeLessThan(200)
    expect(it_.target.knockbackTicks).toBeGreaterThan(0)
  })

  it('leaves a body it has no history for exactly where it is', () => {
    const it_ = scene()
    const lag = historyFor(200)
    // Nothing recorded at all: the first sub-steps of a room, or a player who
    // has only just been given a slot.
    const before = it_.state.entities.map((entity) => [...entity.origin])
    lag.rewind(it_.state, it_.shooter, () => undefined)

    expect(it_.state.entities.map((entity) => [...entity.origin])).toEqual(before)
    expect(lag.stats.missed).toBe(1)
    expect(lag.stats.rewound).toBe(0)
  })
})

describe('a room judging a shot', () => {
  /** A room with both seats filled over loopbacks, greeted and ready to tick. */
  async function duel(id: string): Promise<{
    readonly room: ReturnType<typeof createRoom>
    readonly host: LoopbackPair
    readonly guest: LoopbackPair
  }> {
    const room = createRoom({
      map: SERVER_MAP,
      plan: SERVER_PLAN,
      clock: manualClock(),
      build: 'lagcomp-test',
      id,
    })

    const host = createLoopbackPair()
    const guest = createLoopbackPair()
    for (const pair of [host, guest]) {
      // The far end has to be listening, or the loopback never drains and a
      // `settleLoopback` waits forever for a queue nobody is reading.
      pair.client.setHandlers({ onMessage: () => undefined })
      room.join(pair.server)
      pair.client.send(
        JSON.stringify({
          t: 'hello',
          protocol: PROTOCOL_VERSION,
          build: 'lagcomp-test',
          mapHash: SERVER_MAP_HASH,
        }),
      )
    }
    await settleLoopback(host)
    await settleLoopback(guest)
    return { room, host, guest }
  }

  /** Hold the trigger with `weapon` in hand, for two sub-steps. */
  function holdTrigger(weapon: Weapon): string {
    const cmd: UserCmd = {
      forwardMove: 0,
      sideMove: 0,
      yaw: 0,
      pitch: 0,
      buttons: BUTTON_ATTACK,
      weapon,
    }
    return JSON.stringify({ t: 'cmds', startTick: 1, cmds: [encodeCmd(cmd), encodeCmd(cmd)] })
  }

  it('records the world every sub-step and hands the rewind to tick()', async () => {
    // The wiring, end to end: a real `Room`, a real command with the trigger
    // held, and the compensator's own counter as the proof that the seam was
    // taken rather than skipped.
    const { room, host } = await duel('LAG001')

    // Some history first, so the rewind has somewhere to land: the buffer is
    // empty at tick zero, and a shot in the opening sub-steps of a match is
    // judged against the present exactly as it would be on a server with no
    // compensation at all.
    room.advance(20)

    host.client.send(holdTrigger(Weapon.Railgun))
    await settleLoopback(host)
    room.advance(4)

    // One rail leaves the muzzle — the refire interval is 1500 ms, so a held
    // trigger over four sub-steps is exactly one shot — and it went through the
    // rewind, with the other player put back where the shooter saw them.
    expect(room.snapshot().lagcomp.shots).toBe(1)
    expect(room.snapshot().lagcomp.rewound).toBe(1)
  })

  it('does not rewind a rocket, only a hitscan', async () => {
    const { room, host } = await duel('LAG002')
    room.advance(20)

    host.client.send(holdTrigger(Weapon.RocketLauncher))
    await settleLoopback(host)
    room.advance(4)

    // A rocket is compensated in where and when it is *born* and never
    // afterwards: nothing is rewound to fire one, and nothing is rewound while
    // it is in the air, or you would be hit by rockets that visibly passed
    // behind you.
    expect(room.snapshot().lagcomp.shots).toBe(0)
  })
})

describe('the shape of the hooks a room passes', () => {
  it('is a rewind and nothing else — a host predicts no splash', () => {
    const hooks: TickHooks = { rewind: historyFor(200).rewind }
    expect(hooks.selfSplash ?? null).toBe(null)
  })
})
