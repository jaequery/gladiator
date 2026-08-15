/**
 * The effects fold, without a GPU.
 *
 * `advanceFx` is the whole rule set — what a frame of netstates and rockets
 * *means* — and it is pure, so all of it is testable as data. The pool that
 * draws the result is exercised by the browser smoke test, where a particle
 * that does not compile is a console error rather than an assertion.
 *
 * The rules being pinned here are the ones with a failure mode: an effect that
 * fires on the frame a client first sees something (a client joining mid-flight
 * would detonate every rocket in the air), and an effect that fires twice for
 * one shot.
 */

import { NEVER_FIRED, PLAYER_VIEW_HEIGHT, type Vec3, Weapon } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import type { PlayerNetState } from './animState.ts'
import {
  BLAST_MARK_RADIUS,
  type FxEvent,
  type FxMemory,
  type FxObservation,
  INITIAL_FX,
  RAIL_MARK_RADIUS,
  RAIL_RANGE,
  type RocketView,
  advanceFx,
} from './fx.ts'

/** A trace that never hits anything: the ray runs its full length. */
const missEverything = (_from: Vec3, to: Vec3): { point: Vec3; normal: Vec3; hit: boolean } => ({
  point: [to[0], to[1], to[2]],
  normal: [0, 0, 0],
  hit: false,
})

/** A trace that stops dead at 100 units against a floor. */
const hitAt100 = (from: Vec3, to: Vec3): { point: Vec3; normal: Vec3; hit: boolean } => {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  const dz = to[2] - from[2]
  const length = Math.sqrt(dx * dx + dy * dy + dz * dz) || 1
  const t = Math.min(1, 100 / length)
  return {
    point: [from[0] + dx * t, from[1] + dy * t, from[2] + dz * t],
    normal: [0, 0, 1],
    hit: true,
  }
}

function player(over: Partial<PlayerNetState> = {}): PlayerNetState {
  return {
    id: 7,
    slot: 0,
    origin: [0, 0, 0],
    velocity: [0, 0, 0],
    angles: [0, 0, 0],
    flags: 0,
    health: 100,
    weapon: Weapon.RocketLauncher,
    lastFireTick: NEVER_FIRED,
    ...over,
  }
}

function observe(over: Partial<FxObservation> = {}): FxObservation {
  return { self: null, others: [], rockets: [], trace: missEverything, ...over }
}

const kinds = (events: readonly FxEvent[]): readonly string[] => events.map((event) => event.kind)

describe('advanceFx', () => {
  it('says nothing about a rocket it is seeing for the first time', () => {
    const rockets: readonly RocketView[] = [{ id: 3, origin: [10, 0, 40] }]
    const first = advanceFx(INITIAL_FX, observe({ rockets }))
    expect(first.events).toHaveLength(0)
    expect(first.memory.rockets.get(3)?.origin).toEqual([10, 0, 40])
    // And nothing on the frame after, while it is still in the air.
    const second = advanceFx(first.memory, observe({ rockets: [{ id: 3, origin: [40, 0, 40] }] }))
    expect(second.events).toHaveLength(0)
  })

  it('explodes a rocket that stopped existing, where it last was', () => {
    const flying = advanceFx(INITIAL_FX, observe({ rockets: [{ id: 3, origin: [0, 0, 40] }] }))
    const moved = advanceFx(
      flying.memory,
      observe({ rockets: [{ id: 3, origin: [64, 0, 40] }] }),
    )
    const gone = advanceFx(moved.memory, observe({ rockets: [], trace: hitAt100 }))

    const blast = gone.events.find((event) => event.kind === 'explosion')
    expect(blast).toEqual({ kind: 'explosion', origin: [64, 0, 40] })
    expect(gone.memory.rockets.size).toBe(0)
  })

  it('scorches along the way the rocket was going, not straight down', () => {
    // A rocket detonates a frame *before* the wall it hit, so the mark has to
    // be traced along its own path. Assuming down would put every wall hit's
    // scorch on the floor underneath it.
    const flying = advanceFx(INITIAL_FX, observe({ rockets: [{ id: 1, origin: [0, 0, 40] }] }))
    const moved = advanceFx(flying.memory, observe({ rockets: [{ id: 1, origin: [32, 0, 40] }] }))
    const gone = advanceFx(moved.memory, observe({ rockets: [], trace: hitAt100 }))

    const mark = gone.events.find((event) => event.kind === 'mark')
    expect(mark).toBeDefined()
    if (mark?.kind !== 'mark') throw new Error('no mark')
    // The trace ran from the last position along +x, so the hit is +x of it.
    expect(mark.origin[0]).toBeGreaterThan(32)
    expect(mark.origin[1]).toBe(0)
    expect(mark.radius).toBe(BLAST_MARK_RADIUS)
  })

  it('leaves no mark for a rocket that detonated in mid-air', () => {
    const flying = advanceFx(INITIAL_FX, observe({ rockets: [{ id: 1, origin: [0, 0, 40] }] }))
    const moved = advanceFx(flying.memory, observe({ rockets: [{ id: 1, origin: [32, 0, 40] }] }))
    const gone = advanceFx(moved.memory, observe({ rockets: [] }))
    expect(kinds(gone.events)).toEqual(['explosion'])
  })

  it('says nothing about a player it is seeing for the first time', () => {
    // Even one who is mid-shot. Every rule is an edge, and an edge against a
    // memory of nothing fires on the frame somebody walks into view.
    const shooting = player({ lastFireTick: 400, weapon: Weapon.Railgun })
    const first = advanceFx(INITIAL_FX, observe({ others: [shooting] }))
    expect(first.events).toHaveLength(0)
    expect(first.memory.fired.get(7)).toBe(400)
  })

  it('draws one muzzle flash per shot, not one per frame', () => {
    const seen = advanceFx(INITIAL_FX, observe({ others: [player()] }))
    const shot = advanceFx(seen.memory, observe({ others: [player({ lastFireTick: 401 })] }))
    expect(kinds(shot.events)).toEqual(['muzzle'])

    // The same shot, still the newest one this player has taken.
    const held = advanceFx(shot.memory, observe({ others: [player({ lastFireTick: 401 })] }))
    expect(held.events).toHaveLength(0)

    const again = advanceFx(held.memory, observe({ others: [player({ lastFireTick: 460 })] }))
    expect(kinds(again.events)).toEqual(['muzzle'])
  })

  it('draws a rail beam from the eye along the shot, and burns what it hits', () => {
    const rail = (over: Partial<PlayerNetState> = {}) =>
      player({ weapon: Weapon.Railgun, origin: [0, 0, 0], ...over })
    const seen = advanceFx(INITIAL_FX, observe({ others: [rail()] }))
    const shot = advanceFx(
      seen.memory,
      observe({ others: [rail({ lastFireTick: 500 })], trace: hitAt100 }),
    )

    expect(kinds(shot.events)).toEqual(['muzzle', 'rail', 'mark'])
    const beam = shot.events[1]
    if (beam?.kind !== 'rail') throw new Error('no beam')
    // From the eye, not the feet — the same rule `audio/cues.ts` uses.
    expect(beam.from).toEqual([0, 0, PLAYER_VIEW_HEIGHT])
    // Yaw 0, pitch 0 is due +x in the Quake frame, stopped at 100 units.
    expect(beam.to[0]).toBeCloseTo(100, 3)
    const mark = shot.events[2]
    if (mark?.kind !== 'mark') throw new Error('no mark')
    expect(mark.radius).toBe(RAIL_MARK_RADIUS)
  })

  it('draws a rail beam to the far plane when it hits nothing', () => {
    const rail = (over: Partial<PlayerNetState> = {}) =>
      player({ weapon: Weapon.Railgun, ...over })
    const seen = advanceFx(INITIAL_FX, observe({ others: [rail()] }))
    const shot = advanceFx(seen.memory, observe({ others: [rail({ lastFireTick: 9 })] }))
    const beam = shot.events.find((event) => event.kind === 'rail')
    if (beam?.kind !== 'rail') throw new Error('no beam')
    expect(beam.to[0]).toBeCloseTo(RAIL_RANGE, 0)
    // Nothing was hit, so nothing was marked.
    expect(kinds(shot.events)).toEqual(['muzzle', 'rail'])
  })

  it('does not trace a beam for a rocket launcher', () => {
    const seen = advanceFx(INITIAL_FX, observe({ others: [player()] }))
    const shot = advanceFx(
      seen.memory,
      observe({ others: [player({ lastFireTick: 3 })], trace: hitAt100 }),
    )
    expect(kinds(shot.events)).toEqual(['muzzle'])
  })

  it('forgets a player who is no longer drawn', () => {
    const seen = advanceFx(INITIAL_FX, observe({ others: [player({ lastFireTick: 12 })] }))
    const gone = advanceFx(seen.memory, observe({}))
    expect(gone.memory.fired.size).toBe(0)
    // So when they come back — a reconnection, a new round — they are seen for
    // the first time again and their weapon does not fire on the spot.
    const back = advanceFx(gone.memory, observe({ others: [player({ lastFireTick: 900 })] }))
    expect(back.events).toHaveLength(0)
  })

  it('watches the local player as well as the opponent', () => {
    const seen = advanceFx(INITIAL_FX, observe({ self: player({ id: 1 }) }))
    const shot = advanceFx(seen.memory, observe({ self: player({ id: 1, lastFireTick: 5 }) }))
    expect(kinds(shot.events)).toEqual(['muzzle'])
  })

  it('is a pure function of its memory and its observation', () => {
    const memory: FxMemory = advanceFx(
      INITIAL_FX,
      observe({ rockets: [{ id: 1, origin: [0, 0, 0] }], others: [player()] }),
    ).memory
    const input = observe({ rockets: [], others: [player({ lastFireTick: 20 })] })
    const a = advanceFx(memory, input)
    const b = advanceFx(memory, input)
    expect(b.events).toEqual(a.events)
  })
})
