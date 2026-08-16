/**
 * What the two weapons are made of.
 *
 * A weapon is drawn twice, in two places, at two sizes: in your own hands
 * (`viewmodel.ts`) and in your opponent's (`playerModel.ts`). Before this
 * module those were two literal box lists a few hundred lines apart, and the
 * predictable thing happened — they drifted, and the launcher you were holding
 * was not quite the launcher you were being shot with.
 *
 * So the *shape* lives here as data and the two rigs build it. A part list is a
 * plain array of primitives with no Babylon in it, which is what lets
 * `weaponModel.test.ts` assert the silhouette — the bore is the widest thing on
 * the gun and it is at the front, the body is a tube, the sight is on top of it
 * — without a GPU. The same split as everywhere else in this directory: the
 * half that decides anything is pure, and the half that touches the engine
 * decides nothing.
 *
 * ## The launcher is Quake's launcher
 *
 * GLAD-HSB5TK. The rocket launcher used to be three boxes in your own hands and
 * two in your opponent's, which read as a shoebox on a stick rather than as the
 * weapon this whole game is built around. What replaces it is the silhouette
 * Quake's launchers have shared since 1996, feature by feature:
 *
 * - an **octagonal tube** for a body — eight sides, not a cylinder and not a
 *   box, because eight is what a 1996 model budget bought and it is the reason
 *   the originals read as *machined* rather than as extruded;
 * - a **flared bore** at the muzzle, wider than anything else on the weapon and
 *   right at the front, with a **rocket sitting in it**. That flare plus the
 *   warhead is the single most recognisable thing about the weapon: it is what
 *   tells you, across the arena, that the thing pointed at you is a launcher;
 * - a **sight rail along the top** with a blade at the front and a notch at the
 *   back — Quake 1's raised rib, which is what stops the top edge reading as a
 *   plain pipe;
 * - **side plates** standing proud of the tube, leaving the open-frame
 *   midsection Quake 3's launcher has;
 * - a squared-off **breech** with a tapered cap behind it, so the back end is a
 *   rocket weapon rather than a sawn-off cylinder — a venturi flaring outwards
 *   on the world model, and, for a reason set out beside it, a cap tapering
 *   inwards on the one you hold;
 * - a raked **pistol grip** and trigger underneath, set back, which is what
 *   gives the profile its forward weight.
 *
 * The railgun is unchanged by that ticket and its parts are the same boxes they
 * always were — long, thin, and carrying a scope, so the two outlines still
 * cannot be confused at arena distance. It is here because the builder has to
 * be one code path or this module's whole argument goes away.
 *
 * ## Two sizes, one weapon
 *
 * Each weapon has a `View` list and a `World` list, and they are not the same
 * numbers scaled. Held at arm's length a weapon is read in detail, so the view
 * list can afford a second barrel band and a trigger. Across the arena an
 * opponent is a few dozen pixels and detail is noise, so the world list spends
 * its parts on the outline instead — the same features, fewer and fatter. What
 * both lists must agree about is the *silhouette*, and that is what the tests
 * check.
 *
 * ## The frame
 *
 * Local `-z` is forward (down the barrel), `+y` is up, `+x` is right — the same
 * convention as the player rig and the camera, and the reason `Vec3` triples
 * here can be read straight across from `playerModel.ts`. Sizes are Quake
 * units. A tube's axis lies along `z`, so its `diameter` is measured across the
 * barrel and its `length` down it.
 */
import type { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import type { Mesh } from '@babylonjs/core/Meshes/mesh'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { CreateCylinder } from '@babylonjs/core/Meshes/Builders/cylinderBuilder'
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import type { Scene } from '@babylonjs/core/scene'
import type { Vec3 } from '@gladiator/sim'

/* --------------------------------------------------------------------------
 * The parts
 * ----------------------------------------------------------------------- */

/**
 * Which of the three weapon materials a part is made of.
 *
 * Three and not one, because an all-grey gun is a grey blob: `dark` is what
 * separates the mouth, the bands and the grip from the body they sit on, and
 * `accent` is spent on one part per weapon — the rocket in the launcher's
 * mouth, the coil on the railgun — so that the warmest colour on a weapon is
 * also the end of it that matters.
 */
export type WeaponFinish = 'metal' | 'dark' | 'accent'

/** A part shared by both primitive kinds. */
type PartBase = {
  /** Suffixed on to the rig's name, so a scene inspector reads as a weapon. */
  readonly name: string
  readonly finish: WeaponFinish
  /** Centre of the part, in the weapon's local frame. */
  readonly at: Vec3
  /**
   * Rotation about `x`, radians, applied about the part's own centre.
   *
   * Only the grip uses it, and only to rake its lower end backwards. A part
   * list with arbitrary orientation in it would be a mesh format, and a mesh
   * format belongs in `docs/assets.md`'s pipeline rather than in a literal.
   */
  readonly tilt?: number
}

/** A box. `size` is `(width, height, depth)` — across, up, and down the barrel. */
export type WeaponBox = PartBase & {
  readonly kind: 'box'
  readonly size: Vec3
}

/**
 * A tube: a prism whose axis lies down the barrel.
 *
 * `diameter` is the back of it and `diameterFront` — when it differs — the
 * front, which is how the bore flares out and the venturi flares back. `sides`
 * defaults to {@link TUBE_SIDES}.
 */
export type WeaponTube = PartBase & {
  readonly kind: 'tube'
  readonly diameter: number
  readonly diameterFront?: number
  readonly length: number
  readonly sides?: number
}

export type WeaponPart = WeaponBox | WeaponTube

/**
 * How many sides a tube has, unless it says otherwise.
 *
 * Eight. A smooth cylinder would cost nothing here and would be *wrong*: the
 * flat facets catching the light at different angles is exactly what makes a
 * Quake weapon look machined instead of inflated, and it is what the eye reads
 * as "metal tube" at a distance where a smooth one reads as a sausage.
 */
export const TUBE_SIDES = 8

/**
 * The rotation that lays a tube down the barrel: a quarter turn about `x`.
 *
 * Negative, and that sign is the whole of it. Babylon builds a cylinder up
 * `+y`; turning it `+pi/2` puts `+y` on `+z`, which is the *back* of the
 * weapon, and every tapered part on it then flares the wrong way — a bore that
 * narrows towards the muzzle and a warhead pointing into the breech. Turning it
 * the other way puts `+y` on `-z`, so `diameterFront` means what it says.
 */
export const TUBE_TURN = -Math.PI / 2

/** The widest part of a part, across the barrel. Used by the silhouette tests. */
export function partWidth(part: WeaponPart): number {
  return part.kind === 'box' ? part.size[0] : Math.max(part.diameter, part.diameterFront ?? 0)
}

/** How far down the barrel a part reaches: `[front, back]`, front being lower. */
export function partSpan(part: WeaponPart): readonly [number, number] {
  const half = (part.kind === 'box' ? part.size[2] : part.length) / 2
  return [part.at[2] - half, part.at[2] + half]
}

/* --------------------------------------------------------------------------
 * The rocket launcher
 * ----------------------------------------------------------------------- */

/**
 * The launcher in your own hands.
 *
 * Runs from the tail cap at `z = -1.4` back to front to the nose of the rocket
 * at `z = -32.9`, and its barrel sits 1.3 units below the rig's origin so that
 * what lands in the corner of the eye is the tube rather than the sight on top
 * of it. Where the rig itself rests is `VIEWMODEL_REST`, and the corner of the
 * screen a viewmodel is allowed is not this ticket's to renegotiate.
 *
 * Two things about this list are answers to what a viewmodel actually looks
 * like on screen, rather than to what a rocket launcher looks like on a bench,
 * and both are worth knowing before moving a number in it.
 *
 * **The whole weapon is pushed a few units down the barrel** rather than
 * starting at the rig's origin. A viewmodel is drawn under perspective from a
 * fixed rest point, so its near end is magnified against its far end — and the
 * far end is the muzzle, which is the half a player has to be able to read.
 * Moving the whole thing away from the eye costs a little apparent size and
 * buys back some of that ratio.
 *
 * **The dark parts are placed for contrast, not for realism.** This gun is lit
 * almost entirely by its own emissive (`viewmodel.ts`), which is flat, and a
 * flat-lit object of one colour is a silhouette with nothing inside it. The
 * bands, the side plates and the grip are dark so that the body reads as a tube
 * with things wrapped round it instead of as a pale wedge.
 */
export const ROCKET_LAUNCHER_VIEW: readonly WeaponPart[] = [
  // The body: one long octagonal tube, and the reason the weapon reads as a
  // launcher before any of the detail on it is resolved.
  { kind: 'tube', name: 'body', finish: 'metal', diameter: 6.8, length: 20, at: [0, -1.3, -17.5] },
  // Two bands round the barrel — Quake 3's launcher is ribbed — and they are
  // the darkest thing on the middle of the weapon, so the eye gets a scale to
  // read the tube's length against.
  {
    kind: 'tube',
    name: 'band.rear',
    finish: 'dark',
    diameter: 7.8,
    length: 1.5,
    at: [0, -1.3, -11],
  },
  {
    kind: 'tube',
    name: 'band.front',
    finish: 'dark',
    diameter: 7.8,
    length: 1.5,
    at: [0, -1.3, -23.5],
  },

  // The bore: the widest thing on the weapon, at the very front, flaring
  // forwards. Everything else on this list is detail; this is the silhouette.
  {
    kind: 'tube',
    name: 'bore',
    finish: 'metal',
    diameter: 8,
    diameterFront: 10.8,
    length: 3.6,
    at: [0, -1.3, -29.3],
  },
  // The dark of the tube behind the rocket, so the mouth reads as open. It
  // stands a little *proud* of the bore rather than flush with it: two solid
  // faces in the same plane is a z-fight, and which one wins is up to the
  // driver. Narrower than the bore, so the flare keeps a metal ring round it.
  { kind: 'tube', name: 'mouth', finish: 'dark', diameter: 6.8, length: 2.2, at: [0, -1.3, -30.4] },
  // And the rocket in it, nose out — the one accent-coloured part on the
  // weapon, and the reason the mouth reads as loaded rather than as a hole.
  {
    kind: 'tube',
    name: 'warhead',
    finish: 'accent',
    diameter: 4.6,
    diameterFront: 1.6,
    length: 4.8,
    at: [0, -1.3, -30.5],
  },

  // The sight: a rib down the top, a blade at the front, a notch at the back.
  { kind: 'box', name: 'sight.rail', finish: 'metal', size: [2.2, 1.9, 17], at: [0, 2.8, -16.5] },
  { kind: 'box', name: 'sight.front', finish: 'metal', size: [1.5, 3, 1.8], at: [0, 4.3, -24.5] },
  { kind: 'box', name: 'sight.rear', finish: 'metal', size: [3.4, 2.2, 2], at: [0, 3.8, -11.6] },

  // Side plates standing proud of the tube: Quake 3's open-frame midsection.
  { kind: 'box', name: 'plate.l', finish: 'dark', size: [1.1, 2.4, 13], at: [-3.9, -1.5, -17.5] },
  { kind: 'box', name: 'plate.r', finish: 'dark', size: [1.1, 2.4, 13], at: [3.9, -1.5, -17.5] },

  // The back end: a squared-off breech and a tapered cap behind it.
  //
  // The cap tapers *inwards* where the world model's flares out, and that is
  // the one place the two lists disagree on purpose. A viewmodel's near end is
  // drawn at more than twice the scale of its muzzle, so a rear flare — which
  // is what a venturi is — puts the widest and nearest face on the weapon
  // squarely over the middle of the screen and buries the end that matters.
  { kind: 'box', name: 'breech', finish: 'metal', size: [5.4, 5.4, 4], at: [0, -1.3, -5.6] },
  {
    kind: 'tube',
    name: 'tail',
    finish: 'metal',
    diameter: 4.4,
    diameterFront: 5.4,
    length: 2,
    at: [0, -1.3, -2.4],
  },

  // What it is held by. Raked, because a vertical grip on a gun this long reads
  // as a handle on a suitcase.
  {
    kind: 'box',
    name: 'grip',
    finish: 'dark',
    size: [2.7, 6.2, 3.1],
    at: [0, -6.6, -5.8],
    tilt: -0.22,
  },
  { kind: 'box', name: 'trigger', finish: 'metal', size: [1.4, 1.1, 3.6], at: [0, -5, -9.1] },
]

/**
 * The launcher in your opponent's.
 *
 * Bigger, and thirteen parts instead of fifteen. It is the same weapon with the
 * same features in the same order; what it does not carry is what would be
 * sub-pixel across an arena — the trigger, and the second barrel band. Its tail
 * *is* a venturi, flaring out behind the breech, for the reason set out on the
 * viewmodel's tail cap above.
 *
 * The back of it stops at `z = +3.4` on purpose: the hand it hangs off recoils
 * seven units *down the barrel* on a shot (`RECOIL`, `playerModel.ts`), and the
 * chest is about that far behind the hand.
 */
export const ROCKET_LAUNCHER_WORLD: readonly WeaponPart[] = [
  { kind: 'tube', name: 'body', finish: 'metal', diameter: 9, length: 22, at: [0, 0, -13.5] },
  { kind: 'tube', name: 'band', finish: 'dark', diameter: 10.4, length: 2, at: [0, 0, -21] },

  {
    kind: 'tube',
    name: 'bore',
    finish: 'metal',
    diameter: 11,
    diameterFront: 13.8,
    length: 4.4,
    at: [0, 0, -26.7],
  },
  { kind: 'tube', name: 'mouth', finish: 'dark', diameter: 9, length: 2.6, at: [0, 0, -28.1] },
  {
    kind: 'tube',
    name: 'warhead',
    finish: 'accent',
    diameter: 5.6,
    diameterFront: 1.8,
    length: 5.2,
    at: [0, 0, -28.2],
  },

  { kind: 'box', name: 'sight.rail', finish: 'metal', size: [2.6, 2, 19], at: [0, 5.1, -12.5] },
  { kind: 'box', name: 'sight.front', finish: 'metal', size: [1.8, 3.4, 2.2], at: [0, 6.9, -21] },
  { kind: 'box', name: 'sight.rear', finish: 'metal', size: [3.4, 2.4, 2.2], at: [0, 6.6, -6] },

  { kind: 'box', name: 'plate.l', finish: 'dark', size: [1.6, 4.6, 13], at: [-5.4, -0.6, -13] },
  { kind: 'box', name: 'plate.r', finish: 'dark', size: [1.6, 4.6, 13], at: [5.4, -0.6, -13] },

  { kind: 'box', name: 'breech', finish: 'metal', size: [8.4, 8.4, 6.4], at: [0, 0, -0.6] },
  {
    kind: 'tube',
    name: 'venturi',
    finish: 'dark',
    diameter: 8.8,
    diameterFront: 6.4,
    length: 3,
    at: [0, 0, 1.9],
  },

  {
    kind: 'box',
    name: 'grip',
    finish: 'dark',
    size: [3.4, 8.2, 4.2],
    at: [0, -7, -2.2],
    tilt: -0.22,
  },
]

/* --------------------------------------------------------------------------
 * The railgun
 * ----------------------------------------------------------------------- */

/**
 * The railgun, unchanged: long, thin, and with something on top of it.
 *
 * These are the boxes it has always been, moved here so that the builder below
 * is one code path rather than two. GLAD-HSB5TK redesigned the launcher and
 * deliberately left this alone — what the two outlines have to do is stay
 * impossible to confuse, and a slim rod beside a fat tube does that.
 */
export const RAILGUN_VIEW: readonly WeaponPart[] = [
  { kind: 'box', name: 'body', finish: 'metal', size: [3, 3, 26], at: [0, 0, -11] },
  { kind: 'box', name: 'coil', finish: 'accent', size: [4.4, 4.4, 4], at: [0, 0, -18] },
  { kind: 'box', name: 'grip', finish: 'metal', size: [2.4, 5, 3], at: [0, -3.4, 1] },
]

export const RAILGUN_WORLD: readonly WeaponPart[] = [
  { kind: 'box', name: 'body', finish: 'metal', size: [4.5, 4.5, 34], at: [0, 0, -14] },
  { kind: 'box', name: 'scope', finish: 'metal', size: [3, 7, 12], at: [0, 5, -6] },
]

/* --------------------------------------------------------------------------
 * Building one
 * ----------------------------------------------------------------------- */

/** The three materials a part list is drawn with, by finish. */
export type WeaponFinishes = Readonly<Record<WeaponFinish, StandardMaterial>>

export type WeaponBuildOptions = {
  /** Prefixed on to each part's name: `player7:rocket.bore`. */
  readonly namePrefix: string
  /** Handed every mesh as it is made, for whatever the caller's rig needs. */
  readonly onMesh?: (mesh: Mesh) => void
}

/**
 * Hang a part list off `parent`.
 *
 * Allocates freely — a weapon is built when a rig is, never in a frame — and
 * decides nothing: every number it writes came out of the list it was handed.
 */
export function buildWeapon(
  scene: Scene,
  parts: readonly WeaponPart[],
  parent: TransformNode,
  finishes: WeaponFinishes,
  options: WeaponBuildOptions,
): void {
  for (const part of parts) {
    const name = `${options.namePrefix}.${part.name}`
    const mesh =
      part.kind === 'box'
        ? CreateBox(
            name,
            { width: part.size[0], height: part.size[1], depth: part.size[2] },
            scene,
          )
        : CreateCylinder(
            name,
            {
              // Babylon builds a cylinder up its `y` axis with `diameterTop` at
              // the `+y` end. {@link TUBE_TURN} is the quarter turn that lays it
              // down the barrel, and it turns the *negative* way precisely so
              // that `+y` lands on `-z`: the front, and therefore the top.
              height: part.length,
              diameterTop: part.diameterFront ?? part.diameter,
              diameterBottom: part.diameter,
              tessellation: part.sides ?? TUBE_SIDES,
            },
            scene,
          )

    mesh.position.set(part.at[0], part.at[1], part.at[2])
    mesh.rotation.set((part.kind === 'tube' ? TUBE_TURN : 0) + (part.tilt ?? 0), 0, 0)
    mesh.parent = parent
    mesh.material = finishes[part.finish]
    // Nothing in this scene is picked — aim is a trace against the simulation's
    // brushes and boxes, never against a mesh.
    mesh.isPickable = false
    options.onMesh?.(mesh)
  }
}

/* --------------------------------------------------------------------------
 * The finishes
 * ----------------------------------------------------------------------- */

/**
 * The three colours, before either rig decides how brightly to light them.
 *
 * Grey-blue steel, a near-black for the recesses, and one warm orange for the
 * warhead. The accent is deliberately *not* the player tint: a weapon that
 * changed colour with whoever was holding it would be one more thing to read
 * off a silhouette that already has to say which weapon and which way it is
 * pointing.
 *
 * One set of colours, so an opponent's weapon is the same steel as your own —
 * the player rig used to mix its own, very slightly darker grey, which is the
 * kind of difference nobody notices and nobody meant.
 */
export const WEAPON_COLOURS: Readonly<Record<WeaponFinish, Vec3>> = {
  metal: [0.5, 0.52, 0.58],
  dark: [0.16, 0.17, 0.2],
  accent: [0.85, 0.42, 0.14],
}

/**
 * Build the three materials, given a rig's own idea of how to make one.
 *
 * The two rigs light their weapons differently — the viewmodel is lit almost
 * entirely by itself, an opponent only enough to stay legible in a dark corner
 * — so what varies is handed in rather than decided here.
 */
export function weaponFinishes(
  make: (name: string, colour: Vec3, finish: WeaponFinish) => StandardMaterial,
  namePrefix: string,
): WeaponFinishes {
  return {
    metal: make(`${namePrefix}:metal`, WEAPON_COLOURS.metal, 'metal'),
    dark: make(`${namePrefix}:dark`, WEAPON_COLOURS.dark, 'dark'),
    accent: make(`${namePrefix}:accent`, WEAPON_COLOURS.accent, 'accent'),
  }
}

/** Every material in a {@link WeaponFinishes}, for a rig's `dispose`. */
export function finishMaterials(finishes: WeaponFinishes): readonly StandardMaterial[] {
  return [finishes.metal, finishes.dark, finishes.accent]
}
