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

import type { NetSnapshot } from './net.ts'

export type HudModel = {
  readonly build: string
  readonly renderer: string
  readonly fps: number
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

  const title = document.createElement('h1')
  title.className = 'hud-title'
  title.textContent = 'gladiator — walking skeleton'
  panel.append(title)

  const buildValue = field(panel, 'build', 'build')
  const rendererValue = field(panel, 'renderer', 'renderer')
  const rateValue = field(panel, 'rate', 'fps / tickrate')
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
  prompt.textContent = 'click to play — WASD to run, space to jump, esc to release the mouse'

  root.append(panel, banner, prompt)

  return {
    update(model) {
      buildValue.textContent = model.build
      rendererValue.textContent = model.renderer
      rateValue.textContent = `${Math.round(model.fps)} / ${model.ticksPerSecond}`
      tickValue.textContent = String(model.tick)
      clientValue.textContent = formatHash(model.clientHash)

      const { net } = model
      serverValue.textContent =
        net.serverHash === null ? '—' : `${formatHash(net.serverHash)} @ ${net.serverTick}`

      if (net.agree === null) {
        agreementValue.textContent = '—'
        agreementValue.dataset['state'] = 'unknown'
      } else {
        agreementValue.textContent =
          `${net.agree ? 'MATCH' : 'MISMATCH'} · ${net.compared} compared, ${net.mismatched} mismatched` +
          (net.dropped > 0 ? `, ${net.dropped} dropped` : '')
        agreementValue.dataset['state'] = net.agree && net.mismatched === 0 ? 'match' : 'mismatch'
      }

      rttValue.textContent = net.rttMs === null ? '—' : `${Math.round(net.rttMs)} ms`
      statusValue.textContent = net.message
      statusValue.dataset['state'] = net.status

      // A version mismatch is the one thing worth interrupting the player for:
      // nothing they do will work until they reload.
      const shout =
        net.status === 'version-mismatch' || net.status === 'unconfigured' ? net.message : null
      banner.hidden = shout === null
      banner.textContent = shout ?? ''

      prompt.hidden = model.locked
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
