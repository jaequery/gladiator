/**
 * The resume ticket, on its own.
 *
 * `deploy.test.ts` proves it works over two real sockets; this proves the
 * things that are hard to arrange over a socket and awful to discover in
 * production — a tampered score, an expired ticket, a machine that does not
 * share the secret, and the one that would be silently catastrophic: a ticket
 * whose payload is read before its signature is checked.
 */
import { DEFAULT_MATCH_RULES, MatchPhase, createMapState, matchRules } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { SERVER_MAP } from './map.ts'
import {
  RESUME_FORMAT,
  RESUME_TICKET_TTL_MS,
  createResumeAuthority,
  generateResumeSecret,
  matchScoreOf,
} from './resume.ts'

const SECRET = 'both-machines-have-this-one'
const SCORE = { wins: [1, 0] as const, roundsPlayed: 1 }

function authority(over: { secret?: string; nowMs?: number } = {}) {
  let nowMs = over.nowMs ?? 1_700_000_000_000
  const auth = createResumeAuthority({
    secret: over.secret ?? SECRET,
    rules: DEFAULT_MATCH_RULES,
    now: () => nowMs,
  })
  return {
    auth,
    advance(ms: number) {
      nowMs += ms
    },
  }
}

describe('minting and reading a ticket', () => {
  it('round-trips the room, the seat and the score', () => {
    const { auth } = authority()
    const ticket = auth.mint({ room: 'H7K2Q9', slot: 1, score: SCORE })
    const verdict = auth.verify(ticket)
    expect(verdict).toMatchObject({
      ok: true,
      claim: { room: 'H7K2Q9', slot: 1, score: { wins: [1, 0], roundsPlayed: 1 } },
    })
  })

  it('fits in a query string', () => {
    // It travels as `?resume=…` on the reconnect, so a ticket the size of a
    // page is a ticket that turns up in somebody's proxy log truncated.
    const { auth } = authority()
    expect(auth.mint({ room: 'H7K2Q9', slot: 0, score: SCORE }).length).toBeLessThan(256)
    expect(auth.mint({ room: 'H7K2Q9', slot: 0, score: SCORE }).startsWith(`${RESUME_FORMAT}.`))
      .toBe(true)
  })

  it('refuses a score somebody improved on the way over', () => {
    // The reason the thing is signed at all. Two players' scores cross a
    // machine inside the clients they belong to, and a payload nobody checked
    // is a scoreboard the loser edits.
    const { auth } = authority()
    const ticket = auth.mint({ room: 'H7K2Q9', slot: 0, score: SCORE })
    const [format, payload, signature] = ticket.split('.') as [string, string, string]
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      w: [number, number]
    }
    decoded.w = [2, 0]
    const forged = Buffer.from(JSON.stringify(decoded), 'utf8').toString('base64url')

    expect(auth.verify(`${format}.${forged}.${signature}`)).toMatchObject({
      ok: false,
      reason: 'signature does not match',
    })
  })

  it('refuses a ticket a different machine signed', () => {
    const minted = authority({ secret: 'one-secret' }).auth.mint({
      room: 'H7K2Q9',
      slot: 0,
      score: SCORE,
    })
    expect(authority({ secret: 'another-secret' }).auth.verify(minted).ok).toBe(false)
  })

  it('expires, and says by how much', () => {
    const { auth, advance } = authority()
    const ticket = auth.mint({ room: 'H7K2Q9', slot: 0, score: SCORE })
    advance(RESUME_TICKET_TTL_MS - 1)
    expect(auth.verify(ticket).ok).toBe(true)
    advance(2)
    const verdict = auth.verify(ticket)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('expired')
  })

  it('refuses nonsense of every shape without throwing', () => {
    // This runs on an upgrade, so anything that throws here is a stranger's
    // string taking the process down. `timingSafeEqual` on a wrong-length
    // buffer is the specific one that would.
    const { auth } = authority()
    for (const nonsense of [
      '',
      'not-a-ticket',
      'g1.only-two-parts',
      'g9.abc.def',
      `${RESUME_FORMAT}...`,
      `${RESUME_FORMAT}.${Buffer.from('{}', 'utf8').toString('base64url')}.short`,
      `${RESUME_FORMAT}.${'A'.repeat(600)}.x`,
      null,
      undefined,
    ]) {
      expect(auth.verify(nonsense).ok).toBe(false)
    }
  })

  it('refuses a score that is not a live match under this build s rules', () => {
    // A ticket minted by yesterday's deploy under different rules. The score is
    // genuinely signed and genuinely meaningless, and rebuilding a room at it
    // would start a match that ends on its first sub-step.
    const yesterday = createResumeAuthority({
      secret: SECRET,
      rules: matchRules({ roundsToWin: 5 }),
      now: () => 1_700_000_000_000,
    })
    const ticket = yesterday.mint({ room: 'H7K2Q9', slot: 0, score: { wins: [4, 0], roundsPlayed: 4 } })

    const today = createResumeAuthority({
      secret: SECRET,
      rules: DEFAULT_MATCH_RULES,
      now: () => 1_700_000_000_000,
    })
    const verdict = today.verify(ticket)
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('not a live match')
  })

  it('refuses a seat that is not a seat', () => {
    const { auth } = authority()
    const ticket = auth.mint({ room: 'H7K2Q9', slot: 7, score: SCORE })
    expect(auth.verify(ticket).ok).toBe(false)
  })

  it('does nothing at all without a secret, and says so', () => {
    const { auth } = authority({ secret: '' })
    expect(auth.enabled).toBe(false)
    expect(auth.mint({ room: 'H7K2Q9', slot: 0, score: SCORE })).toBe('')
    const verdict = auth.verify('anything')
    expect(verdict.ok).toBe(false)
    expect(verdict.ok === false && verdict.reason).toContain('RESUME_SECRET')
  })

  it('generates a secret worth having', () => {
    const secret = generateResumeSecret()
    expect(secret).toMatch(/^[0-9a-f]{64}$/)
    expect(generateResumeSecret()).not.toBe(secret)
  })
})

describe('the score a world is on', () => {
  it('counts the round in progress as undecided, and an intermission as decided', () => {
    // The one subtlety in the whole file: get this backwards and the resumed
    // match replays a round that was scored, or skips one that was not.
    const state = createMapState(SERVER_MAP.source, 1)
    state.match.wins[0] = 1
    state.match.wins[1] = 1

    state.match.phase = MatchPhase.Live
    state.match.round = 3
    expect(matchScoreOf(state)).toEqual({ wins: [1, 1], roundsPlayed: 2 })

    state.match.phase = MatchPhase.Intermission
    expect(matchScoreOf(state)).toEqual({ wins: [1, 1], roundsPlayed: 3 })
  })

  it('is nil-nil in warmup, which is a room whose friend has not arrived', () => {
    const state = createMapState(SERVER_MAP.source, 1)
    expect(state.match.phase).toBe(MatchPhase.Warmup)
    expect(matchScoreOf(state)).toEqual({ wins: [0, 0], roundsPlayed: 0 })
  })
})
