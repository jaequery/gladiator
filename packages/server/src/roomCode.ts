/**
 * The six characters a player types into a friend's chat window.
 *
 * A room code is the entire lobby. There is no matchmaking, no account and no
 * friends list: one player creates a match, gets a code, and sends it to
 * somebody. So the code has to survive being read aloud, retyped from a
 * photograph of a screen, and pasted with a stray hyphen in it — which is
 * exactly the problem Douglas Crockford's base32 alphabet was designed for.
 *
 * ## The alphabet
 *
 * `0123456789ABCDEFGHJKMNPQRSTVWXYZ` — the digits and the letters, minus
 * **I**, **L**, **O** and **U**. The first three go because they are the pairs
 * a human confuses: `I`/`1`, `L`/`1`, `O`/`0`. `U` goes for a different reason
 * and it is worth stating plainly, because it is the one somebody always tries
 * to add back: without a `U`, no six-character draw can spell an obscenity, and
 * a game that hands strangers a random string to send each other should not
 * occasionally hand them that.
 *
 * ## Reading is lenient, writing is not
 *
 * {@link mintRoomCode} only ever emits the 32 canonical symbols in upper case.
 * {@link normalizeRoomCode} accepts rather more, because the alternative is a
 * player who typed a perfectly good code being told it does not exist:
 *
 * - lower case folds up;
 * - `O` and `o` fold to `0`, `I`, `i`, `L` and `l` fold to `1` — Crockford's own
 *   decoding rules, and the reason those letters were removed in the first
 *   place;
 * - hyphens and spaces are dropped, so a code pasted out of a URL that somebody
 *   has hand-wrapped still resolves;
 * - `U` is **refused**, not folded. It is not ambiguous with anything, so a `U`
 *   in a code is a typo or a guess rather than a misread, and quietly mapping it
 *   to something would turn a wrong code into a different room.
 *
 * ## How guessable it is
 *
 * Six symbols from a 32-symbol alphabet is 32⁶ = 1,073,741,824 codes, which is
 * exactly 30 bits — see {@link ROOM_CODE_BITS}. The number that matters is not
 * the size of the space but the chance a guess lands in the *occupied* part of
 * it: {@link guessProbability} and {@link expectedGuessSeconds} compute it, and
 * `docs/deploy.md` records what those come out as at the concurrency this
 * deploy actually admits.
 *
 * A code is not a credential and this is not a security boundary — it is the
 * observation that at this deploy's size, an attacker spending a WebSocket
 * upgrade per guess needs weeks to walk into one stranger's duel. The rate
 * limiting that would make that worse for them is GLAD-V7M6PQ.
 */

/**
 * Crockford's base32, in canonical order: value `i` is `ROOM_CODE_ALPHABET[i]`.
 *
 * Thirty-two symbols exactly. `roomCode.test.ts` asserts the length, the
 * ordering and the absence of the four excluded letters, because a typo in here
 * would produce codes that mint fine and cannot be typed back in.
 */
export const ROOM_CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * How many symbols a code has.
 *
 * Six. Five would be 25 bits and about a thousand-to-one worse to guess; seven
 * is another character to read out over a voice call for entropy nobody at this
 * scale needs. Six is also the length that fits comfortably in a URL, a chat
 * message and a screenshot.
 */
export const ROOM_CODE_LENGTH = 6

/** Symbols in the alphabet. Derived, so the two cannot drift apart. */
export const ROOM_CODE_RADIX = ROOM_CODE_ALPHABET.length

/**
 * How many distinct codes exist: 32⁶ = 1,073,741,824.
 *
 * Computed rather than written out, so that changing {@link ROOM_CODE_LENGTH}
 * changes every number derived from it instead of leaving a stale literal
 * behind.
 */
export const ROOM_CODE_SPACE = codeSpace(ROOM_CODE_LENGTH)

/**
 * The entropy of one minted code, in bits. Exactly 30.
 *
 * Exact because the radix is a power of two and the draw below is uniform — a
 * modulo of a uniform uint32 by 32 is unbiased, which is the reason the draw is
 * spelt that way rather than with a float.
 */
export const ROOM_CODE_BITS = Math.log2(ROOM_CODE_SPACE)

function codeSpace(length: number): number {
  let total = 1
  for (let i = 0; i < length; i += 1) total *= ROOM_CODE_RADIX
  return total
}

/** A uniform 32-bit unsigned integer. See {@link mintRoomCode}. */
export type Uint32Source = () => number

/**
 * Mint a code from `random`.
 *
 * `random` returns a uniform uint32; the default draws from Web Crypto, which
 * both Node 22 and every browser this game supports have as a global. It is
 * injected because a test that cannot fix the draw cannot assert what came out,
 * and because a registry wanting a deterministic sequence should not have to
 * monkey-patch a global to get one.
 *
 * The modulo is unbiased: 32 divides 2³², so every symbol is hit by exactly
 * 2²⁷ of the 2³² inputs. That is the whole reason the alphabet's size is a
 * power of two and not, say, 34.
 */
export function mintRoomCode(random: Uint32Source = cryptoUint32): string {
  let code = ''
  for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
    const draw = random() >>> 0
    code += ROOM_CODE_ALPHABET[draw % ROOM_CODE_RADIX]
  }
  return code
}

/** One uniform uint32 out of the platform's CSPRNG. */
function cryptoUint32(): number {
  const buffer = new Uint32Array(1)
  crypto.getRandomValues(buffer)
  return buffer[0] ?? 0
}

/**
 * Fold whatever a human typed into a canonical code, or `null`.
 *
 * `null` means "this is not a code", and the caller's job is then to say so
 * rather than to guess — an unknown room has to be a legible error and never a
 * hang, which is the whole of `server.ts`'s handling of it.
 */
export function normalizeRoomCode(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null

  let code = ''
  for (const character of raw) {
    // Separators a human or a URL might have introduced. Dropped rather than
    // rejected: "ABC-123" and "ABC 123" are the same code written two ways.
    if (character === '-' || character === ' ' || character === '\t') continue

    const folded = foldSymbol(character)
    if (folded === null) return null
    code += folded
    // Checked inside the loop as well as after it, so a pasted paragraph is
    // refused after seven characters rather than after a megabyte.
    if (code.length > ROOM_CODE_LENGTH) return null
  }

  return code.length === ROOM_CODE_LENGTH ? code : null
}

/**
 * One character, as Crockford decodes it — or `null` if it decodes to nothing.
 *
 * The three folds are the alphabet's reason for existing. `U` is deliberately
 * not one of them; see the header.
 */
function foldSymbol(character: string): string | null {
  const upper = character.toUpperCase()
  if (upper === 'O') return '0'
  if (upper === 'I' || upper === 'L') return '1'
  return ROOM_CODE_ALPHABET.includes(upper) ? upper : null
}

/**
 * The chance one blind guess names a room that exists, with `liveRooms` of them
 * open.
 *
 * The occupancy of the space, not its size — a billion codes with two rooms in
 * them is a very different target from a billion codes with a million.
 */
export function guessProbability(liveRooms: number): number {
  if (liveRooms <= 0) return 0
  const occupied = liveRooms > ROOM_CODE_SPACE ? ROOM_CODE_SPACE : liveRooms
  return occupied / ROOM_CODE_SPACE
}

/**
 * How long an attacker guessing at `guessesPerSecond` expects to wait before
 * one guess lands in an occupied room, in seconds.
 *
 * The mean of a geometric distribution, which is the honest summary: it is an
 * expectation and not a guarantee, and the attacker who gets lucky on the first
 * try was always possible. `Infinity` when nothing can ever be hit.
 *
 * A guess costs a WebSocket upgrade, so `guessesPerSecond` is bounded by what
 * the deploy will accept rather than by the attacker's imagination.
 * `docs/deploy.md` puts the numbers this produces next to the concurrency limit
 * in `fly.toml` that justifies them.
 */
export function expectedGuessSeconds(liveRooms: number, guessesPerSecond: number): number {
  const probability = guessProbability(liveRooms)
  if (probability <= 0 || guessesPerSecond <= 0) return Number.POSITIVE_INFINITY
  return 1 / (probability * guessesPerSecond)
}
