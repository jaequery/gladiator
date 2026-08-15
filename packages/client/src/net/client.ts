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
 * ## It also keeps the clock
 *
 * The other conversation on this socket is clock sync: the host pings, this
 * answers with nothing but the id, and `clockSync.ts` turns the pings into an
 * estimate of which tick the server is on and how far ahead of it this client
 * should be simulating. The round trip in {@link NetSnapshot.rttMs} is the
 * *server's* measurement, arriving in the ping — this module deliberately does
 * not time anything itself, because the number decides how far lag compensation
 * rewinds and a client that reported it could ask to be rewound further.
 *
 * ## It carries snapshots and does not read them
 *
 * The authoritative world arrives here as a {@link ServerSnapshot} and is
 * handed straight to {@link NetOptions.onSnapshot}. This module knows about
 * frames, clocks and sockets, and deliberately nothing about the world:
 * `net/prediction.ts` is what adopts one, `net/reconcile.ts` is what replays on
 * top of it, and `net/interpolate.ts` is what draws the half of it this client
 * does not predict.
 *
 * Reconnection, room codes and the rest of the connection lifecycle are
 * GLAD-DVDV6P.
 */
import {
  PROTOCOL_VERSION,
  TransportState,
  UNKNOWN_RTT,
  type ServerDrain,
  type ServerMessage,
  type ServerSnapshot,
  type Transport,
  type UserCmd,
  type WireCmd,
  describeMapMismatch,
  describeVersionMismatch,
  encodeCmd,
  parseServerMessage,
} from '@gladiator/sim'

import { createClockSync, type ClientClockSync } from './clockSync.ts'

/** How many ticks of our own hashes to keep, for the server to catch up to. */
const HASH_HISTORY = 4096

/**
 * The window the snapshot rate is measured over, in milliseconds.
 *
 * One second, because that is the unit the number is quoted in and a rate
 * derived over a different window and then scaled is a rate that lies about
 * bursts. Long enough that the ~16 ms gap between snapshots does not make it
 * jump; short enough that a stall shows up while the player is still looking.
 */
const RATE_WINDOW_MS = 1000

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
  /**
   * The round trip in whole milliseconds, **as the server measured it**, or
   * `null` before it has measured one.
   *
   * Not timed here. The client used to stopwatch its own command batch against
   * the hash that came back, which was a fine number for a readout and exactly
   * the wrong one for anything that matters: lag compensation rewinds by this,
   * so a client that reports it is a client that can ask to be rewound further
   * (GLAD-5QGO11). It now comes off the ping. `clockSync.ts`.
   */
  readonly rttMs: number | null
  /**
   * The tick we believe the server is on, or `null` before the first ping.
   *
   * Estimated from the pings, not from the hashes: a hash says which tick the
   * server had *reached when it answered us*, which is a different question and
   * one whose answer is already stale by a one-way trip.
   */
  readonly serverTickEstimate: number | null
  /** Ticks the client should be simulating ahead of the server. */
  readonly leadTicks: number
  /** Our commands the server was holding as of the last ping. */
  readonly queuedAtServer: number
  /** Pings answered. Zero for a long time means clock sync is not working. */
  readonly pings: number
  /**
   * Authoritative states received.
   *
   * Beside {@link NetSnapshot.compared}, this is what says reconciliation has
   * anything to work with: a session with pings and hashes but no snapshots is
   * a client predicting into a world nobody is correcting.
   */
  readonly snapshots: number
  /**
   * The host's "I am deploying" notice, once it has arrived.
   *
   * Kept after the socket closes on purpose: it is what tells the difference
   * between a duel that ended and a duel whose machine went away, and the
   * resume ticket in it is the only copy of the score.
   */
  readonly drain: ServerDrain | null
  /**
   * Bytes of snapshot frames received, and the rate over the last second.
   *
   * Snapshots specifically, not every frame: they are the whole state of the
   * world sixty times a second and they are therefore the entire downstream
   * cost of this design. Everything else on the socket — pings, hashes, the
   * welcome — is a rounding error beside them, and mixing the two would hide
   * the number that is going to decide whether a delta encoder is worth
   * writing.
   *
   * Counted in characters rather than encoded bytes, which is the same number
   * here: every frame in this protocol is ASCII JSON, and running a
   * `TextEncoder` over each one to prove it would cost an allocation per
   * snapshot to measure the cost of snapshots.
   */
  readonly snapshotBytes: number
  readonly snapshotBytesPerSecond: number
  /** Every frame, not just snapshots. The whole downstream, for comparison. */
  readonly bytesIn: number
}

export type NetClient = {
  connect(): void
  /**
   * The clock estimate this session is keeping.
   *
   * Exposed rather than folded into {@link NetClient.snapshot} because the
   * frame loop asks it a question with an argument — "what tick is it *now*" —
   * and a snapshot taken ten times a second cannot answer that.
   */
  readonly clock: ClientClockSync
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
  /**
   * Called with every authoritative state, the moment it lands.
   *
   * A callback rather than a queue the frame loop drains, because there is
   * nothing sensible to do with a snapshot other than adopt it, and a queue
   * would only add a frame of delay and a place for one to be forgotten.
   * `net/prediction.ts` is what registers here.
   */
  readonly onSnapshot?: (snapshot: ServerSnapshot) => void
  /**
   * Called when the host says it is deploying, before the socket closes.
   *
   * The seam the reconnect policy hangs off (GLAD-DVDV6P): the frame carries
   * the room code, how long to wait, and this peer's signed resume ticket, and
   * a client that reconnects with `?room=<room>&resume=<ticket>` is put back
   * into the same duel at the same score on the machine that replaced this one.
   * `server/shutdown.ts` sends it.
   */
  readonly onDrain?: (notice: ServerDrain) => void
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

/**
 * The socket URL for this page's `?room=`, or a plain one to open a new match.
 *
 * `wss://host/` asks the host for a new room and the code it mints comes back
 * in the welcome; `wss://host/?room=ABC123` joins the match that code names.
 *
 * A code is carried through verbatim rather than validated here: the host is
 * the only thing that knows which codes exist, it folds the ones a human typed
 * (`@gladiator/server/roomCode.ts`), and a client that pre-judged the shape
 * would be a second opinion to keep in step. What a client *does* owe is that a
 * code the host cannot serve produces a sentence rather than silence — and it
 * does: an unknown code is answered with a `fault` frame, which lands in
 * {@link NetSnapshot.message} and goes on the screen verbatim.
 *
 * The menu that puts a shareable link in front of a player instead of a query
 * string is GLAD-NPCTU8.
 */
export function joinUrl(serverUrl: string, search: string): string {
  const room = new URLSearchParams(search).get('room')
  if (room === null || room === '') return serverUrl
  const url = new URL(serverUrl)
  url.searchParams.set('room', room)
  return url.toString()
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
  const clock = createClockSync()
  let pings = 0
  let snapshots = 0
  let snapshotBytes = 0
  let bytesIn = 0
  // A one-second bucket rather than a decaying average: the readout says
  // "bytes per second" and that is what this measures.
  let windowStartMs: number | null = null
  let windowBytes = 0
  let snapshotBytesPerSecond = 0

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
  let drain: ServerDrain | null = null

  const ourHashAt = (tick: number): number | null => {
    const slot = ((tick % HASH_HISTORY) + HASH_HISTORY) % HASH_HISTORY
    return hashTicks[slot] === tick ? (hashValues[slot] ?? null) : null
  }

  /**
   * Fold a snapshot frame's size into the rate.
   *
   * The clock is read here rather than once per frame loop because a frame
   * arrives on the socket, not on the display — and this is a read of
   * `performance.now()`, which is CPU-side and free. Nothing here touches the
   * renderer, which is the rule the dev HUD is written to (`ui/devHud.ts`).
   */
  const chargeSnapshot = (bytes: number): void => {
    snapshotBytes += bytes
    const nowMs = now()
    if (windowStartMs === null) {
      windowStartMs = nowMs
      windowBytes = bytes
      return
    }
    windowBytes += bytes
    const elapsedMs = nowMs - windowStartMs
    if (elapsedMs < RATE_WINDOW_MS) return
    snapshotBytesPerSecond = elapsedMs > 0 ? (windowBytes * 1000) / elapsedMs : 0
    windowStartMs = nowMs
    windowBytes = 0
  }

  const onServerMessage = (raw: string) => {
    bytesIn += raw.length
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

    if (parsed.t === 'drain') {
      // The host is deploying. Kept rather than acted on: this module owns one
      // socket and has no opinion about opening another, and the close that
      // follows in a moment sets the status. What it does owe is that the
      // ticket is not thrown away — it is the whole of the match's score, and
      // there is exactly one copy of it (`server/resume.ts`).
      drain = parsed
      message = `the server is deploying — rejoin ${parsed.room} in a moment`
      options.onDrain?.(parsed)
      return
    }

    if (parsed.t === 'ping') {
      // Answered on the spot, and with nothing in the reply but the id. Every
      // millisecond between receiving a ping and sending its pong is a
      // millisecond added to the round trip the server measures — and therefore
      // to the lead this client is told to run at, and to how much of its own
      // input the server buffers before executing it. Being slow here is a
      // self-inflicted handicap, which is why nothing is done first.
      transport?.send(JSON.stringify({ t: 'pong', id: parsed.id }))
      clock.observe(parsed, now())
      pings += 1
      return
    }

    if (parsed.t === 'snap') {
      // Handed straight on. Reconciliation is somebody else's job — this module
      // knows about frames and clocks and deliberately nothing about the world
      // (`net/prediction.ts`).
      snapshots += 1
      chargeSnapshot(raw.length)
      options.onSnapshot?.(parsed)
      return
    }

    // A hash. This is the whole point of the walking skeleton.
    serverTick = parsed.tick
    serverHash = parsed.hash
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
    clock,

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
          // Same rule for a deploy: the drain frame already said what happened
          // and where the match went, and "disconnected (code 1001)" on top of
          // it is how a diagnosable event becomes a mystery.
          if (drain !== null) return
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
      rttMs: clock.rttMs === UNKNOWN_RTT ? null : clock.rttMs,
      serverTickEstimate: clock.serverTick(now()),
      leadTicks: clock.leadTicks,
      queuedAtServer: clock.queued,
      pings,
      snapshots,
      drain,
      snapshotBytes,
      snapshotBytesPerSecond,
      bytesIn,
    }),

    close() {
      transport?.close()
    },
  }
}
