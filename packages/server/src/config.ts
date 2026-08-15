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
 * `<project>-<something>.vercel.app`, so this is what makes the preview regex
 * project-scoped rather than "anything on vercel.app". See `docs/deploy.md`.
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
  /** Whether `http://localhost:*` may connect. Off in production. */
  readonly allowLocalhost: boolean
  readonly maxPayloadBytes: number
  /**
   * Where to write a demo of every match, or `null` for "do not record".
   *
   * Off by default. A recording is a growing array per room and a file per
   * match, so it is a thing somebody turns on to chase a bug rather than
   * something a production machine does to two hundred rooms by accident.
   * `demoFile.ts`.
   */
  readonly demoDir: string | null
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
    demoDir: readPath(env['GLADIATOR_DEMO_DIR']),
  }
}

/** A directory, or `null` for unset and for the empty string. */
function readPath(raw: string | undefined): string | null {
  const trimmed = raw?.trim() ?? ''
  return trimmed === '' ? null : trimmed
}
