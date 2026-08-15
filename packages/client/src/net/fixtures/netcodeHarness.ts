/**
 * A whole client, a whole host, and a bad network between them — in virtual
 * time.
 *
 * This is what the netcode acceptance checks are measured on, and its one
 * design rule is that it drives the *shipping* code. The client is
 * `createNetClient` talking to a `Transport`; the world is advanced by
 * `createPredictor`; the corrections come out of `reconcile.ts`; the opponent
 * buffer and its clock are `interpolate.ts`; the eye has `renderOffset.ts`
 * added to it. Nothing is reimplemented, because a harness that reimplements
 * the thing it measures measures the reimplementation.
 *
 * The host is a real `Room` over a real loopback, wrapped in
 * `laggedTransport.ts`. Time is a number this file owns: `pump(nowMs)` releases
 * whatever is due, `manualClock` tells the room what time it is, and a minute
 * of play at 60 frames a second costs CI no wall-clock at all. A failure is
 * therefore a profile and a seed rather than an anecdote.
 *
 * ## One seat, on purpose
 *
 * A `Room` today advances its world by exactly the batch it was handed
 * (`server/session.ts`), so two peers in one room would each advance it by
 * their own commands and the world would run at twice the rate with each player
 * moving on half the ticks. That is not a bug in this harness — it is the
 * question `room.ts` says is answered by a scheduler draining one command per
 * peer per tick, and that scheduler is GLAD-FHKBN8. Seating a second peer here
 * would mean building it, so this harness seats one, and the half of this
 * ticket that needs an opponent — entity interpolation — is measured in
 * `interpolate.test.ts` against a real simulated trajectory delivered on a
 * jittery schedule. What that test does not cover is the socket, and what this
 * one does not cover is the opponent.
 *
 * ## The frame is `main.ts`'s frame
 *
 * Read them side by side. Pump the network, let the loopback deliver, advance
 * the two rendering clocks, turn elapsed wall-clock into whole ticks, predict
 * each of them, flush. The only thing missing is the renderer, and what stands
 * in for it is a record of the value the renderer would have drawn: where the
 * eye went.
 */
import {
  EntityKind,
  NULL_CMD,
  SKELETON_SEED,
  createMapState,
  type GameState,
  type LoadedMap,
  type UserCmd,
  type Vec3,
} from '@gladiator/sim'
import { manualClock } from '@gladiator/server/clock'
import {
  laggedTransport,
  type LagProfile,
  type LaggedTransport,
} from '@gladiator/server/net/laggedTransport'
import {
  createLoopbackPair,
  settleLoopback,
  type LoopbackPair,
} from '@gladiator/server/net/loopbackTransport'
import { createRoom, type Room } from '@gladiator/server/room'

import { advance, alphaOf } from '../../loop.ts'
import {
  createRenderOffset,
  withRenderOffset,
  type RenderOffset,
} from '../../render/renderOffset.ts'
import { interpolateOrigin } from '../../render/view.ts'
import { createNetClient, mustHoldStill, type NetClient } from '../client.ts'
import {
  createEntityBuffer,
  createInterpolationClock,
  type EntityBuffer,
  type InterpolationClock,
} from '../interpolate.ts'
import { createPredictor, type Predictor } from '../prediction.ts'
import { CorrectionBand, decayMsFor, type Correction } from '../reconcile.ts'

/** 60 Hz, which is what a browser gives you and what the batching is shaped by. */
export const FRAME_MS = 1000 / 60

/** What the player is holding down on a given frame. */
export type PlayerScript = (frame: number) => UserCmd

export type PlayedSession = {
  readonly room: Room
  readonly net: NetClient
  readonly predictor: Predictor
  readonly history: EntityBuffer
  readonly interp: InterpolationClock
  readonly offset: RenderOffset
  readonly link: LaggedTransport
  /** Every correction reconciliation produced, in order. */
  readonly corrections: readonly Correction[]
  /** The commands predicted, in tick order. The reference trace's input. */
  readonly sent: readonly UserCmd[]
  /** The hash predicted for each tick. */
  readonly predictedHashes: ReadonlyMap<number, number>
  /** Where the camera was put, once per frame. */
  readonly eyes: readonly Vec3[]
  readonly nowMs: number
  /** Run `frames` frames of virtual time. */
  run(frames: number): Promise<void>
  /**
   * Let everything still in the air arrive.
   *
   * A run ends with about a round trip of commands in flight and the
   * acknowledgements for them not yet sent, which is a perfectly ordinary state
   * for a live session and a useless one to assert against. This is the
   * "and then the network went quiet" that lets a test compare two endpoints.
   */
  drain(): Promise<void>
  stop(): void
}

export type SessionOptions = {
  readonly map: LoadedMap
  readonly profile: LagProfile
  readonly script?: PlayerScript
  /** Milliseconds a frame. 60 Hz unless a test wants something else. */
  readonly frameMs?: number
}

/**
 * A script with a turn, a strafe and a jump in it.
 *
 * The continuous turn is what drags every quadrant of the trig through the run;
 * a stream that only ever faced one way would agree about a much smaller part
 * of the simulation than it appears to.
 */
export function playScript(frame: number): UserCmd {
  return {
    ...NULL_CMD,
    forwardMove: frame % 140 < 110 ? 1 : -1,
    sideMove: frame % 70 < 35 ? 1 : -1,
    yaw: (frame * 211) % 65536,
    pitch: 0,
    buttons: frame % 53 === 0 ? 1 : 0,
    weapon: NULL_CMD.weapon,
  }
}

export function playSession(options: SessionOptions): PlayedSession {
  const frameMs = options.frameMs ?? FRAME_MS
  const script = options.script ?? playScript
  const map = options.map

  const clock = manualClock()
  const room = createRoom({
    map,
    clock,
    build: 'harness',
    peerId: (index) => `harness-${index}`,
  })

  const pair: LoopbackPair = createLoopbackPair()
  room.join(pair.server)

  // The impairment sits on the *client's* end, which is where a real one is:
  // the host is at the far side of a wire it does not own.
  const link = laggedTransport(pair.client, options.profile)

  const state = createMapState(map.source, SKELETON_SEED)
  const predictor = createPredictor({ state, world: map.world, slot: 0 })
  const history = createEntityBuffer({ localSlot: 0 })
  const interp = createInterpolationClock()
  const offset = createRenderOffset()

  const corrections: Correction[] = []
  const sent: UserCmd[] = []
  const predictedHashes = new Map<number, number>()
  const eyes: Vec3[] = []
  let nowMs = 0
  let accumulatorMs = 0

  const net = createNetClient({
    transport: link,
    endpoint: 'the harness',
    build: 'harness',
    mapHash: map.hash,
    now: () => nowMs,
    onSnapshot: (snapshot) => {
      history.push(snapshot.state)
      const correction = predictor.accept(snapshot)
      if (correction === null) return
      corrections.push(correction)
      if (correction.band === CorrectionBand.Snap) offset.clear()
      else offset.push(correction.offset, decayMsFor(correction.band))
    },
  })
  net.connect()

  return {
    room,
    net,
    predictor,
    history,
    interp,
    offset,
    link,
    corrections,
    sent,
    predictedHashes,
    eyes,

    get nowMs() {
      return nowMs
    },

    async run(frames: number) {
      for (let frame = 0; frame < frames; frame += 1) {
        nowMs += frameMs
        clock.set(nowMs)

        // The host's housekeeping beat — clock-sync pings, idle peers. It never
        // advances the world: a room's world advances by commands.
        room.sweep(nowMs)
        await settleLoopback(pair)

        // Release whatever the network owed us, then let the loopback carry it
        // the rest of the way. Snapshots are adopted inside this, on the
        // callback, exactly as they are in a tab.
        link.pump(nowMs)
        await settleLoopback(pair)

        offset.advance(frameMs)
        interp.advance(frameMs, history.newestTick)

        if (mustHoldStill(net.snapshot().status)) {
          accumulatorMs = 0
        } else {
          const cmd = script(frame)
          const step = advance(accumulatorMs, frameMs)
          accumulatorMs = step.accumulatorMs
          for (let i = 0; i < step.ticks; i += 1) {
            const hash = predictor.predict(cmd)
            sent.push(cmd)
            predictedHashes.set(predictor.tick, hash)
            net.record(predictor.tick, hash)
            net.queue(predictor.tick, cmd)
          }
          net.flush()
        }

        const alpha = alphaOf(accumulatorMs)
        eyes.push(
          withRenderOffset(
            interpolateOrigin(
              { origin: predictor.previousOrigin },
              { origin: localOrigin(predictor.state, 0) },
              alpha,
            ),
            offset.value,
          ),
        )

        await settleLoopback(pair)
      }
    },

    async drain() {
      // Twice each way: releasing the outbound commands produces replies, which
      // are then held by the same link and need releasing in their turn.
      for (let pass = 0; pass < 4; pass += 1) {
        link.flush()
        await settleLoopback(pair)
      }
    },

    stop() {
      pair.close()
    },
  }
}

function localOrigin(state: GameState, slot: number): Vec3 {
  const player = state.entities.find(
    (entity) => entity.kind === EntityKind.Player && entity.slot === slot,
  )
  return player === undefined ? [0, 0, 0] : [player.origin[0], player.origin[1], player.origin[2]]
}
