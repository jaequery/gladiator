/**
 * The resume ticket: what a match is reduced to so it can cross a machine.
 *
 * A room is a live `GameState` being advanced 125 times a second in one
 * process's memory (`rooms.ts`), and that is not a shortcut — two players in a
 * duel have to reach the same process. The consequence is that a deploy
 * destroys every room on the machine, and there is nothing on the new machine
 * for a reconnecting client to rejoin.
 *
 * So the *score* crosses, and the world does not. On its way out
 * (`shutdown.ts`) the host hands each peer a ticket saying which room they were
 * in, which seat they had, and what the scoreline was; the next machine reads
 * one, rebuilds the room under the same code, and starts the next round from
 * spawn points like any other. A resumed match is a duel continued, not a world
 * restored — see `sim/match/round.ts`'s `startMatch`.
 *
 * ## Why it is signed
 *
 * Because a score that crossed a machine inside a client is a score a client
 * can choose. Without a signature "resume me at 2-0" is a button, and this is
 * the same reasoning that keeps the round-trip measurement on the server
 * (`sim/protocol.ts`, `ClientPong`): a number that decides something must not be
 * one the interested party supplies. HMAC-SHA256 over the payload with a
 * deploy-wide secret, compared in constant time.
 *
 * The secret is `RESUME_SECRET` and it has to be the *same on both machines* —
 * a per-process random would sign tickets nothing can check, which is the one
 * failure mode that would look like it worked in every test and never once in
 * production. A deploy with no secret set does not pretend: {@link
 * ResumeAuthority.enabled} is false, the drain frame carries an empty ticket,
 * and the log says so at boot. `docs/deploy.md` and `NOTES.md`.
 *
 * ## What is deliberately not in a ticket
 *
 * No session id, no player identity, no health, no position. A ticket is a
 * bearer token for a *seat in a scoreline* and lives for
 * {@link RESUME_TICKET_TTL_MS}; anyone who can read one off the wire is already
 * in a position to read the match. The connection lifecycle's own reconnect
 * token — the one that puts a player back into a *live* room on the same
 * machine within a grace window — is GLAD-DVDV6P's, and it is a different
 * object with a different lifetime.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import {
  DUEL_SLOTS,
  MAX_RESUME_TICKET_CHARS,
  MatchPhase,
  isPlayableScore,
  type GameState,
  type MatchRules,
  type MatchScore,
} from '@gladiator/sim'

import { normalizeRoomCode } from './roomCode.ts'

/**
 * How long a ticket is good for. Two minutes.
 *
 * The window it has to cover is a blue/green cutover plus a client's backoff:
 * the new machine passing its health checks, DNS and the proxy moving over, and
 * a client that waits `retryAfterMs` and then backs off to at most four seconds
 * between attempts. Two minutes is comfortably more than that and short enough
 * that a ticket copied out of a log is worthless by the time anyone reads it.
 */
export const RESUME_TICKET_TTL_MS = 120_000

/**
 * The ticket format's own version tag, first field of every ticket.
 *
 * Not `PROTOCOL_VERSION`: a ticket is minted by one deploy and read by the
 * next, so the two ends are *by construction* different builds, and the whole
 * point is that the reader can tell whether it understands the format before it
 * verifies anything. A ticket in a format this build does not know is refused
 * as a stranger rather than as a forgery.
 */
export const RESUME_FORMAT = 'g1'

/** What a verified ticket says. */
export type ResumeClaim = {
  /** The room to rebuild, canonical. */
  readonly room: string
  /** The seat this peer had, so a score does not change sides on a reconnect. */
  readonly slot: number
  /** The scoreline the match was on. */
  readonly score: MatchScore
  /** When this ticket stops being good, on the minting machine's clock. */
  readonly expiresAtMs: number
}

/**
 * The scoreline a world is on right now, as a resumable score.
 *
 * The only subtlety is what "rounds played" means, and it is a phase question:
 * during a live round the round in progress has not been decided, so the
 * decided count is one below `match.round`; during an intermission the round
 * just ended *has* been scored and the count is `match.round` itself. Getting
 * this wrong does not lose the score — it replays or skips a round number,
 * which both players see on the HUD and neither can explain.
 */
export function matchScoreOf(state: GameState): MatchScore {
  const match = state.match
  const decided = match.phase === MatchPhase.Live ? match.round - 1 : match.round
  return { wins: [match.wins[0], match.wins[1]], roundsPlayed: decided > 0 ? decided : 0 }
}

export type ResumeVerdict =
  | { readonly ok: true; readonly claim: ResumeClaim }
  /** Why not, in words, for the log. Never sent to the client verbatim. */
  | { readonly ok: false; readonly reason: string }

export type ResumeAuthority = {
  /**
   * Whether this deploy can mint and check tickets at all.
   *
   * False when no secret is configured, which is a deploy whose matches do not
   * survive a machine swap. Said out loud at boot rather than discovered during
   * one.
   */
  readonly enabled: boolean
  /** A ticket for this seat in this room, good for {@link RESUME_TICKET_TTL_MS}. */
  mint(claim: Omit<ResumeClaim, 'expiresAtMs'>): string
  /** Read a ticket a client handed back. */
  verify(ticket: string | null | undefined): ResumeVerdict
}

/** The payload, with short keys: it rides in a query string. */
type Payload = {
  /** room */
  readonly r: string
  /** slot */
  readonly s: number
  /** wins, by slot */
  readonly w: readonly [number, number]
  /** rounds decided */
  readonly n: number
  /** expiry, epoch milliseconds */
  readonly x: number
}

function base64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url')
}

function sign(secret: string, body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url')
}

/**
 * Constant-time comparison of two base64url signatures.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak the length
 * through an exception and — much more importantly here — crash the upgrade
 * handler on a malformed ticket. Length is compared first and the result is
 * folded in, so a wrong length is a `false` rather than a throw.
 */
function signatureMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(actual, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function readPayload(raw: string): Payload | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
  const record = parsed as Record<string, unknown>
  const room = record['r']
  const slot = record['s']
  const wins = record['w']
  const rounds = record['n']
  const expiry = record['x']
  if (typeof room !== 'string') return null
  if (typeof slot !== 'number' || !Number.isInteger(slot)) return null
  if (!Array.isArray(wins) || wins.length !== 2) return null
  if (typeof wins[0] !== 'number' || typeof wins[1] !== 'number') return null
  if (typeof rounds !== 'number' || !Number.isInteger(rounds)) return null
  if (typeof expiry !== 'number' || !Number.isInteger(expiry)) return null
  return { r: room, s: slot, w: [wins[0], wins[1]], n: rounds, x: expiry }
}

export type ResumeOptions = {
  /**
   * The shared secret. Empty disables minting and verification entirely.
   *
   * Never defaulted to a generated value: a random per-process secret produces
   * tickets that verify perfectly on the machine that minted them and nowhere
   * else, so every test passes and no real deploy ever resumes.
   */
  readonly secret: string
  /** The rules a resumed match will be played under, to check a score against. */
  readonly rules: MatchRules
  readonly ttlMs?: number
  /**
   * Epoch milliseconds, injected for tests. `Date.now` by default.
   *
   * **Wall-clock, and deliberately not the host's {@link Clock}.** Everywhere
   * else on this side the clock is monotonic with an arbitrary origin, which is
   * exactly right for measuring a round trip and exactly wrong here: a ticket
   * is stamped by one machine and read by another, and `performance.now()` on
   * two machines are two unrelated numbers. The comparison has to be against
   * something both ends mean the same thing by, so it is epoch time — and the
   * tolerance for the clock skew between two machines of the same app is the
   * two minutes in {@link RESUME_TICKET_TTL_MS}.
   */
  readonly now?: () => number
}

export function createResumeAuthority(options: ResumeOptions): ResumeAuthority {
  const secret = options.secret
  const ttlMs = options.ttlMs ?? RESUME_TICKET_TTL_MS
  const now = options.now ?? (() => Date.now())
  const enabled = secret !== ''

  return {
    enabled,

    mint(claim) {
      const nowMs = now()
      if (!enabled) return ''
      const payload: Payload = {
        r: claim.room,
        s: claim.slot,
        w: [claim.score.wins[0], claim.score.wins[1]],
        n: claim.score.roundsPlayed,
        x: nowMs + ttlMs,
      }
      const body = `${RESUME_FORMAT}.${base64url(JSON.stringify(payload))}`
      return `${body}.${sign(secret, body)}`
    },

    verify(ticket) {
      const nowMs = now()
      if (!enabled) return { ok: false, reason: 'this deploy has no RESUME_SECRET set' }
      if (ticket === null || ticket === undefined || ticket === '') {
        return { ok: false, reason: 'no ticket' }
      }
      // Bounded before anything is decoded: the string arrived in a URL, and
      // the first thing to know about a stranger's string is that it is small.
      if (ticket.length > MAX_RESUME_TICKET_CHARS) {
        return { ok: false, reason: `ticket is ${ticket.length} characters` }
      }

      const parts = ticket.split('.')
      if (parts.length !== 3) return { ok: false, reason: 'not a ticket' }
      const [format, encoded, signature] = parts as [string, string, string]
      if (format !== RESUME_FORMAT) {
        return { ok: false, reason: `ticket format ${format} is not ${RESUME_FORMAT}` }
      }
      // The signature is checked *before* the payload is trusted for anything,
      // including being parsed into decisions — the only thing the bytes are
      // used for first is their own MAC.
      if (!signatureMatches(sign(secret, `${format}.${encoded}`), signature)) {
        return { ok: false, reason: 'signature does not match' }
      }

      const payload = readPayload(encoded)
      if (payload === null) return { ok: false, reason: 'payload is not a claim' }
      if (payload.x <= nowMs) {
        return { ok: false, reason: `ticket expired ${nowMs - payload.x} ms ago` }
      }

      const room = normalizeRoomCode(payload.r)
      if (room === null) return { ok: false, reason: `${payload.r} is not a room code` }
      if (!DUEL_SLOTS.includes(payload.s)) {
        return { ok: false, reason: `slot ${payload.s} is not a seat` }
      }

      const score: MatchScore = { wins: [payload.w[0], payload.w[1]], roundsPlayed: payload.n }
      // Checked against *this* build's rules, not the minting build's. A deploy
      // that changed the format from best-of-five is a deploy whose old
      // scorelines mean something else, and a room rebuilt at one would be a
      // match nobody agreed to play.
      if (!isPlayableScore(score, options.rules)) {
        return {
          ok: false,
          reason: `the score ${score.wins[0]}-${score.wins[1]} after ${score.roundsPlayed} rounds is not a live match under this build's rules`,
        }
      }

      return { ok: true, claim: { room, slot: payload.s, score, expiresAtMs: payload.x } }
    },
  }
}

/**
 * A secret to run a *local* server with, printed once so it can be copied.
 *
 * For `pnpm --filter @gladiator/server dev` and nothing else. Production sets
 * `RESUME_SECRET` as a Fly secret, because the machine that reads a ticket is
 * never the machine that minted it — that is the entire point of the thing.
 */
export function generateResumeSecret(): string {
  return randomBytes(32).toString('hex')
}
