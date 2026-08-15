/**
 * Pointer lock, and raw mouse input.
 *
 * A hundred lines that are ours rather than a library's, because the two things
 * this has to get right are a single option flag that most libraries do not
 * pass, and what to do when the browser says no to it.
 *
 * ## `unadjustedMovement: true` is not optional
 *
 * By default the browser hands a page the same mouse deltas the desktop gets,
 * with the operating system's pointer acceleration already applied: move the
 * mouse faster and the same physical distance turns you further. That is
 * correct for a cursor and disqualifying for a shooter. A flick is a learned
 * physical gesture, and if the same gesture produces a different angle
 * depending on how fast the wrist moved, the skill that separates two players
 * is the mouse driver's.
 *
 * So the lock is requested with `unadjustedMovement: true`. Where the browser
 * refuses, the request is retried *without* the flag, because accelerated input
 * is much better than no game — and {@link PointerLock.rawInput} records which
 * of the three things happened, so the settings screen can say so rather than
 * showing a cm/360 field that quietly means something else.
 *
 * ## Three states, because there are three answers
 *
 * The flag arrived alongside a second change: `requestPointerLock()` returning
 * a promise. A browser that returns one can be *asked* whether the flag was
 * honoured. A browser still on the events-only specification cannot — it takes
 * the options object, ignores the member it does not know, and locks. There is
 * no other feature detection: no `supports()`, nothing on the element.
 *
 * So `unknown` is a real state and not a placeholder, and the fallback warning
 * covers it as well as `refused`. Promising raw input on a browser that never
 * said it applied it is the same bug as promising it on one that said it did
 * not. `docs/browser-support.md` is the measured matrix.
 *
 * ## Escape, and why nothing retries on a timer
 *
 * Every browser refuses `requestPointerLock` for a moment after the *user*
 * released the lock with escape, whether or not a transient activation is
 * available — deliberately, so a page cannot trap a pointer the player just
 * freed. The only thing that works is a brand-new gesture, which is why a
 * refusal is reported through {@link PointerLock.onDenied} for the menu to put
 * a "click to resume" in front of, and why there is no `setTimeout` in here.
 */

/** Whether the browser is giving us unaccelerated deltas, and how sure we are. */
export type RawInput =
  /** No lock has been requested yet, or this browser does not report. */
  | 'unknown'
  /** The browser resolved an `unadjustedMovement` request: raw deltas. */
  | 'granted'
  /** The browser refused the flag; the lock was taken without it. */
  | 'refused'

/**
 * The slice of an element this needs. A canvas satisfies it; so does a fake,
 * which is how `pointerLock.test.ts` drives all three browser behaviours
 * without a browser.
 */
export type LockTarget = {
  requestPointerLock(options?: { unadjustedMovement?: boolean }): unknown
}

/** The slice of `document` this needs. Same reasoning as {@link LockTarget}. */
export type LockDocument = {
  readonly pointerLockElement: unknown
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export type PointerLock = {
  /** Whether the pointer is currently locked to the element. */
  readonly locked: boolean
  /** Whether the browser *confirmed* unaccelerated deltas. */
  readonly raw: boolean
  /** The same answer with its uncertainty intact. See {@link RawInput}. */
  readonly rawInput: RawInput
  /** Ask for the lock. Must be called from a user gesture. */
  request(): void
  /** Called on every change of {@link PointerLock.locked}, with the new state. */
  onChange(listener: (locked: boolean) => void): void
  /**
   * Called when a request was refused outright — most often because the player
   * pressed escape a moment ago and the browser is still holding the door shut.
   * The cure is another click, so this is what the pause menu listens to.
   */
  onDenied(listener: (reason: string) => void): void
  dispose(): void
}

/**
 * Ask for the lock, and say which kind of answer came back.
 *
 * `requestPointerLock` is typed as returning a promise and does not always
 * return one: the events-only specification returns `undefined`, and a browser
 * on that specification can neither confirm nor deny the flag. Separating "no
 * promise" from "a promise that resolved" is the whole of the raw-input
 * verdict, so it is spelt out here rather than normalised away.
 */
export function requestWithOptions(
  element: LockTarget,
  options?: { unadjustedMovement?: boolean },
): Promise<boolean> | null {
  const result: unknown = element.requestPointerLock(options)
  return result instanceof Promise ? result.then(() => true) : null
}

export function createPointerLock(
  element: LockTarget,
  doc: LockDocument = document,
): PointerLock {
  const changed: Array<(locked: boolean) => void> = []
  const denied: Array<(reason: string) => void> = []
  let locked = false
  let rawInput: RawInput = 'unknown'

  const onChange = () => {
    locked = doc.pointerLockElement === element
    for (const listener of changed) listener(locked)
  }

  // The events-only half of the API, and the only failure channel a browser
  // without the promise form has. Deliberately not "the lock failed" as a
  // sentence: what a player needs is the instruction, and the menu writes it.
  const onError = () => {
    for (const listener of denied) listener('the browser refused the pointer lock')
  }

  doc.addEventListener('pointerlockchange', onChange)
  doc.addEventListener('pointerlockerror', onError)

  return {
    get locked() {
      return locked
    },
    get raw() {
      return rawInput === 'granted'
    },
    get rawInput() {
      return rawInput
    },

    request() {
      const promised = requestWithOptions(element, { unadjustedMovement: true })
      if (promised === null) {
        // No promise to ask. The lock is either happening or `pointerlockerror`
        // is about to fire; either way this browser will not tell us whether it
        // applied the flag, and saying "granted" here would be a guess a
        // sensitivity setting is measured against.
        rawInput = 'unknown'
        return
      }

      promised.then(
        () => {
          rawInput = 'granted'
        },
        (cause: unknown) => {
          // Retried without the flag on *any* rejection rather than only on
          // `NotSupportedError`: the failure that matters to a player is not
          // getting into the game, and a browser that rejects for a reason we
          // did not anticipate would otherwise leave them outside it.
          rawInput = 'refused'
          const plain = requestWithOptions(element)
          plain?.catch((second: unknown) => {
            for (const listener of denied) listener(describe(second) ?? describe(cause) ?? 'refused')
          })
        },
      )
    },

    onChange(listener) {
      changed.push(listener)
    },

    onDenied(listener) {
      denied.push(listener)
    },

    dispose() {
      doc.removeEventListener('pointerlockchange', onChange)
      doc.removeEventListener('pointerlockerror', onError)
      changed.length = 0
      denied.length = 0
    },
  }
}

/** Whatever the browser called it, as one short line. */
function describe(cause: unknown): string | null {
  if (cause instanceof Error) return cause.message === '' ? cause.name : cause.message
  return cause === undefined || cause === null ? null : String(cause)
}
