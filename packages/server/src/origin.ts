/**
 * The origin allowlist.
 *
 * A WebSocket upgrade is **not** subject to CORS and triggers no preflight. The
 * browser sends an `Origin` header and then does exactly what the server tells
 * it — which means any page on the internet can open a socket to this server
 * unless the server itself says no. That is cross-site WebSocket hijacking, and
 * checking `Origin` at upgrade is the whole defence.
 *
 * ## The decision this file exists to record
 *
 * Vercel gives every preview deployment its own hostname, so the allowlist has
 * to answer a question with no comfortable answer: a pattern tight enough to be
 * a security control rejects the previews, and one loose enough to admit them
 * all is a wildcard wearing a regex. Three candidates, and why the third won:
 *
 * 1. **Production only.** Airtight, and every preview deploy fails to connect
 *    in a way that looks exactly like the server being down — so the person
 *    testing the preview files the wrong bug.
 * 2. **`^https://[a-z0-9-]+\.vercel\.app$`.** Admits every preview, and also
 *    every page every other Vercel customer on earth has ever deployed.
 * 3. **Project *and scope* scoped** — what this file does:
 *
 *        ^https://<project>-[a-z0-9][a-z0-9-]*-<scope>\.vercel\.app$
 *
 * The scope is the team or account slug Vercel appends to every generated
 * preview hostname, and it is globally unique — nobody else can be issued a
 * hostname ending `-<scope>.vercel.app`. That is what makes this a control
 * rather than a gesture, and it is the piece the obvious version misses:
 * `^https://gladiator(-[a-z0-9-]+)?\.vercel\.app$` looks project-scoped and is
 * not, because *anyone* may create a Vercel project called `gladiator-x` and be
 * handed `gladiator-x.vercel.app`.
 *
 * ## It fails closed
 *
 * The scope comes from `VERCEL_SCOPE`, and with no scope configured there is no
 * preview pattern at all — not a looser one. A deploy that forgot the variable
 * loses preview connectivity, which is visible and recoverable; the alternative
 * silently downgrades the control to the version above that is not one.
 * `server.ts` logs which state it booted in, and `NOTES.md` records the whole
 * decision with the trade-off.
 *
 * ## What this is not
 *
 * `Origin` is set by browsers, not by people. A native client can send whatever
 * it likes, so this stops browser-based abuse and nothing else — it is
 * defence in depth in front of a server that is authoritative anyway.
 * Authentication, rate limits and message caps are GLAD-V7M6PQ.
 */
import type { ServerConfig } from './config.ts'

export type OriginVerdict = {
  readonly allowed: boolean
  /** Why, in words, for the rejection log. */
  readonly reason: string
}

/** Regex-escape everything a Vercel project or scope name could contain. */
function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The pattern for this project's preview deployments, or `null` with no scope.
 *
 * Matches both shapes Vercel generates — `<project>-<hash>-<scope>` for a
 * deployment and `<project>-git-<branch>-<scope>` for a branch alias — because
 * the middle is "anything with no dots in it" and both are.
 *
 * The production alias `<project>.vercel.app` is deliberately *not* matched
 * here. It is one fixed string, it belongs in `ALLOWED_ORIGINS` beside the
 * custom domain, and a pattern that also admitted it would have to allow an
 * empty middle — which is the hole this whole file is about.
 */
export function vercelPreviewPattern(project: string, scope: string): RegExp | null {
  if (project === '' || scope === '') return null
  return new RegExp(
    `^https://${escapeForRegex(project)}-[a-z0-9][a-z0-9-]*-${escapeForRegex(scope)}\\.vercel\\.app$`,
  )
}

/** `http://localhost:5173`, `http://127.0.0.1:4173`, and the like. */
const LOCALHOST_PATTERN = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/

export function createOriginPolicy(config: ServerConfig): (origin?: string) => OriginVerdict {
  const preview = vercelPreviewPattern(config.vercelProject, config.vercelScope)
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
    if (preview !== null && preview.test(origin)) {
      return {
        allowed: true,
        reason: `a ${config.vercelProject} preview in the ${config.vercelScope} scope`,
      }
    }
    if (config.allowLocalhost && LOCALHOST_PATTERN.test(origin)) {
      return { allowed: true, reason: 'localhost, and this is not a production build' }
    }
    return { allowed: false, reason: `origin ${origin} is not allowed` }
  }
}

/** One line for the boot log: what this deploy will let through, and what it will not. */
export function describeOriginPolicy(config: ServerConfig): string {
  const listed = config.allowedOrigins.length > 0 ? config.allowedOrigins.join(' ') : '(none listed)'
  const preview =
    config.vercelScope === ''
      ? 'no preview pattern (VERCEL_SCOPE is unset, so previews are refused)'
      : `previews ${config.vercelProject}-*-${config.vercelScope}.vercel.app`
  return `origins: ${listed} + ${preview}${config.allowLocalhost ? ' + localhost' : ''}`
}
