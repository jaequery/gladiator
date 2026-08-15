/**
 * The `ws` adapter: one socket, seen as a `Transport`.
 *
 * Deliberately the only module in the host that knows what a WebSocket is. The
 * room, the session and the loopback are all written against `Transport`, so
 * this file is the entire Node-specific surface of the authoritative side —
 * which is what makes the *same* room run in a browser tab over a loopback.
 *
 * It is thin on purpose. Nothing here decides anything: it renames events,
 * converts a `RawData` into the two shapes `TransportMessage` allows, and
 * delivers the synthetic open that `Transport.setHandlers` requires.
 *
 * ## Except for one decision, and it is this file's whole share of GLAD-V7M6PQ
 *
 * **A throw out of a handler ends this connection and nothing else.** A `ws`
 * message handler runs inside `EventEmitter.emit`, so an exception escaping it
 * is not caught by anything — it unwinds through the event loop and takes the
 * *process* down, which is every other room on the machine. That is the whole
 * hostile-input threat in one sentence: a frame that finds one unguarded
 * `DataView` read somewhere downstream and turns it into a fleet-wide outage.
 *
 * The room already treats every frame as hostile (`validate.ts`, then a parser
 * that returns `null` rather than throwing), so nothing is *expected* to reach
 * this. It is here because "nothing is expected to" is exactly the claim a
 * hardening ticket cannot rest on: the guard costs a try/catch on a path that
 * runs a few hundred times a second, and the alternative costs the machine.
 */
import {
  CloseReason,
  TransportState,
  type Transport,
  type TransportHandlers,
  type TransportMessage,
} from '@gladiator/sim'
import type { RawData, WebSocket } from 'ws'

import { CLOSE_BAD_FRAME } from '../session.ts'

/**
 * `ws` hands a binary frame over as a `Buffer`, or as a list of them when the
 * frame arrived fragmented. A `Buffer` *is* a `Uint8Array`, but it is a view
 * into a pooled allocation that `ws` reuses, so it is copied rather than
 * passed on — the same aliasing hazard the loopback copies to avoid, arriving
 * from the other direction.
 */
function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) {
    const total = data.reduce((sum, chunk) => sum + chunk.byteLength, 0)
    const joined = new Uint8Array(total)
    let at = 0
    for (const chunk of data) {
      joined.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), at)
      at += chunk.byteLength
    }
    return joined
  }
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0))
  return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
}

/**
 * Bytes over this socket, both ways.
 *
 * Optional and injected because this file is not allowed to *decide* anything —
 * it renames events. The meter it fills in is `health.ts`'s, and what the
 * numbers are for is the cost arithmetic in `NOTES.md`: Fly bills egress by the
 * gigabyte and a duel is a known number of snapshots a second, so the only
 * honest way to price one is to weigh the frames a real match sends.
 */
export type TransportMeter = {
  read(bytes: number): void
  wrote(bytes: number): void
}

/** Bytes on the wire for a frame, before framing overhead. */
function sizeOf(message: TransportMessage): number {
  return typeof message === 'string' ? Buffer.byteLength(message, 'utf8') : message.byteLength
}

export function wsTransport(socket: WebSocket, meter?: TransportMeter): Transport {
  // The socket's listeners are attached exactly once and forward to whichever
  // handler set is current. The obvious alternative — `removeAllListeners` on
  // each `setHandlers` — is a trap with teeth: `WebSocketServer` puts its own
  // `close` listener on every socket to take it out of `wss.clients`, so
  // clearing the event wholesale leaks the connection and `wss.close()` then
  // waits forever for a client that has already gone. Never reach for
  // `removeAllListeners` on an object somebody else also listens to.
  let handlers: TransportHandlers = {}
  let wired = false
  let openAnnounced = false

  const announceOpen = (): void => {
    if (openAnnounced) return
    openAnnounced = true
    handlers.onOpen?.()
  }

  /**
   * Run a handler, and end *this* connection if it throws.
   *
   * `onError` first, so the room logs which peer it was, and then a close with
   * the bad-frame code — the same sentence a frame we could not parse gets,
   * because from the client's side that is what happened. `terminate` rather
   * than a graceful close would skip the close frame, and a client that is not
   * told anything is the one failure nobody can diagnose.
   */
  const guarded = (what: string, run: () => void): void => {
    try {
      run()
    } catch (thrown) {
      const error = thrown instanceof Error ? thrown : new Error(String(thrown))
      try {
        handlers.onError?.(new Error(`${what} threw: ${error.message}`))
      } catch {
        // A reporting path that throws is not worth a second one.
      }
      if (socket.readyState === socket.OPEN) socket.close(CLOSE_BAD_FRAME, 'bad frame')
    }
  }

  return {
    get readyState(): TransportState {
      // `WebSocket.readyState` and `TransportState` are the same four numbers
      // with the same four meanings, which is why there is no lookup table here
      // to get wrong.
      return socket.readyState as TransportState
    },

    send(message: TransportMessage) {
      // Never throws on a closed socket: a caller racing a disconnect is the
      // normal case. `sim/src/transport.ts` spells the contract out.
      if (socket.readyState !== socket.OPEN) return
      meter?.wrote(sizeOf(message))
      socket.send(message)
    },

    close(code = CloseReason.Normal, reason = '') {
      socket.close(code, reason)
    },

    setHandlers(next: TransportHandlers) {
      handlers = next
      openAnnounced = false

      if (!wired) {
        wired = true
        socket.on('open', announceOpen)
        socket.on('message', (data: RawData, isBinary: boolean) => {
          // `toBytes` is inside the guard too: `data` is whatever `ws` handed
          // us, and reassembling a fragmented frame is arithmetic over lengths
          // an attacker chose. The meter is inside as well — a frame we are
          // about to refuse still arrived and still cost bandwidth, so it
          // belongs in the byte count either way.
          guarded('message', () => {
            const message = isBinary ? toBytes(data) : String(data)
            meter?.read(sizeOf(message))
            handlers.onMessage?.(message)
          })
        })
        socket.on('close', (code: number, reason: Buffer) => {
          guarded('close', () => {
            handlers.onClose?.(code, reason.toString())
          })
        })
        socket.on('error', (error: Error) => {
          guarded('error', () => {
            handlers.onError?.(error)
          })
        })
      }

      if (socket.readyState === socket.OPEN) {
        // Already open — which it always is by the time `wss.on('connection')`
        // fires. The contract requires a synthetic open here, or every caller
        // would need to special-case the socket it was handed and single-player
        // would stop being the same code path. Deferred so the caller finishes
        // installing before anything is delivered.
        queueMicrotask(announceOpen)
      }
    },
  }
}
