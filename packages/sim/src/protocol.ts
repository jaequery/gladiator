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
 */
export const PROTOCOL_VERSION = 4

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

export type ServerMessage =
  | ServerWelcome
  | ServerHash
  | ServerPing
  | ServerVersionMismatch
  | ServerMapMismatch
  | ServerFault

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
    if (protocol === null || build === null || session === null || mapHash === null) return null
    return { t: 'welcome', protocol, build, session, mapHash }
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

  return null
}
