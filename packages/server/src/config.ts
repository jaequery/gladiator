/**
 * Server configuration, read once from the environment.
 *
 * Everything here is a value rather than a lookup so the pieces below can be
 * tested without a `process`. Room and tick configuration is GLAD-FHKBN8's.
 */

/** The port `pnpm --filter @gladiator/server dev` listens on locally. */
export const DEFAULT_PORT = 8787

/**
 * The Vercel project the client is deployed as. Preview deployments are
 * `<project>-<something>-<scope>.vercel.app`, so this is half of what makes the
 * preview pattern a control rather than a wildcard. See `origin.ts`.
 */
export const DEFAULT_VERCEL_PROJECT = 'gladiator'

/** Biggest frame we will read. A `cmds` batch at the cap is a few kilobytes. */
export const MAX_PAYLOAD_BYTES = 64 * 1024

export type ServerConfig = {
  readonly port: number
  /** The commit this build came from. Shown to clients on a version mismatch. */
  readonly build: string
  /** Origins allowed verbatim. */
  readonly allowedOrigins: readonly string[]
  /** The Vercel project whose preview deployments are allowed. */
  readonly vercelProject: string
  /**
   * The Vercel team or account slug preview hostnames end with.
   *
   * Empty means no preview pattern at all — `origin.ts` fails closed rather
   * than falling back to a looser one, and the boot log says which it did.
   */
  readonly vercelScope: string
  /** Whether `http://localhost:*` may connect. Off in production. */
  readonly allowLocalhost: boolean
  readonly maxPayloadBytes: number
  /**
   * The HMAC secret that signs resume tickets (`resume.ts`).
   *
   * Shared by every machine of the app, because the machine that *checks* a
   * ticket is by construction never the one that minted it. Empty means this
   * deploy hands out no tickets and a deploy ends the matches it interrupts.
   */
  readonly resumeSecret: string
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
    vercelScope: env['VERCEL_SCOPE'] ?? '',
    allowLocalhost: env['NODE_ENV'] !== 'production',
    maxPayloadBytes: readInteger(env['MAX_PAYLOAD_BYTES'], MAX_PAYLOAD_BYTES),
    resumeSecret: env['RESUME_SECRET'] ?? '',
  }
}
