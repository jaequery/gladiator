/**
 * The listen server: the authoritative host, running in this tab.
 *
 * This is the point of the whole ticket. `createRoom` is the same module the
 * Node server runs — not a browser port of it, not an offline mode that
 * resembles it — and the client talks to it through a `Transport`, exactly as
 * it talks to Fly. Single-player therefore exercises the handshake, the map
 * hash check, the framing, the codec, the command batching and the hash echo,
 * every time anybody plays alone.
 *
 * How Quake, Source and most engines have always done it, and for the same
 * reason: the alternative is two implementations of the rules, and the second
 * one is always the one with the bug.
 *
 * ## What it costs
 *
 * A microtask per frame each way, and a UTF-8 encode/decode of a few hundred
 * bytes. Not a Web Worker: at roughly forty microseconds a tick the jank
 * isolation buys nothing, and it would cost structured-clone marshalling,
 * materially worse debugging, and — the moment anyone reached for
 * `SharedArrayBuffer` — the COOP/COEP headers that break every embed.
 *
 * ## What it deliberately does not do
 *
 * Add latency. Zero RTT does hide everything reconciliation exists for, and the
 * answer to that is a decorator and a latency matrix in CI
 * (`@gladiator/server/net/laggedTransport.ts`), not self-inflicted lag in the
 * mode whose entire selling point is feel.
 *
 * The opponent is now in here, and it arrived exactly the way this header said
 * it would: `net/botPeer.ts` joins the room as a second peer over a loopback of
 * its own, which is why `Room` takes a capacity rather than assuming one. It is
 * not wired in here — an {@link ListenServerOptions.opponent} factory is, so
 * that the module that knows about the bot is the one that imports it, and a
 * test can seat something else in that chair.
 */
import {
  PROTOCOL_VERSION,
  SKELETON_SEED,
  createDemoRecorder,
  type Demo,
  type DemoRecorder,
  type LoadedMap,
  type MatchRules,
  type Transport,
} from '@gladiator/sim'
import { systemClock, type Clock } from '@gladiator/server/clock'
import { createLoopbackPair, type LoopbackPair } from '@gladiator/server/net/loopbackTransport'
import { createRoom, type Room } from '@gladiator/server/room'
import { stepsFor } from '@gladiator/server/scheduler'

export type ListenServerOptions = {
  readonly map: LoadedMap
  readonly build: string
  readonly seed?: number
  /** Seats. Two, as on Fly; the bot takes the other one. */
  readonly capacity?: number
  /** The code this room answers to. Cosmetic in a tab; there is no registry. */
  readonly id?: string
  /**
   * The rules this room's match plays under. The server's default when absent.
   *
   * Chosen by whoever *opens* the room and never proposed by a joiner, which is
   * the same rule `AGENTS.md` states for everything else a stranger can ask
   * for: a client that could talk the host into `selfDamage: none` mid-match is
   * a client that could ask for other things. Two peers on different rules
   * already fail loudly at tick zero, by design.
   */
  readonly rules?: MatchRules
  /**
   * Wall-clock, injected.
   *
   * A tab passes nothing and gets `performance.now()`. A test passes its own,
   * because the host's clock is what the rate limit in front of the input
   * buffer is measured against (`@gladiator/server/inputQueue.ts`) — and a test
   * that plays a minute of commands in a millisecond of real time would have
   * every one of them past the first thirty-two refused at the door.
   */
  readonly clock?: Clock
  /**
   * Record the command stream this tab's host executes.
   *
   * The same recorder a Fly machine uses, for the same reason: single-player is
   * the multiplayer code path, so a bug seen alone is a bug reproducible from a
   * demo. `?dev=1` turns it on and the panel offers the file
   * (`sim/src/demo.ts`).
   */
  readonly record?: boolean
  /**
   * Somebody to duel, seated once the room exists.
   *
   * A factory rather than a value because the opponent has to `join` the room
   * it is going to play in, and the room is built in here. It is called exactly
   * once, immediately after the local player is seated, so the bot always takes
   * the second slot and `main.ts`'s `LOCAL_SLOT` stays true.
   *
   * Left out entirely for a match that is waiting for a human, which is what
   * `?host=1` does — an empty second seat is a room somebody can still join,
   * and a bot in it is not.
   */
  readonly opponent?: (room: Room) => Opponent
}

/**
 * The second seat, whatever is in it.
 *
 * Narrow on purpose: this module knows that something needs telling how many
 * sub-steps are about to run, and nothing else about it. `net/botPeer.ts` is
 * the only implementation, and the reason this type exists rather than
 * `BotPeer` being named here is that `listenServer.ts` would otherwise import
 * the bot into every session that never plays one.
 */
export type Opponent = {
  /** Decide and send commands for the `steps` sub-steps about to run. */
  beat(steps: number): void
  stop(): void
}

export type ListenServer = {
  /** The client's end of the pipe. Hand this to `createNetClient`. */
  readonly transport: Transport
  /** The host, for the HUD and the browser smoke test. */
  readonly room: Room
  /**
   * The pipe itself, for the two things only a diagnostic wants: how many bytes
   * single-player is actually pushing through the codec, and whether anything
   * is still in flight. A test needs the second to know when to assert.
   */
  readonly pair: LoopbackPair
  /**
   * The host's frame: the sub-steps this much wall-clock is worth, and then the
   * housekeeping — peers that have gone quiet, and the clock-sync pings.
   *
   * A `Room` never holds a timer (`@gladiator/server/room.ts`), so somebody has
   * to give it one — on Fly that is `scheduler.ts`'s drift-corrected loop, and
   * in a tab it is the animation frame that is already running. The frame loop
   * calling this is what makes the tab a *host* rather than a room nobody winds
   * up, and it is why the clock estimate reads the same ~0 ms here as it would
   * read 40 ms over a socket, through exactly the same code.
   *
   * The accumulator is `stepsFor`, the same pure fold the Node scheduler uses,
   * so a tab and a Fly machine turn a frame into sub-steps by one rule rather
   * than by two that happen to agree. What a tab does *not* need is the aim-at-
   * the-next-boundary half of that module: `requestAnimationFrame` already
   * schedules itself against the display, and a second timer chasing 62.5 Hz
   * inside a 60 Hz frame would be two clocks arguing.
   *
   * Returns the sub-steps run, which is what the diagnostics panel reads to say
   * whether the host in this tab is keeping up.
   */
  beat(nowMs: number): number
  /** Sub-steps recorded so far, or `null` when this host is not recording. */
  readonly recordedFrames: number | null
  /** The recording so far, or `null`. `sim/src/demo.ts`. */
  demo(): Demo | null
  stop(): void
}

export function createListenServer(options: ListenServerOptions): ListenServer {
  const pair: LoopbackPair = createLoopbackPair()
  // Spelled once, because the room and the recorder have to agree about it: a
  // demo replayed under a different seed draws a different spawn pair on the
  // first round and diverges before anybody has pressed a key.
  const seed = options.seed ?? SKELETON_SEED
  const id = options.id ?? 'LOCAL1'
  const recorder: DemoRecorder | null =
    options.record === true
      ? createDemoRecorder({
          build: options.build,
          room: id,
          map: { name: options.map.source.name, hash: options.map.hash },
          seed,
          protocol: PROTOCOL_VERSION,
        })
      : null
  const room = createRoom({
    map: options.map,
    // A real clock by default, because a listen server is a real host: it is
    // what a peer's idle timeout and the input buffer's rate limit are measured
    // against. It never reaches `tick()` — a room's world advances by the
    // sub-steps the frame beat hands it, which is what makes this room and the
    // one on Fly produce the same hashes from the same input.
    clock: options.clock ?? systemClock(),
    build: options.build,
    id,
    seed,
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    ...(options.rules === undefined ? {} : { rules: options.rules }),
    peerId: (index) => `local-${index}`,
    ...(recorder === null ? {} : { recorder }),
  })
  room.join(pair.server)

  // After the local player, so the bot takes slot 1 and the tab keeps slot 0.
  const opponent: Opponent | null = options.opponent?.(room) ?? null

  // The previous frame's clock reading, so a beat knows how much wall-clock it
  // is worth. `null` until the first one: the alternative is a first frame
  // measured against zero, which is every millisecond since the tab was opened.
  let lastMs: number | null = null
  let remainderMs = 0

  return {
    transport: pair.client,
    room,
    pair,

    get recordedFrames() {
      return recorder?.frames ?? null
    },

    demo: () => room.demo(),

    beat(nowMs: number): number {
      const elapsedMs = lastMs === null ? 0 : nowMs - lastMs
      lastMs = nowMs
      const fold = stepsFor(remainderMs, elapsedMs)
      remainderMs = fold.remainderMs
      // Before the advance: the opponent decides from the world as it stands,
      // and its commands land on the loopback's microtask to be executed by the
      // next beat. `net/botPeer.ts` argues why that frame of delay is left in.
      opponent?.beat(fold.steps)
      const steps = room.advance(fold.steps)
      room.sweep(nowMs)
      return steps
    },

    stop: () => {
      opponent?.stop()
      pair.close()
    },
  }
}
