/**
 * Putting the share link on the player's clipboard, and what to do when the
 * browser will not.
 *
 * One button, three outcomes, and the third is the one that decides whether the
 * flow works at all:
 *
 *   1. **The asynchronous clipboard.** `navigator.clipboard.writeText` — the
 *      one that works — is only available in a *secure context*. The deployed
 *      origin is HTTPS and `localhost` counts, so this is the path a player
 *      takes.
 *   2. **`document.execCommand('copy')`.** Deprecated, synchronous, and still
 *      the only thing that works on an insecure origin — a LAN address a friend
 *      typed in, a preview served over plain HTTP.
 *   3. **Neither.** Then the *link itself* has to be on screen, selected, so
 *      the player can copy it with the keyboard. A copy button that silently
 *      does nothing is worse than no button, because the player believes they
 *      have the link and pastes an empty message.
 *
 * The point of the file is that (3) is a state the caller is told about rather
 * than a promise that quietly resolves.
 */

/** Which of the three happened. */
export type CopyResult =
  | 'clipboard'
  /** The deprecated path; it worked. */
  | 'execCommand'
  /** Nothing worked — show the link and select it. */
  | 'unavailable'

/**
 * The two ways a browser will copy something, injected.
 *
 * Both optional, because both are genuinely absent somewhere: the asynchronous
 * clipboard on an insecure origin, and `execCommand` under a hardened policy.
 */
export type CopyEnv = {
  readonly writeText?: (text: string) => Promise<void>
  readonly execCopy?: (text: string) => boolean
}

export async function copyText(text: string, env: CopyEnv): Promise<CopyResult> {
  if (env.writeText !== undefined) {
    try {
      await env.writeText(text)
      return 'clipboard'
    } catch {
      // Permission refused, or a document that lost focus between the click and
      // the promise. Fall through: `execCommand` needs no permission.
    }
  }

  if (env.execCopy !== undefined) {
    try {
      if (env.execCopy(text)) return 'execCommand'
    } catch {
      // Deprecated, and entitled to throw. Say so rather than pretending.
    }
  }

  return 'unavailable'
}

/**
 * The browser's own two paths.
 *
 * `isSecureContext` is checked rather than the origin's scheme: it is the exact
 * condition the clipboard API is gated on, it is true for `localhost` as well
 * as HTTPS, and re-deriving it from `location.protocol` would be a second
 * opinion that is wrong on exactly the origins a developer tests on.
 */
export function browserCopyEnv(): CopyEnv {
  const clipboard = window.isSecureContext ? navigator.clipboard : undefined
  return {
    ...(clipboard === undefined ? {} : { writeText: (text: string) => clipboard.writeText(text) }),
    execCopy: (text: string) => {
      // Off-screen rather than `hidden`: a hidden element cannot hold a
      // selection, and a selection is the whole mechanism here.
      const scratch = document.createElement('textarea')
      scratch.value = text
      scratch.setAttribute('readonly', '')
      scratch.style.position = 'fixed'
      scratch.style.top = '-1000px'
      scratch.style.opacity = '0'
      document.body.append(scratch)
      scratch.select()
      try {
        return document.execCommand('copy')
      } finally {
        scratch.remove()
      }
    },
  }
}

/** What the button says afterwards, for each outcome. */
export function copyMessage(result: CopyResult): string {
  if (result === 'unavailable') return 'copy it from here'
  return 'copied'
}
