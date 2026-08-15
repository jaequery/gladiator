/**
 * The page somebody gets when they open a room link on a phone.
 *
 * They will. A room code is a link sent through a chat app, and a chat app is
 * mostly read on a phone — so the second player's *first* contact with this
 * game is, more often than not, a device it cannot be played on. What that
 * player must not get is the game trying anyway: a canvas that never locks a
 * pointer, a click that does nothing, and a conclusion that the link was
 * broken. What they should get is one sentence saying why, and the link still
 * in their hands so they can open it somewhere with a mouse.
 *
 * ## What is actually being detected
 *
 * Not "a phone" — there is no such thing to detect, and every attempt to do it
 * from the user-agent string has been wrong within a year. Two capabilities
 * that this game genuinely requires:
 *
 *   - **Pointer lock exists.** Without it there is no mouselook at all.
 *   - **A fine pointer exists.** `(pointer: fine)` is the CSS media feature for
 *     "the primary input can point precisely" — a mouse, a trackpad, a stylus.
 *     A phone matches `(pointer: coarse)` and not this.
 *
 * A touchscreen laptop matches *both* coarse and fine, and plays perfectly, so
 * the rule is "no fine pointer **and** positive evidence of a touch device"
 * rather than "any touch device". And where the browser answers neither — an
 * old engine, a headless one, an embedded view — the answer is to let them
 * play. A false bounce turns a working machine away; a false pass shows a
 * player a menu that does not respond, which they can at least see and leave.
 */
import { type CopyEnv, copyMessage, copyText } from './clipboard.ts'
import { formatRoomCode } from './roomFlow.ts'

/** What a browser says about itself, reduced to the two things that matter. */
export type DeviceProbe = {
  /** `requestPointerLock` exists on elements. */
  readonly pointerLock: boolean
  /** `(pointer: fine)` — a mouse, a trackpad, a stylus. */
  readonly finePointer: boolean
  /** `(pointer: coarse)` — a finger. */
  readonly coarsePointer: boolean
  /** `navigator.maxTouchPoints`. Zero on a machine with no touchscreen. */
  readonly touchPoints: number
}

/** Why this device was turned away, or `null` for "it was not". */
export type BounceReason = 'no-pointer-lock' | 'touch-only' | null

export function bounceReason(probe: DeviceProbe): BounceReason {
  if (!probe.pointerLock) return 'no-pointer-lock'
  // Positive evidence required. A browser that answers neither media query is
  // let through on purpose: see the header.
  const touchOnly = !probe.finePointer && (probe.coarsePointer || probe.touchPoints > 0)
  return touchOnly ? 'touch-only' : null
}

/** Read the two capabilities off the browser this page is running in. */
export function probeDevice(): DeviceProbe {
  const matches = (query: string): boolean => {
    try {
      return window.matchMedia(query).matches
    } catch {
      return false
    }
  }
  return {
    pointerLock: typeof Element.prototype.requestPointerLock === 'function',
    finePointer: matches('(pointer: fine)'),
    coarsePointer: matches('(pointer: coarse)'),
    touchPoints: navigator.maxTouchPoints ?? 0,
  }
}

/** The sentence at the top of the bounce page, for each reason. */
export function bounceHeadline(reason: Exclude<BounceReason, null>): string {
  return reason === 'no-pointer-lock'
    ? 'This browser cannot lock the mouse'
    : 'Gladiator needs a mouse and a keyboard'
}

export function bounceBody(reason: Exclude<BounceReason, null>): string {
  return reason === 'no-pointer-lock'
    ? 'A duel is aimed with the mouse, which needs the Pointer Lock API. This browser does not have it — a recent Chrome, Edge, Firefox or Safari on a desktop does.'
    : 'A duel is decided by flicks of the mouse and by strafe-jumping on the keyboard, and there is no honest way to do either with a thumb. Open this on a desktop and it will play.'
}

export type BouncePage = {
  /** Take the page away — the player asked to try anyway. */
  dismiss(): void
  readonly root: HTMLElement
}

export type BounceOptions = {
  readonly reason: Exclude<BounceReason, null>
  /** The room this link was for, if it was for one. */
  readonly code: string | null
  /** The link to hand back to the player, so they can open it elsewhere. */
  readonly link: string
  readonly copy: CopyEnv
  /** Called when the player insists. `null` leaves no way past. */
  readonly onDismiss?: () => void
}

/**
 * Mount the bounce page.
 *
 * Written into the same overlay everything else uses, and deliberately *before*
 * a renderer or a socket exists: the point is that a phone never reaches either
 * one. `main.ts` returns straight after calling this.
 */
export function createBouncePage(parent: HTMLElement, options: BounceOptions): BouncePage {
  const root = document.createElement('section')
  root.id = 'bounce'
  root.dataset['hud'] = 'bounce'

  const title = document.createElement('h1')
  title.className = 'bounce-title'
  title.textContent = bounceHeadline(options.reason)

  const body = document.createElement('p')
  body.className = 'bounce-body'
  body.textContent = bounceBody(options.reason)

  root.append(title, body)

  // The half that makes this a useful page rather than a polite one: whoever
  // sent the link is waiting, and the player needs to be able to forward it to
  // a machine that can play it.
  if (options.code !== null) {
    const invite = document.createElement('p')
    invite.className = 'bounce-body'
    invite.textContent = 'Somebody is waiting for you in this match:'

    const code = document.createElement('div')
    code.className = 'bounce-code'
    code.dataset['hud'] = 'bounce-code'
    code.textContent = formatRoomCode(options.code)

    root.append(invite, code)
  }

  const link = document.createElement('input')
  link.className = 'bounce-link'
  link.dataset['hud'] = 'bounce-link'
  link.readOnly = true
  link.value = options.link
  link.setAttribute('aria-label', 'the link to this match')

  const copy = document.createElement('button')
  copy.className = 'bounce-copy'
  copy.dataset['hud'] = 'bounce-copy'
  copy.type = 'button'
  copy.textContent = 'copy the link'
  copy.addEventListener('click', () => {
    void copyText(options.link, options.copy).then((result) => {
      copy.textContent = copyMessage(result)
      copy.dataset['state'] = result === 'unavailable' ? 'manual' : 'copied'
      // Selected either way: on the failure path it is the only way to copy,
      // and on the success path it is the reassurance that it was this text.
      link.select()
    })
  })

  const row = document.createElement('div')
  row.className = 'bounce-row'
  row.append(link, copy)
  root.append(row)

  if (options.onDismiss !== undefined) {
    const anyway = document.createElement('button')
    anyway.className = 'bounce-anyway'
    anyway.dataset['hud'] = 'bounce-anyway'
    anyway.type = 'button'
    anyway.textContent = 'let me try anyway'
    anyway.addEventListener('click', () => {
      root.remove()
      options.onDismiss?.()
    })
    root.append(anyway)
  }

  parent.append(root)

  return {
    root,
    dismiss() {
      root.remove()
    },
  }
}
