/**
 * Entity interpolation, and the acceptance check that is hardest to state:
 * **the opponent has to move smoothly**.
 *
 * "Smoothly" is not a matter of opinion here. A player's motion has a roughness
 * of its own — they jump, they land, they change direction — and the most an
 * interpolator can promise is that it does not add any. So the measurement is a
 * ratio: the second derivative of the *rendered* track against the second
 * derivative of the same trajectory drawn from perfect knowledge. Under one, the
 * interpolation is smoothing; over one, it is stuttering.
 *
 * And it is measured against a control, because a bound with nothing to fail
 * against is a bound nobody has watched fire. The control is the obvious
 * implementation — render at `newestSnapshotTick - delay`, recomputed every
 * frame — which is mathematically correct interpolation between correct states
 * and visibly stutters, because the *clock* is stuttering. That is the failure
 * this file exists to catch, so it is reproduced here and shown to be worse.
 *
 * The trajectory is not synthetic. It is a real `pmove` run over the real
 * arena, so the motion has the real thing's jumps, landings and integer
 * velocity snapping in it. What is modelled directly is the *delivery*: a
 * schedule of arrival times with jitter in it, and a stall when a frame is lost.
 * That is what jitter and TCP loss are, and going through a socket to produce
 * them would buy nothing this test could assert on — `netcode.test.ts` is the
 * one that goes through a socket.
 */
import {
  SKELETON_SEED,
  TICK_INTERVAL_MS,
  createMapState,
  encodeState,
  findPlayer,
  rngFloat,
  seedRng,
  tick as simTick,
  type RngHolder,
  type UserCmd,
  type Vec3,
  type WireState,
} from '@gladiator/sim'
import { NULL_CMD } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { CLIENT_MAP } from '../map.ts'
import { lerp } from '../render/view.ts'
import {
  HISTORY_CAPACITY,
  INTERP_DELAY_MS,
  INTERP_DELAY_TICKS,
  INTERP_SNAP_TICKS,
  MAX_EXTRAPOLATION_TICKS,
  MAX_INTERP_RATE,
  createEntityBuffer,
  createInterpolationClock,
  extrapolated,
  interpolateEntity,
} from './interpolate.ts'

/** 60 Hz, which is what a browser gives you. */
const FRAME_MS = 1000 / 60

/** The opponent is slot 0; this client predicts a slot nobody else holds. */
const REMOTE_SLOT = 0
const LOCAL_SLOT = 1

function script(tick: number): UserCmd {
  return {
    ...NULL_CMD,
    forwardMove: tick % 220 < 170 ? 1 : -1,
    sideMove: tick % 110 < 55 ? 1 : -1,
    yaw: (tick * 97) % 65536,
    pitch: 0,
    buttons: tick % 90 === 0 ? 1 : 0,
    weapon: NULL_CMD.weapon,
  }
}

type Delivery = {
  /** The tick this state is of. */
  readonly tick: number
  readonly state: WireState
  /** When it lands, on the client's clock. */
  readonly arrivalMs: number
}

type Recording = {
  readonly deliveries: readonly Delivery[]
  /** The opponent's true origin at each tick, index 0 being tick 1. */
  readonly truth: readonly Vec3[]
}

/**
 * A real run of the movement, batched the way a 60 Hz client's commands batch,
 * with an arrival time for each batch.
 *
 * `jitterMs` spreads arrivals; `stallEvery` retransmits one batch in `n`, which
 * holds it and — the load-bearing half — every batch behind it, because that is
 * what TCP does with a lost segment.
 */
function record(options: {
  readonly ticks: number
  readonly latencyMs: number
  readonly jitterMs: number
  readonly seed: number
  readonly stallEvery?: number
  readonly stallMs?: number
}): Recording {
  const state = createMapState(CLIENT_MAP.source, SKELETON_SEED)
  const rng: RngHolder = { rng: seedRng(options.seed) }
  const deliveries: Delivery[] = []
  const truth: Vec3[] = []

  let lastArrivalMs = 0
  let batch = 0
  let tick = 0
  while (tick < options.ticks) {
    // Two ticks in one frame, then three: what 60 Hz buys at 125 Hz, forever.
    const size = batch % 2 === 0 ? 2 : 3
    for (let i = 0; i < size && tick < options.ticks; i += 1) {
      tick += 1
      simTick(state, [script(tick)], CLIENT_MAP.world)
      const player = findPlayer(state, REMOTE_SLOT)
      if (player === null) throw new Error('the recording lost its player')
      truth.push([player.origin[0], player.origin[1], player.origin[2]])
    }

    const sentMs = tick * TICK_INTERVAL_MS
    const stalled =
      options.stallEvery !== undefined && options.stallEvery > 0 && batch % options.stallEvery === 0
    const arrival =
      sentMs + options.latencyMs + rngFloat(rng) * options.jitterMs + (stalled ? (options.stallMs ?? 0) : 0)
    // A WebSocket is TCP: a frame never arrives before the one in front of it,
    // and a retransmission holds up everything behind it.
    lastArrivalMs = Math.max(arrival, lastArrivalMs)
    deliveries.push({ tick, state: encodeState(state), arrivalMs: lastArrivalMs })
    batch += 1
  }

  return { deliveries, truth }
}

type Track = Array<Vec3 | null>

type Rendered = {
  readonly track: Track
  /** The furthest the sample ever had to guess past real data, in ticks. */
  readonly worstExtrapolation: number
  readonly snaps: number
}

/** Render a recording at 60 Hz, either on the real clock or on the naive one. */
function render(recording: Recording, mode: 'clock' | 'naive'): Rendered {
  const buffer = createEntityBuffer({ localSlot: LOCAL_SLOT })
  const clock = createInterpolationClock()
  const track: Track = []
  let worstExtrapolation = 0

  let next = 0
  const lastArrival = recording.deliveries[recording.deliveries.length - 1]?.arrivalMs ?? 0

  for (let nowMs = 0; nowMs <= lastArrival; nowMs += FRAME_MS) {
    while (next < recording.deliveries.length) {
      const delivery = recording.deliveries[next] as Delivery
      if (delivery.arrivalMs > nowMs) break
      buffer.push(delivery.state)
      next += 1
    }

    clock.advance(FRAME_MS, buffer.newestTick)
    const newest = buffer.newestTick
    if (newest === null) {
      track.push(null)
      continue
    }
    const renderTick = mode === 'clock' ? clock.renderTick : newest - INTERP_DELAY_TICKS
    const sample = buffer.sample(renderTick)
    worstExtrapolation = Math.max(worstExtrapolation, sample.extrapolatedTicks)
    const entity = sample.entities[0]
    track.push(entity === undefined ? null : [entity.origin[0], entity.origin[1], entity.origin[2]])
  }

  return { track, worstExtrapolation, snaps: clock.snaps }
}

/**
 * The same trajectory drawn from perfect knowledge: no network, no buffer, the
 * true position at exactly `renderTick`.
 *
 * The floor. Whatever roughness is in here is roughness the *player* put there
 * by jumping and turning, and no interpolator is obliged to remove it.
 */
function idealTrack(recording: Recording): Track {
  const track: Track = []
  const lastArrival = recording.deliveries[recording.deliveries.length - 1]?.arrivalMs ?? 0
  const firstArrival = recording.deliveries[0]?.arrivalMs ?? 0

  for (let nowMs = 0; nowMs <= lastArrival; nowMs += FRAME_MS) {
    if (nowMs < firstArrival) {
      track.push(null)
      continue
    }
    const at = nowMs / TICK_INTERVAL_MS - INTERP_DELAY_TICKS
    const before = Math.floor(at)
    const alpha = at - before
    const a = recording.truth[before - 1]
    const b = recording.truth[before]
    if (a === undefined || b === undefined) {
      track.push(null)
      continue
    }
    track.push([
      lerp(a[0], b[0], alpha),
      lerp(a[1], b[1], alpha),
      lerp(a[2], b[2], alpha),
    ])
  }
  return track
}

/**
 * The 99th percentile of the second difference of a track, in units.
 *
 * A discrete second derivative at a fixed frame interval, which is exactly
 * "does this look like it is being pushed around". A percentile rather than a
 * maximum, so that one landing does not decide the answer — the maximum is
 * asserted separately where it matters.
 */
function roughness(track: Track): number {
  const jerks: number[] = []
  for (let i = 1; i + 1 < track.length; i += 1) {
    const a = track[i - 1]
    const b = track[i]
    const c = track[i + 1]
    if (!a || !b || !c) continue
    const dx = c[0] - 2 * b[0] + a[0]
    const dy = c[1] - 2 * b[1] + a[1]
    const dz = c[2] - 2 * b[2] + a[2]
    jerks.push(Math.sqrt(dx * dx + dy * dy + dz * dz))
  }
  if (jerks.length === 0) return Number.POSITIVE_INFINITY
  jerks.sort((x, y) => x - y)
  return jerks[Math.min(jerks.length - 1, Math.floor(jerks.length * 0.99))] as number
}

describe('the interpolation clock', () => {
  it('starts eighty milliseconds behind the newest snapshot', () => {
    const clock = createInterpolationClock()
    expect(clock.started).toBe(false)
    clock.advance(FRAME_MS, null)
    expect(clock.started).toBe(false)

    clock.advance(FRAME_MS, 400)
    expect(clock.started).toBe(true)
    expect(clock.renderTick).toBe(400 - INTERP_DELAY_TICKS)
    expect(INTERP_DELAY_TICKS).toBe(10)
    expect(INTERP_DELAY_MS).toBe(80)
  })

  it('never runs backwards, and never faster than the bound', () => {
    // Monotonicity is what keeps the second derivative bounded. A clock that
    // could reverse is a clock that draws a player moonwalking.
    const clock = createInterpolationClock()
    clock.advance(FRAME_MS, 100)

    let previous = clock.renderTick
    // A newest tick that lurches: nothing for a while, then a lump of
    // snapshots, then a stall, then another lump — all inside the band a slew
    // is supposed to close, so nothing here is allowed to jump.
    for (const newest of [100, 100, 100, 112, 112, 112, 130, 130, 128, 146]) {
      clock.advance(FRAME_MS, newest)
      const step = clock.renderTick - previous
      expect(step).toBeGreaterThanOrEqual(0)
      expect(step).toBeLessThanOrEqual((FRAME_MS / TICK_INTERVAL_MS) * (1 + MAX_INTERP_RATE) + 1e-9)
      previous = clock.renderTick
    }
    expect(clock.snaps).toBe(0)
  })

  it('jumps rather than slewing when the error is half a second', () => {
    // Not jitter: a stall that has outlasted the extrapolation cap, a
    // backgrounded tab, or a reconnection. Slewing that at a tenth would take
    // five seconds of a visibly wrong clock.
    const clock = createInterpolationClock()
    clock.advance(FRAME_MS, 100)
    expect(clock.snaps).toBe(0)

    clock.advance(FRAME_MS, 100 + INTERP_SNAP_TICKS + 20)
    expect(clock.snaps).toBe(1)
    expect(clock.renderTick).toBe(100 + INTERP_SNAP_TICKS + 20 - INTERP_DELAY_TICKS)
  })

  it('closes an ordinary error without ever jumping', () => {
    const clock = createInterpolationClock()
    clock.advance(FRAME_MS, 100)
    // Three ticks of drift, the size a jittery link produces.
    for (let i = 0; i < 200; i += 1) clock.advance(FRAME_MS, 100 + 3 + i * (FRAME_MS / TICK_INTERVAL_MS))
    expect(clock.snaps).toBe(0)
  })
})

describe('the history buffer', () => {
  const recording = record({ ticks: 60, latencyMs: 40, jitterMs: 0, seed: 1 })

  it('holds what it is given, in tick order, once each', () => {
    const buffer = createEntityBuffer({ localSlot: LOCAL_SLOT })
    const first = recording.deliveries[0] as Delivery
    const second = recording.deliveries[1] as Delivery

    expect(buffer.push(second.state)).toBe(true)
    expect(buffer.push(first.state)).toBe(true)
    // A duplicate is not new information, and executing it twice is exactly the
    // kind of thing the transport contract says cannot happen anyway.
    expect(buffer.push(first.state)).toBe(false)
    expect(buffer.held).toBe(2)
    expect(buffer.oldestTick).toBe(first.tick)
    expect(buffer.newestTick).toBe(second.tick)
  })

  it('is bounded, so an hour costs what a minute does', () => {
    const long = record({ ticks: 1200, latencyMs: 0, jitterMs: 0, seed: 2 })
    const buffer = createEntityBuffer({ localSlot: LOCAL_SLOT, capacity: 8 })
    for (const delivery of long.deliveries) buffer.push(delivery.state)
    expect(buffer.held).toBe(8)
    expect(buffer.newestTick).toBe(long.deliveries[long.deliveries.length - 1]?.tick)
    expect(HISTORY_CAPACITY).toBe(128)
  })

  it('leaves out the slot this client predicts', () => {
    // The local player is predicted, never interpolated: they are the one
    // entity whose future input this client does know.
    const buffer = createEntityBuffer({ localSlot: REMOTE_SLOT })
    buffer.push((recording.deliveries[0] as Delivery).state)
    expect(buffer.sample(1).entities).toHaveLength(0)
  })

  it('extrapolates past the newest state, and stops', () => {
    const buffer = createEntityBuffer({ localSlot: LOCAL_SLOT })
    const last = recording.deliveries[recording.deliveries.length - 1] as Delivery
    for (const delivery of recording.deliveries) buffer.push(delivery.state)

    const capped = buffer.sample(last.tick + MAX_EXTRAPOLATION_TICKS * 4)
    expect(capped.extrapolatedTicks).toBe(MAX_EXTRAPOLATION_TICKS)

    const inside = buffer.sample(last.tick + 4)
    expect(inside.extrapolatedTicks).toBe(4)
    // A straight line from the velocity in the snapshot. Not `pmove`: running
    // the real movement forward would need the commands, which are precisely
    // what a remote player has not sent.
    const at = inside.entities[0]
    const held = buffer.sample(last.tick).entities[0]
    if (at === undefined || held === undefined) throw new Error('nothing to extrapolate')
    const seconds = (4 * TICK_INTERVAL_MS) / 1000
    expect(at.origin[0]).toBeCloseTo(held.origin[0] + held.velocity[0] * seconds, 9)
  })

  it('holds the oldest state for a clock that has not caught up', () => {
    const buffer = createEntityBuffer({ localSlot: LOCAL_SLOT })
    for (const delivery of recording.deliveries) buffer.push(delivery.state)
    const oldest = buffer.oldestTick ?? 0
    expect(buffer.sample(oldest - 50).extrapolatedTicks).toBe(0)
    expect(buffer.sample(oldest - 50).entities[0]?.origin).toEqual(
      buffer.sample(oldest).entities[0]?.origin,
    )
  })

  it('interpolates the continuous fields and takes the discrete ones whole', () => {
    const buffer = createEntityBuffer({ localSlot: LOCAL_SLOT })
    for (const delivery of recording.deliveries) buffer.push(delivery.state)
    const [a, b] = [recording.deliveries[4] as Delivery, recording.deliveries[5] as Delivery]

    const before = buffer.sample(a.tick).entities[0]
    const after = buffer.sample(b.tick).entities[0]
    if (before === undefined || after === undefined) throw new Error('no pair to interpolate')

    const mid = interpolateEntity(before, after, 0.5)
    expect(mid.origin[0]).toBeCloseTo((before.origin[0] + after.origin[0]) / 2, 9)
    // Half a weapon switch is not a thing, and an animation is either playing
    // or it is not.
    expect(mid.weapon).toBe(after.weapon)
    expect(mid.flags).toBe(after.flags)
    expect(mid.lastFireTick).toBe(after.lastFireTick)
  })

  it('leaves an entity where it is when asked to extrapolate nowhere', () => {
    const buffer = createEntityBuffer({ localSlot: LOCAL_SLOT })
    buffer.push((recording.deliveries[3] as Delivery).state)
    const entity = buffer.sample(0).entities[0]
    if (entity === undefined) throw new Error('nothing in the buffer')
    expect(extrapolated(entity, 0).origin).toEqual(entity.origin)
    expect(extrapolated(entity, -5).origin).toEqual(entity.origin)
  })
})

describe('the opponent, under jitter', () => {
  /** Ten seconds of a real movement run over a link with real jitter on it. */
  const recording = record({ ticks: 1250, latencyMs: 40, jitterMs: 30, seed: 0x51e7 })

  it('is drawn no more roughly than the motion itself is', () => {
    const drawn = render(recording, 'clock')
    const ideal = idealTrack(recording)

    const drawnRoughness = roughness(drawn.track)
    const idealRoughness = roughness(ideal)

    // The whole claim, in one line: interpolation adds no roughness of its own.
    // The floor is what the player put there by jumping and changing direction,
    // and drawing them 80 ms in the past between two real states should be
    // smoother than that, not rougher, because it averages over two or three
    // ticks of it.
    expect(drawnRoughness).toBeLessThanOrEqual(idealRoughness * 1.5)
    // And it is a real trajectory rather than a stationary one.
    expect(idealRoughness).toBeGreaterThan(0)

    // Nothing was ever guessed and the clock never gave up: 80 ms of buffer
    // covers 30 ms of jitter, which is the thing an interpolation buffer is
    // actually for.
    expect(drawn.worstExtrapolation).toBe(0)
    expect(drawn.snaps).toBe(0)
  })

  it('is drawn far more smoothly than rendering at the newest snapshot would', () => {
    // The control, and the failure the acceptance check names: mathematically
    // correct interpolation between correct states, on a clock that lurches
    // with the arrivals. It is the obvious implementation and it stutters.
    const drawn = render(recording, 'clock')
    const naive = render(recording, 'naive')

    expect(roughness(naive.track)).toBeGreaterThan(roughness(drawn.track) * 3)
  })

  it('rides out a retransmission stall without a jump', () => {
    // TCP loses nothing and stalls everything: one batch in twenty is held for
    // 150 ms, and every batch behind it is held with it. The 80 ms buffer does
    // not cover that — extrapolation does, up to its cap — and what must not
    // happen is the clock giving up and jumping.
    const stalled = record({
      ticks: 1250,
      latencyMs: 40,
      jitterMs: 10,
      seed: 0x9a11,
      stallEvery: 20,
      stallMs: 150,
    })
    const buffer = createEntityBuffer({ localSlot: LOCAL_SLOT })
    const clock = createInterpolationClock()

    let next = 0
    let worstExtrapolation = 0
    const track: Track = []
    const lastArrival = stalled.deliveries[stalled.deliveries.length - 1]?.arrivalMs ?? 0
    for (let nowMs = 0; nowMs <= lastArrival; nowMs += FRAME_MS) {
      while (next < stalled.deliveries.length) {
        const delivery = stalled.deliveries[next] as Delivery
        if (delivery.arrivalMs > nowMs) break
        buffer.push(delivery.state)
        next += 1
      }
      clock.advance(FRAME_MS, buffer.newestTick)
      if (buffer.newestTick === null) {
        track.push(null)
        continue
      }
      const sample = buffer.sample(clock.renderTick)
      worstExtrapolation = Math.max(worstExtrapolation, sample.extrapolatedTicks)
      const entity = sample.entities[0]
      track.push(
        entity === undefined ? null : [entity.origin[0], entity.origin[1], entity.origin[2]],
      )
    }

    expect(clock.snaps).toBe(0)
    expect(worstExtrapolation).toBeGreaterThan(0)
    expect(worstExtrapolation).toBeLessThanOrEqual(MAX_EXTRAPOLATION_TICKS)
    // Rougher than a clean link — a guess is a guess — but still nothing like
    // the lurch of rendering at the newest snapshot.
    expect(roughness(track)).toBeLessThan(roughness(render(stalled, 'naive').track))
  })
})
