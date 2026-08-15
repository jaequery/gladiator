/**
 * One user gesture, two things that need one.
 *
 * Browsers will not start an `AudioContext` without a user gesture, and they
 * will not grant pointer lock without one either. The bug this file exists to
 * make impossible is the version where those are two different gestures: the
 * player clicks the canvas, the pointer locks, they are in the game — and the
 * audio context is still `suspended`, because nothing asked it to resume. The
 * first rocket is silent, and the player concludes the game has no sound.
 *
 * It is a genuinely easy mistake, because it looks fine to whoever wrote it: a
 * `resume()` on a "start" button that a player who clicked straight into the
 * canvas never pressed, or a resume attached to `keydown` when the gesture that
 * matters is a click. So the two calls live in one handler, in one file, and
 * `gesture.test.ts` asserts that a single event triggers both.
 *
 * The listener stays attached rather than firing once. Pointer lock is dropped
 * every time the player presses escape and has to be re-requested, and a
 * browser may suspend the context again when the tab goes to the background —
 * so every click is an opportunity to be in the right state, and `resume()` on
 * a running context is free.
 */

/** The slice of an element this needs. A canvas satisfies it; so does a fake. */
export type GestureTarget = {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export type GestureActions = {
  /** Resume the audio context. Idempotent. */
  readonly resume: () => void
  /** Ask for pointer lock. */
  readonly requestLock: () => void
}

export type ArmedGesture = {
  dispose(): void
}

/** Which event counts. Pointer lock may only be requested from a click. */
export const GESTURE_EVENT = 'click'

/**
 * Both actions, once.
 *
 * Audio first, and it is not arbitrary: `requestPointerLock` can throw
 * synchronously — a document that is not focused, a lock request the browser
 * declines outright — and if it did so first, the resume would never run and
 * the failure mode would be exactly the silent one this file is about. Neither
 * call is allowed to take the other down, so both are guarded.
 *
 * Exported as well as armed, because the click that starts a match is not
 * always on the canvas: the menu's "enter the arena" button is a gesture too
 * (`ui/menu.ts`), and a second copy of these two calls somewhere else is
 * exactly how one of them gets forgotten.
 */
export function runGesture(actions: GestureActions): void {
  try {
    actions.resume()
  } catch (cause) {
    console.warn(`gladiator: audio could not resume: ${String(cause)}`)
  }
  try {
    actions.requestLock()
  } catch (cause) {
    console.warn(`gladiator: pointer lock was refused: ${String(cause)}`)
  }
}

/** Run {@link runGesture} on every {@link GESTURE_EVENT} on `target`. */
export function armGesture(target: GestureTarget, actions: GestureActions): ArmedGesture {
  const handler = () => runGesture(actions)

  target.addEventListener(GESTURE_EVENT, handler)

  return {
    dispose() {
      target.removeEventListener(GESTURE_EVENT, handler)
    },
  }
}
