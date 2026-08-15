/**
 * The in-process `Transport` — a socket with no socket in it.
 *
 * This is what makes single-player run the *multiplayer* code path. The bot
 * match hosts a real `Room` in the browser tab and talks to it over one of
 * these, so the code that handles a duel is exercised every time anybody plays
 * alone. It is the listen-server pattern, which is how Quake, Source and most
 * engines have always done single-player-on-multiplayer-code, and its whole
 * value is that there is one code path rather than two.
 *
 * The pattern has exactly one dangerous failure, and this module exists to make
 * it impossible.
 *
 * ## 1. Bytes cross, never objects
 *
 * The tempting implementation hands the receiver the value the sender passed.
 * It is faster, it is shorter, and it shares a mutable reference between the
 * two ends of a "network". Mutations then propagate without serialisation,
 * every test goes green, and the bug surfaces the first time there is a real
 * socket in the middle — by which point it looks like a netcode problem and is
 * an aliasing problem.
 *
 * So a `string` is UTF-8 encoded on `send` and decoded on delivery, and a
 * `Uint8Array` is **copied**. The real codec runs even when both ends are in
 * the same heap, and `loopbackTransport.test.ts` proves it by mutating a buffer
 * after sending it and watching the receiver not notice.
 *
 * Delivery re-inflates a text frame back into a `string`, which is what a
 * WebSocket does with a text frame. The wire is bytes; the two APIs are the
 * same. A loopback that delivered bytes where a socket delivers a string would
 * have reintroduced the second code path this whole ticket is about.
 *
 * ## 2. Delivery is asynchronous
 *
 * A synchronous hand-off would let a client's `send` re-enter the host in the
 * middle of a tick — a re-entrancy a socket cannot produce, so nothing
 * downstream is written to survive it. Frames are delivered on a
 * `queueMicrotask`, which is the smallest boundary that makes the two paths
 * behave the same. A drain delivers only the frames that were already queued
 * when it started, so anything a handler sends goes out on the *next* turn
 * rather than extending the current one into an unbounded loop.
 *
 * ## What this is not
 *
 * It is not a Web Worker, on purpose. A worker buys jank isolation this game
 * does not need at roughly forty microseconds a tick, and costs
 * structured-clone marshalling, materially worse debugging, and — the moment
 * anyone reaches for `SharedArrayBuffer` — the COOP/COEP headers that break
 * every embed. The microtask boundary gives most of the value for none of it.
 *
 * It is not lossy or laggy either. Zero RTT hides everything reconciliation
 * exists for, which is a real problem — and the fix is a decorator and a test
 * harness (`laggedTransport.ts`), not a mode of the thing players ship on. Do
 * not put self-inflicted lag into the mode whose selling point is feel.
 */
import {
  CloseReason,
  TransportState,
  type Transport,
  type TransportHandlers,
  type TransportMessage,
} from '@gladiator/sim'

/** Which end of the pair a frame came from. For the {@link LoopbackOptions.onWire} tap. */
export type LoopbackEnd = 'client' | 'server'

/** How a frame gets from `send` to the far side's handler. See the header. */
export type Defer = (run: () => void) => void

export type LoopbackOptions = {
  /**
   * The deferral primitive. `queueMicrotask` unless a test says otherwise.
   *
   * Injected so a test can make delivery synchronous-but-explicit and assert on
   * ordering without racing the microtask queue.
   */
  readonly defer?: Defer
  /**
   * Called with every frame that crosses, before it is decoded.
   *
   * The tap exists so a test can assert the claim in the header — that what
   * crosses is a `Uint8Array` and nothing else — rather than the module merely
   * asserting it in prose.
   */
  readonly onWire?: (frame: Uint8Array, from: LoopbackEnd) => void
}

export type LoopbackPair = {
  /** The end the game holds. */
  readonly client: Transport
  /** The end the host holds. `Room.join` takes this one. */
  readonly server: Transport
  /** Frames encoded but not yet handed to a handler. */
  readonly inFlight: number
  /** Bytes that have crossed, both directions. Diagnostics. */
  readonly wireBytes: number
  /** Nothing queued and no delivery scheduled: it is safe to assert. */
  readonly idle: boolean
  /** Close both ends. Idempotent, whoever asks first. */
  close(code?: number, reason?: string): void
}

/**
 * A frame on the wire.
 *
 * `bytes` is always a private copy; `text` records whether to hand the receiver
 * a `string` or the bytes, so the loopback matches a WebSocket's text/binary
 * distinction rather than inventing a third convention.
 */
type Frame = {
  readonly bytes: Uint8Array
  readonly text: boolean
}

type End = {
  readonly name: LoopbackEnd
  handlers: TransportHandlers | null
  inbox: Frame[]
  state: TransportState
  /** The synthetic open has been delivered to the current handler set. */
  openNotified: boolean
  closeNotified: boolean
  closeCode: number
  closeReason: string
  drainScheduled: boolean
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Turn a message into bytes.
 *
 * The `slice()` is the entire point of this module. Without it the two ends
 * share the caller's buffer and the loopback is a lie.
 */
function encodeFrame(message: TransportMessage): Frame {
  if (typeof message === 'string') return { bytes: encoder.encode(message), text: true }
  return { bytes: message.slice(), text: false }
}

/** And back. A text frame arrives as a `string`, exactly as it would over a socket. */
function decodeFrame(frame: Frame): TransportMessage {
  return frame.text ? decoder.decode(frame.bytes) : frame.bytes
}

function createEnd(name: LoopbackEnd): End {
  return {
    name,
    handlers: null,
    inbox: [],
    state: TransportState.Open,
    openNotified: false,
    closeNotified: false,
    closeCode: CloseReason.Normal,
    closeReason: '',
    drainScheduled: false,
  }
}

/**
 * Two transports wired to each other, both already open.
 *
 * "Already open" is why `Transport.setHandlers` is specified to deliver a
 * synthetic `onOpen`: a caller that waited for an open event that had already
 * happened would hang, and single-player would need a special case, and there
 * would be two code paths again.
 */
export function createLoopbackPair(options: LoopbackOptions = {}): LoopbackPair {
  const defer: Defer = options.defer ?? ((run) => queueMicrotask(run))
  const onWire = options.onWire

  const client = createEnd('client')
  const server = createEnd('server')
  let wireBytes = 0

  const peerOf = (end: End): End => (end === client ? server : client)

  /**
   * Hand this end everything it is owed: the open it may not have seen, the
   * frames waiting for it, and the close if one has happened.
   *
   * Only the frames already queued are delivered. Anything a handler sends
   * while this runs is queued for the next turn, which is what stops a busy
   * conversation from turning one microtask into an unbounded loop.
   */
  const pump = (end: End): void => {
    const handlers = end.handlers
    if (handlers === null) return

    if (!end.openNotified && end.state !== TransportState.Closed) {
      end.openNotified = true
      handlers.onOpen?.()
    }

    const batch = end.inbox
    end.inbox = []
    for (const frame of batch) {
      // A close mid-batch drops what is left, the same way a socket does.
      if (end.state === TransportState.Closed && end.closeNotified) break
      handlers.onMessage?.(decodeFrame(frame))
    }

    if (end.state === TransportState.Closed && !end.closeNotified) {
      end.closeNotified = true
      handlers.onClose?.(end.closeCode, end.closeReason)
    }
  }

  const schedule = (end: End): void => {
    if (end.drainScheduled) return
    end.drainScheduled = true
    defer(() => {
      end.drainScheduled = false
      pump(end)
    })
  }

  const closeBoth = (code: number, reason: string): void => {
    for (const end of [client, server]) {
      if (end.state === TransportState.Closed) continue
      end.state = TransportState.Closed
      end.closeCode = code
      end.closeReason = reason
      schedule(end)
    }
  }

  const transportFor = (end: End): Transport => ({
    get readyState() {
      return end.state
    },

    send(message: TransportMessage) {
      // Never throws for a closed transport: a caller racing a disconnect is
      // the normal case, and a send that throws turns every call site into a
      // try/catch. `Transport` in `packages/sim` spells this out.
      if (end.state !== TransportState.Open) return
      const peer = peerOf(end)
      if (peer.state === TransportState.Closed) return

      const frame = encodeFrame(message)
      wireBytes += frame.bytes.byteLength
      onWire?.(frame.bytes, end.name)
      peer.inbox.push(frame)
      schedule(peer)
    },

    close(code = CloseReason.Normal, reason = '') {
      closeBoth(code, reason)
    },

    setHandlers(handlers: TransportHandlers) {
      end.handlers = handlers
      // A new handler set on an already-open transport is owed its open, and
      // possibly a backlog: sends that happened before anyone was listening are
      // queued rather than dropped.
      end.openNotified = false
      schedule(end)
    },
  })

  return {
    client: transportFor(client),
    server: transportFor(server),
    get inFlight() {
      return client.inbox.length + server.inbox.length
    },
    get wireBytes() {
      return wireBytes
    },
    get idle() {
      return (
        client.inbox.length === 0 &&
        server.inbox.length === 0 &&
        !client.drainScheduled &&
        !server.drainScheduled
      )
    },
    close(code = CloseReason.Normal, reason = '') {
      closeBoth(code, reason)
    },
  }
}

/**
 * Wait until nothing is in flight.
 *
 * Delivery is a chain of microtasks, so "everything has arrived" is a state to
 * be waited for rather than a line to be written after the last `send`.
 * Awaiting a resolved promise yields one turn of the microtask queue; the loop
 * is what makes a conversation of arbitrary depth settle.
 *
 * The turn cap is a deadlock detector, not a timeout: a pair that is still busy
 * after ten thousand turns is two handlers talking to each other forever, and a
 * test that hung would be much harder to read than one that says so.
 */
export async function settleLoopback(pair: LoopbackPair, maxTurns = 10_000): Promise<void> {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    if (pair.idle) return
    await Promise.resolve()
  }
  throw new Error(`loopback still busy after ${maxTurns} microtask turns`)
}
