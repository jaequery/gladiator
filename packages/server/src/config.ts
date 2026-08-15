/**
 * Server configuration, read once from the environment.
 *
 * Everything here is a value rather than a lookup so the pieces below can be
 * tested without a `process`. Room and tick configuration is GLAD-FHKBN8's; the
 * limits a hostile client runs into are GLAD-V7M6PQ's, and the ones with an
 * argument behind them live next to the code that enforces them — `validate.ts`
 * for what a connection may send, `inputQueue.ts` for what it may execute.
 */
import { MAX_FRAME_BYTES } from './validate.ts'

/** The port `pnpm --filter @gladiator/server dev` listens on locally. */
export const DEFAULT_PORT = 8787

/**
 * The Vercel project the client is deployed as. Preview deployments are
 * `<project>-<something>.vercel.app`, so this is what makes the preview regex
 * project-scoped rather than "anything on vercel.app". See `docs/deploy.md`.
 */
export const DEFAULT_VERCEL_PROJECT = 'gladiator'

/**
 * Biggest frame we will read.
 *
 * One number with two enforcers: `ws`'s `maxPayload`, which refuses an
 * oversized frame before its bytes are ever assembled, and the frame guard in
 * `validate.ts`, which catches the same thing arriving over a loopback. The
 * arithmetic behind 16 kB — a full 256-command batch is about 7.7 — is
 * {@link MAX_FRAME_BYTES}'s doc comment, which this re-exports rather than
 * restates.
 */
export const MAX_PAYLOAD_BYTES = MAX_FRAME_BYTES

/**
 * Connections one client address may open per wall-clock second.
 *
 * One, with a burst of {@link CONNECT_BURST}. A guess at a room code costs a
 * connection, so this is the number the brute-force arithmetic in
 * `docs/deploy.md` is computed against: at 200 live rooms — every connection
 * this machine admits having opened a match nobody joined — one address needs a
 * median of two months to walk into one stranger's duel.
 *
 * It is a limit on the *address*, not on the player, and that is the trade being
 * made: everyone behind one NAT or one IPv6 /64 shares it (`rateLimit.ts`), so
 * the budget is sized for a household rather than for one browser tab. A player
 * reloading a page spends one.
 */
export const CONNECT_BUDGET_PER_SECOND = 1

/**
 * How far ahead of its own connection budget one address may run.
 *
 * Twenty. A page reload, a flaky network reconnecting, and a second player in
 * the same house are all bursts of connections that are not an attack; twenty is
 * enough of them that no honest sequence reaches it, and it costs the attacker
 * twenty guesses out of a billion.
 */
export const CONNECT_BURST = 20

/**
 * How many sockets one client address may hold open at once.
 *
 * Eight. `MAX_ROOMS` is 200 and a room is created per connection that asks for
 * one, so without this a single script could hold every room on the machine
 * open by opening connections slowly enough to stay under the rate limit. Eight
 * is four duels from one address, which is a LAN party rather than a bot.
 */
export const MAX_CONNECTIONS_PER_ADDRESS = 8

/**
 * The header the real client address is read from, when there is one.
 *
 * Behind Fly's proxy every connection arrives from the proxy, so
 * `socket.remoteAddress` is one address for the whole internet and a per-address
 * limit built on it would rate-limit every player together. Fly sets
 * `Fly-Client-IP` and overwrites whatever the client sent, which is what makes
 * it trustworthy *there*.
 *
 * **It is only trustworthy there.** A process reachable directly, with no proxy
 * in front of it, would be handed whatever an attacker typed — a fresh bucket
 * per guess, which is the same as no limit at all. Set `TRUSTED_IP_HEADER=` to
 * the empty string to turn it off and use the socket's own address.
 */
export const DEFAULT_TRUSTED_IP_HEADER = 'fly-client-ip'

export type ServerConfig = {
  readonly port: number
  /** The commit this build came from. Shown to clients on a version mismatch. */
  readonly build: string
  /** Origins allowed verbatim. */
  readonly allowedOrigins: readonly string[]
  /** The Vercel project whose preview deployments are allowed. */
  readonly vercelProject: string
  /** Whether `http://localhost:*` may connect. Off in production. */
  readonly allowLocalhost: boolean
  readonly maxPayloadBytes: number
  /** Connections per second, per client address. {@link CONNECT_BUDGET_PER_SECOND}. */
  readonly connectBudgetPerSecond: number
  readonly connectBurst: number
  /** Sockets one address may hold open. {@link MAX_CONNECTIONS_PER_ADDRESS}. */
  readonly maxConnectionsPerAddress: number
  /** Where the real client address is, behind a proxy. `''` means "nowhere". */
  readonly trustedIpHeader: string
}

function readInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

function readList(raw: string | undefined): readonly string[] {
  if (raw === undefined) return []
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
}

export function readConfig(env: Record<string, string | undefined>): ServerConfig {
  return {
    // Fly injects PORT; locally there is none and DEFAULT_PORT applies.
    port: readInteger(env['PORT'], DEFAULT_PORT),
    build: env['GLADIATOR_BUILD'] ?? 'dev',
    allowedOrigins: readList(env['ALLOWED_ORIGINS']),
    vercelProject: env['VERCEL_PROJECT'] ?? DEFAULT_VERCEL_PROJECT,
    allowLocalhost: env['NODE_ENV'] !== 'production',
    maxPayloadBytes: readInteger(env['MAX_PAYLOAD_BYTES'], MAX_PAYLOAD_BYTES),
    connectBudgetPerSecond: readInteger(
      env['CONNECT_BUDGET_PER_SECOND'],
      CONNECT_BUDGET_PER_SECOND,
    ),
    connectBurst: readInteger(env['CONNECT_BURST'], CONNECT_BURST),
    maxConnectionsPerAddress: readInteger(
      env['MAX_CONNECTIONS_PER_ADDRESS'],
      MAX_CONNECTIONS_PER_ADDRESS,
    ),
    // `??` rather than `||`, because `TRUSTED_IP_HEADER=` set to the empty
    // string is a deliberate "there is no proxy in front of me" and must not
    // fall through to the Fly default.
    trustedIpHeader: (env['TRUSTED_IP_HEADER'] ?? DEFAULT_TRUSTED_IP_HEADER).toLowerCase(),
  }
}
