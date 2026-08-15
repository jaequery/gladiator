/**
 * The connection lifecycle: who holds a seat, who may take it, and what happens
 * to a match when somebody's connection dies.
 *
 * A room seats two peers, and *which* two is the question every two-player room
 * server gets wrong. Not because the answers are hard, but because they are
 * usually not answered at all: a socket closes, a peer is spliced out of an
 * array, and what that means for the match is whatever the rest of the code
 * happens to do next. So every transition is a named verdict here, with the
 * reasoning next to it, and `lifecycle.test.ts` has one test per transition.
 *
 * ## A seat is not a connection
 *
 * That is the whole idea. A **seat** is a side of the duel: a slot in the world,
 * a score, a body standing in the arena. A **connection** is a socket, and a
 * socket dies for reasons that have nothing to do with the match — a tunnel
 * changing, a laptop lid, a phone moving between cells. Treating the two as one
 * thing is what makes a dropped packet end a duel.
 *
 * So a seat outlives its connection by {@link RECONNECT_GRACE_MS}, and the only
 * thing that proves ownership of one is the token the host minted when it was
 * first taken. A room code says *which match*; a token says *which side of it*.
 *
 * ## The disconnect default, and why the body stays
 *
 * A vacated seat keeps its body in the world. The room stops feeding it
 * commands, so `inputQueue.ts`'s missing-command fallback repeats the last one
 * for half a second and then hands it an idle command forever: the player comes
 * to rest and stands there, **killable**. That is deliberate. The alternative —
 * removing the body — makes pulling your network cable the cheapest way to deny
 * an opponent a frag they had already earned, and it makes a rocket in flight
 * detonate against nothing.
 *
 * The two halves of that policy live in two files and are deliberately sized so
 * they cannot argue: the repeat is bounded at ~500 ms (`inputQueue.ts`) and the
 * grace window is 30 seconds, so a disconnected player has been standing still
 * for 29.5 of the 30 seconds their seat is held. A "repeat last command" policy
 * with no bound would have them strafe-jumping off a ledge for the whole window.
 *
 * ## Why the timeout ends the match rather than the round
 *
 * Awarding only the round would start the next one against an empty seat and
 * award that one too, three seconds later, until the score ran out. Same result,
 * arrived at over half a minute of watching nothing happen. `forfeitMatch` in
 * the simulation awards the round in progress *and* the match, and the score it
 * leaves behind is the honest one — the rounds that were actually played, with
 * the win going to the player who was still there.
 *
 * ## No clock in here
 *
 * `nowMs` is an argument, as it is everywhere on the authoritative side. This
 * module is reachable from `room.ts`, so it runs inside a browser tab as part of
 * the listen server, and `room.isomorphic.test.ts` fails the build on a
 * `Date.now()` anywhere in that import graph.
 */
import { DUEL_SLOTS, NO_SLOT } from '@gladiator/sim'

import { cryptoUint32, type Uint32Source } from './roomCode.ts'

/**
 * How long a seat is held for a peer that has gone, in milliseconds.
 *
 * Thirty seconds. The number is a judgement about what disconnects actually
 * look like: a wifi handover or a tunnel reconnect is over in two or three
 * seconds, a phone changing cell towers can take ten, and past half a minute the
 * player has either closed the tab or is not coming back in a state to duel.
 *
 * It is also the number that makes rage-quitting pointless. A player who is
 * about to lose a round gains nothing by disconnecting: their body stays where
 * it is, takes the rocket, and loses the round anyway — and if they stay away,
 * they lose the match rather than the round.
 *
 * Two other numbers are tied to it and both are checked by a test:
 * `EMPTY_ROOM_TTL_MS` must be at least this long, or a room whose *only* peer
 * dropped would be reaped before they could come back to it; and
 * `MAX_REPEAT_TICKS` must be far shorter, so the body has come to rest long
 * before the window closes.
 */
export const RECONNECT_GRACE_MS = 30_000

/**
 * How many hex characters a seat token has. 32, which is 128 bits.
 *
 * Far more than the 30 bits in a room code, and for a different reason: a code
 * is typed by a human and therefore bounded by what a human will retype, while a
 * token is only ever copied by a program. So it is sized as a bearer credential
 * — guessing one is not a thing anybody can do — and the remaining exposure is
 * that it is *bearer*: whoever holds it holds the seat. It is never shown to the
 * other peer and never put in a frame anybody else receives.
 */
export const SEAT_TOKEN_LENGTH = 32

/** What a seat is doing. */
export const SeatPhase = {
  /** Nobody holds it. The next arrival gets it. */
  Open: 'open',
  /** A connected peer holds it. */
  Live: 'live',
  /** The peer is gone and the seat is being held for them. */
  Vacant: 'vacant',
  /** The window ran out. The seat is gone and so is the match. */
  Forfeit: 'forfeit',
} as const

export type SeatPhase = (typeof SeatPhase)[keyof typeof SeatPhase]

export type Seat = {
  readonly slot: number
  readonly phase: SeatPhase
  /** Minted when the seat was first taken; reissued to whoever comes back. */
  readonly token: string | null
  /** The peer currently holding it, or the one that left. */
  readonly peerId: string | null
  /** When it was vacated, on the room's clock, or -1. */
  readonly vacatedMs: number
}

/** What the lifecycle decided about somebody arriving. */
export const Admission = {
  /** A free seat, freshly taken. The common case. */
  Seated: 'seated',
  /** A token whose seat was being held. The match is exactly as they left it. */
  Resumed: 'resumed',
  /**
   * A token whose seat is *still connected*. The newer socket wins and the older
   * one is closed.
   *
   * The alternative — refusing the newcomer — locks a player out of their own
   * seat behind a socket that is dead in every sense except that the kernel has
   * not noticed yet, which is exactly what a half-open TCP connection is. A
   * token is proof of the seat, so the holder of it is allowed to displace
   * whatever is sitting there.
   */
  Replaced: 'replaced',
  /** Two peers already, and no token to prove either seat. */
  Full: 'full',
  /** This match is over and cannot be rejoined. Not a hang: a sentence. */
  Ended: 'ended',
} as const

export type Admission = (typeof Admission)[keyof typeof Admission]

export type Arrival = {
  readonly verdict: Admission
  /** The seat taken, or {@link NO_SLOT} when it was refused. */
  readonly slot: number
  /** What this peer must come back with, or `null` when it was refused. */
  readonly token: string | null
  /** The peer whose socket this arrival displaced, if any. */
  readonly evicted: string | null
}

export type Departure = {
  /** The seat that was freed or held, or {@link NO_SLOT} for an unknown peer. */
  readonly slot: number
  /** What the seat is now: {@link SeatPhase.Vacant} or {@link SeatPhase.Open}. */
  readonly phase: SeatPhase
}

export type Lifecycle = {
  readonly seats: readonly Seat[]
  readonly capacity: number
  readonly graceMs: number
  /** Seats a connected peer is holding. */
  readonly live: number
  /** Seats being held for somebody who might come back. */
  readonly held: number
  /**
   * Set once this match is decided and unresumable.
   *
   * It refuses *new* seats. A peer holding a seat's token is still let back in —
   * see {@link Lifecycle.arrive} — because the commonest reason a match ends
   * unresumably is that one side forfeited, and the other side is owed the
   * result.
   */
  readonly ended: boolean
  /**
   * Seat an arriving peer.
   *
   * `token` is what the client sent, or `null` for somebody arriving fresh. An
   * unknown token is *not* an error — it is a stale one from a room that no
   * longer exists, and its holder is treated as a newcomer rather than turned
   * away from a seat that is free.
   *
   * `prefer` asks for a particular slot and is honoured when that slot is still
   * {@link SeatPhase.Open}. It exists for a resumed match (`resume.ts`): the
   * score is indexed by slot, so two players who came back in the other order
   * would find the scoreline had swapped with them. It is only ever a
   * preference — a taken seat falls back to the first free one, because
   * refusing a player a room has space for would be worse than a mirrored
   * scoreline. A token beats it outright: that names a seat rather than asking
   * for one.
   */
  arrive(peerId: string, token: string | null, nowMs: number, prefer?: number | null): Arrival
  /**
   * A peer's socket has gone.
   *
   * `hold` is whether there is a match worth coming back to — the room asks the
   * simulation (`isMatchRunning`), because the lifecycle deliberately knows
   * nothing about phases. A seat vacated during warmup is simply reopened: there
   * is no score to protect, and holding it would make the room refuse a player
   * who could have started the match.
   */
  depart(peerId: string, nowMs: number, hold: boolean): Departure
  /** The seats whose grace ran out at `nowMs`. They are now forfeit. */
  expire(nowMs: number): readonly number[]
  /** Milliseconds left on a seat's window, or 0 when it is not being held. */
  graceLeftMs(slot: number, nowMs: number): number
  /** The slot this peer holds, or {@link NO_SLOT}. */
  slotOf(peerId: string): number
  /** The seat opposite `slot` — the other side of the duel — or `null`. */
  opposite(slot: number): Seat | null
  /** Refuse every further arrival: this match is decided and unresumable. */
  end(): void
}

export type LifecycleOptions = {
  /** Seats. Two, and never more than {@link DUEL_SLOTS} has slots for. */
  readonly capacity?: number
  readonly graceMs?: number
  /** Injected, so a test can name the tokens it is about to send back. */
  readonly random?: Uint32Source
}

/**
 * A seat token: 128 bits, as lower-case hex.
 *
 * Drawn from the same uniform uint32 source as a room code, four times. Hex
 * rather than the room code's Crockford base32 because nobody reads this one out
 * loud — the alphabet there exists to survive a human, and this string never
 * meets one.
 */
export function mintSeatToken(random: Uint32Source = cryptoUint32): string {
  let token = ''
  while (token.length < SEAT_TOKEN_LENGTH) {
    token += (random() >>> 0).toString(16).padStart(8, '0')
  }
  return token.slice(0, SEAT_TOKEN_LENGTH)
}

export function createLifecycle(options: LifecycleOptions = {}): Lifecycle {
  const capacity = Math.max(0, Math.min(options.capacity ?? DUEL_SLOTS.length, DUEL_SLOTS.length))
  const graceMs = options.graceMs ?? RECONNECT_GRACE_MS
  const random = options.random

  type Held = {
    readonly slot: number
    phase: SeatPhase
    token: string | null
    peerId: string | null
    vacatedMs: number
  }

  const seats: Held[] = []
  for (let index = 0; index < capacity; index += 1) {
    const slot = DUEL_SLOTS[index]
    if (slot === undefined) continue
    seats.push({ slot, phase: SeatPhase.Open, token: null, peerId: null, vacatedMs: -1 })
  }

  let ended = false

  const viewOf = (seat: Held): Seat => ({
    slot: seat.slot,
    phase: seat.phase,
    token: seat.token,
    peerId: seat.peerId,
    vacatedMs: seat.vacatedMs,
  })

  const take = (seat: Held, peerId: string, token: string): void => {
    seat.phase = SeatPhase.Live
    seat.peerId = peerId
    seat.token = token
    seat.vacatedMs = -1
  }

  return {
    get seats() {
      return seats.map(viewOf)
    },

    capacity,
    graceMs,

    get live() {
      return seats.filter((seat) => seat.phase === SeatPhase.Live).length
    },

    get held() {
      return seats.filter((seat) => seat.phase === SeatPhase.Vacant).length
    },

    get ended() {
      return ended
    },

    arrive(peerId: string, token: string | null, nowMs: number, prefer?: number | null): Arrival {
      const refused = (verdict: Admission): Arrival => ({
        verdict,
        slot: NO_SLOT,
        token: null,
        evicted: null,
      })

      // The token is looked at *before* {@link Lifecycle.ended}, and the order
      // is the decision: `ended` refuses new seats, not returning ones. A player
      // whose opponent's window ran out while they were themselves reconnecting
      // is owed the sight of the match they just won by forfeit, and a room that
      // refused them would be a room that decided a duel and then hung up on the
      // winner.
      if (token !== null && token !== '') {
        const seat = seats.find((held) => held.token === token)
        if (seat !== undefined) {
          // A forfeited seat's token is a key to a door that has been taken off
          // its hinges. Its holder is told the match ended rather than being
          // seated into a world whose match is `Over`.
          //
          // A seat whose window has run out but which nothing has swept yet is
          // the same answer, and asking the clock here rather than trusting the
          // sweep to have run is what keeps the verdict from depending on which
          // of the two happened first this frame.
          if (seat.phase === SeatPhase.Forfeit) return refused(Admission.Ended)
          if (seat.phase === SeatPhase.Vacant && nowMs - seat.vacatedMs >= graceMs) {
            return refused(Admission.Ended)
          }

          const evicted = seat.phase === SeatPhase.Live ? seat.peerId : null
          const resumed = seat.phase === SeatPhase.Vacant
          take(seat, peerId, token)
          return {
            verdict: resumed ? Admission.Resumed : Admission.Replaced,
            slot: seat.slot,
            token,
            evicted,
          }
        }
        // An unknown token falls through on purpose: it is a leftover from a
        // room that has been reaped, and its holder is a stranger arriving at a
        // match with a free seat. Refusing them would turn a stale value in
        // somebody's tab into a room they cannot join.
      }

      if (ended) return refused(Admission.Ended)

      // The asked-for seat when it is free, the first free one otherwise. The
      // fallback is not a detail: a resume whose preferred slot is taken is a
      // player whose opponent got back first, which is the ordinary case and
      // not a reason to refuse anybody.
      const isOpen = (seat: Seat): boolean => seat.phase === SeatPhase.Open
      const wanted =
        prefer === undefined || prefer === null
          ? undefined
          : seats.find((seat) => seat.slot === prefer)
      const open = wanted !== undefined && isOpen(wanted) ? wanted : seats.find(isOpen)
      if (open === undefined) return refused(Admission.Full)

      const minted = mintSeatToken(random)
      take(open, peerId, minted)
      return { verdict: Admission.Seated, slot: open.slot, token: minted, evicted: null }
    },

    depart(peerId: string, nowMs: number, hold: boolean): Departure {
      const seat = seats.find((held) => held.peerId === peerId)
      if (seat === undefined) return { slot: NO_SLOT, phase: SeatPhase.Open }
      // A peer that was already displaced by a newer socket for the same seat
      // (see {@link Admission.Replaced}) is not holding anything, and its close
      // must not vacate the seat the replacement is sitting in.
      if (seat.phase === SeatPhase.Forfeit) return { slot: seat.slot, phase: seat.phase }

      if (!hold) {
        seat.phase = SeatPhase.Open
        seat.peerId = null
        seat.token = null
        seat.vacatedMs = -1
        return { slot: seat.slot, phase: SeatPhase.Open }
      }

      seat.phase = SeatPhase.Vacant
      seat.vacatedMs = nowMs
      return { slot: seat.slot, phase: SeatPhase.Vacant }
    },

    expire(nowMs: number): readonly number[] {
      const gone: number[] = []
      for (const seat of seats) {
        if (seat.phase !== SeatPhase.Vacant) continue
        if (nowMs - seat.vacatedMs < graceMs) continue
        seat.phase = SeatPhase.Forfeit
        gone.push(seat.slot)
      }
      return gone
    },

    graceLeftMs(slot: number, nowMs: number): number {
      const seat = seats.find((held) => held.slot === slot)
      if (seat === undefined || seat.phase !== SeatPhase.Vacant) return 0
      const left = graceMs - (nowMs - seat.vacatedMs)
      return left > 0 ? Math.round(left) : 0
    },

    slotOf(peerId: string): number {
      const seat = seats.find((held) => held.peerId === peerId && held.phase === SeatPhase.Live)
      return seat === undefined ? NO_SLOT : seat.slot
    },

    opposite(slot: number): Seat | null {
      const other = seats.find((seat) => seat.slot !== slot)
      return other === undefined ? null : viewOf(other)
    },

    end() {
      ended = true
    },
  }
}
