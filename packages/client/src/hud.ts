/**
 * The on-screen readout.
 *
 * Two of this ticket's three acceptance criteria are things a person has to be
 * able to *see*: the client and server hashes agreeing, and a protocol mismatch
 * saying so in words. So the HUD is not decoration here — it is the instrument.
 * The real HUD is GLAD-BHNPOE.
 *
 * Every element carries a `data-hud` attribute. The browser smoke test reads
 * those rather than scraping text, so restyling the page does not break it.
 */
import { formatHash } from '@gladiator/sim'

import { isFatal, type NetSnapshot } from './net/client.ts'

export type HudModel = {
  readonly build: string
  /** Which arena this page loaded. Its hash comes from {@link NetSnapshot}, so
   *  the HUD shows the hash that was actually sent. */
  readonly mapName: string
  readonly renderer: string
  readonly fps: number
  /** 99th-percentile frame interval, and what it is allowed to be. */
  readonly p99Ms: number
  readonly frameBudgetMs: number
  readonly tick: number
  readonly ticksPerSecond: number
  readonly clientHash: number
  readonly locked: boolean
  readonly net: NetSnapshot
}

export type Hud = {
  update(model: HudModel): void
  /** A fatal message, in place of everything else. */
  fail(message: string): void
}

/**
 * Assign only when the value changed.
 *
 * Writing the same string back into `textContent` still dirties the node, and
 * a dirty node in the overlay means the browser recomposites the whole page on
 * top of the canvas. Most of this readout is unchanged most of the time.
 */
function setText(element: HTMLElement, value: string): void {
  if (element.textContent !== value) element.textContent = value
}

/** The same, for a `data-` attribute the smoke test reads. */
function setState(element: HTMLElement, value: string): void {
  if (element.dataset['state'] !== value) element.dataset['state'] = value
}

function field(parent: HTMLElement, key: string, label: string): HTMLElement {
  const row = document.createElement('div')
  row.className = 'hud-row'
  const name = document.createElement('span')
  name.className = 'hud-label'
  name.textContent = label
  const value = document.createElement('span')
  value.className = 'hud-value'
  value.dataset['hud'] = key
  row.append(name, value)
  parent.append(row)
  return value
}

export function createHud(root: HTMLElement): Hud {
  root.innerHTML = ''

  const panel = document.createElement('section')
  panel.className = 'hud-panel'
  // Part of the no-overlap set the aspect-ratio check in `scripts/e2e.mjs`
  // measures: the in-match HUD (GLAD-BHNPOE) shares the overlay with this
  // panel, and "nothing overlaps" has to mean nothing.
  panel.dataset['hudBox'] = ''

  const title = document.createElement('h1')
  title.className = 'hud-title'
  title.textContent = 'gladiator — walking skeleton'
  panel.append(title)

  const buildValue = field(panel, 'build', 'build')
  const mapValue = field(panel, 'map', 'arena')
  const rendererValue = field(panel, 'renderer', 'renderer')
  const rateValue = field(panel, 'rate', 'fps / tickrate')
  const paceValue = field(panel, 'pace', 'p99 / budget')
  const tickValue = field(panel, 'tick', 'tick')
  const clientValue = field(panel, 'client-hash', 'client hash')
  const serverValue = field(panel, 'server-hash', 'server hash')
  const agreementValue = field(panel, 'agreement', 'agreement')
  const rttValue = field(panel, 'rtt', 'rtt')
  const statusValue = field(panel, 'status', 'status')

  const banner = document.createElement('div')
  banner.className = 'hud-banner'
  banner.dataset['hud'] = 'banner'
  banner.hidden = true

  const prompt = document.createElement('div')
  prompt.className = 'hud-prompt'
  prompt.dataset['hud'] = 'prompt'
  prompt.dataset['hudBox'] = ''
  prompt.textContent = 'click to play — WASD to run, space to jump, esc to release the mouse'

  root.append(panel, banner, prompt)

  return {
    update(model) {
      setText(buildValue, model.build)
      setText(rendererValue, model.renderer)
      setText(rateValue, `${Math.round(model.fps)} / ${model.ticksPerSecond}`)
      // The frame *rate* is an average and averages hide hitches; the
      // percentile beside it is the number that says whether it stutters.
      // `render/frameStats.ts`.
      setText(paceValue, `${model.p99Ms.toFixed(1)} / ${model.frameBudgetMs.toFixed(1)} ms`)
      setState(
        paceValue,
        model.p99Ms === 0 ? 'unknown' : model.p99Ms <= model.frameBudgetMs ? 'match' : 'mismatch',
      )
      setText(tickValue, String(model.tick))
      setText(clientValue, formatHash(model.clientHash))

      const { net } = model
      // The server's arena beside ours, so "are we on the same map" is a
      // question the page answers rather than one the console has to.
      const ours = `${model.mapName} ${net.mapHash}`
      setText(
        mapValue,
        net.serverMapHash === null || net.serverMapHash === net.mapHash
          ? ours
          : `${ours} · server has ${net.serverMapHash}`,
      )

      setText(
        serverValue,
        net.serverHash === null ? '—' : `${formatHash(net.serverHash)} @ ${net.serverTick}`,
      )

      if (net.agree === null) {
        setText(agreementValue, '—')
        setState(agreementValue, 'unknown')
      } else {
        setText(
          agreementValue,
          `${net.agree ? 'MATCH' : 'MISMATCH'} · ${net.compared} compared, ${net.mismatched} mismatched` +
            (net.dropped > 0 ? `, ${net.dropped} dropped` : ''),
        )
        setState(agreementValue, net.agree && net.mismatched === 0 ? 'match' : 'mismatch')
      }

      setText(rttValue, net.rttMs === null ? '—' : `${Math.round(net.rttMs)} ms`)
      setText(statusValue, net.message)
      setState(statusValue, net.status)

      // A version or map mismatch is worth interrupting the player for:
      // nothing they do will work until they reload. `isFatal` is shared with
      // `main.ts`, which takes the in-match HUD down for the same three states.
      const shout = isFatal(net.status) ? net.message : null
      if (banner.hidden !== (shout === null)) banner.hidden = shout === null
      setText(banner, shout ?? '')

      if (prompt.hidden !== model.locked) prompt.hidden = model.locked
    },

    fail(message) {
      root.innerHTML = ''
      const failure = document.createElement('div')
      failure.className = 'hud-banner'
      failure.dataset['hud'] = 'banner'
      failure.textContent = message
      root.append(failure)
    },
  }
}
