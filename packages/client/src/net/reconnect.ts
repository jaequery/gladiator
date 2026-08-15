/**
 * The client half of the connection lifecycle: when to come back, and when not
 * to bother.
 *
 * A duel is a socket that has to survive a wifi handover, a tunnel changing, a
 * laptop lid and a rolling deploy — none of which are the player's fault and all
 * of which look identical from up here. The host holds the seat for thirty
 * seconds (`@gladiator/server/lifecycle.ts`); this decides whether to go back for
 * it, and how fast.
 *
 * ## Two decisions, and the first one is the important one
 *
 * **Not every close is worth retrying.** A version mismatch, a map mismatch, a
 * room that does not exist, a match that has ended and a seat somebody else took
 * are all *answers*. Retrying an answer means a client that hammers a host which
 * has already told it the truth, and a player watching a spinner instead of
 * reading a sentence. So the close code is the gate, and the default for a code
 * this build has never heard of is to stop rather than to loop.
 *
 * The code is used rather than the fault frame beside it because a close code
 * always arrives and a frame sometimes does not — a socket that dies mid-write
 * delivers 1006 and nothing else.
 *
 * ## The backoff, and why it has a floor as well as a ceiling
 *
 * `BASE + random() * (window - BASE)`, where the window doubles with each
 * failure up to {@link RECONNECT_CEILING_MS}. Every delay therefore lands inside
 * [{@link RECONNECT_BASE_MS}, {@link RECONNECT_CEILING_MS}] by construction, the
 * expected wait grows while the host stays down, and the spread is the whole
 * window rather than a few percent around it.
 *
 * The floor is for the player: the overwhelmingly common disconnect is a blip,
 * and 250 ms is fast enough that they may not notice it happened. The ceiling is
 * for the host: past four seconds nobody is waiting any more, and a client that
 * had backed off to a minute would miss the end of its own grace window. The
 * *jitter* is for the host too, and it is the reason this is not a plain
 * doubling — a machine that restarts drops every socket it holds in the same
 * millisecond, and clients that all wait exactly 250 ms then 500 ms then 1000 ms
 * would arrive back in exactly the same lockstep. Full jitter over the window is
 * the cheapest way to turn one spike into a smear.
 *
 * ## No timer in here
 *
 * A delay is a *deadline*, and the frame loop asks whether it has passed
 * (`NetClient.poll`). The same reasoning as everywhere else in this repo: a
 * module that reached for `setTimeout` could not be driven by a test in
 * microseconds, and the browser already has a beat running sixty times a second.
 */

/** The shortest a client will ever wait before trying again. */
export const RECONNECT_BASE_MS = 250

/** The longest. Past this nobody is still watching, and the seat is gone. */
export const RECONNECT_CEILING_MS = 4_000

/**
 * How long to keep trying before giving up, in milliseconds.
 *
 * Forty-five seconds, and it is a *deadline* rather than a number of attempts on
 * purpose. What decides whether coming back is still worth anything is the
 * host's grace window — thirty seconds, `@gladiator/server/lifecycle.ts` — and a
 * count is a bad proxy for it: with the jitter above, twelve attempts is
 * anywhere between three seconds and half a minute depending on the draws, so a
 * client could give up while its seat was still being held, or keep dialling
 * long after the match had been awarded to somebody else.
 *
 * Fifteen seconds past the window rather than exactly on it, because the two
 * clocks are not the same clock and the window starts when the *host* noticed —
 * up to a round trip after this side did, and up to the idle timeout later if
 * the socket died without a close.
 */
export const RECONNECT_WINDOW_MS = 45_000

/** What to do about a socket that closed. */
export const Retry = {
  /** Wait out a backoff and dial again. */
  Backoff: 'backoff',
  /** Do not come back. The host has already said something true. */
  Stop: 'stop',
} as const

export type Retry = (typeof Retry)[keyof typeof Retry]

/**
 * Whether a close code is worth coming back from.
 *
 * The two rules, in order:
 *
 * - **Anything in the application range (4000–4999) stops.** Every one of them
 *   is a refusal this server wrote on purpose — wrong protocol, wrong map, room
 *   full, no such room, match ended, seat taken by another tab — and all of them
 *   would still be true a second later. A client that retried 4004 would spend a
 *   minute failing to load a map it does not have.
 * - **A clean 1000 stops; the rest of the protocol range backs off.** 1000 is
 *   somebody hanging up on purpose, at either end. 1001 is a deploy, 1006 is the
 *   wire breaking, 1011 and 1012 are a host having a bad time — all of them are
 *   moments rather than verdicts.
 */
export function retryVerdict(code: number): Retry {
  if (code >= 4000) return Retry.Stop
  if (code === 1000) return Retry.Stop
  // 1008 is a policy violation: this client did something the host refuses, and
  // it will do it again on the next socket.
  if (code === 1008) return Retry.Stop
  return Retry.Backoff
}

export type BackoffOptions = {
  readonly baseMs?: number
  readonly ceilingMs?: number
  /** Injected so a test can pin the draw. `Math.random` in a browser. */
  readonly random?: () => number
}

/**
 * How long to wait before attempt number `attempt` (zero-based).
 *
 * The first retry is exactly {@link RECONNECT_BASE_MS} — there is no window to
 * spread it over yet, and the first one is the one worth being quick about.
 * Every later one is drawn uniformly from the whole window.
 */
export function backoffMs(attempt: number, options: BackoffOptions = {}): number {
  const base = options.baseMs ?? RECONNECT_BASE_MS
  const ceiling = options.ceilingMs ?? RECONNECT_CEILING_MS
  const random = options.random ?? Math.random
  const steps = attempt < 0 ? 0 : attempt
  // Doubling, in a loop rather than with `**`, which is banned in `packages/sim`
  // for being implementation-approximated and is not worth spelling two ways.
  let window = base
  for (let i = 0; i < steps && window < ceiling; i += 1) window *= 2
  if (window > ceiling) window = ceiling
  return Math.round(base + random() * (window - base))
}

export type ReconnectPolicy = {
  /** Attempts made since the last successful connection. */
  readonly attempts: number
  /** Whether the window has closed. */
  readonly exhausted: boolean
  /**
   * Note a close at `nowMs` and say how long to wait, or `null` for "do not
   * come back".
   *
   * `null` covers both reasons at once, which is deliberate: the caller's
   * question is "am I dialling again", and it has one answer whether the host
   * refused us or the seat we were coming back to has certainly expired.
   */
  next(code: number, nowMs: number): number | null
  /** A connection succeeded. The next failure starts the window again. */
  succeed(): void
}

export type ReconnectOptions = BackoffOptions & {
  readonly windowMs?: number
}

export function createReconnectPolicy(options: ReconnectOptions = {}): ReconnectPolicy {
  const windowMs = options.windowMs ?? RECONNECT_WINDOW_MS
  let attempts = 0
  /** When the *first* failure of this run happened. `null` while connected. */
  let startedMs: number | null = null
  let exhausted = false

  return {
    get attempts() {
      return attempts
    },

    get exhausted() {
      return exhausted
    },

    next(code: number, nowMs: number): number | null {
      if (retryVerdict(code) === Retry.Stop) return null
      if (startedMs === null) startedMs = nowMs
      if (nowMs - startedMs >= windowMs) {
        exhausted = true
        return null
      }
      const delay = backoffMs(attempts, options)
      attempts += 1
      return delay
    },

    succeed() {
      attempts = 0
      startedMs = null
      exhausted = false
    },
  }
}
