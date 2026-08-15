import { mintRoomCode } from '@gladiator/server/roomCode'
import { describe, expect, it } from 'vitest'

import {
  formatRoomCode,
  matchIntent,
  readTypedCode,
  roomCodeIn,
  roomUrl,
  shareLink,
} from './roomFlow.ts'

const ORIGIN = 'https://gladiator.example/'

describe('what a URL is asking for', () => {
  it('shows the menu when nothing was asked for', () => {
    expect(matchIntent('')).toEqual({ kind: 'menu' })
    expect(matchIntent('?hud=demo')).toEqual({ kind: 'menu' })
    expect(matchIntent('?room=')).toEqual({ kind: 'menu' })
  })

  it('boots single-player on ?local=1', () => {
    expect(matchIntent('?local=1')).toEqual({ kind: 'bot' })
    // The presence of the parameter is what counts, as it is in `main.ts`.
    expect(matchIntent('?local')).toEqual({ kind: 'bot' })
  })

  it('goes straight into the join with the code already in hand', () => {
    expect(matchIntent('?room=H7K2Q9')).toEqual({ kind: 'join', code: 'H7K2Q9' })
  })

  it('folds a code somebody retyped by hand', () => {
    // Crockford's own rules, the host's implementation: lower case, O for 0,
    // I and L for 1, and the hyphen a person put in to read it out.
    expect(matchIntent('?room=h7k-2q9')).toEqual({ kind: 'join', code: 'H7K2Q9' })
    expect(matchIntent('?room=oil234')).toEqual({ kind: 'join', code: '011234' })
    expect(roomCodeIn('?room=H7K 2Q9')).toBe('H7K2Q9')
  })

  it('keeps what was typed when it is not a code, rather than dropping it', () => {
    // A chat client ate a character, or the code was read out over a bad line.
    // The player is not at fault and the box should still have their attempt.
    expect(matchIntent('?room=H7K2Q')).toEqual({ kind: 'join-typo', typed: 'H7K2Q' })
    expect(matchIntent('?room=UUUUUU')).toEqual({ kind: 'join-typo', typed: 'UUUUUU' })
  })

  it('reads the bot mode first, because ?local=1 is not a room', () => {
    expect(matchIntent('?local=1&room=H7K2Q9')).toEqual({ kind: 'bot' })
  })

  it('opens a room with no menu in front of it on ?host=1', () => {
    expect(matchIntent('?host=1')).toEqual({ kind: 'create' })
  })

  it('rejoins rather than opening a second room when a host reloads', () => {
    // `roomUrl` leaves the rest of the query string alone, so a host who
    // pressed "create a match" from `?host=1` and then reloaded is holding
    // both. Reading `host` first would open them a new, empty room and leave
    // their friend in the old one.
    expect(matchIntent('?host=1&room=H7K2Q9')).toEqual({ kind: 'join', code: 'H7K2Q9' })
  })
})

describe('the link a player sends', () => {
  it('is this page with the room on it', () => {
    expect(shareLink(ORIGIN, 'H7K2Q9')).toBe('https://gladiator.example/?room=H7K2Q9')
  })

  it('throws the current query string away', () => {
    // Otherwise a host who arrived on `?local=1` hands their friend a link that
    // boots them into single-player, and neither of them can work out why.
    expect(shareLink(`${ORIGIN}?local=1&hud=demo#x`, 'H7K2Q9')).toBe(
      'https://gladiator.example/?room=H7K2Q9',
    )
  })

  it('keeps the path, so a deploy under a subdirectory still works', () => {
    expect(shareLink('https://example.test/gladiator/index.html?a=1', 'H7K2Q9')).toBe(
      'https://example.test/gladiator/index.html?room=H7K2Q9',
    )
  })

  it('round-trips: the link a host sends is a join for the code they were given', () => {
    for (let i = 0; i < 64; i += 1) {
      const code = mintRoomCode()
      const link = shareLink(ORIGIN, code)
      expect(matchIntent(new URL(link).search)).toEqual({ kind: 'join', code })
    }
  })

  it('rewrites the address bar relatively, so the origin cannot drift', () => {
    expect(roomUrl('H7K2Q9')).toBe('?room=H7K2Q9')
    expect(new URL(roomUrl('H7K2Q9'), 'http://127.0.0.1:8799/').toString()).toBe(
      'http://127.0.0.1:8799/?room=H7K2Q9',
    )
  })

  it('keeps the rest of the address bar, unlike the share link', () => {
    // The address bar is the player's own state — a debug flag, the demo HUD —
    // and a reload that dropped it would be a reload that changed the page.
    expect(roomUrl('H7K2Q9', '?host=1&hud=demo')).toBe('?host=1&hud=demo&room=H7K2Q9')
    expect(roomUrl('H7K2Q9', '?room=OLD111')).toBe('?room=H7K2Q9')
  })
})

describe('the code on screen', () => {
  it('is grouped so it can be read out loud', () => {
    expect(formatRoomCode('H7K2Q9')).toBe('H7K-2Q9')
  })

  it('is still a code the host accepts, hyphen and all', () => {
    expect(roomCodeIn(`?room=${formatRoomCode('H7K2Q9')}`)).toBe('H7K2Q9')
  })
})

describe('the join box', () => {
  it('says nothing until there is something to say', () => {
    expect(readTypedCode('')).toEqual({ code: null, hint: '' })
    expect(readTypedCode('   ')).toEqual({ code: null, hint: '' })
  })

  it('counts down the characters still needed', () => {
    expect(readTypedCode('H').hint).toBe('5 more characters')
    expect(readTypedCode('H7K2Q').hint).toBe('1 more character')
    expect(readTypedCode('H7K-2Q').hint).toBe('1 more character')
  })

  it('accepts a code the moment it is one', () => {
    expect(readTypedCode('h7k2q9').code).toBe('H7K2Q9')
    expect(readTypedCode('  H7K-2Q9 ').code).toBe('H7K2Q9')
  })

  it('says what is wrong when six characters are not a code', () => {
    // `U` is refused rather than folded: it is ambiguous with nothing, so a `U`
    // is a typo rather than a misread. `@gladiator/server/roomCode.ts`.
    expect(readTypedCode('H7K2QU').hint).toContain('typo')
    expect(readTypedCode('H7K2Q99').hint).toBe('a room code is six characters')
  })
})
