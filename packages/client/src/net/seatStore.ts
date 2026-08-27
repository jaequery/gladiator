/**
 * The seat this tab holds, kept where a reload can find it.
 *
 * A seat is reserved for thirty seconds after its socket drops
 * (`server/lifecycle.ts`): the seat goes `Vacant` rather than `Open`, and only
 * an `Open` one is handed to an arriving stranger. The proof that an arrival is
 * not a stranger is the token the welcome carried. Without somewhere to put
 * that token, the single most common way to lose a socket — the player pressing
 * reload — is the one case the reservation cannot serve: the page comes back
 * with `?room=CODE` still in the address bar, a fresh peer id and an empty
 * memory, and is refused `room-full` by a room that is holding a seat for it.
 *
 * ## Why `sessionStorage` and not `localStorage`
 *
 * The token is a bearer credential: whoever presents it takes the seat. So the
 * question is not "where is this convenient" but "how long, and to whom".
 *
 * `sessionStorage` is scoped to the tab and cleared when it closes, which is
 * the same lifetime the credential has any meaning for — a seat nobody is
 * sitting in is forfeit long before the tab is. `localStorage` would outlive
 * the match by weeks, be shared with every other tab on the origin, and be
 * readable by anything that ever manages to run script here. Neither buys
 * anything: a *second* tab presenting this token would be taking the seat away
 * from the first, which is not a feature.
 *
 * The room is stored with it and checked on the way out, so a token can only
 * ever be offered back to the room it was minted for.
 *
 * `settings.ts` takes the same shape for the same reasons — an injected slice
 * of storage rather than a global, because `localStorage` and `sessionStorage`
 * both *throw* in a browser with site data blocked, and losing a player to a
 * privacy setting would be a very silly way to lose a player.
 */

/**
 * The key the seat is written under.
 *
 * Versioned like `SETTINGS_KEY`, and for the same reason: a shape change gets a
 * new key rather than a migration, so an old build reading a new one finds
 * nothing and dials without a token — which is exactly the behaviour that
 * predates this file and is safe.
 */
export const SEAT_KEY = 'gladiator.seat.v1'

/** The slice of `sessionStorage` this needs. */
export type SeatStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export type SeatStore = {
  /** Remember the token that proves this tab's seat in `room`. */
  remember(room: string, token: string): void
  /** The token for `room`, or `null` if this tab has no claim on it. */
  recall(room: string): string | null
  /** Forget it — the seat is gone, or was refused. */
  forget(): void
}

/** `sessionStorage`, or `null` where the browser refuses to hand it over. */
export function tabStorage(): SeatStorage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

export function createSeatStore(storage: SeatStorage | null): SeatStore {
  return {
    remember(room, token) {
      try {
        storage?.setItem(SEAT_KEY, JSON.stringify({ room, token }))
      } catch {
        // Quota, private browsing, a policy. This session keeps its seat — the
        // token is still in memory for as long as the page lives, which is what
        // a redial uses. All that is lost is surviving a reload.
      }
    },

    recall(room) {
      try {
        const raw = storage?.getItem(SEAT_KEY)
        if (raw === null || raw === undefined) return null
        const held: unknown = JSON.parse(raw)
        if (typeof held !== 'object' || held === null) return null
        const { room: heldRoom, token } = held as { room?: unknown; token?: unknown }
        // The room is checked rather than trusted: a token minted for one room
        // proves nothing about another, and offering it would be handing a
        // credential to a host that has no business seeing it.
        if (heldRoom !== room || typeof token !== 'string' || token === '') return null
        return token
      } catch {
        return null
      }
    },

    forget() {
      try {
        storage?.removeItem(SEAT_KEY)
      } catch {
        // See `remember`.
      }
    },
  }
}
