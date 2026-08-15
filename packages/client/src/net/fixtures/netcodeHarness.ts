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
 * A room seats two, and this seats one. What is being measured here is *this*
 * client's prediction against an authoritative world, and a second peer would
 * add a second uncontrolled input stream to a comparison that is about one.
 * Two peers in one room over two real sockets, playing a round to a decision,
 * is `server/src/duel.test.ts`; the opponent half — entity interpolation — is
 * `interpolate.test.ts`, against a real simulated trajectory on a jittery
 * delivery schedule. What that test does not cover is the socket, and what this
 * one does not cover is the opponent.
 *
 * ## The frame is `main.ts`'s frame
 *
 * Read them side by side. Pump the network, beat the host, let the loopback
 * deliver, advance the two rendering clocks, turn elapsed wall-clock into whole
 * ticks — slewed toward the lead — predict each of them, flush. The only thing
 * missing is the renderer, and what stands in for it is a record of the value
 * the renderer would have drawn: where the eye went.
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
import { stepsFor } from '@gladiator/server/scheduler'

import { advance, alphaOf } from '../../loop.ts'
import {
  createRenderOffset,
  withRenderOffset,
  type RenderOffset,
} from '../../render/renderOffset.ts'
import { interpolateOrigin } from '../../render/view.ts'
import { createNetClient, mustHoldStill, type NetClient } from '../client.ts'
import { shouldSnap, slewMs } from '../clockSync.ts'
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
  // The host's own accumulator, carried between frames exactly as the Node
  // scheduler carries it. Separate from the client's: they are two clocks.
  let hostRemainderMs = 0
  // The label the next command goes out under. Free-running and slewed; never
  // written by a snapshot. See the note in the frame below.
  let commandTick = 0

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

        // The host's frame. The same two calls `listenServer.ts` makes in a tab
        // and `server.ts` makes on Fly: turn the wall-clock that just went past
        // into whole 8 ms sub-steps and run them, then do the housekeeping —
        // clock-sync pings and peers that have gone quiet.
        //
        // `stepsFor` rather than a count this file works out for itself: one
        // accumulator, shared with the shipping scheduler, or the harness would
        // be measuring a host that ticks slightly differently from the real one.
        // Release whatever the network owed us first, then let the loopback
        // carry it the rest of the way — in both directions. Commands that are
        // due land in the host's jitter buffer before the sub-steps that want
        // them, and snapshots are adopted inside this, on the callback, exactly
        // as they are in a tab.
        link.pump(nowMs)
        await settleLoopback(pair)

        const fold = stepsFor(hostRemainderMs, frameMs)
        hostRemainderMs = fold.remainderMs
        room.advance(fold.steps)
        room.sweep(nowMs)
        await settleLoopback(pair)
        link.pump(nowMs)
        await settleLoopback(pair)

        offset.advance(frameMs)
        interp.advance(frameMs, history.newestTick)

        if (mustHoldStill(net.snapshot().status)) {
          accumulatorMs = 0
        } else {
          const cmd = script(frame)
          // The lead, closed by running the *command* clock a few percent fast
          // rather than by jumping it. Without it the client and the host run
          // at the same rate in the same phase, every command arrives one
          // one-way trip after the sub-step that wanted it, and the host spends
          // the match on the missing-command fallback.
          //
          // The counter it steers is `commandTick`, not `predictor.tick`, and
          // that separation is the whole of why this works. The predicted
          // world's tick is the *server's* — a snapshot overwrites it sixty
          // times a second — so steering on it would be steering on a number
          // the host keeps resetting, and the two would fight until every
          // command went out under a label the host had already executed.
          const errorTicks = net.clock.errorTicks(commandTick, nowMs)
          if (shouldSnap(errorTicks)) {
            // Past a quarter of a second of error there is no smooth path: a
            // slew at 12.5% would take seconds. Jumping a *label* costs
            // nothing — the host admits any increasing tick — where jumping a
            // simulated clock would be a lurch the player sees.
            commandTick = net.clock.targetTick(nowMs) ?? commandTick
          }
          const step = advance(accumulatorMs, frameMs + slewMs(errorTicks, frameMs))
          accumulatorMs = step.accumulatorMs
          for (let i = 0; i < step.ticks; i += 1) {
            commandTick += 1
            const hash = predictor.predict(cmd, commandTick)
            sent.push(cmd)
            predictedHashes.set(predictor.tick, hash)
            net.record(predictor.tick, hash)
            net.queue(commandTick, cmd)
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
      // "And then the network went quiet." Three things have to come to rest
      // and they feed each other, which is why this is a loop rather than a
      // pair of calls: the commands still in the air have to be released, the
      // host has to run the sub-steps they were for, and the snapshots that
      // produces have to travel back and be adopted before the client's
      // unacknowledged queue is empty.
      //
      // Bounded, because a harness that could spin forever is a harness that
      // will. A run ends with about a round trip outstanding, so a handful of
      // passes is always enough and the cap is only a backstop.
      for (let pass = 0; pass < 64; pass += 1) {
        link.flush()
        await settleLoopback(pair)
        const queued = room.peers[0]?.queued ?? 0
        if (queued > 0) room.advance(queued)
        link.flush()
        await settleLoopback(pair)
        if (queued === 0 && predictor.pending === 0 && link.inFlight === 0 && pair.idle) break
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
