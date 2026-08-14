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
 * Version 3 is the second kind. No frame changed shape; `EntityState` grew
 * `weapon` and `lastFireTick` (GLAD-PWCON8), which changes the canonical
 * encoding and therefore every `hash` a peer computes for the same world. A
 * client one deploy behind would now disagree with the server about a world
 * both of them simulated correctly, and report it as a desync — which is
 * exactly the confusion this number exists to prevent.
 */
export const PROTOCOL_VERSION = 3

/**
 * The most commands one frame may carry. The client's accumulator clamps a
 * stalled frame to 250 ms, which is 31 ticks, so anything near this cap is a
 * client that is lying. Rate limiting proper is GLAD-V7M6PQ.
 */
export const MAX_CMDS_PER_BATCH = 256

/** A `UserCmd` on the wire: `[forwardMove, sideMove, yaw, pitch, buttons]`. */
export type WireCmd = readonly [number, number, number, number, number]

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

export type ClientMessage = ClientHello | ClientCmds

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

export type ServerMessage =
  | ServerWelcome
  | ServerHash
  | ServerVersionMismatch
  | ServerMapMismatch
  | ServerFault

/** Pack a command for the wire. */
export function encodeCmd(cmd: UserCmd): WireCmd {
  return [cmd.forwardMove, cmd.sideMove, cmd.yaw, cmd.pitch, cmd.buttons]
}

/**
 * Unpack a command from the wire, clamping it into a legal one.
 *
 * Anything that is not a five-number tuple becomes a standing-still command
 * rather than an error: a tick is a total function, so the door is the only
 * place a bad value can be turned away.
 */
export function decodeCmd(wire: unknown): UserCmd {
  if (!Array.isArray(wire) || wire.length !== 5) return sanitizeUserCmd(null)
  return sanitizeUserCmd({
    forwardMove: wire[0],
    sideMove: wire[1],
    yaw: wire[2],
    pitch: wire[3],
    buttons: wire[4],
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
