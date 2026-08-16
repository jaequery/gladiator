/**
 * The one decision the menu's key handling makes.
 *
 * The screens themselves are checked in a real browser by `scripts/e2e.mjs`,
 * for the reason `credits.test.ts` states: a DOM simulated in Node would be a
 * second opinion about what the page does. What is worth asserting here is the
 * rule underneath — which keys the menu keeps, and the one it must not.
 */
import { describe, expect, it } from 'vitest'

import { menuSwallowsKey, rawInputLabel, rawInputWarning } from './menu.ts'

describe('what the menu keeps', () => {
  it('keeps every key that is also a key in the game', () => {
    // A space on a focused button would otherwise be a press *and* a jump, and
    // a `C` in a room code would open the credits.
    for (const code of ['Space', 'KeyC', 'KeyW', 'KeyA', 'KeyS', 'KeyD', 'Enter', 'Tab']) {
      expect(menuSwallowsKey(code)).toBe(true)
    }
  })

  it('lets escape through, because escape is how a player leaves', () => {
    // GLAD-G42FEB. `main.ts` listens on the window and is the only thing that
    // knows what leaving means here — close the credits, step back a screen.
    // Swallowed, it left a player who opened the credits from the menu on a
    // full-screen panel with no way off it but a reload.
    expect(menuSwallowsKey('Escape')).toBe(false)
  })
})

describe('the raw-input verdict', () => {
  it('warns about everything that is not a granted one', () => {
    expect(rawInputWarning('granted')).toBeNull()
    expect(rawInputWarning('refused')).not.toBeNull()
    expect(rawInputWarning('unknown')).not.toBeNull()
    for (const state of ['granted', 'refused', 'unknown'] as const) {
      expect(rawInputLabel(state)).not.toBe('')
    }
  })
})
