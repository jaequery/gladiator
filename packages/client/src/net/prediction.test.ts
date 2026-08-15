/**
 * The predictor: the world this tab believes in, and the input it has not been
 * told about yet.
 *
 * The end-to-end behaviour is `netcode.test.ts`'s. What is asserted here is the
 * bookkeeping around it — the ring buffer's bounds, what an acknowledgement
 * trims, and the one non-obvious thing the module does: it *moves the previous
 * origin with a correction*, so that the frame the correction lands on draws
 * exactly the motion it would have drawn anyway and the whole of the
 * discontinuity is left to the render offset.
 */
import {
  NULL_CMD,
  SKELETON_SEED,
  createMapState,
  findPlayer,
  hashState,
  tick as simTick,
  type GameState,
  type UserCmd,
  type Vec3,
  snapshotFrame,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { CLIENT_MAP } from '../map.ts'
import { lerp } from '../render/view.ts'
import { PENDING_CAPACITY, createPredictor } from './prediction.ts'
import { CorrectionBand } from './reconcile.ts'

const FORWARD: UserCmd = { ...NULL_CMD, forwardMove: 1 }

function world(): GameState {
  return createMapState(CLIENT_MAP.source, SKELETON_SEED)
}

function originOf(state: GameState): Vec3 {
  const player = findPlayer(state, 0)
  if (player === null) throw new Error('no player in this world')
  return [player.origin[0], player.origin[1], player.origin[2]]
}

/** Where the camera would be put this frame, ignoring the render offset. */
function drawnAt(previous: Vec3, current: Vec3, alpha: number): Vec3 {
  return [
    lerp(previous[0], current[0], alpha),
    lerp(previous[1], current[1], alpha),
    lerp(previous[2], current[2], alpha),
  ]
}

describe('predicting', () => {
  it('advances the world and hands back the hash of it', () => {
    const state = world()
    const predictor = createPredictor({ state, world: CLIENT_MAP.world, slot: 0 })

    const hash = predictor.predict(FORWARD)
    expect(predictor.tick).toBe(1)
    expect(hash).toBe(hashState(state))
    // The same object the caller handed in, advanced in place — which is what
    // lets the HUD and the renderer keep the reference they already have.
    expect(predictor.state).toBe(state)
  })

  it('keeps every command until it is acknowledged', () => {
    const predictor = createPredictor({ state: world(), world: CLIENT_MAP.world, slot: 0 })
    for (let i = 0; i < 20; i += 1) predictor.predict(FORWARD)
    expect(predictor.pending).toBe(20)

    const host = world()
    for (let i = 0; i < 14; i += 1) simTick(host, [FORWARD], CLIENT_MAP.world)
    predictor.accept(snapshotFrame(host, 14))

    expect(predictor.pending).toBe(6)
    expect(predictor.stats.replayed).toBe(6)
    expect(predictor.tick).toBe(20)
  })

  it('remembers where the eye was one tick ago', () => {
    const state = world()
    const predictor = createPredictor({ state, world: CLIENT_MAP.world, slot: 0 })
    const start = originOf(state)

    predictor.predict(FORWARD)
    expect([...predictor.previousOrigin]).toEqual([...start])
    const afterOne = originOf(state)

    predictor.predict(FORWARD)
    expect([...predictor.previousOrigin]).toEqual([...afterOne])
  })

  it('bounds the ring, and says when it dropped something', () => {
    const predictor = createPredictor({
      state: world(),
      world: CLIENT_MAP.world,
      slot: 0,
      capacity: 4,
    })
    for (let i = 0; i < 10; i += 1) predictor.predict(FORWARD)

    expect(predictor.pending).toBe(4)
    expect(predictor.stats.overflowed).toBe(6)
    // Bounded rather than targeted: eight seconds of unacknowledged input is a
    // dead connection, and the default says so.
    expect(PENDING_CAPACITY).toBe(1024)
  })

  it('refuses a snapshot it cannot read, and leaves the world alone', () => {
    const state = world()
    const predictor = createPredictor({ state, world: CLIENT_MAP.world, slot: 0 })
    predictor.predict(FORWARD)
    const before = hashState(state)

    expect(predictor.accept({ t: 'snap', ack: 0, state: [4, 5, 6] })).toBe(null)
    expect(predictor.stats.rejected).toBe(1)
    expect(predictor.stats.reconciled).toBe(0)
    expect(hashState(state)).toBe(before)
  })
})

describe('a correction and the camera', () => {
  it('draws the same frame it would have drawn, and owes the rest to the offset', () => {
    const state = world()
    const predictor = createPredictor({ state, world: CLIENT_MAP.world, slot: 0 })
    for (let i = 0; i < 12; i += 1) predictor.predict(FORWARD)

    const wasDrawn = drawnAt([...predictor.previousOrigin] as Vec3, originOf(state), 0.5)

    // The host agrees about everything except where the player is standing.
    const host = world()
    for (let i = 0; i < 12; i += 1) simTick(host, [FORWARD], CLIENT_MAP.world)
    const moved = findPlayer(host, 0)
    if (moved === null) throw new Error('no player to move')
    moved.origin[1] += 12

    const correction = predictor.accept(snapshotFrame(host, 12))
    if (correction === null) throw new Error('a good snapshot was refused')
    expect(correction.band).toBe(CorrectionBand.Soft)

    // The frame draws the same picture: the interpolation carries the motion it
    // would have carried anyway, and the offset carries the jump. Without the
    // shift the camera would travel twelve units in one frame — the artefact
    // the offset exists to prevent, moved one level down.
    const nowDrawn = drawnAt([...predictor.previousOrigin] as Vec3, originOf(state), 0.5)
    expect(nowDrawn[0] + correction.offset[0]).toBeCloseTo(wasDrawn[0], 9)
    expect(nowDrawn[1] + correction.offset[1]).toBeCloseTo(wasDrawn[1], 9)
    expect(nowDrawn[2] + correction.offset[2]).toBeCloseTo(wasDrawn[2], 9)
  })

  it('does not interpolate across a hard snap', () => {
    const state = world()
    const predictor = createPredictor({ state, world: CLIENT_MAP.world, slot: 0 })
    for (let i = 0; i < 12; i += 1) predictor.predict(FORWARD)

    const host = world()
    for (let i = 0; i < 12; i += 1) simTick(host, [FORWARD], CLIENT_MAP.world)
    const moved = findPlayer(host, 0)
    if (moved === null) throw new Error('no player to move')
    moved.origin[0] += 300

    const correction = predictor.accept(snapshotFrame(host, 12))
    expect(correction?.band).toBe(CorrectionBand.Snap)
    expect(predictor.stats.snaps).toBe(1)
    // There is nothing to interpolate across: the player is somewhere else, and
    // a previous origin left three hundred units behind would draw a very fast
    // journey to it.
    expect([...predictor.previousOrigin]).toEqual([...originOf(state)])
  })

  it('counts each band, and the ones over a unit', () => {
    const state = world()
    const predictor = createPredictor({ state, world: CLIENT_MAP.world, slot: 0 })

    const host = world()
    const distances: number[] = []
    const nudge = (by: number, at: number) => {
      while (host.tick < at) simTick(host, [FORWARD], CLIENT_MAP.world)
      const player = findPlayer(host, 0)
      if (player === null) throw new Error('no player to move')
      player.origin[1] += by
      const correction = predictor.accept(snapshotFrame(host, at))
      if (correction === null) throw new Error('a good snapshot was refused')
      distances.push(correction.distance)
      // Put it back, so the *next* displacement is measured from an
      // undisplaced host rather than compounding with this one.
      player.origin[1] -= by
    }

    for (let i = 0; i < 4; i += 1) predictor.predict(FORWARD)
    nudge(0, 4)
    for (let i = 0; i < 4; i += 1) predictor.predict(FORWARD)
    nudge(5, 8)
    for (let i = 0; i < 4; i += 1) predictor.predict(FORWARD)
    nudge(50, 12)
    for (let i = 0; i < 4; i += 1) predictor.predict(FORWARD)
    nudge(500, 16)

    const stats = predictor.stats
    expect(stats.reconciled).toBe(4)
    expect(stats.ignored).toBe(1)
    expect(stats.soft).toBe(1)
    expect(stats.loud).toBe(1)
    expect(stats.snaps).toBe(1)
    // Three of the four were over a unit — the number the acceptance check
    // measures a rate of.
    expect(stats.noticeable).toBe(3)
    expect(stats.worstUnits).toBe(Math.max(...distances))
    expect(stats.worstUnits).toBeGreaterThan(400)
  })
})
