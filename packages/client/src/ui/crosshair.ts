/**
 * The crosshair: two weapons, two shapes, and the refire timer drawn around
 * them.
 *
 * Pure geometry in a fixed 64x64 box, so the shapes are asserted in a test
 * rather than eyeballed in a screenshot. The view (`hud.ts`) turns a spec into
 * SVG elements and never invents a line of its own.
 *
 * ## Why the two weapons look different
 *
 * They are aimed at different things. The rocket launcher is mostly *not*
 * pointed at a player — you shoot the floor under them, the wall beside them,
 * the ledge they are about to land on — so it gets a centre dot, which is the
 * only mark precise enough to place a splash, inside arms wide enough to leave
 * the target visible. The railgun is pointed at exactly one pixel of a player,
 * so it gets a tight, thin cross with no dot in the middle of it: at arena
 * distance an opponent is a few dozen pixels and a dot would cover the part of
 * them you are trying to hit.
 *
 * A player who cannot tell at a glance which weapon is up has to look at the
 * corner of the screen to find out, which is exactly the look away this whole
 * ticket exists to remove.
 *
 * ## The ring is the rail's ammunition
 *
 * There is no ammunition in this game (`sim/weapons.ts`), so the only resource
 * either weapon has is time: 800 ms for the launcher, 1500 ms for the rail. A
 * rail shot missed is a second and a half of being unarmed, and that is a
 * tactical fact the player is managing whether or not the HUD tells them. So
 * the wait is drawn as an arc *around the crosshair* — where the eye already
 * is — and not only as a bar in the corner.
 */
import { Weapon } from '@gladiator/sim'

/** The side of the box every coordinate below is in. */
export const CROSSHAIR_SIZE = 64

/** The middle of it. Where the shot goes. */
export const CROSSHAIR_CENTRE = CROSSHAIR_SIZE / 2

/**
 * Radius of the cooldown arc, in box units.
 *
 * Outside the longest arm of either crosshair (13) with room to spare, so the
 * ring never touches the marks a player is aiming with — it is read in
 * peripheral vision, as a shape that is either closed or not.
 */
export const COOLDOWN_RING_RADIUS = 19

/** `[x1, y1, x2, y2]` in box units. */
export type CrosshairLine = readonly [number, number, number, number]

export type CrosshairSpec = {
  readonly weapon: Weapon
  /** For the `data-crosshair` attribute, so a test can name what it is seeing. */
  readonly key: string
  readonly lines: readonly CrosshairLine[]
  readonly strokeWidth: number
  /** Zero for a crosshair with no centre dot. */
  readonly dotRadius: number
}

/**
 * Four arms, each `gap` from the centre and `length` long.
 *
 * Written as a generator rather than sixteen literals because the symmetry is
 * the specification: a crosshair whose left arm is a unit longer than its right
 * is a crosshair that quietly pulls your aim.
 */
function cross(gap: number, length: number): CrosshairLine[] {
  const c = CROSSHAIR_CENTRE
  const far = gap + length
  return [
    [c - far, c, c - gap, c],
    [c + gap, c, c + far, c],
    [c, c - far, c, c - gap],
    [c, c + gap, c, c + far],
  ]
}

/** Wide arms, a placing dot, heavy stroke. See the header. */
const ROCKET_CROSSHAIR: CrosshairSpec = {
  weapon: Weapon.RocketLauncher,
  key: 'rocket',
  lines: cross(5, 7),
  strokeWidth: 1.8,
  dotRadius: 1.3,
}

/** Tight arms, no dot, thin stroke. */
const RAIL_CROSSHAIR: CrosshairSpec = {
  weapon: Weapon.Railgun,
  key: 'rail',
  lines: cross(3, 10),
  strokeWidth: 1.1,
  dotRadius: 0,
}

/** Holding nothing — a corpse, a spectator. A dot, so the centre is still marked. */
const EMPTY_CROSSHAIR: CrosshairSpec = {
  weapon: Weapon.None,
  key: 'none',
  lines: [],
  strokeWidth: 1,
  dotRadius: 1.1,
}

/**
 * The crosshair for a weapon.
 *
 * Returns the same object for the same weapon, so the view can compare by
 * identity and rebuild the SVG only when the weapon in hand actually changed.
 */
export function crosshairFor(weapon: Weapon): CrosshairSpec {
  if (weapon === Weapon.RocketLauncher) return ROCKET_CROSSHAIR
  if (weapon === Weapon.Railgun) return RAIL_CROSSHAIR
  return EMPTY_CROSSHAIR
}

/* --------------------------------------------------------------------------
 * The hit marker
 * ----------------------------------------------------------------------- */

/**
 * Four diagonal ticks in the quadrants between the arms.
 *
 * Deliberately in the gaps rather than on top of the cross: it has to be
 * unmistakable at a glance without ever obscuring the mark you are aiming with,
 * and a shape that appears where nothing was is read faster than one that
 * changes colour. Quake's hit marker, and every arena shooter's since.
 */
export const HIT_MARKER_LINES: readonly CrosshairLine[] = (() => {
  const c = CROSSHAIR_CENTRE
  const near = 5
  const far = 10
  const lines: CrosshairLine[] = []
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      lines.push([c + sx * near, c + sy * near, c + sx * far, c + sy * far])
    }
  }
  return lines
})()

/* --------------------------------------------------------------------------
 * The cooldown arc
 * ----------------------------------------------------------------------- */

/** How far round the ring goes. Set once on the element as its dash array. */
export const RING_CIRCUMFERENCE = 2 * Math.PI * COOLDOWN_RING_RADIUS

/**
 * Where to start the dash so that `fraction` of the ring is drawn.
 *
 * `fraction` is how much of the refire interval is *left*, so a full ring is a
 * weapon that has just fired and an empty one is a weapon that is ready. That
 * way round because the thing being drawn is the wait, and a wait that shrinks
 * to nothing is the shape "you can shoot now" — the opposite convention would
 * draw a full ring at the moment there is nothing to say.
 */
export function ringDashOffset(fraction: number): number {
  const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
  return RING_CIRCUMFERENCE * (1 - clamped)
}
