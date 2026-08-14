/**
 * Keyboard, mouse and pointer lock — everything between a human and a
 * `UserCmd`.
 *
 * The view angles are kept here as floating-point degrees and quantised to
 * Quake's 16-bit angle units only when a command is built. That ordering
 * matters: accumulating quantised deltas would make slow mouse movement
 * ratchet, while quantising at the door means the angle the client simulates
 * and the angle the server receives are the same integer by construction.
 */
import {
  BUTTON_JUMP,
  type UserCmd,
  pitchUnitsFromDegrees,
  yawUnitsFromDegrees,
} from '@gladiator/sim'

/** Degrees of view rotation per unit of raw mouse movement. Quake's `m_yaw`. */
export const DEGREES_PER_COUNT = 0.022

/** The `sensitivity` cvar, in spirit. Settings are GLAD-NPCTU8. */
export const DEFAULT_SENSITIVITY = 2.5

/** Movement keys, by `KeyboardEvent.code` so the layout does not matter. */
const FORWARD_KEYS = ['KeyW', 'ArrowUp']
const BACK_KEYS = ['KeyS', 'ArrowDown']
const LEFT_KEYS = ['KeyA', 'ArrowLeft']
const RIGHT_KEYS = ['KeyD', 'ArrowRight']
const JUMP_KEYS = ['Space']

const TRACKED_KEYS = new Set([
  ...FORWARD_KEYS,
  ...BACK_KEYS,
  ...LEFT_KEYS,
  ...RIGHT_KEYS,
  ...JUMP_KEYS,
])

export type ViewAngles = {
  /** Degrees, wrapped. Increasing yaw turns left, as in Quake. */
  yawDegrees: number
  /** Degrees, clamped. Positive is looking up. */
  pitchDegrees: number
}

export type InputController = {
  /** Whether the pointer is currently locked to the canvas. */
  readonly locked: boolean
  readonly angles: ViewAngles
  /** Build the command for the tick about to be simulated. */
  sample(): UserCmd
  /** Ask the browser for pointer lock. Must be called from a user gesture. */
  requestLock(): void
  /** Called on every pointer-lock state change, with the new state. */
  onLockChange(listener: (locked: boolean) => void): void
  dispose(): void
}

/**
 * Turn a held-key set and a view into a command. Exported separately from the
 * DOM plumbing so it can be tested without a browser.
 */
export function commandFrom(held: ReadonlySet<string>, angles: ViewAngles): UserCmd {
  const forward = FORWARD_KEYS.some((key) => held.has(key)) ? 1 : 0
  const back = BACK_KEYS.some((key) => held.has(key)) ? 1 : 0
  const left = LEFT_KEYS.some((key) => held.has(key)) ? 1 : 0
  const right = RIGHT_KEYS.some((key) => held.has(key)) ? 1 : 0
  const jump = JUMP_KEYS.some((key) => held.has(key))

  return {
    // Holding both directions cancels, rather than one arbitrarily winning.
    forwardMove: forward - back,
    sideMove: right - left,
    yaw: yawUnitsFromDegrees(angles.yawDegrees),
    pitch: pitchUnitsFromDegrees(angles.pitchDegrees),
    buttons: jump ? BUTTON_JUMP : 0,
  }
}

export type InputOptions = {
  readonly sensitivity?: number
}

/** Wire up a canvas for play. */
export function createInputController(
  canvas: HTMLCanvasElement,
  options: InputOptions = {},
): InputController {
  const sensitivity = options.sensitivity ?? DEFAULT_SENSITIVITY
  const held = new Set<string>()
  const angles: ViewAngles = { yawDegrees: 0, pitchDegrees: 0 }
  const lockListeners: Array<(locked: boolean) => void> = []
  let locked = false

  const onKeyDown = (event: KeyboardEvent) => {
    if (!TRACKED_KEYS.has(event.code)) return
    held.add(event.code)
    // Space scrolls the page otherwise, which is a jump that also moves the
    // viewport — an unmistakable "this is a document, not a game" tell.
    event.preventDefault()
  }

  const onKeyUp = (event: KeyboardEvent) => {
    if (!TRACKED_KEYS.has(event.code)) return
    held.delete(event.code)
    event.preventDefault()
  }

  const onMouseMove = (event: MouseEvent) => {
    if (!locked) return
    angles.yawDegrees -= event.movementX * DEGREES_PER_COUNT * sensitivity
    angles.pitchDegrees -= event.movementY * DEGREES_PER_COUNT * sensitivity
    // Keep yaw in a band a float can hold precisely over a long session.
    angles.yawDegrees = ((angles.yawDegrees % 360) + 360) % 360
    if (angles.pitchDegrees > 89) angles.pitchDegrees = 89
    if (angles.pitchDegrees < -89) angles.pitchDegrees = -89
  }

  const onLockChange = () => {
    locked = document.pointerLockElement === canvas
    // Keys held when focus is lost would otherwise stay held forever, and the
    // player returns to find themselves sprinting into a wall.
    if (!locked) held.clear()
    for (const listener of lockListeners) listener(locked)
  }

  const onBlur = () => held.clear()

  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('blur', onBlur)
  document.addEventListener('mousemove', onMouseMove)
  document.addEventListener('pointerlockchange', onLockChange)

  return {
    get locked() {
      return locked
    },
    angles,
    sample: () => commandFrom(held, angles),
    requestLock: () => {
      // Chrome returns a promise and rejects if the gesture was not trusted;
      // Safari returns undefined. Swallowing the rejection keeps a failed lock
      // from becoming an unhandled rejection in the console.
      const result: unknown = canvas.requestPointerLock()
      if (result instanceof Promise) result.catch(() => undefined)
    },
    onLockChange: (listener) => {
      lockListeners.push(listener)
    },
    dispose: () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', onBlur)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('pointerlockchange', onLockChange)
    },
  }
}
