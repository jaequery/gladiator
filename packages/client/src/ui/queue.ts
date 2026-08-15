/**
 * The quick-match panel: what a player waiting for a stranger is looking at.
 *
 * `?queue=1` asks the host to match this player with whoever is waiting
 * (`server/queue.ts`), and the whole of what the host says about it is a
 * {@link QueueStatus}. This turns that into three sentences and puts one of
 * them on the screen.
 *
 * ## Why there is a panel at all
 *
 * A duel that starts when a stranger arrives is a duel that does not start for
 * an unknown length of time, and the failure mode is not "the queue is slow" —
 * it is a player sitting in an empty arena with no idea whether anything is
 * happening. So the wait is stated, its deadline is stated, and the end of it
 * is stated **whichever way it ends**: the timeout is not a failure to report,
 * it is the outcome that hands back a room code somebody can be sent.
 *
 * ## Split the same way the rest of the HUD is
 *
 * {@link queueReadout} is a pure function of the status and is where every
 * sentence and every rule about when the panel is on the screen lives;
 * {@link createQueuePanel} is the DOM and does nothing but write what it is
 * handed. The suite runs in Node, so the half that can be tested is the half
 * that decides anything — the same division `hudModel.ts` and `hud.ts` are on
 * either side of.
 */
import { QueueState } from '@gladiator/sim'

import type { QueueStatus } from '../net/client.ts'

/**
 * How long "opponent found" stays up, in milliseconds.
 *
 * Long enough to read, short enough to be gone before the first rocket. It
 * leaves by itself rather than on the match starting, because the two are the
 * same moment and a panel that waited for the second one would still be up
 * during the countdown a player is supposed to be aiming through.
 */
export const MATCHED_DWELL_MS = 2_500

export type QueueReadout = {
  readonly state: QueueState
  /** The line in bold. Short enough to read without stopping. */
  readonly headline: string
  /** The line under it: the numbers, or the thing to do about it. */
  readonly detail: string
  /** How much of the wait has gone, 0 to 1. Zero when there is no deadline. */
  readonly progress: number
}

/** Whole seconds, as a wait is read: `9s`, `1:04`. */
export function formatWait(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * What the panel should be saying, or `null` for "nothing at all".
 *
 * `matchStarted` is the one thing this cannot see from the status: a player
 * whose wait timed out is still sitting in a real room under a real code, and a
 * friend can walk into it at any point afterwards. When that happens the queue
 * has nothing more to say and the panel has to get out of the way of the duel,
 * so the caller passes the world's own answer to "has a match begun" rather
 * than this file inferring it from a frame the host never sends.
 */
export function queueReadout(
  status: QueueStatus | null,
  matchStarted: boolean,
): QueueReadout | null {
  if (status === null || matchStarted) return null

  if (status.state === QueueState.Waiting) {
    const remainingMs = Math.max(0, status.timeoutMs - status.waitedMs)
    return {
      state: status.state,
      headline: 'Looking for an opponent',
      detail: `waiting ${formatWait(status.waitedMs)} · giving up in ${formatWait(remainingMs)}`,
      progress: status.timeoutMs > 0 ? Math.min(1, status.waitedMs / status.timeoutMs) : 0,
    }
  }

  if (status.state === QueueState.Matched) {
    if (status.sinceMs >= MATCHED_DWELL_MS) return null
    return {
      state: status.state,
      headline: 'Opponent found',
      detail: `room ${status.room} · the duel starts now`,
      progress: 1,
    }
  }

  // Timed out. The sentence has the code in it because the code is the thing to
  // do next: this player is already sitting in a room, and anyone who is sent
  // those six characters lands in it.
  return {
    state: status.state,
    headline: 'Nobody is waiting right now',
    detail: `send the code ${status.room} to a friend — they will land in this match`,
    progress: 1,
  }
}

export type QueuePanel = {
  /** Draw the readout, or take the panel off the screen when it is `null`. */
  update(readout: QueueReadout | null): void
  /** For the browser test: how many times the panel has actually been written. */
  readonly writes: number
}

/**
 * Mount the panel, hidden, and hand back the handle that draws it.
 *
 * Written only when something changed, like the rest of the HUD: this is called
 * every frame and the wait only changes once a second, so nearly every call
 * writes nothing. A dirty overlay costs a recomposite of the whole page over
 * the canvas — `ui/hud.ts` has the measurement.
 */
export function createQueuePanel(parent: HTMLElement): QueuePanel {
  const root = document.createElement('div')
  root.className = 'queue-panel'
  root.dataset['queue'] = 'idle'
  root.hidden = true

  const headline = document.createElement('p')
  headline.className = 'queue-headline'
  headline.dataset['queue'] = 'headline'
  root.append(headline)

  const detail = document.createElement('p')
  detail.className = 'queue-detail'
  detail.dataset['queue'] = 'detail'
  root.append(detail)

  const track = document.createElement('div')
  track.className = 'queue-track'
  const bar = document.createElement('div')
  bar.className = 'queue-bar'
  bar.dataset['queue'] = 'bar'
  track.append(bar)
  root.append(track)

  parent.append(root)

  let shown: QueueReadout | null = null
  let writes = 0

  return {
    update(readout) {
      if (readout === null) {
        if (shown === null) return
        shown = null
        root.hidden = true
        root.dataset['queue'] = 'idle'
        writes += 1
        return
      }

      if (
        shown !== null &&
        shown.state === readout.state &&
        shown.headline === readout.headline &&
        shown.detail === readout.detail &&
        // Quantised to the percent the bar can actually show, so a value that
        // creeps every frame settles into "no change" between steps.
        Math.round(shown.progress * 100) === Math.round(readout.progress * 100)
      ) {
        return
      }

      shown = readout
      writes += 1
      root.hidden = false
      root.dataset['queue'] = readout.state
      headline.textContent = readout.headline
      detail.textContent = readout.detail
      bar.style.width = `${Math.round(readout.progress * 100)}%`
    },

    get writes() {
      return writes
    },
  }
}
