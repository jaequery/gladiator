/**
 * Reconciliation, with the disagreement built by hand.
 *
 * `netcode.test.ts` runs the real thing over a real host and finds that
 * prediction is exact, which is the outcome anybody wants and a poor test of
 * the code that exists for when it is not. So here the two worlds are made to
 * disagree deliberately, by feeding the "server" different commands from the
 * ones the client predicted, and every band is walked.
 *
 * The property under test is the structural rule: **the simulation takes the
 * authoritative value immediately, and only rendering lags.** Every assertion
 * below about `state` is that half; every assertion about `offset` is the
 * other.
 */
import {
  EntityKind,
  NULL_CMD,
  SKELETON_SEED,
  createMapState,
  findPlayer,
  hashState,
  tick as simTick,
  type GameState,
  type ServerSnapshot,
  type UserCmd,
  snapshotFrame,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { CLIENT_MAP } from '../map.ts'
import {
  CORRECTION_NOISE_UNITS,
  CORRECTION_SNAP_UNITS,
  CORRECTION_SOFT_UNITS,
  CorrectionBand,
  LOUD_DECAY_MS,
  SOFT_DECAY_MS,
  classifyCorrection,
  decayMsFor,
  reconcile,
  type PendingCommand,
} from './reconcile.ts'

const FORWARD: UserCmd = { ...NULL_CMD, forwardMove: 1 }
const BACKWARD: UserCmd = { ...NULL_CMD, forwardMove: -1 }
const STILL: UserCmd = NULL_CMD

function world(): GameState {
  return createMapState(CLIENT_MAP.source, SKELETON_SEED)
}

/** Advance `state` by `ticks` of `cmd`, and hand back the commands used. */
function play(state: GameState, cmd: UserCmd, ticks: number): PendingCommand[] {
  const used: PendingCommand[] = []
  for (let i = 0; i < ticks; i += 1) {
    simTick(state, [cmd], CLIENT_MAP.world)
    used.push({ tick: state.tick, cmd })
  }
  return used
}

function originOf(state: GameState): readonly [number, number, number] {
  const player = findPlayer(state, 0)
  if (player === null) throw new Error('no player in this world')
  return [player.origin[0], player.origin[1], player.origin[2]]
}

/**
 * A client that predicted `predicted` for `ticks`, and a host that ran
 * `executed` for `acked` of them and has not seen the rest.
 */
function diverged(options: {
  readonly acked: number
  readonly ticks: number
  readonly predicted: UserCmd
  readonly executed: UserCmd
  /**
   * Move the host's player by this much before snapshotting.
   *
   * The way to walk a *specific* band. Two commands that disagree produce
   * whatever distance the movement happens to produce, which is a poor way to
   * land either side of a threshold; a displacement is exact, and with nothing
   * left to replay it is the correction distance to the last bit.
   */
  readonly teleportBy?: readonly [number, number, number]
}) {
  const client = world()
  const pending = play(client, options.predicted, options.ticks)

  const host = world()
  play(host, options.executed, options.acked)
  const shift = options.teleportBy
  if (shift !== undefined) {
    const player = findPlayer(host, 0)
    if (player === null) throw new Error('no player to move')
    player.origin[0] += shift[0]
    player.origin[1] += shift[1]
    player.origin[2] += shift[2]
  }

  const snapshot: ServerSnapshot = snapshotFrame(host, options.acked)
  return { client, host, pending, snapshot, predictedOrigin: originOf(client) }
}

describe('the bands', () => {
  it('puts each distance where the ticket says', () => {
    expect(classifyCorrection(0)).toBe(CorrectionBand.None)
    expect(classifyCorrection(CORRECTION_NOISE_UNITS)).toBe(CorrectionBand.None)
    expect(classifyCorrection(CORRECTION_NOISE_UNITS + 1e-9)).toBe(CorrectionBand.Soft)
    expect(classifyCorrection(CORRECTION_SOFT_UNITS)).toBe(CorrectionBand.Soft)
    expect(classifyCorrection(CORRECTION_SOFT_UNITS + 1e-9)).toBe(CorrectionBand.Loud)
    expect(classifyCorrection(CORRECTION_SNAP_UNITS)).toBe(CorrectionBand.Loud)
    expect(classifyCorrection(CORRECTION_SNAP_UNITS + 1e-9)).toBe(CorrectionBand.Snap)
    // A NaN distance is not a small one. Nothing should produce one, and
    // treating it as "below the noise floor" would be the quietest possible way
    // to stop correcting.
    expect(classifyCorrection(Number.NaN)).toBe(CorrectionBand.None)
  })

  it('is the rocket, not a number somebody picked', () => {
    // One splash radius is the largest displacement the game can legitimately
    // hand a player in a tick, which is what makes anything bigger a teleport
    // rather than a correction.
    expect(CORRECTION_SNAP_UNITS).toBe(120)
  })

  it('carries the two middle bands and neither extreme', () => {
    expect(decayMsFor(CorrectionBand.None)).toBe(0)
    expect(decayMsFor(CorrectionBand.Soft)).toBe(SOFT_DECAY_MS)
    expect(decayMsFor(CorrectionBand.Loud)).toBe(LOUD_DECAY_MS)
    expect(decayMsFor(CorrectionBand.Snap)).toBe(0)
  })
})

describe('reconciling', () => {
  it('lands back where prediction already was, when prediction was right', () => {
    const { client, pending, snapshot } = diverged({
      acked: 6,
      ticks: 20,
      predicted: FORWARD,
      executed: FORWARD,
    })
    const before = hashState(client)

    const correction = reconcile({
      state: client,
      world: CLIENT_MAP.world,
      slot: 0,
      snapshot,
      pending,
    })

    if (correction === null) throw new Error('a good snapshot was refused')
    expect(correction.distance).toBe(0)
    expect(correction.band).toBe(CorrectionBand.None)
    expect(correction.replayed).toBe(14)
    expect(correction.tick).toBe(20)
    expect(correction.predictedTick).toBe(20)
    // Bit for bit: replaying the unacknowledged commands on top of the
    // authoritative world is not *nearly* the same as having predicted it.
    expect(hashState(client)).toBe(before)
  })

  it('takes the authoritative value immediately, and hands the delta to rendering', () => {
    const { client, pending, snapshot } = diverged({
      acked: 12,
      ticks: 12,
      predicted: FORWARD,
      executed: FORWARD,
      teleportBy: [10, 0, 0],
    })
    const predicted = originOf(client)

    const correction = reconcile({
      state: client,
      world: CLIENT_MAP.world,
      slot: 0,
      snapshot,
      pending,
    })
    if (correction === null) throw new Error('a good snapshot was refused')

    expect(correction.band).toBe(CorrectionBand.Soft)
    expect(correction.distance).toBeCloseTo(10, 9)
    expect(correction.distance).toBeGreaterThan(CORRECTION_NOISE_UNITS)
    expect(correction.distance).toBeLessThanOrEqual(CORRECTION_SOFT_UNITS)

    // The simulation moved, all the way, at once. It did not compromise and it
    // did not ease toward the answer — a half-corrected world is the world the
    // *next* replay starts from, so the error would compound instead of
    // decaying.
    const settled = originOf(client)
    expect(settled[0]).toBeCloseTo(predicted[0] + 10, 9)

    // And the whole of the difference is in the offset, which is what the
    // camera gets and the simulation never sees.
    expect(correction.offset[0]).toBeCloseTo(predicted[0] - settled[0], 9)
    expect(correction.offset[1]).toBeCloseTo(predicted[1] - settled[1], 9)
    expect(correction.offset[2]).toBeCloseTo(predicted[2] - settled[2], 9)
  })

  it('is loud past thirty units, and still smoothed', () => {
    const { client, pending, snapshot } = diverged({
      acked: 12,
      ticks: 12,
      predicted: FORWARD,
      executed: FORWARD,
      teleportBy: [0, 60, 0],
    })
    const correction = reconcile({
      state: client,
      world: CLIENT_MAP.world,
      slot: 0,
      snapshot,
      pending,
    })
    if (correction === null) throw new Error('a good snapshot was refused')

    expect(correction.band).toBe(CorrectionBand.Loud)
    expect(correction.distance).toBeCloseTo(60, 9)
    // Still carried, and over the longer window: the distance is up to four
    // times as far as an ordinary correction, and a fixed window would make it
    // travel four times as fast, which is the version a player notices.
    expect(correction.offset[1]).toBeCloseTo(-60, 9)
    expect(decayMsFor(correction.band)).toBe(LOUD_DECAY_MS)
  })

  it('is a hard snap past a splash radius, and carries no offset', () => {
    const { client, pending, snapshot } = diverged({
      acked: 12,
      ticks: 12,
      predicted: FORWARD,
      executed: FORWARD,
      // Further than any explosion could have thrown them: a teleport, a
      // telefrag, or a desync.
      teleportBy: [200, 0, 0],
    })

    const correction = reconcile({
      state: client,
      world: CLIENT_MAP.world,
      slot: 0,
      snapshot,
      pending,
    })
    if (correction === null) throw new Error('a good snapshot was refused')

    expect(correction.band).toBe(CorrectionBand.Snap)
    expect(correction.distance).toBeGreaterThan(CORRECTION_SNAP_UNITS)
    // Nothing to smooth: carrying two hundred units of offset would draw the
    // player somewhere they demonstrably are not.
    expect(correction.offset).toEqual([0, 0, 0])
  })

  it('measures the disagreement two different command streams produce', () => {
    // The realistic shape of a correction: the host executed something other
    // than what was predicted, and the replay carries the difference forward.
    const { client, pending, snapshot } = diverged({
      acked: 6,
      ticks: 18,
      predicted: FORWARD,
      executed: BACKWARD,
    })
    const correction = reconcile({
      state: client,
      world: CLIENT_MAP.world,
      slot: 0,
      snapshot,
      pending,
    })
    if (correction === null) throw new Error('a good snapshot was refused')

    expect(correction.replayed).toBe(12)
    expect(correction.distance).toBeGreaterThan(CORRECTION_NOISE_UNITS)
    expect(correction.band).toBe(classifyCorrection(correction.distance))
    expect(correction.band).not.toBe(CorrectionBand.Snap)
  })

  it('replays only what the ack has not seen', () => {
    const { client, pending, snapshot } = diverged({
      acked: 15,
      ticks: 18,
      predicted: FORWARD,
      executed: FORWARD,
    })
    const correction = reconcile({
      state: client,
      world: CLIENT_MAP.world,
      slot: 0,
      snapshot,
      pending,
    })
    expect(correction?.replayed).toBe(3)
  })

  it('adopts the world when there is nothing outstanding at all', () => {
    const { client, host, pending, snapshot } = diverged({
      acked: 12,
      ticks: 12,
      predicted: FORWARD,
      executed: BACKWARD,
    })
    const correction = reconcile({
      state: client,
      world: CLIENT_MAP.world,
      slot: 0,
      snapshot,
      pending,
    })
    expect(correction?.replayed).toBe(0)
    // Exactly the host's world, because there was nothing of ours it had not
    // seen. This is the case that catches a codec with a hole in it.
    expect(hashState(client)).toBe(hashState(host))
  })

  it('refuses a snapshot it cannot read, and leaves the world alone', () => {
    const { client, pending } = diverged({
      acked: 4,
      ticks: 10,
      predicted: FORWARD,
      executed: STILL,
    })
    const before = hashState(client)

    const correction = reconcile({
      state: client,
      world: CLIENT_MAP.world,
      slot: 0,
      snapshot: { t: 'snap', ack: 4, state: [1, 2, 3] },
      pending,
    })

    expect(correction).toBe(null)
    // A client that quietly played on with half a world would be worse than one
    // that ignored the frame and let the hash echo say so.
    expect(hashState(client)).toBe(before)
  })

  it('reports nothing to correct when the world has no body for this slot', () => {
    // A spectator, or a peer whose entity has not been spawned yet. There is
    // nothing to measure a distance between, and inventing one would be a
    // correction nobody asked for.
    const client = world()
    const pending = play(client, FORWARD, 4)
    const host = world()
    play(host, FORWARD, 4)
    host.entities = host.entities.filter((entity) => entity.kind !== EntityKind.Player)

    const correction = reconcile({
      state: client,
      world: CLIENT_MAP.world,
      slot: 0,
      snapshot: snapshotFrame(host, 4),
      pending,
    })
    expect(correction?.band).toBe(CorrectionBand.None)
    expect(correction?.distance).toBe(0)
  })
})
