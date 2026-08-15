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
  TransportState,
  UNKNOWN_RTT,
  type ServerLifecycle,
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
import { createReconnectPolicy, type ReconnectOptions } from './reconnect.ts'

/** How many ticks of our own hashes to keep, for the server to catch up to. */
const HASH_HISTORY = 4096

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
  /** The room this session is in, once the host has said. `roomCode.ts`. */
  readonly room: string | null
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
}

/** What a redial needs to know to reach the same seat again. */
export type RedialContext = {
  /** The room code the host put in the welcome, or `null` before one arrived. */
  readonly room: string | null
  /** This seat's token, or `null` if the session never got as far as a welcome. */
  readonly token: string | null
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

/**
 * The same URL again, with proof of a seat on it.
 *
 * Built from the *original* join URL rather than from the bare server address,
 * so that a socket which died before the welcome arrived still retries the room
 * the player asked for instead of quietly opening a new one. Once a welcome has
 * landed, the host's own canonical code replaces whatever the player typed —
 * they may have typed it with a hyphen in it (`server/roomCode.ts`).
 */
export function rejoinUrl(joined: string, context: RedialContext): string {
  const url = new URL(joined)
  if (context.room !== null) url.searchParams.set('room', context.room)
  if (context.token !== null) url.searchParams.set('token', context.token)
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
      room = parsed.room
      // Kept even across a resume, where the host reissues the same value: a
      // client that dropped its token on the way back in would have exactly one
      // reconnect in it.
      token = parsed.token
      status = 'live'
      retry.succeed()
      redialAtMs = null
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

        const wait = options.redial === undefined ? null : retry.next(code, now())
        if (wait === null) {
          status = 'closed'
          message = `disconnected (code ${code}${reason === '' ? '' : `: ${reason}`})`
          return
        }

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
      const next = options.redial?.({ room, token, attempt: retry.attempts }) ?? null
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
      room,
      lifecycle,
      graceLeftMs: graceLeftMs(),
      reconnects,
      retries: retry.attempts,
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
