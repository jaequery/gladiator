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
 * ## It comes back
 *
 * A socket that dies is not a session that ended (GLAD-DVDV6P). The host holds
 * this client's seat for thirty seconds and the welcome carried the token that
 * proves it, so a drop is answered by dialling again — through
 * {@link NetOptions.redial}, which is how this module gets a *new* pipe without
 * knowing what a pipe is made of. `reconnect.ts` decides which closes are worth
 * coming back from and how long to wait.
 *
 * Two things happen on the way back in, and both are the same rule: **anything
 * predicted across the gap is thrown away.** The outbox is cleared, because
 * every command in it is labelled in a tick space the host has moved on from;
 * and {@link NetOptions.onResume} tells the frame loop to discard its own
 * pending input and hard-snap to whatever the first snapshot says. Replaying
 * input across a multi-second gap produces a plausible-looking journey that
 * nobody made.
 */
import {
  LifecycleEvent,
  PROTOCOL_VERSION,
  QueueState,
  TransportState,
  UNKNOWN_RTT,
  type ServerDrain,
  type ServerLifecycle,
  type ServerMessage,
  type ServerQueue,
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
import { createReconnectPolicy, type ReconnectOptions } from './reconnect.ts'

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
  /** The socket dropped and a backoff is running. `reconnect.ts`. */
  | 'reconnecting'
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
 *
 * `reconnecting` is the first case again. There is no socket, so every tick
 * predicted during the gap is a tick the host will never be told about — and the
 * host is meanwhile simulating this player's body standing still, which is the
 * world the client is about to be handed. Predicting through a reconnect would
 * mean arriving back with a private opinion about where the player is, several
 * seconds deep, and then snapping out of it.
 */
export function mustHoldStill(status: NetStatus): boolean {
  return (
    status === 'idle' ||
    status === 'connecting' ||
    status === 'reconnecting' ||
    status === 'map-mismatch'
  )
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

/**
 * Where this session stands in the quick-match line, as of now.
 *
 * The server's {@link ServerQueue} frame with one thing changed: `waitedMs`
 * keeps running between frames. The host says "you have waited 0 ms" once, when
 * it parks you, and then says nothing until something happens — so a readout
 * that printed the frame verbatim would be a stopped clock in front of a player
 * who is specifically waiting. The elapsed time is added here, from the same
 * `now` everything else in this module is measured on, and it is cosmetic:
 * nothing decides anything from it, which is why the client is allowed to keep
 * it at all.
 */
export type QueueStatus = {
  readonly state: QueueState
  /** The room this session is in. Something to send a friend when it times out. */
  readonly room: string
  readonly waitedMs: number
  /** How long the wait may last in total. Zero once it is over. */
  readonly timeoutMs: number
  /**
   * How long ago the host last said this, in milliseconds.
   *
   * A different question from {@link QueueStatus.waitedMs}, which is why it is
   * a second number rather than the same one read twice: the wait stops when
   * the wait ends, and this does not. It is what lets "opponent found" leave
   * the screen by itself a couple of seconds later (`ui/queue.ts`).
   */
  readonly sinceMs: number
}

export type NetSnapshot = {
  readonly status: NetStatus
  /** One line, already written for a human. The HUD prints it verbatim. */
  readonly message: string
  readonly serverBuild: string | null
  /**
   * The room this session ended up in, once the host has said, in canonical
   * form — never an echo of what this client asked for.
   *
   * It is how a player who *created* a match learns the code to send: they sent
   * none, the host minted one, and it arrives in the welcome. `ui/menu.ts` puts
   * it on screen and `main.ts` writes it into the address bar, so that a reload
   * rejoins rather than opening a second empty room. `server/roomCode.ts` is
   * what canonical means.
   */
  readonly room: string | null
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
   * The last thing the host said about somebody's connection, or `null`.
   *
   * Kept structurally as well as folded into {@link NetSnapshot.message},
   * because "your opponent left" is a thing a menu will want to draw properly
   * (GLAD-NPCTU8) and a sentence is not a thing you can draw a countdown ring
   * around.
   */
  readonly lifecycle: ServerLifecycle | null
  /**
   * Milliseconds left on the countdown that event carried, or `null`.
   *
   * Counted down here rather than resent by the host: a grace window is thirty
   * seconds of wall-clock and the host has better things to do than tell sixty
   * clients a second what a subtraction comes to.
   */
  readonly graceLeftMs: number | null
  /** Sockets this session has been through. Zero for one that never dropped. */
  readonly reconnects: number
  /** Failed dials since the last one that worked. `reconnect.ts`. */
  readonly retries: number
  /**
   * The host's "I am deploying" notice, once it has arrived.
   *
   * Kept after the socket closes on purpose: it is what tells the difference
   * between a duel that ended and a duel whose machine went away, and the
   * resume ticket in it is the only copy of the score.
   */
  readonly drain: ServerDrain | null
  /**
   * The quick-match line, or `null` for a session that never asked to be in one.
   *
   * `null` is therefore "this is a room-code match", which is what the panel
   * branches on: a duel between two friends must not grow a "looking for an
   * opponent" spinner because one of them has not arrived yet.
   */
  readonly queue: QueueStatus | null
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
  /**
   * The frame's beat for everything that is waiting on wall-clock: today, one
   * thing, which is whether a reconnect's backoff has run out.
   *
   * Called once per frame and *outside* the branch that holds the world still,
   * because the whole point of it is to run while the world is held still.
   * `flush` cannot do this job for the same reason: nothing is queued during a
   * reconnect, so nothing would call it.
   */
  poll(): void
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
   * Open a *new* pipe to the same seat, or `null` when there is nowhere to dial.
   *
   * A factory rather than a second transport, because a reconnect needs a socket
   * that does not exist yet and this module is not allowed to know how one is
   * made. The context carries what the host said about this session — which room
   * and which seat — so the caller can put them in a URL
   * (`?room=ABC123&token=…`).
   *
   * Leaving it out is the old behaviour exactly: a close is the end of the
   * session, which is the right answer for a listen server (there is no wire to
   * break) and for a test that is asserting on one socket.
   */
  readonly redial?: (context: RedialContext) => Transport | null
  /** Backoff and attempt limits. `reconnect.ts`. */
  readonly reconnect?: ReconnectOptions
  /**
   * Called when a reconnect has been accepted by the host.
   *
   * The frame loop's cue to throw away everything it predicted before the gap —
   * the pending command queue and the frame accumulator — and take the next
   * snapshot as gospel. `main.ts`.
   */
  readonly onResume?: () => void
  /**
   * Called when the host says it is deploying, before the socket closes.
   *
   * The seam the reconnect policy hangs off (GLAD-DVDV6P): the frame carries
   * the room code, how long to wait, and this peer's signed resume ticket, and
   * a client that reconnects with `?room=<room>&resume=<ticket>` is put back
   * into the same duel at the same score on the machine that replaced this one.
   * `server/shutdown.ts` sends it.
   *
   * The redial below acts on all three without being told to — this is for a
   * caller that wants to *say* something about a deploy, not to survive one.
   */
  readonly onDrain?: (notice: ServerDrain) => void
}

/** What a redial needs to know to reach the same seat again. */
export type RedialContext = {
  /** The room code the host put in the welcome, or `null` before one arrived. */
  readonly room: string | null
  /** This seat's token, or `null` if the session never got as far as a welcome. */
  readonly token: string | null
  /**
   * The resume ticket from a drain notice, or `null` outside a deploy.
   *
   * The seat token and this are answers to different questions and both go on
   * the URL: a token asks the machine that is still holding the seat, and a
   * ticket tells a machine that was not there what the score was. During a
   * deploy the token names a room that has gone, so the ticket is what is left.
   */
  readonly resume: string | null
  /** Which attempt this is, from 1. Diagnostics; the policy is `reconnect.ts`. */
  readonly attempt: number
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
 * The socket URL for a room code or a place in the queue, or a plain one to
 * open a new match.
 *
 * `wss://host/` asks the host for a new room and the code it mints comes back
 * in the welcome; `wss://host/?room=ABC123` joins the match that code names;
 * `wss://host/?queue=1` asks to be matched with whoever is waiting
 * (`server/queue.ts`).
 *
 * A code beats the queue when a page somehow carries both, which is the same
 * order the host reads them in: six characters somebody typed is a request for
 * a *particular* match, and quietly putting that player in front of a stranger
 * instead would be the worst possible way to answer it.
 *
 * A code is carried through verbatim rather than validated here: the host is
 * the only thing that knows which codes exist, it folds the ones a human typed
 * (`@gladiator/server/roomCode.ts`), and a client that pre-judged the shape
 * would be a second opinion to keep in step. What a client *does* owe is that a
 * code the host cannot serve produces a sentence rather than silence — and it
 * does: an unknown code is answered with a `fault` frame, which lands in
 * {@link NetSnapshot.message} and goes on the screen verbatim.
 *
 * Two arguments rather than the page's query string, because the page's own URL
 * is no longer the only place either request can come from: `ui/menu.ts` has a
 * join box whose code has never been near `window.location`, and a "find a
 * match" button that is a click rather than a parameter. `main.ts` is what reads
 * the URL, with {@link quickMatchRequested} and `ui/roomFlow.ts`, and both paths
 * arrive here as the same two answers.
 */
export function joinUrl(serverUrl: string, room: string | null, queue = false): string {
  if (room !== null && room !== '') {
    const url = new URL(serverUrl)
    url.searchParams.set('room', room)
    return url.toString()
  }
  if (!queue) return serverUrl
  const url = new URL(serverUrl)
  // Normalised to `1` rather than echoed: the host only asks whether the
  // parameter is there, and a page that arrived with `?queue=yes` should put
  // one shape of request on the wire.
  url.searchParams.set('queue', '1')
  return url.toString()
}

/** `?queue=1` — ask the host to match this player with a stranger. */
export function quickMatchRequested(search: string): boolean {
  return new URLSearchParams(search).has('queue')
}

/**
 * The same URL again, with proof of a seat on it.
 *
 * Built from the *original* join URL rather than from the bare server address,
 * so that a socket which died before the welcome arrived still retries the room
 * the player asked for instead of quietly opening a new one. Once a welcome has
 * landed, the host's own canonical code replaces whatever the player typed —
 * they may have typed it with a hyphen in it (`server/roomCode.ts`).
 *
 * Building from the original URL also means a quick match keeps its `?queue=1`
 * across a redial, and both halves of that are wanted (GLAD-ZHRFBK). A socket
 * that died while still waiting for a stranger has no room to name, so the retry
 * asks for the queue again, which is the only sensible thing it could ask for.
 * Once a welcome has landed there is a code, and the host reads `?room=` first
 * and never consults the queue — so the stale parameter rides along inert rather
 * than being stripped by a second opinion here about what the host prefers.
 */
export function rejoinUrl(joined: string, context: RedialContext): string {
  const url = new URL(joined)
  if (context.room !== null) url.searchParams.set('room', context.room)
  if (context.token !== null) url.searchParams.set('token', context.token)
  // An empty ticket is a legal drain frame and means "this deploy could not
  // sign one" (`server/resume.ts`), so it is dropped rather than sent as a
  // parameter the next machine would have to parse to learn it says nothing.
  if (context.resume !== null && context.resume !== '') {
    url.searchParams.set('resume', context.resume)
  }
  return url.toString()
}

/** What the HUD says when a deploy was built with no host to talk to. */
export const NO_SERVER_CONFIGURED =
  'VITE_SERVER_URL is not set for this deploy, so there is no server to talk to.'

/**
 * The reading before a match has been picked.
 *
 * A page now opens on a menu and connects to nothing until a player chooses
 * something (`ui/menu.ts`), so there is a real state in which no `NetClient`
 * exists yet — and the diagnostics panel still has to draw. `idle` rather than
 * a fourth status word because it already means exactly this everywhere else,
 * including in {@link mustHoldStill}: a world with no host to agree with does
 * not advance.
 */
export const NO_SESSION: NetSnapshot = {
  status: 'idle',
  message: 'no match yet — pick one from the menu',
  serverBuild: null,
  room: null,
  mapHash: '',
  serverMapHash: null,
  serverTick: null,
  serverHash: null,
  clientHash: null,
  agree: null,
  compared: 0,
  mismatched: 0,
  dropped: 0,
  rttMs: null,
  serverTickEstimate: null,
  leadTicks: 0,
  queuedAtServer: 0,
  pings: 0,
  snapshots: 0,
  // Nobody has connected, so nobody can have dropped: a session that was never
  // opened has no opponent to have lost and no socket to have been through.
  lifecycle: null,
  graceLeftMs: null,
  reconnects: 0,
  retries: 0,
  drain: null,
  queue: null,
  snapshotBytes: 0,
  snapshotBytesPerSecond: 0,
  bytesIn: 0,
}

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

  let transport = options.transport
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
  // The last thing the host said about the queue, and when it said it. The two
  // together are what keep the wait counting between frames — see
  // {@link QueueStatus}.
  let queued: { readonly frame: ServerQueue; readonly atMs: number } | null = null

  // What the host told us about this session, and therefore what a reconnect has
  // to present to get back into it. The token is deliberately not in the
  // snapshot: it is a bearer credential and the snapshot is a diagnostics
  // object that gets printed.
  let room: string | null = null
  let token: string | null = null
  let lifecycle: ServerLifecycle | null = null
  let lifecycleAtMs = 0

  const retry = createReconnectPolicy(options.reconnect ?? {})
  let reconnects = 0
  /** When the current backoff runs out, or `null` when nothing is waiting. */
  let redialAtMs: number | null = null
  /**
   * Which socket the handlers below belong to.
   *
   * A transport that has been given up on can still deliver a late `onError` or
   * a second `onClose`, and acting on one would restart a backoff that has
   * already been replaced. Every handler checks the generation it was installed
   * under and ignores the event if the pipe has moved on.
   */
  let generation = 0
  /** Set while dialling a replacement, so a welcome knows it is a *return*. */
  let resuming = false

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

  /**
   * The queue frame with the wait brought up to date, or `null`.
   *
   * Only a wait that is still running keeps counting: once the host has said
   * `matched` or `timeout`, the number it sent is the final one, and a readout
   * that went on incrementing it would be telling a player they are still
   * waiting for something that has already happened.
   */
  const queueStatus = (): QueueStatus | null => {
    if (queued === null) return null
    const { frame, atMs } = queued
    const since = Math.max(0, now() - atMs)
    return {
      state: frame.state,
      room: frame.room,
      waitedMs: frame.waitedMs + (frame.state === QueueState.Waiting ? since : 0),
      timeoutMs: frame.timeoutMs,
      sinceMs: since,
    }
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
      // The host's answer, and the only place a code a player can send comes
      // from. Folded here rather than at every reader, because the empty string
      // is the wire's way of saying "no room yet" and `null` is the language's:
      // see {@link NetSnapshot.room}.
      room = parsed.room === '' ? null : parsed.room
      // Kept even across a resume, where the host reissues the same value: a
      // client that dropped its token on the way back in would have exactly one
      // reconnect in it.
      token = parsed.token
      status = 'live'
      retry.succeed()
      redialAtMs = null
      // The deploy is behind us. Forgotten rather than kept for the record,
      // because everything downstream reads a non-null `drain` as "a deploy is
      // happening now": a stale one would put a spent ticket on the next
      // redial's URL and swallow the message of an ordinary disconnect an hour
      // later.
      drain = null
      message = `connected to build ${parsed.build}, protocol ${parsed.protocol}, arena ${parsed.mapHash}, room ${parsed.room}`
      if (resuming) {
        resuming = false
        message = `back in room ${parsed.room} — the match carried on without you`
        // Everything predicted before the gap is now wrong by however long the
        // gap was. The frame loop throws its pending commands away and takes the
        // next snapshot whole. See {@link NetOptions.onResume}.
        options.onResume?.()
      }
      return
    }

    if (parsed.t === 'life') {
      lifecycle = parsed
      lifecycleAtMs = now()
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

    if (parsed.t === 'queue') {
      // Kept, not acted on. This module owns one socket and has no opinion
      // about matchmaking; what it owes the player is that the answer to "am I
      // still waiting" is on the screen, which is `ui/queue.ts`'s job from
      // here. The stamp is what makes the wait tick over between frames.
      queued = { frame: parsed, atMs: now() }
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

  /** Milliseconds left on the countdown the host last sent, or `null`. */
  const graceLeftMs = (): number | null => {
    if (lifecycle === null || lifecycle.graceMs <= 0) return null
    const left = lifecycle.graceMs - (now() - lifecycleAtMs)
    return left > 0 ? Math.round(left) : 0
  }

  /**
   * The line on the screen.
   *
   * Computed at snapshot time rather than stored, for one reason: a countdown.
   * "They forfeit in 12s" has to be a different sentence a second later, and the
   * HUD reads this ten times a second (`client/src/hud.ts`).
   */
  const describe = (): string => {
    const left = graceLeftMs()
    if (lifecycle !== null && left !== null && lifecycle.event === LifecycleEvent.OpponentLeft) {
      return `your opponent's connection dropped — they forfeit in ${Math.ceil(left / 1000)}s`
    }
    if (lifecycle !== null && status === 'live') return lifecycle.detail
    return message
  }

  /** Install this module's handlers on whatever pipe is current. */
  const install = (): void => {
    const pipe = transport
    if (pipe === null) return
    const mine = generation

    pipe.setHandlers({
      // Installing handlers on an already-open transport still gets an open —
      // the loopback is always open, and without the synthetic one this would
      // be the special case that made single-player a second code path.
      onOpen: () => {
        if (mine !== generation) return
        pipe.send(JSON.stringify({ t: 'hello', protocol, build: options.build, mapHash }))
      },
      onMessage: (frame) => {
        if (mine !== generation) return
        // The protocol is JSON text. Bytes here would be a host speaking the
        // *next* protocol, and guessing which is worse than saying so.
        if (typeof frame === 'string') onServerMessage(frame)
      },
      onError: () => {
        if (mine !== generation) return
        // Browsers deliberately give no detail here, to avoid leaking whether
        // a host exists. Say what we can and let `onClose` add the code.
        if (status === 'version-mismatch' || status === 'map-mismatch') return
        status = 'error'
        message = `the connection to ${options.endpoint} failed`
      },
      onClose: (code, reason) => {
        if (mine !== generation) return
        // A mismatch closes the pipe on purpose; keep the useful message.
        if (status === 'version-mismatch' || status === 'map-mismatch') return

        const backoff = options.redial === undefined ? null : retry.next(code, now())
        if (backoff === null) {
          status = 'closed'
          // A deploy already said what happened and where the match went, and
          // "disconnected (code 1001)" on top of it is how a diagnosable event
          // becomes a mystery.
          if (drain === null) {
            message = `disconnected (code ${code}${reason === '' ? '' : `: ${reason}`})`
          }
          return
        }

        // A drain notice is the host telling us how long it will be gone, and
        // it outranks the backoff whenever it asks for longer: the machine is
        // being replaced, and dialling it every 250 ms until it is back is a
        // client generating load precisely when there is nothing to answer it.
        // The backoff still wins when *it* is longer — a deploy that runs over
        // its estimate must not be retried at a fixed rate forever.
        const wait = drain === null ? backoff : Math.max(backoff, drain.retryAfterMs)

        // Everything in the outbox was predicted into a socket that no longer
        // exists, and every command in it is labelled in a tick space this
        // session is about to leave behind. Dropped without being counted as a
        // *dropped command*, because that counter exists to catch a session
        // whose two tick counters have silently come apart, and this one is
        // about to be told authoritatively where it is.
        outbox.length = 0
        redialAtMs = now() + wait
        status = 'reconnecting'
        message =
          code === 1001
            ? `the server is deploying — reconnecting in ${Math.round(wait / 100) / 10}s`
            : `connection lost (code ${code}) — reconnecting in ${Math.round(wait / 100) / 10}s`
      },
    })
  }

  return {
    clock,

    connect() {
      if (transport === null) return
      status = 'connecting'
      message = `connecting to ${options.endpoint}`
      install()
    },

    poll() {
      if (redialAtMs === null || now() < redialAtMs) return
      redialAtMs = null

      // A new pipe, and a new generation with it: whatever the dead socket
      // says from here is about a session that has moved on.
      generation += 1
      const next =
        options.redial?.({ room, token, resume: drain?.resume ?? null, attempt: retry.attempts }) ??
        null
      if (next === null) {
        status = 'closed'
        message = 'there is nowhere left to reconnect to'
        return
      }

      transport = next
      reconnects += 1
      // A session that never got a welcome has no seat to return to, so its
      // reconnect is an ordinary dial and must not tell the frame loop to throw
      // away a world it has not been given a replacement for.
      resuming = token !== null
      status = 'connecting'
      message = `reconnecting to ${options.endpoint} (attempt ${retry.attempts})`
      install()
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
      message: describe(),
      serverBuild,
      room,
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
      lifecycle,
      graceLeftMs: graceLeftMs(),
      reconnects,
      retries: retry.attempts,
      drain,
      queue: queueStatus(),
      snapshotBytes,
      snapshotBytesPerSecond,
      bytesIn,
    }),

    close() {
      // A close this side asked for is not a connection to come back from, so
      // the backoff is cancelled before the handlers can hear about it.
      redialAtMs = null
      generation += 1
      transport?.close()
    },
  }
}
