/**
 * A `Transport` decorator that makes the network bad on purpose.
 *
 * Zero RTT hides everything. A loopback host answers before the caller's stack
 * has unwound, so prediction is never wrong, reconciliation never runs, an
 * input buffer never underflows and a snapshot never arrives out of order. A
 * single-player build on a naked loopback therefore proves that the code runs,
 * and proves nothing whatsoever about the code that exists to cope with a
 * network — which is most of it.
 *
 * So the harness puts the network back. This wraps either end of a pair and
 * applies latency, jitter, loss, reordering and duplication to both directions,
 * all drawn from a seeded PRNG, so a failure is a *seed* rather than an
 * anecdote: paste the seed into the test and the same frames go missing in the
 * same order on every machine, forever.
 *
 * ## It is pumped, not timed
 *
 * There is no `setTimeout` in here. Held frames carry a due time and are
 * released by `pump(nowMs)`, which means a latency matrix — five profiles over
 * a minute of simulated play — costs CI no wall-clock at all, and means the
 * release order is a function of the schedule rather than of how loaded the
 * machine was. A harness that waited for real milliseconds would be both slower
 * and flakier.
 *
 * ## It does not ship
 *
 * This belongs to tests and to a developer's own console, never to a build a
 * player runs. Single-player ships at ~0 ms, because the selling point of the
 * mode is feel and self-inflicted lag is the one thing guaranteed to ruin it.
 *
 * ## Loss is a stall, unless you ask for a gap
 *
 * The transport is a WebSocket, which is TCP, and TCP does not lose data — it
 * *retransmits* it. A lost segment therefore costs about a round trip and holds
 * every byte behind it while it is refetched, and the receiver sees a stall
 * followed by a burst rather than a hole. Modelling it as a hole is the
 * UDP-flavoured mistake that makes an interpolation buffer look like it covers
 * loss, when what it covers is jitter and reordering.
 *
 * So {@link LagProfile.retransmitMs} is how long a lost frame is held before it
 * arrives anyway, and — the load-bearing half — the frames behind it are held
 * with it, because a stalled stream stalls. Setting it to zero gives the old
 * behaviour: the frame is gone for good, which is a *datagram* and a deliberate
 * violation of the `Transport` contract, kept for the same reason
 * `reorderChance` is (`sim/src/transport.ts` lists what would break).
 *
 * The decision reuses the loss draw rather than adding a fifth: the question
 * "was this segment lost" is the same question either way, and the profile only
 * changes what happens next. That keeps the four-draws-per-frame discipline
 * below exactly as it was, so a profile that turns retransmission on makes the
 * *same* frames go missing as the one that does not.
 *
 * ## Jitter does not reorder; `reorderChance` does
 *
 * A `Transport` is specified to deliver every message exactly once and in
 * order, and a WebSocket over TCP really does — a delayed segment holds the
 * ones behind it rather than letting them past. So a frame's arrival is never
 * scheduled before the arrival of the frame in front of it: jitter bunches
 * arrivals up and spreads them out, and the order that comes out is the order
 * that went in.
 *
 * Reordering is therefore its own knob, and turning it on is a deliberate
 * *violation* of the transport contract rather than a bigger dose of jitter.
 * That distinction is the whole reason the knob exists: unreliable datagrams
 * are the obvious future optimisation, `sim/src/transport.ts` lists exactly
 * which parts of the protocol would break under one, and this is how that list
 * gets tested before anybody bets on it.
 *
 * ## The PRNG discipline
 *
 * Four draws per frame, always in the same order — loss, jitter, reorder,
 * duplicate — whether or not the profile has any of those turned on. Same
 * reason the kernel advances its stream every sub-step whether or not anything
 * rolled a die (`sim/src/kernel.ts`): the stream position is then a function of
 * how many frames have gone past and nothing else, so two runs that differ only
 * in a profile's *magnitudes* still make the same decisions.
 */
import {
  TransportState,
  rngChance,
  rngFloat,
  seedRng,
  type RngHolder,
  type Transport,
  type TransportHandlers,
  type TransportMessage,
} from '@gladiator/sim'

export type LagProfile = {
  /** The floor, in milliseconds. Half of a round trip. */
  readonly latencyMs: number
  /** Added to `latencyMs`, uniform in `[0, jitterMs)`. */
  readonly jitterMs: number
  /**
   * Chance in `[0, 1]` that a frame is lost in transit.
   *
   * What "lost" costs is {@link LagProfile.retransmitMs}: on a TCP link the
   * frame arrives late and holds the stream up behind it, and on an unreliable
   * one it never arrives at all.
   */
  readonly lossChance: number
  /**
   * How long a lost frame is held before its retransmission lands, in
   * milliseconds — and how long everything queued behind it is held too.
   *
   * About one round trip is the honest number for TCP. **Zero means the frame
   * is dropped**, which is a datagram and a deliberate violation of the
   * `Transport` contract. See the header.
   */
  readonly retransmitMs: number
  /** Chance a frame arrives twice. */
  readonly duplicateChance: number
  /** Chance a frame is held back far enough that later ones overtake it. */
  readonly reorderChance: number
  /** How far back a reordered frame is held, in milliseconds. */
  readonly reorderMs: number
  /** The seed. A failure is reproduced by pasting this number back in. */
  readonly seed: number
}

/** A perfect link: the decorator still buffers and still needs pumping. */
export const NO_LAG: LagProfile = {
  latencyMs: 0,
  jitterMs: 0,
  lossChance: 0,
  retransmitMs: 0,
  duplicateChance: 0,
  reorderChance: 0,
  reorderMs: 0,
  seed: 1,
}

/**
 * A profile in the neighbourhood of a real duel across a country: ~40 ms each
 * way with a few milliseconds of jitter and the occasional lost frame.
 */
export const TYPICAL_LAG: LagProfile = {
  ...NO_LAG,
  latencyMs: 40,
  jitterMs: 8,
  lossChance: 0.01,
  // One round trip's worth of refetch, which is what a real TCP link charges.
  retransmitMs: 80,
  reorderMs: 30,
  seed: 0x9e3779b9,
}

export type LagStats = {
  /** Frames handed to `send`. */
  readonly sent: number
  /** Frames the inner transport delivered to us. */
  readonly received: number
  /** Frames released by `pump`, in either direction. Duplicates count twice. */
  readonly delivered: number
  /** Frames the loss draw picked and `retransmitMs` did not rescue. */
  readonly dropped: number
  /** Frames retransmitted: late, and holding up everything behind them. */
  readonly stalled: number
  readonly duplicated: number
  readonly reordered: number
}

export type LaggedTransport = Transport & {
  /**
   * Release everything whose due time has arrived, oldest first.
   *
   * Frames scheduled *during* a pump are not released by it, so a conversation
   * cannot run away inside one call.
   */
  pump(nowMs: number): void
  /** Release everything still held, regardless of when it was due. */
  flush(): void
  readonly stats: LagStats
  /** Frames held and not yet released. */
  readonly inFlight: number
  readonly profile: LagProfile
}

/** Which way a held frame is going. */
type Direction = 'out' | 'in'

type Held = {
  readonly dueMs: number
  /** Tie-break, so a stable order does not depend on the sort implementation. */
  readonly seq: number
  readonly direction: Direction
  readonly message: TransportMessage
}

/** Bytes are copied on the way into the queue, for the same reason the loopback copies. */
function hold(message: TransportMessage): TransportMessage {
  return typeof message === 'string' ? message : message.slice()
}

export function laggedTransport(
  inner: Transport,
  profile: Partial<LagProfile> & { readonly seed: number },
): LaggedTransport {
  const settings: LagProfile = { ...NO_LAG, ...profile }
  const rng: RngHolder = { rng: seedRng(settings.seed) }

  const queue: Held[] = []
  let seq = 0
  let handlers: TransportHandlers | null = null
  let nowMs = 0
  /**
   * When the last in-order frame is due, per direction.
   *
   * This is what keeps jitter from silently reordering: a frame is never due
   * before the one in front of it. A frame the reorder knob picked deliberately
   * does not update it, which is how the ones behind get past.
   */
  const lastDueMs: Record<Direction, number> = { out: 0, in: 0 }

  const stats = {
    sent: 0,
    received: 0,
    delivered: 0,
    dropped: 0,
    stalled: 0,
    duplicated: 0,
    reordered: 0,
  }

  /**
   * Decide what the network does to one frame, and queue whatever survives.
   *
   * The four draws happen unconditionally and in a fixed order — see the header.
   */
  const impair = (message: TransportMessage, direction: Direction): void => {
    const lost = rngChance(rng, settings.lossChance)
    const jitter = rngFloat(rng) * settings.jitterMs
    const reordered = rngChance(rng, settings.reorderChance)
    const duplicated = rngChance(rng, settings.duplicateChance)

    if (lost && settings.retransmitMs <= 0) {
      stats.dropped += 1
      return
    }

    // A retransmission is late *and* blocking: the frame itself is held for the
    // refetch, and because `lastDueMs` moves with it, everything queued behind
    // it is held too. That head-of-line block is the whole difference between a
    // TCP stall and a UDP gap, and it is what an interpolation buffer sized for
    // jitter does not cover.
    const arrival = nowMs + settings.latencyMs + jitter + (lost ? settings.retransmitMs : 0)
    if (lost) stats.stalled += 1

    let dueMs: number
    if (reordered) {
      // Deliberately out of line, and deliberately not moving the line: the
      // frames behind this one keep their earlier times and overtake it.
      dueMs = arrival + settings.reorderMs
      stats.reordered += 1
    } else {
      dueMs = Math.max(arrival, lastDueMs[direction])
      lastDueMs[direction] = dueMs
    }

    const payload = hold(message)
    queue.push({ dueMs, seq: (seq += 1), direction, message: payload })

    if (duplicated) {
      // A millisecond behind the original, so the pair is genuinely two
      // arrivals rather than one that the receiver might coalesce.
      stats.duplicated += 1
      queue.push({ dueMs: dueMs + 1, seq: (seq += 1), direction, message: hold(payload) })
    }
  }

  const release = (held: Held): void => {
    stats.delivered += 1
    if (held.direction === 'out') inner.send(held.message)
    else handlers?.onMessage?.(held.message)
  }

  const drain = (deadlineMs: number): void => {
    // The ready set is taken first: a frame queued by a handler during this
    // pump belongs to the next one, however early it claims to be due.
    const ready: Held[] = []
    for (let i = queue.length - 1; i >= 0; i -= 1) {
      const held = queue[i]
      if (held === undefined || held.dueMs > deadlineMs) continue
      ready.push(held)
      queue.splice(i, 1)
    }
    ready.sort((a, b) => a.dueMs - b.dueMs || a.seq - b.seq)
    for (const held of ready) release(held)
  }

  return {
    get readyState() {
      return inner.readyState
    },

    get profile() {
      return settings
    },

    get stats(): LagStats {
      return { ...stats }
    },

    get inFlight() {
      return queue.length
    },

    send(message: TransportMessage) {
      if (inner.readyState !== TransportState.Open) return
      stats.sent += 1
      impair(message, 'out')
    },

    close(code?: number, reason?: string) {
      // A close is control, not data: it goes through immediately, and whatever
      // was still in the air is lost — which is what a socket does too.
      queue.length = 0
      inner.close(code, reason)
    },

    setHandlers(next: TransportHandlers) {
      handlers = next
      inner.setHandlers({
        // Open, close and error are control and arrive undelayed. Only messages
        // are held, because only messages are what the game reasons about.
        onOpen: () => next.onOpen?.(),
        onClose: (code, reason) => next.onClose?.(code, reason),
        onError: (error) => next.onError?.(error),
        onMessage: (message) => {
          stats.received += 1
          impair(message, 'in')
        },
      })
    },

    pump(at: number) {
      nowMs = at
      drain(at)
    },

    flush() {
      drain(Number.POSITIVE_INFINITY)
    },
  }
}
