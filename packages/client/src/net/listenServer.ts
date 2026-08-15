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
 * There is no opponent in here yet either. The bot is GLAD-V7CMHR, GLAD-TSED8V
 * and GLAD-HK3ATM; when it arrives it joins this room as a second peer over a
 * loopback of its own, which is why `Room` takes a capacity rather than
 * assuming one.
 */
import type { LoadedMap, Transport } from '@gladiator/sim'
import { systemClock } from '@gladiator/server/clock'
import { createLoopbackPair, type LoopbackPair } from '@gladiator/server/net/loopbackTransport'
import { createRoom, type Room } from '@gladiator/server/room'

export type ListenServerOptions = {
  readonly map: LoadedMap
  readonly build: string
  readonly seed?: number
  /** Seats. One until there is a bot to put in the other. */
  readonly capacity?: number
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
  stop(): void
}

export function createListenServer(options: ListenServerOptions): ListenServer {
  const pair: LoopbackPair = createLoopbackPair()
  const room = createRoom({
    map: options.map,
    // A real clock, because a listen server is a real host: it is what a peer's
    // idle timeout is measured against. It never reaches `tick()` — a room's
    // world advances by commands, which is what makes this room and the one on
    // Fly produce the same hashes from the same input.
    clock: systemClock(),
    build: options.build,
    id: 'listen',
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
    peerId: (index) => `local-${index}`,
  })
  room.join(pair.server)

  return {
    transport: pair.client,
    room,
    pair,
    stop: () => pair.close(),
  }
}
