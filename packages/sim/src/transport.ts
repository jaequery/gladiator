/**
 * `Transport` — the one interface a WebSocket, an in-process loopback and
 * (later) a WebTransport session all satisfy.
 *
 * It exists so that single-player is not a second code path. The bot match
 * runs the real server over a loopback `Transport` (GLAD-4G4W2T), which means
 * the code that handles a duel is exercised every time anyone plays alone.
 *
 * The interface is callbacks rather than `EventTarget` because `EventTarget`
 * is not in the ECMAScript standard library, and `packages/sim` has no ambient
 * types at all — see "The simulation boundary" in `AGENTS.md`.
 *
 * ---
 *
 * ## The reliability contract
 *
 * **A `Transport` MUST deliver every message, exactly once, in the order it
 * was sent.** WebSocket gives this; the loopback gives it trivially;
 * WebTransport gives it on a stream and does *not* give it on a datagram.
 *
 * That last clause is the reason this section exists. Unreliable datagrams are
 * the obvious future optimisation — they trade head-of-line blocking for
 * dropped packets, which is usually the right trade for a game. The cost of
 * taking it is precisely the list of things in the protocol that may not be
 * dropped, so the list is written down here rather than rediscovered under
 * time pressure.
 *
 * ### What does not need reliability
 *
 * - **Snapshots.** Idempotent state. A dropped snapshot costs one frame of
 *   entity interpolation and is fully repaired by the next one.
 * - **`UserCmd` batches.** Sent redundantly by design — each batch carries the
 *   last few unacknowledged commands, so a drop is repaired by the next send.
 * - **Ping/pong.** Loss is what they measure.
 *
 * ### What does need reliability
 *
 * - **Rocket spawns.** *Each rocket is sent once, at spawn* — an event, not
 *   state. A rocket is not re-described in every snapshot; the client is told
 *   it exists, with its origin, velocity and spawn tick, and simulates the
 *   flight itself. That is what keeps a projectile costing one message instead
 *   of one message per tick of flight, and it is why the projectile a client
 *   draws matches the one the server traced.
 *
 *   **This is a reliability requirement.** Drop that one message and the
 *   client never draws the rocket, never hears it, and takes 100 splash damage
 *   from nothing. There is no later message that repairs it, because there is
 *   no later message.
 *
 *   Moving rockets to an unreliable channel therefore means changing the
 *   *design*, not the transport: either re-announce live projectiles in
 *   snapshots until acknowledged, or accept that a dropped spawn is a
 *   mispredicted death. Neither is a change anyone should make by accident,
 *   which is what this paragraph is for.
 *
 * - **Round transitions and match end** (GLAD-L4SYN9). Also events, also
 *   unrepairable, for the same reason.
 * - **Join, leave and forfeit** (GLAD-DVDV6P).
 *
 * ---
 *
 * ## The loopback's extra obligations
 *
 * The in-process implementation (`@gladiator/server/net/loopbackTransport.ts`,
 * GLAD-4G4W2T) is the one that makes single-player run the multiplayer code
 * path, and it is the one with a way to cheat. Two rules, both of which a
 * socket gets for free and an in-process pipe has to be *made* to obey:
 *
 * 1. **Bytes cross, never objects.** A loopback that handed the receiver the
 *    sender's own value would share a mutable reference: a mutation on one side
 *    would appear on the other with no serialisation in between, every test
 *    would pass, and the bug would surface the first time a real socket was
 *    involved. So a `string` is UTF-8 encoded on send and decoded on delivery,
 *    and a `Uint8Array` is **copied**. The wire is bytes even when the wire is
 *    a field in the same heap.
 *
 * 2. **Delivery is asynchronous.** A synchronous hand-off lets a client's
 *    `send` re-enter the host in the middle of a tick — a re-entrancy a socket
 *    can never produce, so nothing downstream is written to survive it. The
 *    loopback defers on a microtask, which is the smallest boundary that makes
 *    the two paths behave the same.
 *
 * Both rules apply to *any* implementation that does not go through a kernel
 * socket, which is why they are written here rather than beside the one that
 * exists.
 *
 * ---
 *
 * ## What a `Transport` is not
 *
 * It does not know what a message *means* — it moves bytes. Framing, the
 * message union and validation are the server's and the client's business
 * (`server/src/session.ts`; the hardening is GLAD-V7M6PQ). It does not reconnect
 * on its own either: reconnection changes match state, so it belongs to the
 * connection lifecycle (GLAD-DVDV6P), not to the pipe.
 *
 * It does not own a clock, either. Latency, jitter, loss and reordering are a
 * *decorator* over a transport and a test harness rather than a mode of one —
 * `@gladiator/server/net/laggedTransport.ts`, driven by a `pump(nowMs)` so a
 * latency matrix costs CI no wall-clock at all.
 */

/**
 * What crosses a transport.
 *
 * Binary for everything in a match — the wire format is bit-packed and a
 * megabit of JSON per player is not a thing this game is going to do. Strings
 * are permitted so that a handshake, a dev tool or a health probe does not
 * need a second pipe; nothing on the gameplay path may use them.
 */
export type TransportMessage = Uint8Array | string

/**
 * Connection state, with the same four values and the same meanings as
 * `WebSocket.readyState`, so a WebSocket-backed implementation is a passthrough
 * and there is no adaptor table to get wrong.
 */
export const TransportState = {
  Connecting: 0,
  Open: 1,
  Closing: 2,
  Closed: 3,
} as const

export type TransportState = (typeof TransportState)[keyof typeof TransportState]

/**
 * Why a transport closed.
 *
 * Deliberately small: the numbers that a *policy* branches on. Anything richer
 * is an application-level message sent before the close, not a close code.
 */
export const CloseReason = {
  /** Either side asked. The normal path. */
  Normal: 1000,
  /**
   * The host is shutting down or the tab is navigating away.
   *
   * What a deploy looks like from the client's side, and the reason it is worth
   * having its own code: a 1001 is "come back in a moment" and a 1006 is "the
   * wire broke", and a reconnect policy that could not tell them apart would
   * either hammer a dead host or give up on a rolling restart.
   */
  GoingAway: 1001,
  /** The pipe broke: socket error, timeout, tab closed. */
  Abnormal: 1006,
  /** Rejected: bad room code, room full, protocol violation (GLAD-V7M6PQ). */
  PolicyViolation: 1008,
  /** The host is at capacity. Not a fault in the client; a reason to wait. */
  TryAgainLater: 1013,
} as const

export type CloseReason = (typeof CloseReason)[keyof typeof CloseReason]

export type TransportHandlers = {
  onOpen?: () => void
  onMessage?: (message: TransportMessage) => void
  /** Called at most once, and always exactly once if `onOpen` was called. */
  onClose?: (code: number, reason: string) => void
  onError?: (error: Error) => void
}

export type Transport = {
  readonly readyState: TransportState

  /**
   * Queue a message.
   *
   * Never throws for a closed transport — a caller racing a disconnect is the
   * normal case, not an exceptional one, and a send that throws turns every
   * call site into a try/catch. Sending on a closed transport drops the
   * message silently; sending before `onOpen` queues it.
   */
  send(message: TransportMessage): void

  /** Close. Idempotent. `onClose` fires once, whoever asked first. */
  close(code?: number, reason?: string): void

  /**
   * Install handlers. Replaces any previous set.
   *
   * A transport handed to the game may already be open — the loopback always
   * is. An implementation MUST therefore deliver a synthetic `onOpen` to a
   * handler set installed on an already-open transport, or the caller has to
   * special-case the loopback, and single-player stops being the same code
   * path.
   */
  setHandlers(handlers: TransportHandlers): void
}

/** Bytes if it is bytes, otherwise the string's length in UTF-16 code units. */
export function messageSize(message: TransportMessage): number {
  return typeof message === 'string' ? message.length : message.byteLength
}
