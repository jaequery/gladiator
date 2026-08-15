/**
 * The room-code flow, as arithmetic on a URL.
 *
 * The whole lobby is one string sent to a friend. There is no matchmaking, no
 * account and no invite system, so every step between "I got a link" and "I am
 * in the duel" is a step where the second player gives up — which makes the
 * shape of the URL a design decision rather than plumbing.
 *
 * ## The code lives in the query string, and nowhere else
 *
 * `?room=H7K2Q9` is the whole of it. A query parameter rather than a fragment
 * because the fragment is not sent anywhere and this one has to survive being
 * pasted into a chat window that rewrites links, and rather than a path segment
 * because the client is a static bundle on Vercel and a path would need a
 * rewrite rule to serve the same `index.html`.
 *
 * It is also the reason there is no client-side "state" to lose: the code in
 * the address bar *is* the session, so a reload rejoins the same match and a
 * bookmark is a rematch. When a player creates a room the host mints the code
 * and it arrives in the welcome, at which point the page rewrites its own URL
 * to include it ({@link roomUrl}) — so even the host, who never typed a code,
 * can reload.
 *
 * ## Reading is lenient, writing is strict
 *
 * The alphabet, the folding and the six-character length are the host's
 * (`@gladiator/server/roomCode.ts`), imported rather than restated: a client
 * with its own copy of the alphabet is a second opinion to keep in step, and
 * the failure mode is a player being told a perfectly good code does not exist.
 * What this module adds is only what a *page* needs — which URL means what, and
 * what to put in front of somebody who typed something that is not a code.
 */
import { normalizeRoomCode } from '@gladiator/server/roomCode'

/** The query parameter the code rides in. The host reads the same name. */
export const ROOM_PARAM = 'room'

/** `?local=1` — the listen server, and single-player. */
export const LOCAL_PARAM = 'local'

/**
 * `?host=1` — open a room and go straight in, with no menu in front of it.
 *
 * The sibling of `?local=1` and `?shot=1`: a URL that names a state the page
 * can otherwise only be clicked into. It is what `scripts/e2e.mjs` drives, so
 * that the browser test measures the *game* rather than a menu, and it is what
 * a developer wants on a reload. A player never types it — they press "create a
 * match", which is the same code path with the menu still on screen.
 */
export const HOST_PARAM = 'host'

/** What a page's URL is asking for. */
export type MatchIntent =
  /** Nothing was asked for: show the menu. */
  | { readonly kind: 'menu' }
  /** `?local=1`: the host in this tab, and a bot to duel. */
  | { readonly kind: 'bot' }
  /** `?host=1`: open a room, and no menu in front of it. */
  | { readonly kind: 'create' }
  /** `?room=H7K2Q9`: join that match, with nothing to type. */
  | { readonly kind: 'join'; readonly code: string }
  /**
   * `?room=` something that is not a code.
   *
   * Its own case rather than "menu", because the player did nothing wrong that
   * they can see — a chat client ate the last character, or the code was read
   * out over a bad line — and the useful response is the join box, open, with
   * what they arrived with still in it.
   */
  | { readonly kind: 'join-typo'; readonly typed: string }

/**
 * The code in a query string, folded to canonical form, or `null`.
 *
 * `null` covers both "there is no code here" and "that is not a code"; the
 * caller that needs to tell them apart is {@link matchIntent}.
 */
export function roomCodeIn(search: string): string | null {
  return normalizeRoomCode(new URLSearchParams(search).get(ROOM_PARAM))
}

/**
 * What this page was opened to do.
 *
 * The order is the interesting part. `?room=` outranks `?host=1` because
 * {@link roomUrl} leaves the rest of the query string alone when it writes the
 * minted code into the address bar — so a host who reloads is holding
 * `?host=1&room=H7K2Q9`, and the right reading of that is "rejoin the match I
 * am already in" rather than "open a second empty one".
 */
export function matchIntent(search: string): MatchIntent {
  const parameters = new URLSearchParams(search)
  if (parameters.get(LOCAL_PARAM) !== null) return { kind: 'bot' }

  const typed = parameters.get(ROOM_PARAM)
  if (typed !== null && typed !== '') {
    const code = normalizeRoomCode(typed)
    return code === null ? { kind: 'join-typo', typed } : { kind: 'join', code }
  }

  return parameters.get(HOST_PARAM) !== null ? { kind: 'create' } : { kind: 'menu' }
}

/**
 * The link a player sends a friend.
 *
 * Built from the page's own address with the query string thrown away first, so
 * a host who arrived on `?local=1&hud=demo` does not hand somebody a link that
 * boots them into single-player with a debug readout. The fragment goes for the
 * same reason.
 */
export function shareLink(href: string, code: string): string {
  const url = new URL(href)
  url.search = ''
  url.hash = ''
  url.searchParams.set(ROOM_PARAM, code)
  return url.toString()
}

/**
 * The same thing as a *relative* URL, for `history.replaceState`.
 *
 * Relative because replacing the address bar with an absolute URL is how a page
 * accidentally moves itself between `127.0.0.1` and `localhost`, or drops a
 * port, and either one breaks the socket that is already open.
 *
 * Everything else in the query string is kept. This is the address bar and not
 * the share link: whatever the player has turned on — `?hud=demo`, a protocol
 * override, the diagnostics — is theirs, and a reload that silently dropped it
 * would be a reload that changed the page. The link that goes to a *friend* is
 * {@link shareLink}, and that one keeps nothing.
 */
export function roomUrl(code: string, search = ''): string {
  const parameters = new URLSearchParams(search)
  parameters.set(ROOM_PARAM, code)
  return `?${parameters.toString()}`
}

/**
 * A code as it goes on screen: `H7K-2Q9` in threes.
 *
 * Grouping is not decoration — six unbroken characters of base32 is exactly the
 * string a person loses their place in halfway through reading it aloud. The
 * hyphen is safe because the host drops hyphens when it folds a code, so what a
 * player reads back is a code the host accepts verbatim.
 */
export function formatRoomCode(code: string): string {
  const half = Math.ceil(code.length / 2)
  return `${code.slice(0, half)}-${code.slice(half)}`
}

/**
 * What a player has typed into the join box, and whether it is enough yet.
 *
 * Returned rather than enforced with an input mask: a mask that eats characters
 * as they are typed is how a pasted code silently loses its last two, and a
 * player who pasted something reasonable and got nothing back has no way to
 * tell what happened.
 */
export type TypedCode = {
  /** The canonical code, or `null` if this is not one yet. */
  readonly code: string | null
  /** What to say under the box. Empty while there is nothing to say. */
  readonly hint: string
}

export function readTypedCode(typed: string): TypedCode {
  const trimmed = typed.trim()
  if (trimmed === '') return { code: null, hint: '' }

  const code = normalizeRoomCode(trimmed)
  if (code !== null) return { code, hint: '' }

  // Count only the characters a code is made of, so "H7K-2Q" is four short of
  // nothing and "H7K2Q" is one short of a code.
  const symbols = [...trimmed].filter((character) => !' \t-'.includes(character)).length
  if (symbols < 6) return { code: null, hint: `${6 - symbols} more character${symbols === 5 ? '' : 's'}` }
  if (symbols > 6) return { code: null, hint: 'a room code is six characters' }
  return { code: null, hint: 'that is not a room code — check for a typo' }
}
