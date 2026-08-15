/**
 * The client half of the hash echo.
 *
 * The client simulates its own input immediately and sends the commands on.
 * The host runs the *same* `tick()` over the *same* commands and sends back a
 * state hash. If the two ever disagree, the shared simulation is not shared,
 * and everything built on top of it — prediction, lag compensation, the bot —
 * is built on sand. So this makes that disagreement loud, on screen, from the
 * first deploy.
 *
 * ## It talks to a `Transport`, not to a WebSocket
 *
 * This is what makes single-player run the multiplayer code path. Everything
 * below is written against the interface in `sim/src/transport.ts`, so the same
 * client code talks to a server on Fly through `websocketTransport.ts` and to a
 * `Room` in this very tab through a loopback (`listenServer.ts`). There is no
 * offline branch, because there is nothing for one to be a branch *of*.
 *
 * A `Transport` may already be open when it arrives — a loopback always is —
 * which is why its contract requires a synthetic open, and why `connect()` here
 * is "install handlers" rather than "dial".
 *
 * Reconnection, room codes and the rest of the connection lifecycle are
 * GLAD-DVDV6P; prediction and reconciliation are GLAD-6RT64L. What is here is
 * the smallest thing that can tell the truth about agreement.
 */
import {
  PROTOCOL_VERSION,
  TransportState,
  type ServerMessage,
  type Transport,
  type UserCmd,
  type WireCmd,
  describeMapMismatch,
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
  | 'map-mismatch'
  | 'closed'
  | 'error'
  | 'unconfigured'

/**
 * Whether the simulation must not advance in this state.
 *
 * Two reasons, and they are the same reason twice. Before the socket has
 * opened, ticks the server never received would offset the two tick counters
 * for the rest of the session. And after a *map* mismatch, every tick would be
 * simulated against different geometry from the authoritative one, so the
 * player would run into walls that are not there and shoot through walls that
 * are. Neither is recoverable without a reload, so the honest thing is to stop
 * and say so rather than to play a game that is already wrong.
 *
 * `version-mismatch` deliberately does not stop the world: the page can still
 * be looked at, and the banner already says nothing will connect.
 */
export function mustHoldStill(status: NetStatus): boolean {
  return status === 'idle' || status === 'connecting' || status === 'map-mismatch'
}

/**
 * Whether this session is over and nothing the player does can revive it.
 *
 * The three states that need a reload rather than a retry. It is what the
 * diagnostics panel interrupts the player for, and — the reason it is a
 * function rather than a condition written out twice — it is also what takes
 * the in-match HUD off the screen: a health bar and a round score over a page
 * whose only remaining instruction is "reload" is furniture in front of the
 * one sentence that matters.
 */
export function isFatal(status: NetStatus): boolean {
  return (
    status === 'version-mismatch' || status === 'map-mismatch' || status === 'unconfigured'
  )
}

export type NetSnapshot = {
  readonly status: NetStatus
  /** One line, already written for a human. The HUD prints it verbatim. */
  readonly message: string
  readonly serverBuild: string | null
  /** The map hash this client actually sent — which `mapHashOverride` changes. */
  readonly mapHash: string
  /** The map the server is authoritative over, once it has said. */
  readonly serverMapHash: string | null
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
  /**
   * The pipe to the host, or `null` when this deploy has none configured.
   *
   * A WebSocket to Fly, or a loopback to a `Room` running in this tab. The
   * client cannot tell, and that is the point.
   */
  readonly transport: Transport | null
  /**
   * What to call the far end in a message a player reads — a URL, or
   * "the host in this tab". Purely for the HUD.
   */
  readonly endpoint: string
  readonly build: string
  /** Overridden by the tests; `performance.now` in a browser. */
  readonly now?: () => number
  /** The hash of the map this page loaded. `map.ts`. */
  readonly mapHash: string
  /** Sent instead of {@link PROTOCOL_VERSION}, to prove the mismatch path. */
  readonly protocolOverride?: number
  /** Sent instead of {@link NetOptions.mapHash}, to prove the mismatch path. */
  readonly mapHashOverride?: string
  /** What the HUD says when {@link NetOptions.transport} is `null`. */
  readonly unconfiguredMessage?: string
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

/** What the HUD says when a deploy was built with no host to talk to. */
export const NO_SERVER_CONFIGURED =
  'VITE_SERVER_URL is not set for this deploy, so there is no server to talk to.'

export function createNetClient(options: NetOptions): NetClient {
  const now = options.now ?? (() => performance.now())
  const protocol = options.protocolOverride ?? PROTOCOL_VERSION
  const mapHash = options.mapHashOverride ?? options.mapHash

  // Ring buffers, so a session that runs for an hour costs the same as one that
  // runs for a minute.
  const hashTicks = new Int32Array(HASH_HISTORY).fill(-1)
  const hashValues = new Int32Array(HASH_HISTORY)

  const outbox: WireCmd[] = []
  let outboxStartTick = 0
  let sentAtMs: number | null = null

  const transport = options.transport
  let status: NetStatus = transport === null ? 'unconfigured' : 'idle'
  let message =
    transport === null
      ? (options.unconfiguredMessage ?? NO_SERVER_CONFIGURED)
      : 'not connected yet'
  let serverBuild: string | null = null
  let serverMapHash: string | null = null
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
      serverMapHash = parsed.mapHash
      status = 'live'
      message = `connected to build ${parsed.build}, protocol ${parsed.protocol}, arena ${parsed.mapHash}`
      return
    }

    if (parsed.t === 'map_mismatch') {
      serverMapHash = parsed.serverMapHash
      status = 'map-mismatch'
      message = describeMapMismatch(parsed)
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
      if (transport === null) return
      status = 'connecting'
      message = `connecting to ${options.endpoint}`

      transport.setHandlers({
        // Installing handlers on an already-open transport still gets an open —
        // the loopback is always open, and without the synthetic one this would
        // be the special case that made single-player a second code path.
        onOpen: () => {
          transport.send(JSON.stringify({ t: 'hello', protocol, build: options.build, mapHash }))
        },
        onMessage: (frame) => {
          // The protocol is JSON text. Bytes here would be a host speaking the
          // *next* protocol, and guessing which is worse than saying so.
          if (typeof frame === 'string') onServerMessage(frame)
        },
        onError: () => {
          // Browsers deliberately give no detail here, to avoid leaking whether
          // a host exists. Say what we can and let `onClose` add the code.
          if (status === 'version-mismatch' || status === 'map-mismatch') return
          status = 'error'
          message = `the connection to ${options.endpoint} failed`
        },
        onClose: (code, reason) => {
          // A mismatch closes the pipe on purpose; keep the useful message.
          if (status === 'version-mismatch' || status === 'map-mismatch') return
          status = 'closed'
          message = `disconnected (code ${code}${reason === '' ? '' : `: ${reason}`})`
        },
      })
    },

    record(tick, hash) {
      const slot = ((tick % HASH_HISTORY) + HASH_HISTORY) % HASH_HISTORY
      hashTicks[slot] = tick
      hashValues[slot] = hash | 0
    },

    queue(tick, cmd) {
      // No host at all is not a dropped command — there was never an agreement
      // to break, and counting these would bury the ones that matter.
      if (transport === null) return
      if (outbox.length === 0) outboxStartTick = tick
      outbox.push(encodeCmd(cmd))
    },

    flush() {
      if (outbox.length === 0) return
      if (transport === null || transport.readyState !== TransportState.Open) {
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
      transport.send(JSON.stringify({ t: 'cmds', startTick: outboxStartTick, cmds: outbox }))
      if (sentAtMs === null) sentAtMs = now()
      outbox.length = 0
    },

    snapshot: () => ({
      status,
      message,
      serverBuild,
      mapHash,
      serverMapHash,
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
      transport?.close()
    },
  }
}
