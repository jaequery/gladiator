/**
 * The performance HUD: what the netcode is doing, on screen, while you play.
 *
 * `?dev=1`. Five numbers are the point of it, and each one is the first thing
 * you would ask for after a moment that felt wrong:
 *
 * | Reading | The question it answers |
 * | ------- | ----------------------- |
 * | tick | which moment am I looking at — the coordinate every log line and every demo frame is in |
 * | rtt | is the link the problem |
 * | pending | how much of my input the host has not seen; a number that climbs is a socket that has stopped draining |
 * | error | how far the prediction was out, in units, on the last snapshot |
 * | snapshot B/s | what this design actually costs downstream, which is the number that decides whether a delta encoder is worth writing |
 *
 * Plus the two counters that should never move at all (`sim/src/counters.ts`,
 * `net/mispredict.ts`), because a counter nobody can see is a counter nobody
 * checks.
 *
 * ## It is free to run, and that is a constraint rather than an aspiration
 *
 * Everything here is a value somebody else already computed — a field off a
 * `NetSnapshot`, a counter, a frame interval the renderer was keeping anyway.
 * **Nothing in this file may ask the GPU a question.** `readPixels`,
 * `getQueryResult`, `engine.getGlInfo`, any timer query — each of those forces
 * the driver to finish the work it had queued, so a panel that measured the
 * frame time would *be* the frame time. `render/frameStats.ts` measures on the
 * CPU for exactly this reason, and this panel reads what it produced.
 *
 * The second half of free is the write path: the same compare-before-assign
 * guard `ui/hud.ts` uses, because a dirty overlay costs a recomposite of the
 * whole page over the canvas — a measured 16.7 ms to a 50 ms 99th percentile
 * (`main.ts`'s `HUD_INTERVAL_MS`).
 *
 * ## Why it is opt-in and unmarked
 *
 * No `data-hud-box`. The aspect-ratio check in `scripts/e2e.mjs` reveals every
 * box it can find and requires them not to overlap, which is the right rule for
 * the readout a player sees and the wrong one for an instrument that is only on
 * a page when somebody has asked for it. It is not mounted at all without
 * `?dev=1`, so there is nothing on the page to measure.
 *
 * ## The split
 *
 * {@link devHudRows} is a pure function of {@link DevHudModel} and is what the
 * tests assert on; {@link createDevHud} is the DOM. Same shape, and the same
 * reason, as `ui/hudModel.ts` and `ui/hud.ts`: the suite runs in Node.
 */

/** Is this page asking for the instrument? `?dev=1`, or bare `?dev`. */
export function devMode(search: string): boolean {
  return new URLSearchParams(search).get('dev') !== null
}

export type DevHudModel = {
  /** The world tick the prediction is at — the *server's* numbering. */
  readonly tick: number
  /** The free-running label this client's next command goes out under. */
  readonly commandTick: number
  /** Round trip in milliseconds, as the *server* measured it, or `null`. */
  readonly rttMs: number | null
  /** Commands sent and not yet acknowledged. */
  readonly pending: number
  /** How far the last reconciliation moved the player, in units. */
  readonly errorUnits: number
  /** The worst it has been this session, in units. */
  readonly worstErrorUnits: number
  readonly snapshots: number
  readonly snapshotBytesPerSecond: number
  readonly fps: number
  readonly p99Ms: number
  readonly frameBudgetMs: number
  /** The §2.6 speed rail. Any non-zero value is a sentence somebody owes. */
  readonly speedClamps: number
  readonly worstClampedSpeed: number
  /** Self-splash mispredicts. `net/mispredict.ts`. Also should be zero. */
  readonly selfSplashMispredicts: number
  readonly selfSplashes: number
  /** Hard snaps this session. `net/reconcile.ts`. */
  readonly snaps: number
  /** Sub-steps recorded so far, or `null` when this page is not recording. */
  readonly recordedFrames: number | null
}

export type DevHudRow = {
  /** Stable, so the view builds its fields once and then only writes values. */
  readonly key: string
  readonly label: string
  readonly value: string
  /** `warn` is drawn in the mismatch colour. Absent is ordinary. */
  readonly state?: 'warn'
}

/** A byte rate, in the unit a person reads it in. */
export function formatRate(bytesPerSecond: number): string {
  if (bytesPerSecond <= 0) return '—'
  if (bytesPerSecond < 1000) return `${Math.round(bytesPerSecond)} B/s`
  return `${(bytesPerSecond / 1000).toFixed(1)} kB/s`
}

/** A correction, in units. Two decimals, because the noise floor is 0.1. */
export function formatUnits(units: number): string {
  return units === 0 ? '0' : units.toFixed(2)
}

/**
 * The panel's contents, as rows.
 *
 * Order is the order you would read them in when something felt wrong: where am
 * I, what is the link doing, how wrong was I, what is it costing, and then the
 * two things that should never have happened.
 */
export function devHudRows(model: DevHudModel): readonly DevHudRow[] {
  const rows: DevHudRow[] = [
    { key: 'tick', label: 'tick / cmd', value: `${model.tick} / ${model.commandTick}` },
    { key: 'rtt', label: 'rtt', value: model.rttMs === null ? '—' : `${Math.round(model.rttMs)} ms` },
    {
      key: 'pending',
      label: 'pending cmds',
      value: String(model.pending),
      // Past a second of unacknowledged input the link has stopped draining,
      // whatever the round trip says.
      ...(model.pending > 125 ? { state: 'warn' as const } : {}),
    },
    {
      key: 'error',
      label: 'predict error',
      value: `${formatUnits(model.errorUnits)} / ${formatUnits(model.worstErrorUnits)} u`,
    },
    {
      key: 'snap-rate',
      label: 'snapshots',
      value: `${formatRate(model.snapshotBytesPerSecond)} · ${model.snapshots}`,
    },
    {
      key: 'pace',
      label: 'fps · p99',
      value: `${Math.round(model.fps)} · ${model.p99Ms.toFixed(1)} / ${model.frameBudgetMs.toFixed(1)} ms`,
      ...(model.p99Ms > model.frameBudgetMs ? { state: 'warn' as const } : {}),
    },
    {
      key: 'clamps',
      label: 'speed clamps',
      value:
        model.speedClamps === 0
          ? '0'
          : `${model.speedClamps} · worst ${Math.round(model.worstClampedSpeed)} qu/s`,
      ...(model.speedClamps > 0 ? { state: 'warn' as const } : {}),
    },
    {
      key: 'mispredicts',
      label: 'splash mispredict',
      value: `${model.selfSplashMispredicts} / ${model.selfSplashes}`,
      ...(model.selfSplashMispredicts > 0 ? { state: 'warn' as const } : {}),
    },
    {
      key: 'snaps',
      label: 'hard snaps',
      value: String(model.snaps),
      ...(model.snaps > 0 ? { state: 'warn' as const } : {}),
    },
  ]

  if (model.recordedFrames !== null) {
    rows.push({
      key: 'demo',
      label: 'recording',
      value: `${model.recordedFrames} sub-steps`,
    })
  }

  return rows
}

export type DevHud = {
  update(model: DevHudModel): void
  setVisible(visible: boolean): void
  readonly visible: boolean
}

/**
 * Mount the panel. Call only when {@link devMode} says to — see the header.
 */
export function createDevHud(root: HTMLElement): DevHud {
  const panel = document.createElement('section')
  panel.className = 'dev-panel'
  panel.dataset['hud'] = 'dev'

  const title = document.createElement('h2')
  title.className = 'dev-title'
  title.textContent = 'netcode'
  panel.append(title)

  const values = new Map<string, HTMLElement>()
  const fieldFor = (key: string, label: string): HTMLElement => {
    const existing = values.get(key)
    if (existing !== undefined) return existing
    const row = document.createElement('div')
    row.className = 'hud-row'
    const name = document.createElement('span')
    name.className = 'hud-label'
    name.textContent = label
    const value = document.createElement('span')
    value.className = 'hud-value'
    value.dataset['dev'] = key
    row.append(name, value)
    panel.append(row)
    values.set(key, value)
    return value
  }

  root.append(panel)
  let visible = true

  return {
    get visible() {
      return visible
    },

    setVisible(next: boolean) {
      if (visible === next) return
      visible = next
      panel.hidden = !next
    },

    update(model: DevHudModel) {
      if (!visible) return
      for (const row of devHudRows(model)) {
        const element = fieldFor(row.key, row.label)
        // Compare before assigning: writing the same string back still dirties
        // the node, and a dirty overlay is a recomposite over the canvas.
        if (element.textContent !== row.value) element.textContent = row.value
        const state = row.state ?? ''
        if (element.dataset['state'] !== state) element.dataset['state'] = state
      }
    },
  }
}
