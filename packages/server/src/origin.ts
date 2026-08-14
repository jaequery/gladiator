/**
 * The origin allowlist.
 *
 * A WebSocket upgrade is **not** subject to CORS and triggers no preflight. The
 * browser sends an `Origin` header and then does exactly what the server tells
 * it — which means any page on the internet can open a socket to this server
 * unless the server itself says no. That is cross-site WebSocket hijacking, and
 * checking `Origin` at upgrade is the whole defence.
 *
 * ## How loose the allowlist is, and why
 *
 * Vercel gives every preview deployment its own hostname. An allowlist of just
 * the production domain means every preview silently fails to connect, which is
 * worse than it sounds: the failure looks like the server being down, so the
 * person testing the preview reports the wrong bug.
 *
 * So previews are matched by a regex — but a **project-scoped** one:
 *
 *     ^https://<project>(-[a-z0-9-]+)?\.vercel\.app$
 *
 * Not `^https://[a-z0-9-]+\.vercel\.app$`. The loose version would let any
 * Vercel user on earth point a page at this server; the scoped one only admits
 * hostnames Vercel itself will only ever hand to this project.
 *
 * ## What this is not
 *
 * `Origin` is set by browsers, not by people. A native client can send whatever
 * it likes, so this stops browser-based abuse and nothing else. Authentication,
 * rate limits and message caps are GLAD-V7M6PQ; the policy that survives
 * contact with real players is GLAD-G41FQ9.
 */
import type { ServerConfig } from './config.ts'

export type OriginVerdict = {
  readonly allowed: boolean
  /** Why, in words, for the rejection log. */
  readonly reason: string
}

/** Regex-escape everything a Vercel project name could legally contain. */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `https://<project>.vercel.app` and `https://<project>-<anything>.vercel.app`. */
export function vercelOriginPattern(project: string): RegExp {
  return new RegExp(`^https://${escapeForRegex(project)}(-[a-z0-9-]+)?\\.vercel\\.app$`)
}

/** `http://localhost:5173`, `http://127.0.0.1:4173`, and the like. */
const LOCALHOST_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

export function createOriginPolicy(config: ServerConfig): (origin?: string) => OriginVerdict {
  const preview = vercelOriginPattern(config.vercelProject)
  const explicit = new Set(config.allowedOrigins)

  return (origin) => {
    // A browser always sends `Origin` on an upgrade. Something that does not is
    // not a browser, and this server has no non-browser clients — so a missing
    // header is a rejection rather than a wildcard.
    if (origin === undefined || origin === '') {
      return { allowed: false, reason: 'no Origin header' }
    }
    if (explicit.has(origin)) {
      return { allowed: true, reason: 'listed in ALLOWED_ORIGINS' }
    }
    if (preview.test(origin)) {
      return { allowed: true, reason: `matches the ${config.vercelProject} Vercel pattern` }
    }
    if (config.allowLocalhost && LOCALHOST_PATTERN.test(origin)) {
      return { allowed: true, reason: 'localhost, and this is not a production build' }
    }
    return { allowed: false, reason: `origin ${origin} is not allowed` }
  }
}
