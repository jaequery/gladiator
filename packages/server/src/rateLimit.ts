/**
 * One token bucket, and the per-key limiter built out of it.
 *
 * There are four rate limits on the authoritative side and they are all the
 * same shape — a budget per wall-clock second with an allowance for a clump
 * that arrived together — so there is one implementation of the arithmetic and
 * four sets of numbers. The alternative is four hand-rolled buckets that drift
 * apart in exactly the edge cases nobody tests: a clock that went backwards, a
 * bucket that has been notionally refilling since the process booted, a budget
 * of zero meaning "off" in one file and "refuse everything" in another.
 *
 * | Limit | Where | Unit |
 * | ----- | ----- | ---- |
 * | commands executed | `inputQueue.ts`, per peer | commands/s |
 * | frames read | `validate.ts`, per connection | frames/s |
 * | bytes read | `validate.ts`, per connection | bytes/s |
 * | connections opened | `server.ts`, per client address | upgrades/s |
 *
 * ## No clock in here
 *
 * `nowMs` is an argument, as it is everywhere on the authoritative side: the
 * first three of those live under `room.ts`, which runs inside a browser tab as
 * part of the listen server, and `room.isomorphic.test.ts` fails the build on a
 * `Date.now()` reachable from it.
 *
 * ## The bucket starts full, and its clock starts at the first spend
 *
 * A room may sit empty for a minute before anybody joins, and a machine may sit
 * idle for an hour. Neither a peer nor an address should arrive to a bucket that
 * has been refilling since the process booted — which for a large enough gap is
 * indistinguishable from no limit at all on the first burst. So the refill clock
 * is stamped by the first spend rather than by construction, and the bucket
 * begins at exactly `burst`.
 */

export type TokenBucket = {
  /**
   * Take `cost` tokens if they are there. Returns whether they were.
   *
   * A refused spend takes **nothing**: a caller that is over budget should not
   * also be draining the allowance it is waiting for, or a client hammering the
   * door would hold itself out forever rather than for the second it overspent.
   */
  spend(cost: number, nowMs: number): boolean
  /** Tokens available as of the last spend. Diagnostics and tests. */
  readonly tokens: number
}

export type TokenBucketOptions = {
  /** Tokens added per wall-clock second. Zero or less turns the limit off. */
  readonly ratePerSecond: number
  /** The most tokens the bucket ever holds, and what it starts with. */
  readonly burst: number
}

export function createTokenBucket(options: TokenBucketOptions): TokenBucket {
  const ratePerSecond = options.ratePerSecond
  const burst = options.burst
  let tokens = burst
  let refilledMs: number | null = null

  return {
    spend(cost: number, nowMs: number): boolean {
      if (ratePerSecond <= 0) return true
      if (refilledMs === null) refilledMs = nowMs
      // A clock that went backwards adds nothing rather than draining the
      // bucket. `systemClock` is monotonic, but a manual clock in a test and a
      // browser tab restoring from bfcache are both allowed to surprise us.
      const elapsedMs = nowMs > refilledMs ? nowMs - refilledMs : 0
      refilledMs = nowMs
      tokens = Math.min(burst, tokens + (elapsedMs * ratePerSecond) / 1000)
      if (tokens < cost) return false
      tokens -= cost
      return true
    },

    get tokens() {
      return tokens
    },
  }
}

/**
 * Buckets by key, with the idle ones swept.
 *
 * The key is a client address (see {@link clientKey}), so the map is unbounded
 * in exactly the direction an attacker controls: one entry per address that has
 * ever connected. {@link KeyedLimiter.sweep} drops every bucket that has been
 * full for {@link IDLE_BUCKET_MS} — full meaning "has spent nothing recently",
 * which for a token bucket is the same statement as "forgetting this costs the
 * limiter nothing".
 */
export type KeyedLimiter = {
  /** Charge `key` one unit. Returns whether it was under budget. */
  spend(key: string, nowMs: number): boolean
  /** Drop buckets that have refilled and would admit the next request anyway. */
  sweep(nowMs: number): void
  /** Live buckets. Diagnostics, and the assertion that the sweep works. */
  readonly size: number
}

export type KeyedLimiterOptions = {
  readonly ratePerSecond: number
  readonly burst: number
  /** How long a full bucket is kept before it is forgotten. */
  readonly idleMs?: number
  /** A backstop on the map's size. Past it, the sweep is forced. */
  readonly maxKeys?: number
}

/**
 * How long a full bucket is kept around.
 *
 * A bucket that is full admits the next request whatever we do, so keeping one
 * is pure memory. Two minutes rather than "the moment it fills", because a
 * player reloading a page is a burst separated by a few seconds and dropping
 * their bucket between the two would hand them the full allowance twice.
 */
export const IDLE_BUCKET_MS = 120_000

/**
 * The most addresses tracked at once.
 *
 * The sweep runs on the housekeeping beat, so between beats an attacker forging
 * one address per connection could add entries faster than they are dropped.
 * Past this, the oldest are evicted regardless of age — which is the correct
 * failure direction: the limiter forgets, and the worst outcome of forgetting is
 * that the attacker gets the allowance they would have got from a fresh address
 * anyway.
 */
export const MAX_TRACKED_KEYS = 10_000

export function createKeyedLimiter(options: KeyedLimiterOptions): KeyedLimiter {
  const idleMs = options.idleMs ?? IDLE_BUCKET_MS
  const maxKeys = options.maxKeys ?? MAX_TRACKED_KEYS

  type Entry = { readonly bucket: TokenBucket; lastMs: number }
  const entries = new Map<string, Entry>()

  const evictOldest = (): void => {
    // `Map` iterates in insertion order and a re-inserted key moves to the back,
    // so the first entry is the least recently *seen* — which is the one whose
    // bucket is nearest full and therefore cheapest to forget.
    const oldest = entries.keys().next()
    if (!oldest.done) entries.delete(oldest.value)
  }

  return {
    spend(key: string, nowMs: number): boolean {
      let entry = entries.get(key)
      if (entry === undefined) {
        if (entries.size >= maxKeys) evictOldest()
        entry = { bucket: createTokenBucket(options), lastMs: nowMs }
      } else {
        entries.delete(key)
      }
      entry.lastMs = nowMs
      entries.set(key, entry)
      return entry.bucket.spend(1, nowMs)
    },

    sweep(nowMs: number) {
      for (const [key, entry] of [...entries]) {
        if (nowMs - entry.lastMs >= idleMs) entries.delete(key)
      }
    },

    get size() {
      return entries.size
    },
  }
}

/**
 * The key a client address is limited under.
 *
 * Two folds, and both of them are the difference between a limit and a
 * formality:
 *
 * - **An IPv4-mapped address is its IPv4 address.** Node hands back
 *   `::ffff:203.0.113.4` on a dual-stack listener and `203.0.113.4` on an IPv4
 *   one, and two spellings of one address are two buckets.
 * - **An IPv6 address is bucketed by its /64.** A residential IPv6 customer is
 *   routinely handed a /64 or a /56, so limiting per *address* limits nothing —
 *   an attacker walks 18 quintillion addresses inside their own subnet and every
 *   one of them arrives with a full bucket. The /64 is the smallest block an
 *   allocation is ever smaller than, so it is the honest unit.
 *
 * The cost is that everybody behind one NAT or one /64 shares a budget, which is
 * why the budgets in `server.ts` are sized for a household rather than for one
 * player.
 */
export function clientKey(address: string | undefined): string {
  if (address === undefined || address === '') return 'unknown'

  // `::ffff:1.2.3.4` — an IPv4 address wearing an IPv6 hat.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)
  if (mapped !== null) return mapped[1] ?? address

  // No colon means IPv4 (or something that is not an address at all, which is
  // still a perfectly good bucket key — it just is not one we can widen).
  if (!address.includes(':')) return address

  // A scope id (`fe80::1%eth0`) is about this host's interfaces, not about the
  // peer, and keeping it would make one address two buckets.
  const bare = address.split('%')[0] ?? address
  return ipv6Prefix(bare)
}

/** The first four hextets of an IPv6 address — its /64 — in a canonical form. */
function ipv6Prefix(address: string): string {
  const halves = address.split('::')
  const head = (halves[0] ?? '').split(':').filter((part) => part !== '')
  const tail = halves.length > 1 ? (halves[1] ?? '').split(':').filter((part) => part !== '') : []

  // Expand `::` to however many zero groups it stands for. An address with more
  // than eight groups is malformed; it is still hashed to *something* stable
  // rather than rejected, because the caller's alternative is no bucket at all.
  const missing = Math.max(0, 8 - head.length - tail.length)
  const zeros = new Array<string>(missing).fill('0')
  const groups = halves.length > 1 ? [...head, ...zeros, ...tail] : head

  const prefix = groups.slice(0, 4).map((group) => Number.parseInt(group, 16) || 0)
  while (prefix.length < 4) prefix.push(0)
  return `${prefix.map((part) => part.toString(16)).join(':')}::/64`
}
