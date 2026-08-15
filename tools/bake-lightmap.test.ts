/**
 * The bake, and the two things that can be wrong with it.
 *
 * A lightmap fails in exactly two ways and neither of them throws. It can be
 * **stale** — the map moved and the committed atlas still describes where the
 * walls used to be — and it can be **black**, which is what a bake looks like
 * when the UV convention is wrong, when every shadow ray is blocked, or when
 * the lights are inside the ceiling. Both are checked here, over the artifacts
 * that actually ship.
 *
 * This is the same arrangement `tools/bake-map.test.ts` has, and for the same
 * reason: `pnpm lightmap:bake --check` is the command a person runs, and this
 * is what makes it run on every pull request without a workflow change.
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PNG } from 'pngjs'
import { describe, expect, it } from 'vitest'

import { BAKED_MAPS, bakeLightmap, encodePng, lightmapPath, meanLuminance } from './bake-lightmap.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/**
 * How bright a bake has to be, of 255, before it counts as light.
 *
 * 24 is dark — a tenth of the range — and that is the point. This is not a
 * quality gate, it is the difference between "a level with lighting in it" and
 * "a level whose atlas is a black rectangle", and every failure mode that
 * produces the second one produces a mean of nearly zero.
 */
const NOT_BLACK = 24

/** And how much of the atlas has to be doing something, as a fraction. */
const MIN_LIT_FRACTION = 0.2

describe.each(BAKED_MAPS)('%s lightmap', (map) => {
  const committed = readFileSync(lightmapPath(map))
  const baked = bakeLightmap(JSON.parse(readFileSync(join(ROOT, 'maps', 'baked', `${map}.json`), 'utf8')))

  it('is what these sources produce', () => {
    // Two claims in one comparison, and the second is the interesting one.
    //
    // Stale is the failure nobody notices: the artifact is committed, so a map
    // edit without a re-bake ships a lightmap describing the level as it was.
    // And because the committed bytes were written by a *different process on
    // a different day*, a match is also proof that the tracer is deterministic
    // — that nothing in it reached for a clock or for `Math.random`, which is
    // what would make `--check` fail on a tree nobody had touched.
    expect(encodePng(baked).equals(committed)).toBe(true)
  })

  it('has light in it, not a black rectangle', () => {
    const image = PNG.sync.read(committed)
    expect(image.width).toBe(baked.width)
    expect(image.height).toBe(baked.height)
    expect(meanLuminance(baked)).toBeGreaterThan(NOT_BLACK)
    expect(baked.litTexels / (baked.width * baked.height)).toBeGreaterThan(MIN_LIT_FRACTION)
  })

  it('has a *range* in it, rather than one flat value', () => {
    // A bake that came out uniform is a bake whose shadow rays all missed or
    // all hit — which draws a picture, so nothing else would catch it. A real
    // one has bright texels under the lights and dark ones under the ledges.
    const lit = [...baked.rgb].filter((value) => value > 0)
    lit.sort((a, b) => a - b)
    const low = lit[Math.floor(lit.length * 0.1)] ?? 0
    const high = lit[Math.floor(lit.length * 0.9)] ?? 0
    expect(high - low).toBeGreaterThan(32)
  })

  it('is a power of two in both directions', () => {
    // Every block format compresses 4x4 texels at a time and a mip chain has to
    // halve cleanly. `docs/assets.md` §2.
    expect(Number.isInteger(Math.log2(baked.width))).toBe(true)
    expect(Number.isInteger(Math.log2(baked.height))).toBe(true)
  })

})
