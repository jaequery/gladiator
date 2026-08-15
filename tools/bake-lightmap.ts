/**
 * `pnpm lightmap:bake` — trace a map's light into `assets/textures/*_lightmap.png`.
 *
 * This is the ticket's one lever: the arena is static and small, so the light
 * that falls on it can be computed once, offline, and read back at **zero
 * runtime cost**. What that buys is not only a prettier picture — it is a
 * fragment shader with no light loop in it at all, which is the difference
 * between comfortable and marginal on the integrated GPUs this game exists to
 * run well on. `docs/renderer.md` §12.
 *
 * It is a *source* generator, like `pnpm assets:placeholders`: what it writes is
 * a `.png` under `assets/`, committed, and then compressed to `.ktx2` by
 * `pnpm assets:build` exactly as a real bake out of Blender would be.
 *
 *     pnpm lightmap:bake            bake every map, write the sources
 *     pnpm lightmap:bake --check    re-bake in memory, fail on a stale artifact
 *
 * ## What is in the bake
 *
 * Three terms, and the second one is the reason this is worth doing at all:
 *
 *   1. **Direct light**, from the map's own lights, each with a shadow ray. The
 *      renderer can afford four lights; the bake can afford all of them, and it
 *      is the only thing here that can cast a shadow at all.
 *   2. **Ambient light, occluded** — a cosine-weighted hemisphere of rays per
 *      luxel, each one reporting how far it got before something stopped it.
 *      This is the soft contact shading under every ledge and in every corner,
 *      and no amount of real-time lighting at this budget produces it.
 *   3. **One bounce.** A ray that hits something gathers the *direct* light at
 *      what it hit, tinted by that surface's albedo. So a red wall throws red
 *      on the floor beside it, which is the single cheapest thing that makes a
 *      room read as a room rather than as a set of independently shaded planes.
 *
 * Everything is deterministic — a Hammersley sequence, never `Math.random` —
 * so re-running produces a byte-identical PNG and `--check` is a real check.
 *
 * ## The atlas is not authored here
 *
 * Where each face's light lives is `packages/sim/src/map/lightmapUv.ts`, which
 * the browser calls too. This program walks the layout that function returns
 * and never invents one, which is what stops the bake and the mesh from
 * disagreeing about which wall a texel belongs to — the failure `docs/assets.md`
 * §3 is about, whose symptom is a plausible picture rather than a broken one.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { PNG } from 'pngjs'

import {
  type CollisionWorld,
  type LightmapUnwrap,
  type MapSource,
  type TraceResult,
  type Vec3,
  createTrace,
  lightmapUnwrap,
  loadMap,
  mapGeometry,
  traceRay,
} from '@gladiator/sim'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** A colour being accumulated. `Vec3` is deeply readonly, and this one is a sum. */
type Rgb = [number, number, number]

/** The maps that get a bake. Both, because the reference screenshot is `testbed`. */
export const BAKED_MAPS: readonly string[] = ['arena1', 'testbed']

/* --------------------------------------------------------------------------
 * The numbers
 * ----------------------------------------------------------------------- */

/**
 * How many hemisphere rays each luxel casts.
 *
 * 32. Below about 24 the ambient term visibly banded on the big floor slabs —
 * a luxel either catches the ledge above it or does not, and with too few rays
 * the answer flips between neighbours. Above 32 the picture stopped changing
 * and the bake only got slower.
 */
const SKY_RAYS = 32

/**
 * How far a hemisphere ray looks before it gives up, in Quake units.
 *
 * 256 — four player-widths, and the number that decides what "in a corner"
 * means. This is an *occlusion* radius, not a visibility test: an arena is a
 * sealed box, so a ray traced to infinity hits something every single time and
 * an ambient term gated on escaping the level would be identically zero.
 * What actually reads as light is nearby geometry shadowing nearby geometry —
 * under a ledge, in the crease where a wall meets a floor, behind a pillar —
 * and 256 units is the distance over which a duellist perceives that.
 */
const AMBIENT_DISTANCE = 256

/**
 * The ambient term, as a dome: what a ray sees when nothing stops it.
 *
 * Quake's `-ambient`, and it exists for the same reason: a face turned away
 * from every light in a sealed room receives *nothing*, and a player who cannot
 * make out the side of the pillar they are strafing around is losing to the
 * lighting rather than to their opponent. It is scaled by how much of the
 * hemisphere is open, which is what turns a flat minimum into soft shading.
 *
 * Cool, because every light in both maps is warm: the fill being the complement
 * of the key separates a surface facing the light from one facing away by *hue*
 * as well as by value, and hue survives tone mapping.
 *
 * Two colours and a lean, not one colour, and the reason is the same one
 * `scene.ts` gives for tilting the real-time fill: an ambient term that is the
 * same in every direction gives every vertical surface in a room exactly the
 * same value, so all four walls come out identical and a pillar standing in
 * front of one vanishes into it. Grading the dome from {@link AMBIENT_SKY} to
 * {@link AMBIENT_GROUND} along {@link AMBIENT_LEAN} separates the orientations,
 * and it is free — the rays are already being traced.
 */
const AMBIENT_SKY: Vec3 = [0.30, 0.33, 0.43]
const AMBIENT_GROUND: Vec3 = [0.13, 0.13, 0.16]

/**
 * Which way the dome's bright half faces, Quake frame, unit length.
 *
 * Mostly up, leaning south-west. It is `scene.ts`'s `FILL_DIRECTION` run
 * backwards through `QUAKE_TO_ENGINE`, so the baked ambient and the real-time
 * fill on the player models agree about where the room's soft light comes from
 * — a model lit from one side in front of a wall shaded from the other is the
 * kind of wrongness nobody can name and everybody sees.
 */
const AMBIENT_LEAN: Vec3 = [-0.2371, -0.3830, 0.8924]

/**
 * How much of a bounce's gathered light comes back.
 *
 * 0.55 — one bounce off a diffuse surface, minus the albedo already applied.
 * A second bounce was tried and is not in here: it cost twice the bake for a
 * difference no screenshot comparison could see, which is the definition of the
 * wrong side of a fixed budget.
 */
const BOUNCE_GAIN = 0.55

/**
 * What a map's `intensity: 1` is worth to the bake.
 *
 * Deliberately its own number rather than the renderer's
 * `LIGHT_INTENSITY_SCALE`: that one converts to Babylon's falloff model and
 * this one converts to an irradiance the atlas can hold, and tying them
 * together would mean re-baking every map to re-tune a real-time light.
 */
const DIRECT_GAIN = 1.35

/**
 * How far off the surface a luxel is sampled, in Quake units.
 *
 * A quarter of a unit. Far enough that a shadow ray leaving the surface does
 * not immediately hit the surface it left — the classic shadow-acne bug, which
 * looks like the level is covered in noise — and close enough that a luxel on
 * one side of a corner is not lit through the wall.
 */
const SURFACE_OFFSET = 0.25

/**
 * How many times a valid luxel is smeared outwards into an invalid one.
 *
 * 8. Two kinds of texel have no light of their own: one whose sample point
 * landed inside solid geometry (a face's rectangle is its bounding box, and a
 * ramp's bounding box has corners the ramp does not occupy), and one in the
 * padding between two rectangles. Both are read by bilinear filtering and by
 * every mip level, so leaving them black draws a dark seam around every face —
 * and a dark seam around every face is exactly what a broken lightmap looks
 * like, which would make this bake impossible to debug.
 */
const DILATE_PASSES = 8

/* --------------------------------------------------------------------------
 * Sampling
 * ----------------------------------------------------------------------- */

/**
 * The `i`-th of `n` points of a Hammersley sequence.
 *
 * A fixed, low-discrepancy sequence rather than random numbers, for two
 * reasons that both matter: the bake is reproducible, so `--check` means
 * something; and a stratified sequence converges far faster than random
 * sampling at the same ray count, which is the whole reason 32 rays is enough.
 */
function hammersley(i: number, n: number): [number, number] {
  let bits = i
  bits = (bits << 16) | (bits >>> 16)
  bits = ((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1)
  bits = ((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2)
  bits = ((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4)
  bits = ((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8)
  return [i / n, (bits >>> 0) / 4294967296]
}

/**
 * A cosine-weighted direction in the hemisphere about `normal`.
 *
 * Cosine-weighted rather than uniform because the quantity being integrated is
 * irradiance, which already carries a cosine: drawing directions with that
 * cosine as their density lets every sample count the same, so the estimator is
 * "how many rays escaped" rather than a weighted sum. That is what makes the
 * ambient term legible as an occlusion rather than as noise.
 */
function cosineHemisphere(normal: Vec3, u: number, v: number): Rgb {
  const radius = Math.sqrt(u)
  const phi = 2 * Math.PI * v
  const x = radius * Math.cos(phi)
  const y = radius * Math.sin(phi)
  const z = Math.sqrt(Math.max(0, 1 - u))

  // Any vector not parallel to the normal gives a usable tangent. Same
  // 1/sqrt(3) rule as everywhere else in this repository.
  const seed: Rgb =
    Math.abs(normal[0]) < 0.57735 ? [1, 0, 0] : Math.abs(normal[1]) < 0.57735 ? [0, 1, 0] : [0, 0, 1]
  const along = seed[0] * normal[0] + seed[1] * normal[1] + seed[2] * normal[2]
  const tx = seed[0] - normal[0] * along
  const ty = seed[1] - normal[1] * along
  const tz = seed[2] - normal[2] * along
  const length = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1
  const t: Rgb = [tx / length, ty / length, tz / length]
  const b: Rgb = [
    normal[1] * t[2] - normal[2] * t[1],
    normal[2] * t[0] - normal[0] * t[2],
    normal[0] * t[1] - normal[1] * t[0],
  ]

  return [
    t[0] * x + b[0] * y + normal[0] * z,
    t[1] * x + b[1] * y + normal[1] * z,
    t[2] * x + b[2] * y + normal[2] * z,
  ]
}

/* --------------------------------------------------------------------------
 * The light
 * ----------------------------------------------------------------------- */

/** Everything a luxel needs to be lit, gathered once per map. */
type Scene = {
  readonly source: MapSource
  readonly world: CollisionWorld
  /** `world.brushes[i]` was cut from `source.brushes[sourceBrush[i]]`. */
  readonly sourceBrush: Int32Array
  /** Linear albedo per `source.surfaces` entry, for the bounce. */
  readonly albedo: readonly Rgb[]
}

/** Add the direct light reaching `point` with outward normal `normal` into `out`. */
function addDirect(scene: Scene, trace: TraceResult, point: Vec3, normal: Vec3, out: Rgb): void {
  for (const light of scene.source.lights) {
    const dx = light.origin[0] - point[0]
    const dy = light.origin[1] - point[1]
    const dz = light.origin[2] - point[2]
    const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
    if (distance <= 0 || distance >= light.radius) continue

    const facing = (dx * normal[0] + dy * normal[1] + dz * normal[2]) / distance
    if (facing <= 0) continue

    // Inverse-square falloff would black out a room this size long before the
    // authored radius; a windowed linear falloff squared is what every level
    // compiler since Quake has used and it is what the radius in `map/schema.ts`
    // means. The radius is a hard cut, so a light cannot leak through the map.
    const fade = 1 - distance / light.radius
    const attenuation = fade * fade * light.intensity * DIRECT_GAIN * facing
    if (attenuation <= 0) continue

    traceRay(trace, scene.world, point, [light.origin[0], light.origin[1], light.origin[2]])
    if (trace.fraction !== 1) continue

    out[0] += light.color[0] * attenuation
    out[1] += light.color[1] * attenuation
    out[2] += light.color[2] * attenuation
  }
}

/** The albedo of whatever brush a trace hit, or mid-grey if it hit nothing known. */
function albedoAt(scene: Scene, brushIndex: number): Rgb {
  const source = scene.sourceBrush[brushIndex] ?? -1
  const brush = source < 0 ? undefined : scene.source.brushes[source]
  if (brush === undefined) return [0.3, 0.3, 0.3]
  const index = scene.source.surfaces.findIndex((surface) => surface.name === brush.surface)
  return scene.albedo[index] ?? [0.3, 0.3, 0.3]
}

/**
 * The light arriving at one luxel: direct, sky, and one bounce.
 *
 * Returns `null` when the sample point is inside solid geometry — a texel in
 * the corner of a ramp's bounding rectangle, or in the padding between two
 * patches. Those are filled in afterwards by the dilation pass rather than
 * being lit, because there is no surface there to light.
 */
function lightAt(scene: Scene, trace: TraceResult, surface: Vec3, normal: Vec3): Rgb | null {
  const point: Rgb = [
    surface[0] + normal[0] * SURFACE_OFFSET,
    surface[1] + normal[1] * SURFACE_OFFSET,
    surface[2] + normal[2] * SURFACE_OFFSET,
  ]

  // A zero-length trace answers "am I standing in a wall" and nothing else.
  traceRay(trace, scene.world, point, point)
  if (trace.startsolid || trace.allsolid) return null

  const total: Rgb = [0, 0, 0]
  addDirect(scene, trace, point, normal, total)

  const share = 1 / SKY_RAYS
  const bounce: Rgb = [0, 0, 0]
  // What the open part of the hemisphere contributes. A ray's own `fraction` is
  // its credit rather than a yes-or-no: a wall 250 units away is nearly open
  // and a wall two units away is nearly closed, and grading it that way is what
  // stops the ambient term from banding across a big floor slab.
  const ambient: Rgb = [0, 0, 0]
  for (let i = 0; i < SKY_RAYS; i += 1) {
    const [u, v] = hammersley(i, SKY_RAYS)
    const direction = cosineHemisphere(normal, u, v)
    const far: Rgb = [
      point[0] + direction[0] * AMBIENT_DISTANCE,
      point[1] + direction[1] * AMBIENT_DISTANCE,
      point[2] + direction[2] * AMBIENT_DISTANCE,
    ]
    traceRay(trace, scene.world, point, far)

    // The dome, graded along the lean. A ray that got nowhere contributes
    // nothing; one that got most of the way contributes most of what it saw.
    const lean =
      0.5 +
      0.5 *
        (direction[0] * AMBIENT_LEAN[0] +
          direction[1] * AMBIENT_LEAN[1] +
          direction[2] * AMBIENT_LEAN[2])
    const reach = trace.fraction * share
    ambient[0] += (AMBIENT_GROUND[0] + (AMBIENT_SKY[0] - AMBIENT_GROUND[0]) * lean) * reach
    ambient[1] += (AMBIENT_GROUND[1] + (AMBIENT_SKY[1] - AMBIENT_GROUND[1]) * lean) * reach
    ambient[2] += (AMBIENT_GROUND[2] + (AMBIENT_SKY[2] - AMBIENT_GROUND[2]) * lean) * reach

    if (trace.fraction === 1) continue

    // It hit something. Gather the direct light *there* and bring it back
    // tinted by what it bounced off. The hit point is lifted off its plane by
    // the same offset a luxel is, for the same reason.
    const hitNormal: Rgb = [trace.planeNormal[0], trace.planeNormal[1], trace.planeNormal[2]]
    const hit: Rgb = [
      trace.endpos[0] + hitNormal[0] * SURFACE_OFFSET,
      trace.endpos[1] + hitNormal[1] * SURFACE_OFFSET,
      trace.endpos[2] + hitNormal[2] * SURFACE_OFFSET,
    ]
    const brushIndex = trace.brushIndex
    const there: Rgb = [0, 0, 0]
    addDirect(scene, trace, hit, hitNormal, there)
    const tint = albedoAt(scene, brushIndex)
    bounce[0] += there[0] * tint[0] * share
    bounce[1] += there[1] * tint[1] * share
    bounce[2] += there[2] * tint[2] * share
  }

  return [
    total[0] + ambient[0] + bounce[0] * BOUNCE_GAIN,
    total[1] + ambient[1] + bounce[1] * BOUNCE_GAIN,
    total[2] + ambient[2] + bounce[2] * BOUNCE_GAIN,
  ]
}

/* --------------------------------------------------------------------------
 * The atlas
 * ----------------------------------------------------------------------- */

/** Linear `[0, 1]` to an sRGB byte. The texture is tagged sRGB; see `docs/assets.md` §2. */
function srgbByte(linear: number): number {
  const clamped = linear <= 0 ? 0 : linear >= 1 ? 1 : linear
  const encoded =
    clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
  return Math.max(0, Math.min(255, Math.round(encoded * 255)))
}

export type LightmapImage = {
  readonly width: number
  readonly height: number
  /** RGB bytes, sRGB-encoded, three per texel. */
  readonly rgb: Uint8Array
  /** How many texels a patch covered, for the log. */
  readonly litTexels: number
}

/**
 * Bake one map's atlas.
 *
 * Exported so `bake-lightmap.test.ts` can drive it without a filesystem, the
 * same arrangement `tools/bake-map.ts` has.
 */
export function bakeLightmap(baked: unknown): LightmapImage {
  const loaded = loadMap(baked)
  const geometry = mapGeometry(loaded.source)
  const unwrap: LightmapUnwrap = lightmapUnwrap(geometry)

  const scene: Scene = {
    source: loaded.source,
    world: loaded.world,
    sourceBrush: loaded.sourceBrush,
    albedo: loaded.source.surfaces.map((surface) => [
      surface.tint[0],
      surface.tint[1],
      surface.tint[2],
    ]),
  }

  const { atlasWidth, atlasHeight } = unwrap
  const texels = atlasWidth * atlasHeight
  const linear = new Float32Array(texels * 3)
  // 0 = nothing here, 1 = lit by a patch, 2 = filled by dilation.
  const filled = new Uint8Array(texels)
  const trace: TraceResult = createTrace()
  let litTexels = 0

  for (const patch of unwrap.patches) {
    for (let y = 0; y < patch.height; y += 1) {
      for (let x = 0; x < patch.width; x += 1) {
        const surface: Rgb = [
          patch.origin[0] + patch.right[0] * x + patch.down[0] * y,
          patch.origin[1] + patch.right[1] * x + patch.down[1] * y,
          patch.origin[2] + patch.right[2] * x + patch.down[2] * y,
        ]
        const value = lightAt(
          scene,
          trace,
          surface,
          [patch.normal[0], patch.normal[1], patch.normal[2]],
        )
        if (value === null) continue
        const at = (patch.y + y) * atlasWidth + (patch.x + x)
        linear[at * 3] = value[0]
        linear[at * 3 + 1] = value[1]
        linear[at * 3 + 2] = value[2]
        filled[at] = 1
        litTexels += 1
      }
    }
  }

  dilate(linear, filled, atlasWidth, atlasHeight)

  const rgb = new Uint8Array(texels * 3)
  for (let i = 0; i < texels; i += 1) {
    rgb[i * 3] = srgbByte(linear[i * 3] ?? 0)
    rgb[i * 3 + 1] = srgbByte(linear[i * 3 + 1] ?? 0)
    rgb[i * 3 + 2] = srgbByte(linear[i * 3 + 2] ?? 0)
  }

  return { width: atlasWidth, height: atlasHeight, rgb, litTexels }
}

/**
 * Smear lit texels outwards into unlit ones. See {@link DILATE_PASSES}.
 *
 * Each pass averages the lit neighbours of an unlit texel. Passes are applied
 * against a snapshot of the previous one, so the result does not depend on
 * which way the loop happens to run — a dilation that reads its own output
 * marches in the scan direction and leaves comet tails.
 */
function dilate(linear: Float32Array, filled: Uint8Array, width: number, height: number): void {
  for (let pass = 0; pass < DILATE_PASSES; pass += 1) {
    const before = filled.slice()
    let grew = 0
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const at = y * width + x
        if (before[at] !== 0) continue
        let r = 0
        let g = 0
        let b = 0
        let found = 0
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            const nx = x + dx
            const ny = y + dy
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue
            const near = ny * width + nx
            if (before[near] === 0) continue
            r += linear[near * 3] ?? 0
            g += linear[near * 3 + 1] ?? 0
            b += linear[near * 3 + 2] ?? 0
            found += 1
          }
        }
        if (found === 0) continue
        linear[at * 3] = r / found
        linear[at * 3 + 1] = g / found
        linear[at * 3 + 2] = b / found
        filled[at] = 2
        grew += 1
      }
    }
    if (grew === 0) return
  }
}

/** The atlas as a PNG. RGB, no alpha: a lightmap has nothing to be transparent about. */
export function encodePng(image: LightmapImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height, colorType: 2 })
  for (let i = 0; i < image.width * image.height; i += 1) {
    png.data[i * 4] = image.rgb[i * 3] ?? 0
    png.data[i * 4 + 1] = image.rgb[i * 3 + 1] ?? 0
    png.data[i * 4 + 2] = image.rgb[i * 3 + 2] ?? 0
    png.data[i * 4 + 3] = 255
  }
  return PNG.sync.write(png, { colorType: 2 })
}

/** Where a map's bake is committed. */
export function lightmapPath(map: string): string {
  return join(ROOT, 'assets', 'textures', `${map}_lightmap.png`)
}

/** The mean of an atlas, of 255 — the "is it black" number the tests assert on. */
export function meanLuminance(image: LightmapImage): number {
  let total = 0
  for (let i = 0; i < image.rgb.length; i += 1) total += image.rgb[i] ?? 0
  return total / image.rgb.length
}

/* --------------------------------------------------------------------------
 * Entry point
 * ----------------------------------------------------------------------- */

async function main(): Promise<void> {
  const check = process.argv.includes('--check')
  let stale = 0

  for (const map of BAKED_MAPS) {
    const source = readFileSync(join(ROOT, 'maps', 'baked', `${map}.json`), 'utf8')
    const image = bakeLightmap(JSON.parse(source))
    const bytes = encodePng(image)
    const path = lightmapPath(map)
    const relative = `assets/textures/${map}_lightmap.png`

    if (check) {
      let committed: Buffer | undefined
      try {
        committed = readFileSync(path)
      } catch {
        // No artifact at all is the same answer as a stale one, and the message
        // below tells a reader what to run about it either way.
      }
      if (committed === undefined || !committed.equals(bytes)) {
        process.stderr.write(`  ${relative} is stale — run pnpm lightmap:bake\n`)
        stale += 1
        continue
      }
      process.stdout.write(`  ${relative} is current\n`)
      continue
    }

    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, bytes)
    process.stdout.write(
      `  wrote ${relative} — ${image.width}x${image.height}, ${image.litTexels} lit texels, mean ${meanLuminance(image).toFixed(1)}/255\n`,
    )
  }

  if (stale > 0) process.exitCode = 1
}

// Only when run as a program. The tests import `bakeLightmap` directly, and a
// bake that started itself on import would cost every one of them a minute.
const invoked = process.argv[1]
if (invoked !== undefined && pathToFileURL(invoked).href === import.meta.url) {
  await main()
}
