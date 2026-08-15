/**
 * The in-match HUD: the pixels.
 *
 * Every decision about *what* to show is upstream of this file — `hudModel.ts`
 * projects the world, `crosshair.ts` decides the shapes and `feedback.ts`
 * decides what a hit looks like. This is the part that cannot be tested without
 * a browser, so it is kept to exactly that: build a tree once, and each frame
 * write the handful of values that changed. `scripts/e2e.mjs` is what checks it,
 * in a real browser, at three aspect ratios.
 *
 * ## Updated every frame, and that is affordable because of `set*`
 *
 * The diagnostics readout in `../hud.ts` runs at 10 Hz, and the reason is
 * measured: writing its dozen `textContent`s every frame dirties the overlay,
 * and a dirty overlay makes the browser recomposite the whole page on top of
 * the canvas — 16.7 ms became a 50 ms 99th percentile. That constant was left
 * with a note saying the real HUD inherits the constraint. It does, but not the
 * throttle, because the two panels are not the same kind of readout: almost
 * everything on the *diagnostics* panel changes every frame (frame rate, tick,
 * hash), while almost nothing on this one does. Health changes a handful of
 * times a round.
 *
 * So every write below goes through a guard that compares first, and the
 * continuously-varying parts — the cooldown ring, the hurt flash — are
 * quantised so they too settle into "no change" between steps. A frame in which
 * nothing happened writes nothing at all, which is what lets this run at frame
 * rate and still answer "does the HUD reflect the state within one frame" with
 * yes.
 *
 * ## `data-hud` is the test surface
 *
 * Every element carries one, and `data-hud-box` marks the ones that must never
 * overlap. The browser test reads those rather than scraping text or pixels, so
 * restyling the HUD does not break it.
 */
import { Weapon } from '@gladiator/sim'

import {
  COOLDOWN_RING_RADIUS,
  CROSSHAIR_CENTRE,
  CROSSHAIR_SIZE,
  type CrosshairSpec,
  HIT_MARKER_LINES,
  RING_CIRCUMFERENCE,
  crosshairFor,
  ringDashOffset,
} from './crosshair.ts'
import { type FeedbackState, NO_FEEDBACK } from './feedback.ts'
import {
  type HudModel,
  formatClock,
  healthTier,
  matchAnnouncement,
  matchHeadline,
  opponentSlot,
  scoreFor,
} from './hudModel.ts'

const SVG_NS = 'http://www.w3.org/2000/svg'

/**
 * Steps a continuous value is rounded to before it is written.
 *
 * 64 over the whole range is finer than a 1080p screen can show on a 40-pixel
 * ring and coarser than a frame, so the ring is smooth to the eye and still
 * skips most frames' writes. See the header.
 */
const STEPS = 64

function quantise(value: number): number {
  return Math.round(value * STEPS) / STEPS
}

/* --------------------------------------------------------------------------
 * Guarded writes
 *
 * Assign only when the value changed. Writing the same string back into
 * `textContent` still dirties the node, and a dirty node in the overlay costs a
 * recomposite of the whole page over the canvas.
 * ----------------------------------------------------------------------- */

function setText(element: Element, value: string): void {
  if (element.textContent !== value) element.textContent = value
}

function setData(element: HTMLElement | SVGElement, key: string, value: string): void {
  if (element.dataset[key] !== value) element.dataset[key] = value
}

function setStyle(element: HTMLElement | SVGElement, property: string, value: string): void {
  if (element.style.getPropertyValue(property) !== value) {
    element.style.setProperty(property, value)
  }
}

/** Shown or gone. `display: none`, so a hidden element has no box to overlap with. */
function setVisible(element: HTMLElement | SVGElement, visible: boolean): void {
  setData(element, 'visible', visible ? 'yes' : 'no')
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  hud?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (hud !== undefined) node.dataset['hud'] = hud
  return node
}

function svg<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] {
  return document.createElementNS(SVG_NS, tag)
}

/* --------------------------------------------------------------------------
 * The pieces
 * ----------------------------------------------------------------------- */

/** A value, its label, and a bar underneath it. Health and armour are both one. */
function vital(parent: HTMLElement, key: string, label: string) {
  const row = element('div', 'hud-vital')
  const value = element('span', 'hud-vital-value', key)
  const tag = element('span', 'hud-vital-tag')
  tag.textContent = label
  const track = element('div', 'hud-bar')
  const fill = element('i', 'hud-bar-fill', `${key}-bar`)
  track.append(fill)
  row.append(value, tag, track)
  parent.append(row)
  return { value, fill }
}

export type MatchHud = {
  /** Draw one frame. Cheap when nothing changed; see the header. */
  update(model: HudModel, feedback?: FeedbackState): void
  /** Take it off the screen entirely — a menu, the reference screenshot. */
  setVisible(visible: boolean): void
  /**
   * How many times {@link MatchHud.update} has been called.
   *
   * Exposed for the browser test, and it is the one measurement that can tell
   * "the HUD reflects the state within one frame" from "the HUD is on a
   * timer": beside the renderer's own frame count, the two numbers only track
   * each other if this is driven from the frame loop.
   */
  readonly frames: number
}

/**
 * Build the HUD into `root` and return the handle that drives it.
 *
 * Mounted alongside the diagnostics panel rather than replacing it: that panel
 * is the netcode's instrument and the browser test's, and turning it into a
 * setting belongs to the menus (GLAD-NPCTU8). They are laid out so as not to
 * collide, which the aspect-ratio check in `scripts/e2e.mjs` enforces.
 */
export function createMatchHud(root: HTMLElement): MatchHud {
  const hud = element('div', 'hud-match')
  hud.dataset['hud'] = 'match'

  /* --- top centre: the score ---------------------------------------------- */
  const scorebar = element('div', 'hud-scorebar', 'scorebar')
  scorebar.dataset['hudBox'] = ''
  const score = element('div', 'hud-score')
  const scoreYou = element('span', 'hud-score-you', 'score-you')
  const scoreDash = element('span', 'hud-score-dash')
  scoreDash.textContent = '–'
  const scoreThem = element('span', 'hud-score-them', 'score-them')
  score.append(scoreYou, scoreDash, scoreThem)
  const headline = element('div', 'hud-headline', 'headline')
  const target = element('div', 'hud-target', 'target')
  const clock = element('div', 'hud-clock', 'clock')
  scorebar.append(score, headline, target, clock)

  /* --- the middle: crosshair, then the announcement above it -------------- */
  const announce = element('div', 'hud-announce', 'announce')
  announce.dataset['hudBox'] = ''

  const crosshair = svg('svg')
  crosshair.setAttribute('class', 'hud-crosshair')
  crosshair.setAttribute('viewBox', `0 0 ${CROSSHAIR_SIZE} ${CROSSHAIR_SIZE}`)
  crosshair.setAttribute('width', String(CROSSHAIR_SIZE))
  crosshair.setAttribute('height', String(CROSSHAIR_SIZE))
  crosshair.dataset['hud'] = 'crosshair'
  crosshair.dataset['hudBox'] = ''

  const marks = svg('g')
  marks.setAttribute('class', 'hud-crosshair-marks')
  marks.dataset['hud'] = 'crosshair-marks'

  // The cooldown arc, starting at twelve o'clock. Drawn as one dashed circle
  // whose dash is the whole circumference, so the only thing that moves is the
  // offset — one attribute, once a frame, at most.
  const ring = svg('circle')
  ring.setAttribute('class', 'hud-crosshair-ring')
  ring.setAttribute('cx', String(CROSSHAIR_CENTRE))
  ring.setAttribute('cy', String(CROSSHAIR_CENTRE))
  ring.setAttribute('r', String(COOLDOWN_RING_RADIUS))
  ring.setAttribute('stroke-dasharray', String(RING_CIRCUMFERENCE))
  ring.setAttribute('transform', `rotate(-90 ${CROSSHAIR_CENTRE} ${CROSSHAIR_CENTRE})`)
  ring.dataset['hud'] = 'cooldown-ring'

  const hitMarker = svg('g')
  hitMarker.setAttribute('class', 'hud-crosshair-hit')
  hitMarker.dataset['hud'] = 'hitmarker'
  for (const [x1, y1, x2, y2] of HIT_MARKER_LINES) {
    const line = svg('line')
    line.setAttribute('x1', String(x1))
    line.setAttribute('y1', String(y1))
    line.setAttribute('x2', String(x2))
    line.setAttribute('y2', String(y2))
    hitMarker.append(line)
  }

  crosshair.append(marks, ring, hitMarker)

  /* --- bottom left: health and armour ------------------------------------- */
  const vitals = element('div', 'hud-vitals', 'vitals')
  vitals.dataset['hudBox'] = ''
  const health = vital(vitals, 'health', 'health')
  const armor = vital(vitals, 'armor', 'armour')

  /* --- bottom right: the weapon and its wait ------------------------------ */
  const weaponPanel = element('div', 'hud-weapon', 'weapon-panel')
  weaponPanel.dataset['hudBox'] = ''
  const weaponName = element('div', 'hud-weapon-name', 'weapon')
  const weaponTrack = element('div', 'hud-bar hud-bar-wide')
  const weaponFill = element('i', 'hud-bar-fill', 'cooldown-bar')
  weaponTrack.append(weaponFill)
  const cooldownText = element('div', 'hud-weapon-cooldown', 'cooldown')
  weaponPanel.append(weaponName, weaponTrack, cooldownText)

  /* --- everywhere: the hurt flash and where it came from ------------------ */
  // Deliberately not `data-hud-box`: both cover the whole viewport by design,
  // so they overlap everything and are not part of the no-overlap rule.
  const hurt = element('div', 'hud-hurt', 'hurt')
  const damage = element('div', 'hud-damage', 'damage')
  const dial = element('div', 'hud-damage-dial', 'damage-dial')
  const arc = element('div', 'hud-damage-arc')
  dial.append(arc)
  damage.append(dial)

  hud.append(hurt, damage, scorebar, announce, crosshair, vitals, weaponPanel)
  root.append(hud)

  // What the tree currently shows, so a frame that changes nothing writes
  // nothing. Only the values that cannot be read back off the DOM cheaply.
  let drawnCrosshair: CrosshairSpec | null = null
  let drawnRing = -1
  let drawnHit = -1
  let drawnHurt = -1
  let drawnAngle = Number.NaN
  let frames = 0

  const drawCrosshair = (spec: CrosshairSpec) => {
    if (spec === drawnCrosshair) return
    drawnCrosshair = spec
    marks.replaceChildren()
    for (const [x1, y1, x2, y2] of spec.lines) {
      const line = svg('line')
      line.setAttribute('x1', String(x1))
      line.setAttribute('y1', String(y1))
      line.setAttribute('x2', String(x2))
      line.setAttribute('y2', String(y2))
      line.setAttribute('stroke-width', String(spec.strokeWidth))
      marks.append(line)
    }
    if (spec.dotRadius > 0) {
      const dot = svg('circle')
      dot.setAttribute('cx', String(CROSSHAIR_CENTRE))
      dot.setAttribute('cy', String(CROSSHAIR_CENTRE))
      dot.setAttribute('r', String(spec.dotRadius))
      dot.setAttribute('class', 'hud-crosshair-dot')
      marks.append(dot)
    }
    crosshair.dataset['crosshair'] = spec.key
  }

  return {
    update(model, feedback = NO_FEEDBACK) {
      frames += 1
      const { self, match } = model
      const them = opponentSlot(model.slot)

      // --- the score ------------------------------------------------------
      setText(scoreYou, String(scoreFor(match, model.slot)))
      setText(scoreThem, String(scoreFor(match, them)))
      setText(headline, matchHeadline(model))
      setText(target, `first to ${match.roundsToWin}`)
      setText(clock, formatClock(match.remainingMs))
      setVisible(clock, match.remainingMs !== null)

      // The text is written whether or not the banner is up, so the element
      // always has a real box: the aspect-ratio check in `scripts/e2e.mjs`
      // reveals every box to measure it, and an empty one would measure
      // nothing and prove nothing.
      const banner = matchAnnouncement(model)
      setText(announce, banner ?? matchHeadline(model))
      setVisible(announce, banner !== null)

      // --- health and armour ----------------------------------------------
      const tier = healthTier(self)
      setData(vitals, 'state', tier)
      setText(health.value, String(Math.max(0, Math.round(self.health))))
      setText(armor.value, String(Math.max(0, Math.round(self.armor))))
      setStyle(health.fill, 'transform', `scaleX(${quantise(self.healthFraction)})`)
      setStyle(armor.fill, 'transform', `scaleX(${quantise(self.armorFraction)})`)

      // --- the weapon and its wait ----------------------------------------
      setText(weaponName, self.weaponName)
      const ready = self.cooldownMs <= 0
      setData(weaponPanel, 'state', ready ? 'ready' : 'charging')
      setText(cooldownText, ready ? 'ready' : `${(self.cooldownMs / 1000).toFixed(1)}s`)
      // The bar fills back up as the wait runs down, which is the direction a
      // player reads as "becoming available".
      setStyle(weaponFill, 'transform', `scaleX(${quantise(1 - self.cooldownFraction)})`)

      // --- the crosshair ---------------------------------------------------
      drawCrosshair(crosshairFor(self.alive ? self.weapon : Weapon.None))
      setVisible(crosshair, self.present)
      setData(crosshair, 'state', ready ? 'ready' : 'charging')

      const ringFraction = quantise(self.cooldownFraction)
      if (ringFraction !== drawnRing) {
        drawnRing = ringFraction
        ring.setAttribute('stroke-dashoffset', ringDashOffset(ringFraction).toFixed(2))
        setStyle(ring, 'opacity', ringFraction > 0 ? '1' : '0')
      }

      // --- hit confirmation -------------------------------------------------
      // The one thing on this HUD that has to be on screen the instant the
      // state says so: written from the same frame's fold, with nothing
      // between the two.
      const hit = quantise(feedback.hit)
      if (hit !== drawnHit) {
        drawnHit = hit
        setStyle(hitMarker, 'opacity', String(hit))
      }

      // --- damage taken -----------------------------------------------------
      const taken = quantise(feedback.damage)
      if (taken !== drawnHurt) {
        drawnHurt = taken
        setStyle(hurt, 'opacity', String(taken))
        setStyle(damage, 'opacity', String(taken))
      }
      const angle =
        feedback.damageAngle === null
          ? Number.NaN
          : Math.round((feedback.damageAngle * 180) / Math.PI)
      if (!Object.is(angle, drawnAngle)) {
        drawnAngle = angle
        setVisible(damage, !Number.isNaN(angle))
        if (!Number.isNaN(angle)) {
          setStyle(dial, 'transform', `translate(-50%, -50%) rotate(${angle}deg)`)
        }
      }
    },

    setVisible(visible) {
      setVisible(hud, visible)
    },

    get frames() {
      return frames
    },
  }
}
