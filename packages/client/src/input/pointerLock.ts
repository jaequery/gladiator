/**
 * Pointer lock, and raw mouse input.
 *
 * Sixty lines that are ours rather than a library's, because the one thing this
 * has to get right is a single option flag that most libraries do not pass.
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
 * So the lock is requested with `unadjustedMovement: true`, which asks for raw
 * device deltas. Where the browser refuses — it is Chromium-family and a recent
 * Safari, and nothing else — the request is retried without the flag, because
 * accelerated input is much better than no game. {@link PointerLock.raw} says
 * which one happened, so the setting screen (GLAD-NPCTU8) can be honest about
 * it rather than showing a sensitivity slider that means two different things.
 */

export type PointerLock = {
  /** Whether the pointer is currently locked to the element. */
  readonly locked: boolean
  /** Whether the browser granted unaccelerated deltas. */
  readonly raw: boolean
  /** Ask for the lock. Must be called from a user gesture. */
  request(): void
  /** Called on every change of {@link PointerLock.locked}, with the new state. */
  onChange(listener: (locked: boolean) => void): void
  dispose(): void
}

/**
 * `requestPointerLock` is typed as returning a promise and does not always
 * return one — Safari still returns `undefined`. Normalising here keeps the
 * fallback below from depending on which it was.
 */
function requestLock(element: Element, options?: PointerLockOptions): Promise<void> {
  const result: unknown = element.requestPointerLock(options)
  return result instanceof Promise ? result : Promise.resolve()
}

export function createPointerLock(element: HTMLElement): PointerLock {
  const listeners: Array<(locked: boolean) => void> = []
  let locked = false
  let raw = false

  const onChange = () => {
    locked = document.pointerLockElement === element
    if (!locked) raw = false
    for (const listener of listeners) listener(locked)
  }

  document.addEventListener('pointerlockchange', onChange)

  return {
    get locked() {
      return locked
    },
    get raw() {
      return raw
    },

    request() {
      requestLock(element, { unadjustedMovement: true })
        .then(() => {
          raw = true
        })
        .catch(() => {
          // Either the browser has no raw input to give, or the gesture was
          // not trusted. Retry plain: the second failure is the real one, and
          // swallowing it keeps a refused lock from becoming an unhandled
          // rejection in the console on every stray click.
          raw = false
          return requestLock(element).catch(() => undefined)
        })
    },

    onChange(listener) {
      listeners.push(listener)
    },

    dispose() {
      document.removeEventListener('pointerlockchange', onChange)
      listeners.length = 0
    },
  }
}
