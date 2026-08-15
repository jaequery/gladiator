import { describe, expect, it } from 'vitest'

import { MAP_FORMAT_VERSION, loadMap, type MapSource } from '@gladiator/sim'

import { bake, bakeAll, discoverMaps, serialize } from './bake-map.ts'
import { box, defineMap, spawn, surface } from '../maps/helpers.ts'

/**
 * The screen between the two spawns.
 *
 * `map/validate.ts` refuses a map where no two spawns are both far enough apart
 * and out of each other's sight, and a room with nothing in it is a room where
 * they can all see each other. This is the smallest thing that makes the
 * fixture a legal arena: it runs floor to ceiling, so it adds no ledge for the
 * reachability pass to have an opinion about either.
 */
const SCREEN = box('shell', [-64, -256, 0], [64, 256, 512])

/**
 * A map that bakes, to perturb one rule at a time.
 *
 * Big enough that the spawns clear `MIN_SPAWN_SEPARATION` with room to spare,
 * so a test that moves one of them is testing the rule it means to and not
 * tripping a second one on the way.
 */
function validMap(over: Partial<MapSource> = {}): MapSource {
  return {
    ...defineMap({
      name: 'fixture',
      title: 'Fixture',
      author: 'test',
      surfaces: [surface('shell', 'concrete')],
      brushes: [
        box('shell', [-1024, -1024, -64], [1024, 1024, 0]),
        box('shell', [-1024, -1024, 512], [1024, 1024, 576]),
        SCREEN,
      ],
      spawns: [spawn([-512, 0, 0], 0), spawn([512, 0, 0], 180)],
    }),
    ...over,
  }
}

function codesFor(map: MapSource): string[] {
  const outcome = bake(map)
  if (outcome.ok) return []
  return outcome.diagnostics.map((d) => d.code)
}

describe('the bake', () => {
  it('accepts a map with nothing wrong with it', () => {
    const outcome = bake(validMap())
    expect(outcome.ok).toBe(true)
  })

  it('produces a format version and an eight-hex-digit content hash', () => {
    const outcome = bake(validMap())
    if (!outcome.ok) throw new Error(outcome.diagnostics.map((d) => d.detail).join('\n'))
    expect(outcome.baked.format).toBe(MAP_FORMAT_VERSION)
    expect(outcome.baked.hash).toMatch(/^[0-9a-f]{8}$/)
  })

  it('hashes the content, so moving a brush one unit moves the hash', () => {
    const before = bake(validMap())
    const after = bake(
      validMap({
        brushes: [
          box('shell', [-1023, -1024, -64], [1024, 1024, 0]),
          box('shell', [-1024, -1024, 512], [1024, 1024, 576]),
          SCREEN,
        ],
      }),
    )
    if (!before.ok || !after.ok) throw new Error('both fixtures should bake')
    expect(after.baked.hash).not.toBe(before.baked.hash)
  })

  it('round-trips through JSON with the hash intact', () => {
    const outcome = bake(validMap())
    if (!outcome.ok) throw new Error('fixture should bake')
    const loaded = loadMap(JSON.parse(outcome.json))
    expect(loaded.hash).toBe(outcome.baked.hash)
    expect(loaded.source).toEqual(outcome.baked.map)
  })

  it('writes a file that ends in a newline, so a diff has no noise in it', () => {
    const outcome = bake(validMap())
    if (!outcome.ok) throw new Error('fixture should bake')
    expect(serialize(outcome.baked).endsWith('}\n')).toBe(true)
  })
})

/**
 * The five rules the ticket names, each on its own.
 *
 * Asserted by diagnostic *code* rather than by prose: the sentence an author
 * reads is allowed to be reworded, and the rule is not.
 */
describe('the bake refuses', () => {
  it('a spawn point inside solid', () => {
    const map = validMap({
      brushes: [
        box('shell', [-1024, -1024, -64], [1024, 1024, 0]),
        box('shell', [-1024, -1024, 512], [1024, 1024, 576]),
        // A block sitting exactly where the second player would stand.
        box('shell', [448, -64, 0], [576, 64, 64]),
      ],
    })
    expect(codesFor(map)).toContain('spawn-in-solid')
  })

  it('a spawn with under 96 units of headroom', () => {
    const map = validMap({
      brushes: [
        box('shell', [-1024, -1024, -64], [1024, 1024, 0]),
        box('shell', [-1024, -1024, 512], [1024, 1024, 576]),
        // 80 units up: over the 56-unit player's head, under the 96 required.
        box('shell', [448, -64, 80], [576, 64, 120]),
      ],
    })
    const outcome = bake(map)
    if (outcome.ok) throw new Error('a 80-unit crawlspace should not bake')
    const headroom = outcome.diagnostics.find((d) => d.code === 'spawn-headroom')
    expect(headroom?.where).toBe('spawns[1]')
    // The number in the message is the measurement, not a restatement of the rule.
    expect(headroom?.detail).toMatch(/79\.\d units of headroom/)
  })

  it('two spawns within 512 units of each other', () => {
    const map = validMap({ spawns: [spawn([-200, 0, 0], 0), spawn([200, 0, 0], 180)] })
    expect(codesFor(map)).toContain('spawn-separation')
  })

  it('inverted brush extents', () => {
    const map = validMap({
      brushes: [
        box('shell', [-1024, -1024, -64], [1024, 1024, 0]),
        box('shell', [-1024, -1024, 512], [1024, 1024, 576]),
        box('shell', [128, 0, 0], [64, 128, 128]),
      ],
    })
    expect(codesFor(map)).toContain('inverted-extents')
  })

  it('an unreferenced surface', () => {
    const map = validMap({ surfaces: [surface('shell', 'concrete'), surface('ghost', 'metal')] })
    expect(codesFor(map)).toContain('unreferenced-surface')
  })
})

/** Rules that are not on the ticket's list but fail the same way. */
describe('the bake also refuses', () => {
  it('a brush naming a surface that does not exist', () => {
    const map = validMap({
      brushes: [
        box('shell', [-1024, -1024, -64], [1024, 1024, 0]),
        box('shell', [-1024, -1024, 512], [1024, 1024, 576]),
        box('nope', [0, 0, 0], [64, 64, 64]),
      ],
    })
    expect(codesFor(map)).toContain('unknown-surface')
  })

  it('a ramp whose box is too shallow to hold its own slope', () => {
    const map = validMap({
      brushes: [
        box('shell', [-1024, -1024, -64], [1024, 1024, 0]),
        box('shell', [-1024, -1024, 512], [1024, 1024, 576]),
        // 128 of run at 1:1 needs more than 128 of height; this has 64.
        {
          kind: 'ramp',
          surface: 'shell',
          mins: [0, 0, 0],
          maxs: [128, 128, 64],
          rise: '+x',
          slope: '1:1',
        },
      ],
    })
    expect(codesFor(map)).toContain('ramp-too-shallow')
  })

  it('brush extents that are not whole Quake units', () => {
    const map = validMap({
      brushes: [
        box('shell', [-1024, -1024, -64], [1024, 1024, 0]),
        box('shell', [-1024, -1024, 512], [1024, 1024, 576]),
        box('shell', [0, 0, 0], [64.5, 64, 64]),
      ],
    })
    expect(codesFor(map)).toContain('off-grid')
  })

  it('a map with only one spawn', () => {
    expect(codesFor(validMap({ spawns: [spawn([0, 0, 0], 0)] }))).toContain('too-few-spawns')
  })

  it('a brush that is neither drawn nor collided', () => {
    const map = validMap({
      brushes: [
        box('shell', [-1024, -1024, -64], [1024, 1024, 0]),
        box('shell', [-1024, -1024, 512], [1024, 1024, 576]),
        box('shell', [0, 0, 0], [64, 64, 64], { nonSolid: true, noRender: true }),
      ],
    })
    expect(codesFor(map)).toContain('invisible-and-intangible')
  })
})

/**
 * The committed artifacts are the ones `pnpm build` and a Vercel deploy use, so
 * a stale one is a map nobody can reproduce from the source in the tree. This
 * is `pnpm map:bake --check`, run as part of `pnpm test`.
 */
describe('the committed artifacts', () => {
  it('are what the sources bake to', async () => {
    const reports = await bakeAll('check')
    expect(reports.length).toBeGreaterThan(0)
    for (const report of reports) {
      expect(report.outcome.ok, `${report.name} does not bake`).toBe(true)
      expect(report.changed, `${report.path} is stale — run pnpm map:bake`).toBe(false)
    }
  })

  it('cover every map under maps/', () => {
    expect(discoverMaps()).toContain('testbed.ts')
    expect(discoverMaps()).not.toContain('helpers.ts')
  })
})
