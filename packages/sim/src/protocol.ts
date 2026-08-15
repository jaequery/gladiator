/**
 * The wire protocol — the skeleton's share of it.
 *
 * JSON, deliberately. The real protocol is binary and lives in GLAD-OOELC5;
 * this ticket's job is to prove a browser on Vercel and a Node process on Fly
 * agree about the *world*, and a readable frame you can paste into an issue is
 * worth more than a compact one while that is still in doubt.
 *
 * One thing JSON does get exactly right, and it is the thing that matters here:
 * a double survives `JSON.parse(JSON.stringify(x))` bit for bit, because
 * ECMAScript specifies `Number::toString` as the shortest representation that
 * round-trips. So the transport is not what desyncs us.
 *
 * `PROTOCOL_VERSION` is bumped whenever the shape below changes. A client that
 * is one deploy behind must be *told* so — a version mismatch that closes the
 * socket silently is indistinguishable from the server being down, and the
 * player reloads twice and gives up.
 */
import { isWireState, type WireState } from './netstate.ts'
import { sanitizeUserCmd, type UserCmd } from './usercmd.ts'

/**
 * Bump on any change to the message shapes below — **or to what they mean**.
 *
 * Version 3 is both kinds at once. A command grew a sixth number, the weapon
 * being held (GLAD-0QWRYK), so the frame changed shape. And `EntityState` grew
 * `weapon`, `lastFireTick`, `nextFireTick` and `trBase` (GLAD-PWCON8 and
 * GLAD-0QWRYK), which changes the canonical encoding and therefore every `hash`
 * a peer computes for the same world. A client one deploy behind would disagree
 * with the server about a world both of them simulated correctly, and report it
 * as a desync — which is exactly the confusion this number exists to prevent.
 *
 * Version 4 adds the two frames clock sync is made of, {@link ServerPing} and
 * {@link ClientPong} (GLAD-5995PA). A version-3 client answers a ping with
 * nothing, so the server measures no round trip, reports `-1` forever, and the
 * client never learns which tick it is predicting into — a session that
 * connects, plays, and feels wrong. Being told to reload is better.
 *
 * Version 5 adds {@link ServerSnapshot} (GLAD-6RT64L): the authoritative world,
 * whole, so a client can replay its unacknowledged commands on top of it. A
 * version-4 client is handed a frame it cannot parse and treats it as a host
 * speaking a language it does not know, which is exactly what has happened.
 *
 * Version 6 is the second kind of change again (GLAD-FHKBN8). {@link
 * ServerWelcome} grew a `room`, because the host now mints the room code and a
 * player who created a match has no other way to learn the six characters they
 * are supposed to send their friend. And *what a `cmds` frame means* changed
 * underneath it: a batch used to advance the world by exactly its own commands
 * and be answered with a hash, and it is now admitted to a jitter buffer that a
 * fixed-rate scheduler drains. A version-5 client would wait forever for a
 * reply to a batch, which is the confusion this number exists to prevent.
 *
 * Version 7 adds {@link ServerDrain} (GLAD-G41FQ9): the frame a host sends on
 * its way out of a deploy, carrying the room code, when to come back, and the
 * signed ticket that lets the next machine rebuild the match at the score it
 * was on. A version-6 client cannot parse it, so a deploy looks to it exactly
 * as it did before this ticket — a 1001 and a dead socket, with the match gone
 * — which is survivable and is precisely the experience being replaced. Being
 * told to reload is better than silently getting the old one.
 *
 * Version 8 is the connection lifecycle (GLAD-DVDV6P). {@link ServerWelcome}
 * grew a `token` — the one thing a returning client can prove a seat with — and
 * {@link ServerLifecycle} is new, because "your opponent's connection died and
 * they have 27 seconds to come back" is a sentence no other frame could carry. A
 * version-7 client is handed a `life` frame it cannot parse and treats the host
 * as speaking a language it does not know, and, worse, has no token to come back
 * with: it would reconnect as a stranger and be told the room is full.
 *
 * That this is 8 and not 7 is the rule working. Both tickets were built against
 * version 6 and both called themselves 7; G41FQ9 merged first, and a merge to
 * `main` deploys, so a live client already speaks a 7 that has `drain` in it and
 * no `life`. Handing that client a `life` frame under a number it believes it
 * understands is the one failure this constant exists to prevent — so the
 * shipped meaning of 7 stands, and the frames that had not shipped move up.
 */
export const PROTOCOL_VERSION = 8

/**
 * The most commands one frame may carry. The client's accumulator clamps a
 * stalled frame to 250 ms, which is 31 ticks, so anything near this cap is a
 * client that is lying.
 *
 * A cap on one *frame*, which is a different question from a cap on the rate:
 * a client sending 500 legal-sized batches a second passes this and is refused
 * by the token bucket in `server/src/inputQueue.ts`. The rest of the hardening
 * — message sizes, connection-level limits, malformed frames — is GLAD-V7M6PQ.
 */
export const MAX_CMDS_PER_BATCH = 256

/**
 * The longest resume ticket this protocol will carry, in characters.
 *
 * A ticket is a payload and a signature, both base64url (`server/resume.ts`),
 * and the one this deploy mints is a little over 200 characters. The cap is a
 * bound on what a *client* can hand back on a reconnect — it arrives in a query
 * string, so somewhere it is a URL, and a URL nobody bounded is a place to put
 * a megabyte. Generous enough that the payload can grow a field, small enough
 * that it is never the reason a request is large.
 */
export const MAX_RESUME_TICKET_CHARS = 512

/**
 * A `UserCmd` on the wire: `[forwardMove, sideMove, yaw, pitch, buttons,
 * weapon]`.
 *
 * The held weapon rides along on every command rather than arriving as a
 * switch event, because a lost event leaves the two peers holding different
 * weapons for the rest of the match — see `usercmd.ts`.
 */
export type WireCmd = readonly [number, number, number, number, number, number]

export type ClientHello = {
  readonly t: 'hello'
  readonly protocol: number
  readonly build: string
  /**
   * The hash of the map this page loaded. Eight lowercase hex digits.
   *
   * Separate from `protocol` because a map can change without the message
   * shapes changing, and a peer playing yesterday's arena is exactly as
   * desynchronised as one speaking yesterday's protocol — it just fails twenty
   * seconds later and points at the netcode when it does. `map/load.ts`.
   */
  readonly mapHash: string
}

export type ClientCmds = {
  readonly t: 'cmds'
  /** The tick the first command in `cmds` advances the world *to*. */
  readonly startTick: number
  readonly cmds: readonly WireCmd[]
}

/**
 * The echo half of clock sync. The client's *entire* contribution to it.
 *
 * There is deliberately no timestamp in here. A client that reported when it
 * received the ping would be a client that could report a smaller number, and
 * every millisecond it shaves off the round trip is a millisecond of extra
 * rewind it gets from lag compensation (GLAD-5QGO11) — free wallhack-grade
 * advantage, for a one-line patch to a value nobody else can check. So the
 * server keeps the send time itself, matches the id, and subtracts on its own
 * clock. See `server/clockSync.ts`.
 *
 * The only thing a client can still do is answer *late*, which makes its own
 * RTT look worse. That direction is not worth defending against.
 */
export type ClientPong = {
  readonly t: 'pong'
  /** Exactly the id from the {@link ServerPing}. Anything else is discarded. */
  readonly id: number
}

export type ClientMessage = ClientHello | ClientCmds | ClientPong

export type ServerWelcome = {
  readonly t: 'welcome'
  readonly protocol: number
  readonly build: string
  readonly session: string
  /** The map the server is authoritative over. Matches the client's, or the
   *  session would have been refused with a {@link ServerMapMismatch}. */
  readonly mapHash: string
  /**
   * The room this peer was seated in, in canonical form.
   *
   * The host's answer and never an echo of the client's: a player who asked for
   * a new match sent no code at all, and one who joined by code may have typed
   * it in a form the server folded (`server/roomCode.ts`). Six characters of
   * Crockford base32, which is what makes it something a person can read out
   * over a voice call.
   */
  readonly room: string
  /**
   * The bearer token for this **seat**, minted by the host when the seat was
   * first taken and reissued verbatim to whoever comes back holding it.
   *
   * A room code says which match; a token says which *side* of it, and that is
   * the whole difference between reconnecting and joining. Without one, a player
   * whose wifi dropped mid-round would come back to their own match, find both
   * seats taken — one of them by their own vacant body — and be refused as a
   * third player (`server/lifecycle.ts`).
   *
   * It is a bearer credential, so it is never shown to the other peer and never
   * put in a frame anybody else receives. It is not a *security* boundary any
   * more than the room code is: it buys the ability to take a seat in a duel
   * somebody is already playing, for as long as that duel lasts, and the honest
   * summary of the threat model is `docs/deploy.md`.
   */
  readonly token: string
}

/**
 * What happened to somebody's connection. The host's half of the lifecycle.
 *
 * Written from the *recipient's* point of view — "your opponent left", not
 * "slot 1 left" — because the host is the only side that knows who it is
 * talking to, and a client that had to work out whether an event was about
 * itself would be a second copy of the seat table to keep in step.
 *
 * A `life` frame is an **event**, so it needs the reliability the transport
 * contract promises (`transport.ts`): there is no later frame that repairs a
 * dropped "your opponent left", and the countdown it carries is the only reason
 * the other player knows why nobody is shooting back.
 */
export const LifecycleEvent = {
  /** The other seat was taken. The match starts on the next frame. */
  OpponentJoined: 'opponent-joined',
  /**
   * The other peer's socket has gone. Their body stays in the world, standing
   * still and killable, until {@link ServerLifecycle.graceMs} runs out.
   */
  OpponentLeft: 'opponent-left',
  /** They reconnected inside the window. Nothing was lost. */
  OpponentBack: 'opponent-back',
  /** The window ran out. The match is over and you have it. */
  Forfeit: 'forfeit',
} as const

export type LifecycleEvent = (typeof LifecycleEvent)[keyof typeof LifecycleEvent]

export type ServerLifecycle = {
  readonly t: 'life'
  readonly event: LifecycleEvent
  /**
   * Milliseconds left in the grace window this frame is about, or zero when the
   * event has no clock attached.
   *
   * A duration rather than a deadline, because the two ends have no shared
   * wall-clock — only a shared *tick* number, and a grace window is measured in
   * seconds of the host's real time rather than in sub-steps of the world's.
   * The client counts it down itself from the moment it arrives, which is late
   * by one one-way trip and honest about it.
   */
  readonly graceMs: number
  /** One line, already written for a human. The HUD prints it verbatim. */
  readonly detail: string
}

export type ServerHash = {
  readonly t: 'hash'
  readonly tick: number
  readonly hash: number
}

export type ServerVersionMismatch = {
  readonly t: 'version_mismatch'
  readonly serverProtocol: number
  readonly clientProtocol: number
  readonly serverBuild: string
}

/** The client and the server are not looking at the same arena. */
export type ServerMapMismatch = {
  readonly t: 'map_mismatch'
  readonly serverMapHash: string
  readonly clientMapHash: string
}

export type ServerFault = {
  readonly t: 'fault'
  readonly code: string
  readonly detail: string
}

/**
 * "This host is going away in a moment; here is how to come back."
 *
 * What a deploy looks like from inside a live match. The close that follows is
 * a {@link CloseReason.GoingAway}, which already says *that* the host is
 * leaving — this frame is what says **where the match went**, and it is a frame
 * rather than a close reason because a close carries 123 bytes of free text and
 * nothing a client should parse.
 *
 * A room is a live `GameState` in one process's memory (`server/rooms.ts`), so
 * a machine swap destroys it: there is nothing to reconnect *to*. The
 * {@link ServerDrain.resume} ticket is the match's score and this peer's seat,
 * signed by the deploy, so the next machine can rebuild the room at the score
 * it was on without taking a client's word for who was winning.
 *
 * `server/shutdown.ts` sends it; `server/resume.ts` mints and checks the
 * ticket. The reconnect policy that acts on it — the backoff, the grace window,
 * what the player is shown while it happens — is GLAD-DVDV6P's.
 */
export type ServerDrain = {
  readonly t: 'drain'
  /** The room code to rejoin, canonical. Same string as `ServerWelcome.room`. */
  readonly room: string
  /**
   * How long to wait before the first reconnect attempt, in milliseconds.
   *
   * The server's estimate of how long the swap takes, not a rule: a client that
   * dials sooner finds nothing listening, and one that waits far longer has a
   * ticket that has expired. Backoff on top of it is the client's business.
   */
  readonly retryAfterMs: number
  /**
   * The opaque, signed resume ticket. Sent back as `?resume=` on the next
   * connection. Empty when this deploy has no {@link ServerDrain.resume} secret
   * configured, which is a deploy that cannot resume rather than a match that
   * cannot be rejoined — see `server/resume.ts`.
   */
  readonly resume: string
}

/**
 * The server's half of clock sync: "it is tick `tick` here, the last round trip
 * took `rttMs`, and I am holding `queued` of your commands".
 *
 * The server pings and the client echoes, rather than the other way round,
 * because whoever sends the ping is the one who measures the round trip — and
 * the measurement has to be the server's. See {@link ClientPong}.
 *
 * Everything on the wire is an integer, as everywhere else in this protocol. A
 * millisecond is an eighth of a tick, which is finer than the estimate this
 * feeds can possibly be, and integers are one fewer thing two peers can
 * disagree about.
 */
export type ServerPing = {
  readonly t: 'ping'
  /** Echoed back verbatim in the {@link ClientPong}. Monotonic; never reused. */
  readonly id: number
  /**
   * The server's tick at the instant this frame was written.
   *
   * Paired with {@link ServerPing.rttMs}, this is the whole of what a client
   * needs to work out which tick it is predicting into: the tick was current
   * one one-way delay ago. `client/net/clockSync.ts`.
   */
  readonly tick: number
  /**
   * The server's own measurement of the last completed round trip, in whole
   * milliseconds, or {@link UNKNOWN_RTT} until one has completed.
   *
   * Measured against the server's clock from a ping it minted itself. Never a
   * number the client supplied — see {@link ClientPong}.
   */
  readonly rttMs: number
  /**
   * How many of this peer's commands the server is holding and has not executed
   * yet — the depth of its jitter buffer, in ticks.
   *
   * The directly observed version of "how far ahead is this client running",
   * and the number the client trims its lead against once the round-trip
   * estimate has it in the right neighbourhood. `server/inputQueue.ts`.
   */
  readonly queued: number
}

/**
 * The authoritative world, whole, at the tick the host has reached.
 *
 * Reconciliation's raw material (GLAD-6RT64L): the client adopts this state,
 * replays every command it sent after {@link ServerSnapshot.ack}, and lands
 * back where it already thought it was — or does not, which is a correction.
 *
 * ## Why the whole state and not a delta
 *
 * A snapshot is *state*, not an event, and that is what makes it survivable: a
 * client that misses one and receives the next has lost nothing but a frame of
 * interpolation. A delta against a frame the client may not hold gives that
 * property up, and buys bandwidth this game does not need — a duel is two
 * players and a handful of rockets, which is a couple of hundred numbers.
 * Delta encoding belongs to the ticket that measures the bandwidth first.
 *
 * ## Why `ack` is a *client* tick and `state[0]` is a server one
 *
 * They are the same numbering by design — that is what clock sync is for — but
 * they are not the same question. `state[0]` is how far the world has been
 * advanced; `ack` is how much of *this peer's* input is in it. The two are
 * equal only while a host advances the world by exactly the batch it was handed,
 * which is what it does today; the moment a scheduler drains a jitter buffer at
 * a fixed rate (GLAD-FHKBN8) they come apart, and a client that had inferred one
 * from the other would replay the wrong commands.
 */
export type ServerSnapshot = {
  readonly t: 'snap'
  /**
   * The tick label of the last command from *this* peer that the world has
   * executed. Everything the client sent after it is still unacknowledged and
   * gets replayed on top.
   */
  readonly ack: number
  /** The canonical state, flat. `netstate.ts` owns the field order. */
  readonly state: WireState
}

export type ServerMessage =
  | ServerWelcome
  | ServerHash
  | ServerPing
  | ServerSnapshot
  | ServerLifecycle
  | ServerVersionMismatch
  | ServerMapMismatch
  | ServerFault
  | ServerDrain

/** No round trip has completed yet, so there is nothing to report. */
export const UNKNOWN_RTT = -1

/** Pack a command for the wire. */
export function encodeCmd(cmd: UserCmd): WireCmd {
  return [cmd.forwardMove, cmd.sideMove, cmd.yaw, cmd.pitch, cmd.buttons, cmd.weapon]
}

/**
 * Unpack a command from the wire, clamping it into a legal one.
 *
 * Anything that is not a six-number tuple becomes a standing-still command
 * rather than an error: a tick is a total function, so the door is the only
 * place a bad value can be turned away.
 */
export function decodeCmd(wire: unknown): UserCmd {
  if (!Array.isArray(wire) || wire.length !== 6) return sanitizeUserCmd(null)
  return sanitizeUserCmd({
    forwardMove: wire[0],
    sideMove: wire[1],
    yaw: wire[2],
    pitch: wire[3],
    buttons: wire[4],
    weapon: wire[5],
  })
}

/** The on-screen text for a version mismatch. One source of truth, so the
 *  message the test asserts on is the message the player reads. */
export function describeVersionMismatch(mismatch: ServerVersionMismatch): string {
  return (
    `server is on build ${mismatch.serverBuild}, reload — ` +
    `it speaks protocol ${mismatch.serverProtocol} and this page speaks ${mismatch.clientProtocol}.`
  )
}

/** The on-screen text for a map mismatch. Same rule as the version one: the
 *  message a test asserts on is the message a player reads. */
export function describeMapMismatch(mismatch: ServerMapMismatch): string {
  return (
    `this page has arena ${mismatch.clientMapHash} and the server has ` +
    `${mismatch.serverMapHash} — reload to pick up the current one.`
  )
}

function asRecord(raw: string): Record<string, unknown> | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  return parsed as Record<string, unknown>
}

function asFiniteInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null
}

function asString(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.length <= limit ? value : null
}

/** A map hash on the wire: exactly what `formatHash` produces, or nothing. */
function asMapHash(value: unknown): string | null {
  return typeof value === 'string' && /^[0-9a-f]{8}$/.test(value) ? value : null
}

/** One of the lifecycle events, or nothing. Checked against the table so that
 *  a new one cannot arrive as a string nobody handles. */
function asLifecycleEvent(value: unknown): LifecycleEvent | null {
  for (const event of Object.values(LifecycleEvent)) {
    if (value === event) return event
  }
  return null
}

/** Parse a client frame, or `null` if it is not one. */
export function parseClientMessage(raw: string): ClientMessage | null {
  const record = asRecord(raw)
  if (record === null) return null

  if (record['t'] === 'hello') {
    const protocol = asFiniteInteger(record['protocol'])
    const build = asString(record['build'], 64)
    const mapHash = asMapHash(record['mapHash'])
    if (protocol === null || build === null || mapHash === null) return null
    return { t: 'hello', protocol, build, mapHash }
  }

  if (record['t'] === 'cmds') {
    const startTick = asFiniteInteger(record['startTick'])
    const cmds = record['cmds']
    if (startTick === null || startTick < 0) return null
    if (!Array.isArray(cmds) || cmds.length === 0 || cmds.length > MAX_CMDS_PER_BATCH) return null
    return { t: 'cmds', startTick, cmds: cmds.map((cmd) => encodeCmd(decodeCmd(cmd))) }
  }

  if (record['t'] === 'pong') {
    const id = asFiniteInteger(record['id'])
    // A negative id can match no minted ping, so it is not a frame we have any
    // use for. Turned away here rather than left for `clockSync` to shrug at:
    // the door is where a value nobody chose stops being a value at all.
    if (id === null || id < 0) return null
    return { t: 'pong', id }
  }

  return null
}

/** Parse a server frame, or `null` if it is not one. */
export function parseServerMessage(raw: string): ServerMessage | null {
  const record = asRecord(raw)
  if (record === null) return null

  if (record['t'] === 'welcome') {
    const protocol = asFiniteInteger(record['protocol'])
    const build = asString(record['build'], 64)
    const session = asString(record['session'], 64)
    const mapHash = asMapHash(record['mapHash'])
    // Bounded rather than validated against the alphabet: the code's *shape* is
    // `server/roomCode.ts`'s business, and a parser in the simulation package
    // that knew the alphabet would be a second copy of it to keep in step.
    const room = asString(record['room'], 32)
    // Bounded and otherwise opaque, for the same reason as `room`: what a token
    // is made of is `server/lifecycle.ts`'s business, and a parser that knew its
    // shape would be a second opinion about it. Empty is refused — a client that
    // stored one would send it back and be refused as a stranger, which is a
    // failure worth having at the door rather than a minute later.
    const token = asString(record['token'], 64)
    if (protocol === null || build === null || session === null || mapHash === null) return null
    if (room === null || token === null || token === '') return null
    return { t: 'welcome', protocol, build, session, mapHash, room, token }
  }

  if (record['t'] === 'life') {
    const event = asLifecycleEvent(record['event'])
    const graceMs = asFiniteInteger(record['graceMs'])
    const detail = asString(record['detail'], 256)
    if (event === null || graceMs === null || detail === null) return null
    // A negative countdown is a clock that ran backwards; a client that showed
    // one would count *up* towards a forfeit that had already happened.
    if (graceMs < 0) return null
    return { t: 'life', event, graceMs, detail }
  }

  if (record['t'] === 'hash') {
    const tick = asFiniteInteger(record['tick'])
    const hash = asFiniteInteger(record['hash'])
    if (tick === null || hash === null) return null
    return { t: 'hash', tick, hash }
  }

  if (record['t'] === 'ping') {
    const id = asFiniteInteger(record['id'])
    const tick = asFiniteInteger(record['tick'])
    const rttMs = asFiniteInteger(record['rttMs'])
    const queued = asFiniteInteger(record['queued'])
    if (id === null || tick === null || rttMs === null || queued === null) return null
    // `rttMs` may be exactly {@link UNKNOWN_RTT} and nothing else below zero: a
    // negative round trip is a clock that ran backwards, and a client that
    // folded one into its estimate would place the server in its own future.
    if (id < 0 || tick < 0 || queued < 0 || rttMs < UNKNOWN_RTT) return null
    return { t: 'ping', id, tick, rttMs, queued }
  }

  if (record['t'] === 'snap') {
    const ack = asFiniteInteger(record['ack'])
    const state = record['state']
    // The state is checked in full — every number finite, the entity count
    // matching the length — rather than trusted and repaired later. A `NaN` that
    // got past here would be adopted into the client's world, and the
    // simulation has no way to reject one: a tick is a total function.
    if (ack === null || ack < 0 || !isWireState(state)) return null
    return { t: 'snap', ack, state }
  }

  if (record['t'] === 'version_mismatch') {
    const serverProtocol = asFiniteInteger(record['serverProtocol'])
    const clientProtocol = asFiniteInteger(record['clientProtocol'])
    const serverBuild = asString(record['serverBuild'], 64)
    if (serverProtocol === null || clientProtocol === null || serverBuild === null) return null
    return { t: 'version_mismatch', serverProtocol, clientProtocol, serverBuild }
  }

  if (record['t'] === 'map_mismatch') {
    const serverMapHash = asMapHash(record['serverMapHash'])
    const clientMapHash = asMapHash(record['clientMapHash'])
    if (serverMapHash === null || clientMapHash === null) return null
    return { t: 'map_mismatch', serverMapHash, clientMapHash }
  }

  if (record['t'] === 'fault') {
    const code = asString(record['code'], 64)
    const detail = asString(record['detail'], 256)
    if (code === null || detail === null) return null
    return { t: 'fault', code, detail }
  }

  if (record['t'] === 'drain') {
    const room = asString(record['room'], 32)
    const retryAfterMs = asFiniteInteger(record['retryAfterMs'])
    // Bounded rather than parsed: the ticket's shape is `server/resume.ts`'s
    // business and a second opinion about it here would be a second copy to
    // keep in step. Empty is legal and means "this deploy cannot resume".
    const resume = asString(record['resume'], MAX_RESUME_TICKET_CHARS)
    if (room === null || retryAfterMs === null || resume === null) return null
    if (retryAfterMs < 0) return null
    return { t: 'drain', room, retryAfterMs, resume }
  }

  return null
}
