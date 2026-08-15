/**
 * The lightmap atlas, asserted where the baker and the browser meet.
 *
 * Everything here is a property of the *layout*, because that is the thing two
 * programs have to agree about: `tools/bake-lightmap.ts` writes texels and
 * `render/mapMesh.ts` samples them, and if either could compute a different
 * rectangle for a face the level would be lit from the wrong wall. Since both
 * call one function, what is left to prove is that the function's output is
 * self-consistent — no two faces on the same texels, every vertex inside its
 * own patch, and the same answer twice.
 */

import { describe, expect, it } from 'vitest'

import { mapGeometry } from './geometry.ts'
import type { MapSource } from './schema.ts'
import { DEFAULT_PADDING, lightmapUnwrap } from './lightmapUv.ts'

/**
 * A sealed room with a pillar, a ramp and a pane in it.
 *
 * Written here rather than imported from `maps/`: `packages/sim` has no
 * filesystem and cannot reach sideways into that directory, and a fixture with
 * one of every face orientation — axis-aligned, sloped, thin — is what these
 * properties need anyway.
 */
const MAP: MapSource = {
  name: 'unwraptest',
  title: 'Unwrap test',
  author: 'test',
  surfaces: [
    { name: 'floor', material: 'concrete', tint: [0.3, 0.3, 0.3] },
    { name: 'wall', material: 'concrete', tint: [0.2, 0.2, 0.25] },
    { name: 'metal', material: 'metal', tint: [0.45, 0.42, 0.38] },
  ],
  brushes: [
    { kind: 'box', surface: 'floor', mins: [-512, -512, -64], maxs: [512, 512, 0] },
    { kind: 'box', surface: 'wall', mins: [-512, -512, 512], maxs: [512, 512, 576] },
    { kind: 'box', surface: 'wall', mins: [448, -512, 0], maxs: [512, 512, 512] },
    { kind: 'box', surface: 'wall', mins: [-512, -512, 0], maxs: [-448, 512, 512] },
    { kind: 'box', surface: 'wall', mins: [-64, -64, 0], maxs: [64, 64, 256] },
    {
      kind: 'ramp',
      surface: 'metal',
      mins: [128, -128, -32],
      maxs: [320, 128, 96],
      rise: '+x',
      slope: '1:2',
    },
    { kind: 'box', surface: 'metal', mins: [-8, 128, 0], maxs: [8, 256, 128], nonSolid: true },
  ],
  spawns: [],
  lights: [],
  props: [],
}

const geometry = mapGeometry(MAP)

describe('lightmapUnwrap', () => {
  it('gives every face a patch', () => {
    const unwrap = lightmapUnwrap(geometry)
    expect(geometry.faces.length).toBeGreaterThan(0)
    expect(unwrap.patches).toHaveLength(geometry.faces.length)
    // In geometry order, so a baker that walks patches writes a stable atlas.
    expect(unwrap.patches.map((patch) => patch.face)).toEqual(
      geometry.faces.map((_, index) => index),
    )
  })

  it('packs into a power-of-two atlas no taller than it needs to be', () => {
    const unwrap = lightmapUnwrap(geometry)
    expect(Number.isInteger(Math.log2(unwrap.atlasWidth))).toBe(true)
    expect(Number.isInteger(Math.log2(unwrap.atlasHeight))).toBe(true)
    // Every patch is inside it.
    for (const patch of unwrap.patches) {
      expect(patch.x).toBeGreaterThanOrEqual(0)
      expect(patch.y).toBeGreaterThanOrEqual(0)
      expect(patch.x + patch.width).toBeLessThanOrEqual(unwrap.atlasWidth)
      expect(patch.y + patch.height).toBeLessThanOrEqual(unwrap.atlasHeight)
    }
    // And the height is not twice what the shelves came to, which would be a
    // megabyte of black texels nobody has any use for.
    const bottom = Math.max(...unwrap.patches.map((patch) => patch.y + patch.height))
    expect(unwrap.atlasHeight).toBeLessThan(bottom * 2 + 4)
  })

  it('never puts two faces on the same texel', () => {
    // The failure this whole file exists to prevent: two walls sharing a patch
    // renders a level lit from the wrong one, which is a *plausible* picture.
    const unwrap = lightmapUnwrap(geometry)
    const owner = new Int32Array(unwrap.atlasWidth * unwrap.atlasHeight).fill(-1)
    for (const patch of unwrap.patches) {
      for (let y = 0; y < patch.height; y += 1) {
        for (let x = 0; x < patch.width; x += 1) {
          const at = (patch.y + y) * unwrap.atlasWidth + (patch.x + x)
          expect(owner[at]).toBe(-1)
          owner[at] = patch.face
        }
      }
    }
  })

  it('leaves the padding between two patches empty', () => {
    const unwrap = lightmapUnwrap(geometry)
    const rows = new Map<number, Array<{ from: number; to: number }>>()
    for (const patch of unwrap.patches) {
      const row = rows.get(patch.y) ?? []
      row.push({ from: patch.x, to: patch.x + patch.width })
      rows.set(patch.y, row)
    }
    for (const row of rows.values()) {
      row.sort((a, b) => a.from - b.from)
      for (let i = 1; i < row.length; i += 1) {
        const gap = (row[i]?.from ?? 0) - (row[i - 1]?.to ?? 0)
        expect(gap).toBeGreaterThanOrEqual(DEFAULT_PADDING)
      }
    }
  })

  it('samples every vertex from inside its own patch, at texel centres', () => {
    // The centre rule is what keeps a bilinear tap on this face rather than on
    // whatever is packed against it: a vertex at the very edge of the face maps
    // to the *centre* of the first texel, half a texel inside the rectangle.
    const unwrap = lightmapUnwrap(geometry)
    for (const patch of unwrap.patches) {
      const face = geometry.faces[patch.face]
      if (face === undefined) continue
      for (let v = 0; v < face.vertexCount; v += 1) {
        const at = (face.vertexStart + v) * 2
        const u = (unwrap.uv2[at] ?? 0) * unwrap.atlasWidth
        const w = (unwrap.uv2[at + 1] ?? 0) * unwrap.atlasHeight
        expect(u).toBeGreaterThanOrEqual(patch.x + 0.5 - 1e-3)
        expect(u).toBeLessThanOrEqual(patch.x + patch.width - 0.5 + 1e-3)
        expect(w).toBeGreaterThanOrEqual(patch.y + 0.5 - 1e-3)
        expect(w).toBeLessThanOrEqual(patch.y + patch.height - 0.5 + 1e-3)
      }
    }
  })

  it('walks a patch back to the world positions its own vertices are at', () => {
    // The baker's half of the contract: `origin + right * x + down * y` has to
    // land on the face the UVs above came from, or the light is traced at one
    // place and sampled at another.
    const unwrap = lightmapUnwrap(geometry)
    for (const patch of unwrap.patches) {
      const face = geometry.faces[patch.face]
      if (face === undefined) continue
      for (let v = 0; v < face.vertexCount; v += 1) {
        const at = (face.vertexStart + v) * 2
        // Where the baker would have sampled, given this vertex's own UV.
        const x = (unwrap.uv2[at] ?? 0) * unwrap.atlasWidth - patch.x - 0.5
        const y = (unwrap.uv2[at + 1] ?? 0) * unwrap.atlasHeight - patch.y - 0.5
        const p = (face.vertexStart + v) * 3
        for (let axis = 0; axis < 3; axis += 1) {
          const walked =
            (patch.origin[axis] ?? 0) +
            (patch.right[axis] ?? 0) * x +
            (patch.down[axis] ?? 0) * y
          expect(walked).toBeCloseTo(geometry.positions[p + axis] ?? 0, 2)
        }
      }
    }
  })

  it('is a pure function of the geometry', () => {
    // The property `pnpm lightmap:bake --check` rests on: the same map has to
    // produce the same atlas on every machine, or the committed artifact is a
    // coin toss.
    const a = lightmapUnwrap(geometry)
    const b = lightmapUnwrap(mapGeometry(MAP))
    expect(b.atlasWidth).toBe(a.atlasWidth)
    expect(b.atlasHeight).toBe(a.atlasHeight)
    expect([...b.uv2]).toEqual([...a.uv2])
    expect(b.patches).toEqual(a.patches)
  })

  it('refuses to overlap rather than silently sharing texels', () => {
    // A tiny atlas cannot hold this map. The alternative to throwing is two
    // walls on one patch, which is the bug, so it is not allowed to be quiet.
    expect(() => lightmapUnwrap(geometry, { atlasWidth: 16, maxAtlasHeight: 16 })).toThrow(
      /do not fit/,
    )
  })
})
