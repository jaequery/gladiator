/**
 * The client half of the hash echo.
 *
 * The client simulates its own input immediately and sends the commands on.
 * The server runs the *same* `pmove` over the *same* commands and sends back a
 * state hash. If the two ever disagree, the shared simulation is not shared,
 * and everything built on top of it — prediction, lag compensation, the bot —
 * is built on sand. So this ticket makes that disagreement loud, on screen,
 * from the first deploy.
 *
 * Reconnection, room codes and the rest of the connection lifecycle are
 * GLAD-DVDV6P; prediction and reconciliation are GLAD-6RT64L. What is here is
 * the smallest thing that can tell the truth about agreement.
 */
import {
  PROTOCOL_VERSION,
  type ServerMessage,
  type UserCmd,
  type WireCmd,
  describeVersionMismatch,
  encodeCmd,
  parseServerMessage,
} from '@gladiator/sim'

/** How many ticks of our own hashes to keep, for the server to catch up to. */
const HASH_HISTORY = 4096

export type NetStatus =
  | 'idle'
  | 'connecting'
  | 'live'
  | 'version-mismatch'
  | 'closed'
  | 'error'
  | 'unconfigured'

export type NetSnapshot = {
  readonly status: NetStatus
  /** One line, already written for a human. The HUD prints it verbatim. */
  readonly message: string
  readonly serverBuild: string | null
  readonly serverTick: number | null
  readonly serverHash: number | null
  readonly clientHash: number | null
  /** `null` until the first hash has been compared. */
  readonly agree: boolean | null
  readonly compared: number
  readonly mismatched: number
  /**
   * Commands the client simulated and then failed to send.
   *
   * Never let this be invisible. The server numbers its ticks by the commands
   * it receives, so one dropped command offsets the two tick counters for the
   * rest of the session and every hash afterwards is compared against a
   * different moment — which reads as a desynchronised simulation and is
   * nothing of the kind.
   */
  readonly dropped: number
  readonly rttMs: number | null
}

export type NetClient = {
  connect(): void
  /** Record the hash our own simulation produced for `tick`. */
  record(tick: number, hash: number): void
  /** Queue a command for `tick`; it goes out on the next {@link flush}. */
  queue(tick: number, cmd: UserCmd): void
  /** Send everything queued. Called once per frame, not once per tick. */
  flush(): void
  snapshot(): NetSnapshot
  close(): void
}

export type NetOptions = {
  readonly url: string | null
  readonly build: string
  /** Overridden by the tests; `WebSocket` in a browser. */
  readonly socketFactory?: (url: string) => WebSocket
  /** Overridden by the tests; `performance.now` in a browser. */
  readonly now?: () => number
  /** Sent instead of {@link PROTOCOL_VERSION}, to prove the mismatch path. */
  readonly protocolOverride?: number
}

/**
 * Where the server is.
 *
 * `VITE_SERVER_URL` is inlined at build time, which means it has to be set in
 * *every* Vercel environment — Production, Preview and Development — or a
 * preview deploy ships with whatever Preview happens to hold. When it is
 * missing entirely we say so rather than guessing: a guessed `wss://` URL on a
 * deployed origin fails with a browser error that names no cause, and the
 * player sees a page that simply does not work.
 */
export function resolveServerUrl(
  configured: string | undefined,
  location: { protocol: string; hostname: string },
): string | null {
  if (configured !== undefined && configured !== '') return configured
  // Local development: the server is the one from `pnpm --filter @gladiator/server dev`.
  if (location.protocol !== 'https:') return `ws://${location.hostname}:8787`
  return null
}

export function createNetClient(options: NetOptions): NetClient {
  const now = options.now ?? (() => performance.now())
  const socketFactory = options.socketFactory ?? ((url: string) => new WebSocket(url))
  const protocol = options.protocolOverride ?? PROTOCOL_VERSION

  // Ring buffers, so a session that runs for an hour costs the same as one that
  // runs for a minute.
  const hashTicks = new Int32Array(HASH_HISTORY).fill(-1)
  const hashValues = new Int32Array(HASH_HISTORY)

  const outbox: WireCmd[] = []
  let outboxStartTick = 0
  let sentAtMs: number | null = null

  let socket: WebSocket | null = null
  let status: NetStatus = options.url === null ? 'unconfigured' : 'idle'
  let message =
    options.url === null
      ? 'VITE_SERVER_URL is not set for this deploy, so there is no server to talk to.'
      : 'not connected yet'
  let serverBuild: string | null = null
  let serverTick: number | null = null
  let serverHash: number | null = null
  let clientHash: number | null = null
  let agree: boolean | null = null
  let compared = 0
  let mismatched = 0
  let dropped = 0
  let rttMs: number | null = null

  const ourHashAt = (tick: number): number | null => {
    const slot = ((tick % HASH_HISTORY) + HASH_HISTORY) % HASH_HISTORY
    return hashTicks[slot] === tick ? (hashValues[slot] ?? null) : null
  }

  const onServerMessage = (raw: string) => {
    const parsed: ServerMessage | null = parseServerMessage(raw)
    if (parsed === null) {
      status = 'error'
      message = 'the server sent a frame this build does not understand'
      return
    }

    if (parsed.t === 'welcome') {
      serverBuild = parsed.build
      status = 'live'
      message = `connected to build ${parsed.build}, protocol ${parsed.protocol}`
      return
    }

    if (parsed.t === 'version_mismatch') {
      serverBuild = parsed.serverBuild
      status = 'version-mismatch'
      message = describeVersionMismatch(parsed)
      return
    }

    if (parsed.t === 'fault') {
      status = 'error'
      message = `server rejected this session: ${parsed.code} — ${parsed.detail}`
      return
    }

    // A hash. This is the whole point of the ticket.
    serverTick = parsed.tick
    serverHash = parsed.hash
    if (sentAtMs !== null) {
      rttMs = now() - sentAtMs
      sentAtMs = null
    }
    const ours = ourHashAt(parsed.tick)
    if (ours === null) {
      // The tick has already fallen out of our history, which only happens if
      // the server is more than 32 seconds behind. Not a desync; not agreement.
      return
    }
    clientHash = ours >>> 0
    compared += 1
    agree = clientHash === parsed.hash >>> 0
    if (!agree) mismatched += 1
  }

  return {
    connect() {
      if (options.url === null) return
      status = 'connecting'
      message = `connecting to ${options.url}`
      try {
        socket = socketFactory(options.url)
      } catch (cause) {
        status = 'error'
        message = `could not open a socket to ${options.url}: ${String(cause)}`
        return
      }

      socket.addEventListener('open', () => {
        socket?.send(JSON.stringify({ t: 'hello', protocol, build: options.build }))
      })
      socket.addEventListener('message', (event: MessageEvent) => {
        if (typeof event.data === 'string') onServerMessage(event.data)
      })
      socket.addEventListener('error', () => {
        // Browsers deliberately give no detail here, to avoid leaking whether a
        // host exists. Say what we can and let `close` add the code.
        if (status === 'version-mismatch') return
        status = 'error'
        message = `the connection to ${options.url} failed`
      })
      socket.addEventListener('close', (event: CloseEvent) => {
        // A mismatch closes the socket on purpose; keep the useful message.
        if (status === 'version-mismatch') return
        status = 'closed'
        message = `disconnected (code ${event.code}${event.reason === '' ? '' : `: ${event.reason}`})`
      })
    },

    record(tick, hash) {
      const slot = ((tick % HASH_HISTORY) + HASH_HISTORY) % HASH_HISTORY
      hashTicks[slot] = tick
      hashValues[slot] = hash | 0
    },

    queue(tick, cmd) {
      // No server URL at all is not a dropped command — there was never an
      // agreement to break, and counting these would bury the ones that matter.
      if (options.url === null) return
      if (outbox.length === 0) outboxStartTick = tick
      outbox.push(encodeCmd(cmd))
    },

    flush() {
      if (outbox.length === 0) return
      if (socket === null || socket.readyState !== 1 /* OPEN */) {
        // Dropped rather than buffered without bound — but counted, and said
        // out loud, because a silent drop offsets the two tick counters for
        // the rest of the session. See {@link NetSnapshot.dropped}.
        dropped += outbox.length
        outbox.length = 0
        if (status === 'live') {
          status = 'error'
          message = `${dropped} commands could not be sent; this session's ticks no longer line up with the server's`
        }
        return
      }
      socket.send(JSON.stringify({ t: 'cmds', startTick: outboxStartTick, cmds: outbox }))
      if (sentAtMs === null) sentAtMs = now()
      outbox.length = 0
    },

    snapshot: () => ({
      status,
      message,
      serverBuild,
      serverTick,
      serverHash,
      clientHash,
      agree,
      compared,
      mismatched,
      dropped,
      rttMs,
    }),

    close() {
      socket?.close()
      socket = null
    },
  }
}
