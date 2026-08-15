/**
 * Clock sync, end to end and then in pieces.
 *
 * The first describe is the one that matters: a real `server/clockSync.ts`
 * pinging a real `client/net/clockSync.ts` through a real
 * `net/laggedTransport.ts`, at 40, 80 and 180 ms of round trip with jitter on
 * both legs, and the estimate has to land within a tick of the truth. The truth
 * is a tick counter derived from wall-clock rather than a room's, which is the
 * same thing a room's counter now is: `server/src/scheduler.ts` advances every
 * world by exactly the sub-steps the elapsed wall-clock is worth. What this file
 * does not carry is the *consumer* of the estimate — the lead the frame loop
 * slews toward — which is measured end to end in `net/netcode.test.ts`.
 *
 * The second is the other half of the ticket's claim, and it is asserted where
 * a player would see it fail: on the **camera position the renderer is handed**,
 * through the real accumulator and the real interpolation, not on sim state.
 */
import {
  EntityKind,
  SKELETON_SEED,
  SURFACE_CLIP_EPSILON,
  TICK_INTERVAL_MS,
  type CollisionWorld,
  type GameState,
  type UserCmd,
  type Vec3,
  boxBrush,
  cloneGameState,
  createCollisionWorld,
  createGameState,
  parseClientMessage,
  parseServerMessage,
  rngInt,
  seedRng,
  spawnEntity,
  tick as simTick,
  vec3,
  type RngHolder,
} from '@gladiator/sim'
import { JITTER_BUFFER_TICKS } from '@gladiator/server/inputQueue'
import {
  PING_INTERVAL_MS,
  createClockSync as createServerClockSync,
} from '@gladiator/server/clockSync'
import { NO_LAG, laggedTransport } from '@gladiator/server/net/laggedTransport'
import { createLoopbackPair, settleLoopback } from '@gladiator/server/net/loopbackTransport'
import { describe, expect, it } from 'vitest'

import { advance, alphaOf } from '../loop.ts'
import { cameraPose, interpolateOrigin } from '../render/view.ts'
import {
  MAX_SLEW,
  SAMPLE_WINDOW,
  SNAP_TICKS,
  createClockSync,
  leadTicksFor,
  shouldSnap,
  slewMs,
} from './clockSync.ts'

/**
 * How far this tab's `performance.now()` is from the server's.
 *
 * A large, ugly number on purpose. Two `performance.now()` origins have nothing
 * whatsoever to do with each other — one is when a page loaded and the other is
 * when a Fly machine booted — and an estimator that quietly assumed they were
 * close would pass a test whose skew was small.
 */
const CLIENT_SKEW_MS = 987_654.321

type Profile = {
  readonly label: string
  readonly rttMs: number
  readonly jitterMs: number
}

const PROFILES: readonly Profile[] = [
  { label: '40 ms', rttMs: 40, jitterMs: 6 },
  { label: '80 ms', rttMs: 80, jitterMs: 8 },
  { label: '180 ms', rttMs: 180, jitterMs: 12 },
]

type Sample = {
  readonly wallMs: number
  readonly estimate: number
  readonly truth: number
}

/**
 * Ping a client through an impaired link for `durationMs` and record what it
 * believed the server's tick was, every step of the way.
 *
 * The harness advances in irregular one-to-three millisecond steps drawn from a
 * seeded PRNG. Uniform steps would land every ping on the same phase of the
 * server's 8 ms tick boundary — `PING_INTERVAL_MS` is a multiple of it — and an
 * estimator would be graded on a much easier problem than the one it has.
 */
async function converse(profile: Profile, durationMs: number): Promise<Sample[]> {
  const pair = createLoopbackPair()
  const link = laggedTransport(pair.client, {
    ...NO_LAG,
    latencyMs: profile.rttMs / 2,
    jitterMs: profile.jitterMs,
    seed: 0x5995_1a00 + profile.rttMs,
  })

  const server = createServerClockSync()
  const client = createClockSync()

  // The truth: the server's tick counter, a step function of its own clock.
  const serverTickAt = (wallMs: number): number => Math.floor(wallMs / TICK_INTERVAL_MS)

  link.setHandlers({
    onMessage: (frame) => {
      if (typeof frame !== 'string') throw new Error('the host answered in binary')
      const parsed = parseServerMessage(frame)
      if (parsed?.t !== 'ping') return
      client.observe(parsed, wallMs + CLIENT_SKEW_MS)
      link.send(JSON.stringify({ t: 'pong', id: parsed.id }))
    },
  })
  // The server end reads pongs off the wire and stops the clock on them.
  pair.server.setHandlers({
    onMessage: (frame) => {
      if (typeof frame !== 'string') return
      const parsed = parseClientMessage(frame)
      if (parsed?.t === 'pong') server.pong(parsed.id, wallMs)
    },
  })

  const steps: RngHolder = { rng: seedRng(0xc10c_5000 + profile.rttMs) }
  const samples: Sample[] = []
  let wallMs = 0
  while (wallMs < durationMs) {
    wallMs += 1 + rngInt(steps, 3)
    if (server.due(wallMs)) {
      pair.server.send(JSON.stringify(server.ping(wallMs, serverTickAt(wallMs), 0)))
    }
    link.pump(wallMs)
    await settleLoopback(pair)

    const estimate = client.serverTick(wallMs + CLIENT_SKEW_MS)
    if (estimate !== null) {
      samples.push({ wallMs, estimate, truth: serverTickAt(wallMs) })
    }
  }
  pair.close()
  return samples
}

describe('the client works out which tick the server is on', () => {
  for (const profile of PROFILES) {
    it(
      `stays within a tick of the truth at ${profile.label} of round trip`,
      { timeout: 60_000 },
      async () => {
        // Long enough to fill the sample window several times over — the
        // estimate is only claimed to be right "after convergence", and this is
        // where that line is.
        const convergedMs = SAMPLE_WINDOW * PING_INTERVAL_MS
        const samples = await converse(profile, convergedMs + 3_000)
        const converged = samples.filter((sample) => sample.wallMs > convergedMs)

        expect(converged.length).toBeGreaterThan(500)

        const errors = converged.map((sample) => sample.estimate - sample.truth)
        const worst = errors.reduce((most, error) => Math.max(most, Math.abs(error)), 0)
        expect(worst, `worst error at ${profile.label}`).toBeLessThanOrEqual(1)

        // And it is not merely *within* a tick — it is usually exactly right.
        // An estimator that answered "truth minus one" forever would satisfy
        // the bound above and be a whole tick of latency nobody asked for.
        const mean = errors.reduce((sum, error) => sum + Math.abs(error), 0) / errors.length
        expect(mean, `mean error at ${profile.label}`).toBeLessThan(0.5)
      },
    )
  }

  it('measures the round trip on the server and reports it back unchanged', async () => {
    const samples = await converse(PROFILES[1] as Profile, 4_000)
    expect(samples.length).toBeGreaterThan(0)

    const client = createClockSync()
    // The client's own view of the trip is whatever the last ping said, and the
    // ping is the only place it can come from — there is no timestamp in a pong
    // for a client to fill in. `sim/src/protocol.ts`.
    client.observe({ t: 'ping', id: 0, tick: 100, rttMs: 83, queued: 2 }, 1_000)
    expect(client.rttMs).toBe(83)
    expect(client.queued).toBe(2)
  })

  it('knows nothing before the first ping, and says so', () => {
    const client = createClockSync()
    expect(client.serverTick(1234)).toBe(null)
    expect(client.targetTick(1234)).toBe(null)
    // Zero rather than a guess: a caller on the hot path should not have to
    // branch, and "no correction" is the right answer when there is no estimate.
    expect(client.errorTicks(50, 1234)).toBe(0)
  })

  it('leads by half the trip plus the buffer the server wants to be holding', () => {
    expect(leadTicksFor(-1)).toBe(JITTER_BUFFER_TICKS)
    expect(leadTicksFor(0)).toBe(JITTER_BUFFER_TICKS)
    // 80 ms round trip is 40 ms one way, which is five ticks.
    expect(leadTicksFor(80)).toBe(5 + JITTER_BUFFER_TICKS)
    // Rounded up: arriving a fraction of a tick early costs a fraction of a
    // tick, and arriving late costs a fallback command.
    expect(leadTicksFor(81)).toBe(6 + JITTER_BUFFER_TICKS)
  })
})

/* --------------------------------------------------------------------------
 * The correction, measured where a player would see it
 * ----------------------------------------------------------------------- */

/** A floor and nothing else, so a sprint measures the movement and not a wall. */
const OPEN_FLOOR: CollisionWorld = createCollisionWorld([
  boxBrush([-16384, -16384, -64], [16384, 16384, 0]),
])

const SPRINT: UserCmd = {
  forwardMove: 1,
  sideMove: 0,
  yaw: 0,
  pitch: 0,
  buttons: 0,
  weapon: 0,
}

/** 60 Hz, and deliberately not a divisor of the 8 ms tick. */
const FRAME_MS = 1000 / 60

function standingPlayer(): GameState {
  const state = createGameState(SKELETON_SEED)
  spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    origin: vec3(0, 0, SURFACE_CLIP_EPSILON),
    health: 100,
  })
  return state
}

function originOf(state: GameState): Vec3 {
  const origin = state.entities[0]?.origin ?? [0, 0, 0]
  return [origin[0] ?? 0, origin[1] ?? 0, origin[2] ?? 0]
}

/**
 * Run the real client frame loop and return the distance the **camera** moved
 * on each frame.
 *
 * This is `main.ts`'s frame, minus the renderer: the same accumulator, the same
 * `tick()`, the same `interpolateOrigin` between the previous and current
 * states, and the same `cameraPose`. What comes out is what Babylon would have
 * been handed, which is what a player would have seen jump.
 *
 * `correct` is handed the frame's elapsed time and returns the milliseconds the
 * clock correction adds to it — the seam every clock adjustment goes through.
 */
function cameraSteps(frames: number, correct: (frame: number, elapsedMs: number) => number): number[] {
  const state = standingPlayer()
  let previous = cloneGameState(state)
  let accumulatorMs = 0
  let last: Vec3 | null = null
  const steps: number[] = []

  for (let frame = 0; frame < frames; frame += 1) {
    const step = advance(accumulatorMs, FRAME_MS + correct(frame, FRAME_MS))
    accumulatorMs = step.accumulatorMs
    for (let i = 0; i < step.ticks; i += 1) {
      previous = cloneGameState(state)
      simTick(state, [SPRINT], OPEN_FLOOR)
    }

    const eye = cameraPose({
      origin: interpolateOrigin(
        { origin: originOf(previous) },
        { origin: originOf(state) },
        alphaOf(accumulatorMs),
      ),
      yawUnits: SPRINT.yaw,
      pitchUnits: SPRINT.pitch,
    }).position
    if (last !== null) {
      const dx = eye[0] - last[0]
      const dy = eye[1] - last[1]
      const dz = eye[2] - last[2]
      steps.push(Math.sqrt(dx * dx + dy * dy + dz * dz))
    }
    last = eye
  }
  return steps
}

/** Frames after the sprint has reached a steady speed, where a jump would show. */
const SETTLED = 40

function worstAfterSettling(steps: readonly number[]): number {
  return steps.slice(SETTLED).reduce((most, step) => Math.max(most, step), 0)
}

describe('a clock adjustment does not move the camera', () => {
  const baseline = cameraSteps(140, () => 0)
  const nominal = worstAfterSettling(baseline)

  it('sprints far enough for a three-tick jump to be worth hiding', () => {
    // 24 ms of movement at ~320 qu/s is about eight units, half again as far as
    // a whole frame. If the camera were not moving, none of this would prove
    // anything.
    expect(nominal).toBeGreaterThan(4)
  })

  it('slews three ticks away without a single frame stepping further than the slew allows', () => {
    // The closed loop: an error of three ticks appears, `slewMs` hands the
    // accumulator a bounded correction each frame, and the error shrinks by
    // exactly what it was handed.
    let errorTicks = 0
    let corrected = 0
    const steps = cameraSteps(140, (frame, elapsedMs) => {
      if (frame === 60) errorTicks = 3
      const slew = slewMs(errorTicks, elapsedMs)
      errorTicks -= slew / TICK_INTERVAL_MS
      if (slew !== 0) corrected += 1
      return slew
    })

    // It really did correct, and it took a while about it rather than sneaking
    // the whole thing into one frame.
    expect(corrected).toBeGreaterThan(8)
    expect(Math.abs(errorTicks)).toBeLessThan(0.01)

    // The claim: no frame moved the camera further than a frame running
    // `MAX_SLEW` fast. That is a rate change, not a discontinuity.
    const worst = worstAfterSettling(steps)
    expect(worst).toBeLessThanOrEqual(nominal * (1 + MAX_SLEW) + 1e-6)
  })

  it('and the assertion has teeth: snapping the same three ticks does lurch', () => {
    const steps = cameraSteps(140, (frame) => (frame === 60 ? 3 * TICK_INTERVAL_MS : 0))
    expect(worstAfterSettling(steps)).toBeGreaterThan(nominal * 1.5)
  })
})

describe('slewMs', () => {
  it('never adds more than an eighth of the frame', () => {
    expect(slewMs(100, 16)).toBe(MAX_SLEW * 16)
    expect(slewMs(-100, 16)).toBe(-MAX_SLEW * 16)
  })

  it('never overshoots an error smaller than the limit', () => {
    // Handing back more than the error is how a correction becomes a permanent
    // oscillation between two wrong answers.
    expect(slewMs(0.1, 16)).toBeCloseTo(0.8, 10)
    expect(slewMs(0, 16)).toBe(0)
  })

  it('treats a frame that did not happen as no room to correct in', () => {
    expect(slewMs(3, 0)).toBe(0)
    expect(slewMs(3, -5)).toBe(0)
  })
})

describe('shouldSnap', () => {
  it('slews an ordinary drift and gives up on a backgrounded tab', () => {
    expect(shouldSnap(3)).toBe(false)
    expect(shouldSnap(-3)).toBe(false)
    expect(shouldSnap(SNAP_TICKS)).toBe(false)
    // 240 ms out is not drift, it is a tab that was somewhere else. Slewing it
    // would mean two seconds of a visibly fast world.
    expect(shouldSnap(SNAP_TICKS + 1)).toBe(true)
    expect(shouldSnap(-(SNAP_TICKS + 1))).toBe(true)
  })
})
