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

/** Bump on any change to the message shapes below. */
export const PROTOCOL_VERSION = 1

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

export type ServerFault = {
  readonly t: 'fault'
  readonly code: string
  readonly detail: string
}

export type ServerMessage = ServerWelcome | ServerHash | ServerVersionMismatch | ServerFault

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

/** Parse a client frame, or `null` if it is not one. */
export function parseClientMessage(raw: string): ClientMessage | null {
  const record = asRecord(raw)
  if (record === null) return null

  if (record['t'] === 'hello') {
    const protocol = asFiniteInteger(record['protocol'])
    const build = asString(record['build'], 64)
    if (protocol === null || build === null) return null
    return { t: 'hello', protocol, build }
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
    if (protocol === null || build === null || session === null) return null
    return { t: 'welcome', protocol, build, session }
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

  if (record['t'] === 'fault') {
    const code = asString(record['code'], 64)
    const detail = asString(record['detail'], 256)
    if (code === null || detail === null) return null
    return { t: 'fault', code, detail }
  }

  return null
}
