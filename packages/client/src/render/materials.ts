/**
 * What the arena is made of.
 *
 * A map names a *logical* material on every surface — `concrete`, `metal`,
 * `trim` — because `map/schema.ts` deliberately refuses to know what a file
 * path or a shading model is. This file is the other half of that bargain: the
 * one place a logical name is turned into a look, so re-tuning the arena is a
 * renderer change rather than a map change and a map that names something this
 * build has never heard of is still playable.
 *
 * ## A lightmapped world is a world of albedo
 *
 * Everything here assumes the arena's light is **baked**
 * (`tools/bake-lightmap.ts`, `docs/renderer.md` §12). That is not a detail, it
 * decides what a material can be: with no real-time light falling on the world,
 * there is nothing for a specular highlight to answer to, so gloss and
 * shininess are not knobs any more. What is left is exactly Quake's model —
 *
 *     colour = albedo x detail texture x lightmap
 *
 * — and the four knobs below are what make one surface different from another
 * inside it: which detail tiles across it, how much of the map's tint reaches
 * it, whether it is see-through, and whether it makes its own light.
 *
 * The albedo is carried in `emissiveColor` rather than in `ambientColor`, which
 * looks like a mistake and is not. Babylon computes
 * `finalDiffuse = clamp(diffuseBase * diffuseColor + emissiveColor +
 * vAmbientColor) * baseColor`, and `vAmbientColor` is
 * `scene.ambientColor * material.ambientColor` — a *scene*-wide multiplier the
 * player models and the viewmodel are also tuned against. Putting the arena's
 * albedo through it would mean a change to how a player model reads in shadow
 * silently re-graded every wall in the level. `emissiveColor` is per-material
 * and reaches the same sum, so the two are decoupled. It is not emission in any
 * physical sense; with `disableLighting` on, it is simply the term that
 * survives.
 */
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine'
import type { BaseTexture } from '@babylonjs/core/Materials/Textures/baseTexture'
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import type { Scene } from '@babylonjs/core/scene'
import type { MapSurface } from '@gladiator/sim'

import { applyAnisotropy } from './scene.ts'

/**
 * The detail textures the catalogue draws from.
 *
 * Three, not one per material: a detail map is what gives a player something to
 * judge speed and distance against, and two surfaces sharing one is a saving
 * with no cost. `none` is a real answer — glass and a light panel are read by
 * their shape, and tiling grime across either makes them look like painted
 * concrete.
 */
export const DETAIL_KINDS = ['grid', 'panel', 'stripe', 'none'] as const
export type DetailKind = (typeof DETAIL_KINDS)[number]

/** How one logical material is drawn. See the header for what is *not* here. */
export type SurfaceLook = {
  readonly detail: DetailKind
  /**
   * How much of the map's authored tint reaches the albedo.
   *
   * A surface's colour is the map's business — a level designer picks it to
   * separate a floor from a wall. How *bright* that colour is allowed to be is
   * the renderer's, because it trades directly against the bake's exposure: the
   * final pixel is `tint x gain x detail x lightmap`, and the maps were tinted
   * against an older model where a scene-wide ambient did half the work. Above
   * 1 is therefore the normal case rather than the exception, and it clamps in
   * the shader — which is exactly what a white-painted trim wants.
   */
  readonly tintGain: number
  readonly alpha: number
  /**
   * A surface that makes its own light and therefore takes no lightmap.
   *
   * Nothing lights a light. A bake multiplies what it is attached to, so a
   * lamp panel in an otherwise dark corner would be baked *dark*, which is the
   * opposite of the one thing a lamp has to do.
   */
  readonly selfLit: boolean
  /**
   * What a self-lit surface's tint is multiplied by instead of
   * {@link SurfaceLook.tintGain}.
   *
   * Just over 1, so a fixture's brightest channel *saturates* — the shader
   * clamps the sum at 1 — while its dimmest one does not. That is what makes a
   * lamp read as a hot white panel with a warm edge rather than as a flat white
   * rectangle, and it is the only place in the catalogue where clipping is the
   * intended result.
   */
  readonly glow: number
}

/**
 * What an unrecognised material gets.
 *
 * Opaque, matte, gridded — deliberately playable rather than obviously wrong. A
 * map naming a material this build has never heard of is a version skew, and a
 * level that draws is a better outcome than a level that throws.
 */
export const DEFAULT_LOOK: SurfaceLook = {
  detail: 'grid',
  tintGain: 1.6,
  alpha: 1,
  selfLit: false,
  glow: 0,
}

/**
 * The catalogue. Five materials, which is the "N" this ticket's budget bought.
 *
 * | Name | What it is for |
 * | ---- | -------------- |
 * | `concrete` | the shell: floors, walls, ceilings — most of the level |
 * | `metal` | ramps, ledges and the structure a player stands on |
 * | `trim` | the accent bands that tell you where a room ends |
 * | `glass` | a pane you can see through and — where it is `nonSolid` — walk through |
 * | `light` | a fixture, self-lit, the one thing the bake does not touch |
 */
export const SURFACE_LOOKS: Readonly<Record<string, SurfaceLook>> = {
  concrete: DEFAULT_LOOK,
  metal: { detail: 'panel', tintGain: 1.75, alpha: 1, selfLit: false, glow: 0 },
  trim: { detail: 'stripe', tintGain: 2, alpha: 1, selfLit: false, glow: 0 },
  glass: { detail: 'none', tintGain: 1.4, alpha: 0.3, selfLit: false, glow: 0 },
  light: { detail: 'none', tintGain: 1, alpha: 1, selfLit: true, glow: 1.15 },
}

/** The look for a logical material name. Unknown names fall back rather than fail. */
export function lookFor(material: string): SurfaceLook {
  return SURFACE_LOOKS[material] ?? DEFAULT_LOOK
}

/* --------------------------------------------------------------------------
 * The detail textures
 *
 * Drawn into a canvas at load rather than shipped as files. They are grey
 * patterns a few kilobytes of code produces, and a `.ktx2` of each would be
 * three more things in `credits.json` and three more fetches before the first
 * frame for a picture nobody would tell apart. Real art replaces them by
 * changing this function and nothing else — `docs/assets.md` §8.
 * ----------------------------------------------------------------------- */

/** Edge of every generated detail texture, in texels. */
const DETAIL_SIZE = 256

/** How the canvas is reached. Babylon types this as its own 2D context shim. */
type Canvas2D = CanvasRenderingContext2D

function beginDetail(scene: Scene, name: string): { texture: DynamicTexture; context: Canvas2D } {
  const texture = new DynamicTexture(
    `detail:${name}`,
    { width: DETAIL_SIZE, height: DETAIL_SIZE },
    scene,
    true,
  )
  return { texture, context: texture.getContext() as unknown as Canvas2D }
}

function finishDetail(texture: DynamicTexture, engine: AbstractEngine): DynamicTexture {
  texture.update(false)
  texture.wrapU = Texture.WRAP_ADDRESSMODE
  texture.wrapV = Texture.WRAP_ADDRESSMODE
  applyAnisotropy(texture, engine)
  return texture
}

/**
 * A grid, one cell per 64 Quake units.
 *
 * The most load-bearing texture in the game and the least decorative one: a
 * player judging a strafe jump is judging it against something, and 64 units is
 * the width of a step. Two weights of line — the cell edge, and a quarter-cell
 * hairline that stops a wall from reading as a flat colour when one cell fills
 * the screen.
 */
function drawGrid(context: Canvas2D): void {
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, DETAIL_SIZE, DETAIL_SIZE)

  context.strokeStyle = 'rgba(0, 0, 0, 0.10)'
  context.lineWidth = 1
  for (let i = 1; i < 4; i += 1) {
    const at = (i * DETAIL_SIZE) / 4
    context.beginPath()
    context.moveTo(at, 0)
    context.lineTo(at, DETAIL_SIZE)
    context.moveTo(0, at)
    context.lineTo(DETAIL_SIZE, at)
    context.stroke()
  }

  context.strokeStyle = 'rgba(0, 0, 0, 0.38)'
  context.lineWidth = 3
  context.strokeRect(1.5, 1.5, DETAIL_SIZE - 3, DETAIL_SIZE - 3)
}

/**
 * Riveted plate: four plates to a repeat, with a bolt at each corner.
 *
 * Coarser than the grid on purpose. Metal is what a player lands on and runs
 * up, and a busy texture on a ramp reads as a rough surface — which is a lie
 * about a surface `pmove` treats as frictionless as any other.
 */
function drawPanel(context: Canvas2D): void {
  context.fillStyle = '#f2f2f2'
  context.fillRect(0, 0, DETAIL_SIZE, DETAIL_SIZE)

  const plate = DETAIL_SIZE / 2
  context.strokeStyle = 'rgba(0, 0, 0, 0.30)'
  context.lineWidth = 2
  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      context.strokeRect(i * plate + 3, j * plate + 3, plate - 6, plate - 6)
    }
  }

  // The bolts. Drawn as a dark ring with a light centre, which is the cheapest
  // thing that reads as raised rather than as a hole.
  for (let i = 0; i < 2; i += 1) {
    for (let j = 0; j < 2; j += 1) {
      for (const [ox, oy] of [
        [14, 14],
        [plate - 14, 14],
        [14, plate - 14],
        [plate - 14, plate - 14],
      ] as const) {
        const cx = i * plate + ox
        const cy = j * plate + oy
        context.fillStyle = 'rgba(0, 0, 0, 0.34)'
        context.beginPath()
        context.arc(cx, cy, 4, 0, Math.PI * 2)
        context.fill()
        context.fillStyle = 'rgba(255, 255, 255, 0.55)'
        context.beginPath()
        context.arc(cx - 1, cy - 1, 2, 0, Math.PI * 2)
        context.fill()
      }
    }
  }
}

/**
 * A hazard band: diagonal stripes with a heavy edge.
 *
 * Trim exists to be read at a glance from across the arena — "the ledge is
 * here, the room ends there" — so it is the one detail texture with high
 * contrast in it.
 */
function drawStripe(context: Canvas2D): void {
  context.fillStyle = '#ffffff'
  context.fillRect(0, 0, DETAIL_SIZE, DETAIL_SIZE)

  context.strokeStyle = 'rgba(0, 0, 0, 0.42)'
  context.lineWidth = 18
  // Drawn past both edges so the diagonal meets itself across the wrap.
  for (let i = -DETAIL_SIZE; i < DETAIL_SIZE * 2; i += 64) {
    context.beginPath()
    context.moveTo(i, 0)
    context.lineTo(i + DETAIL_SIZE, DETAIL_SIZE)
    context.stroke()
  }

  context.fillStyle = 'rgba(0, 0, 0, 0.55)'
  context.fillRect(0, 0, DETAIL_SIZE, 6)
  context.fillRect(0, DETAIL_SIZE - 6, DETAIL_SIZE, 6)
}

/** The detail textures, built once and shared by every surface that wants one. */
export type SurfaceTextures = {
  /** `null` for {@link DetailKind} `none`, and for an unknown kind. */
  get(kind: DetailKind): BaseTexture | null
  dispose(): void
}

/**
 * Draw the detail textures. Needs a canvas, so the unit tests pass `null` to
 * {@link createSurfaceMaterial} instead and the browser smoke test covers this.
 */
export function createSurfaceTextures(scene: Scene, engine: AbstractEngine): SurfaceTextures {
  const grid = beginDetail(scene, 'grid')
  drawGrid(grid.context)
  const panel = beginDetail(scene, 'panel')
  drawPanel(panel.context)
  const stripe = beginDetail(scene, 'stripe')
  drawStripe(stripe.context)

  const byKind = new Map<DetailKind, DynamicTexture>([
    ['grid', finishDetail(grid.texture, engine)],
    ['panel', finishDetail(panel.texture, engine)],
    ['stripe', finishDetail(stripe.texture, engine)],
  ])

  return {
    get: (kind) => byKind.get(kind) ?? null,
    dispose() {
      for (const texture of byKind.values()) texture.dispose()
      byKind.clear()
    },
  }
}

/* --------------------------------------------------------------------------
 * The material
 * ----------------------------------------------------------------------- */

/**
 * One surface's material.
 *
 * `disableLighting` is the line that pays for this ticket. It removes the light
 * loop from the fragment shader altogether — no attenuation, no `N·L`, no
 * per-light uniform rebind — because every photon in the arena is already in
 * the lightmap. On an integrated GPU at 1920x1080 that is the difference
 * between five multiply-adds a fragment and none.
 *
 * The lightmap itself is attached later, by `applyLightmap`, once it has
 * loaded. Nothing here assigns `lightmapTexture`: `docs/assets.md` §3.
 */
export function createSurfaceMaterial(
  scene: Scene,
  surface: MapSurface,
  textures: SurfaceTextures | null,
): StandardMaterial {
  const look = lookFor(surface.material)
  const material = new StandardMaterial(`surface:${surface.name}`, scene)
  const [r, g, b] = surface.tint
  const gain = look.tintGain * (look.selfLit ? look.glow : 1)

  // The albedo, in the term that survives `disableLighting`. See the header for
  // why this is `emissiveColor` and not `ambientColor`.
  material.emissiveColor = new Color3(r * gain, g * gain, b * gain)
  material.ambientColor = new Color3(0, 0, 0)
  material.diffuseColor = new Color3(r, g, b)
  material.specularColor = new Color3(0, 0, 0)
  material.disableLighting = true

  const detail = textures?.get(look.detail) ?? null
  if (detail !== null) material.diffuseTexture = detail

  material.alpha = look.alpha
  // A pane has two sides and you can be on either of them.
  material.backFaceCulling = look.alpha >= 1
  // `maxSimultaneousLights` is deliberately left alone. `disableLighting` makes
  // Babylon skip the light loop before it ever reads the limit, so setting it
  // would be a second, weaker statement of the same thing — in a number that
  // would then have to be kept in step with a light count that no longer exists.

  return material
}

/** Whether this surface's material should be handed the map's bake. */
export function takesLightmap(surface: MapSurface): boolean {
  return !lookFor(surface.material).selfLit
}
