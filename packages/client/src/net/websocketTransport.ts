/**
 * The browser's `WebSocket`, seen as a `Transport`.
 *
 * The mirror of `@gladiator/server/net/wsTransport.ts`, and the only module in
 * the client that knows what a WebSocket is. Everything above it —
 * `net/client.ts`, and therefore the whole frame loop — is written against
 * `Transport`, which is what lets the same code talk to a server on Fly and to
 * a `Room` running in this tab (`listenServer.ts`).
 *
 * Constructing a `WebSocket` can throw before anything is listening: a bad URL
 * is a `SyntaxError` out of the constructor, not an error event. That is caught
 * here and turned into a closed transport that reports itself, because a caller
 * that had to wrap `new WebSocket` in a try/catch *and* handle an error event
 * would have two failure paths for one failure.
 */
import {
  CloseReason,
  TransportState,
  type Transport,
  type TransportHandlers,
  type TransportMessage,
} from '@gladiator/sim'

export type WebSocketTransportOptions = {
  /** Overridden by the tests; `WebSocket` in a browser. */
  readonly socketFactory?: (url: string) => WebSocket
}

export function websocketTransport(
  url: string,
  options: WebSocketTransportOptions = {},
): Transport {
  const factory = options.socketFactory ?? ((target: string) => new WebSocket(target))

  let socket: WebSocket | null = null
  let failure: Error | null = null
  try {
    socket = factory(url)
  } catch (cause) {
    failure = cause instanceof Error ? cause : new Error(String(cause))
  }

  return {
    get readyState(): TransportState {
      // `WebSocket.readyState` and `TransportState` are the same four numbers
      // with the same four meanings — see `sim/src/transport.ts`.
      return socket === null ? TransportState.Closed : (socket.readyState as TransportState)
    },

    send(message: TransportMessage) {
      // Never throws on a closed socket: a caller racing a disconnect is the
      // normal case, and a send that threw would put a try/catch at every send.
      if (socket === null || socket.readyState !== TransportState.Open) return
      // A `Uint8Array` is often a window onto a bigger allocation, and `send`
      // wants the bytes rather than the buffer behind them. `slice` is that
      // window, copied.
      socket.send(typeof message === 'string' ? message : message.slice())
    },

    close(code = CloseReason.Normal, reason = '') {
      // Codes outside 1000 and 3000–4999 are a `WebSocket` `InvalidAccessError`,
      // and a close that throws while tearing down is a close that leaks.
      try {
        socket?.close(code, reason)
      } catch {
        socket?.close()
      }
    },

    setHandlers(handlers: TransportHandlers) {
      if (socket === null) {
        // Never opened. Report it the way a socket that failed would, on a
        // later turn, so the caller has finished installing before it hears.
        queueMicrotask(() => {
          handlers.onError?.(failure ?? new Error(`could not open a socket to ${url}`))
          handlers.onClose?.(CloseReason.Abnormal, 'never opened')
        })
        return
      }

      const live = socket
      live.addEventListener('open', () => handlers.onOpen?.())
      live.addEventListener('message', (event: MessageEvent) => {
        handlers.onMessage?.(
          typeof event.data === 'string' ? event.data : new Uint8Array(event.data as ArrayBuffer),
        )
      })
      live.addEventListener('error', () => {
        // Browsers deliberately give no detail here, to avoid leaking whether a
        // host exists. The close event that follows carries the code.
        handlers.onError?.(new Error(`the connection to ${url} failed`))
      })
      live.addEventListener('close', (event: CloseEvent) => {
        handlers.onClose?.(event.code, event.reason)
      })

      if (live.readyState === TransportState.Open) {
        // Already open, which happens whenever handlers are installed a turn
        // late. The contract requires the synthetic open; without it a caller
        // would have to special-case the pipe it was handed.
        queueMicrotask(() => handlers.onOpen?.())
      }
    },
  }
}
