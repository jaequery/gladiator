import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Material } from '@babylonjs/core/Materials/material'
import { type MapSource, mapGeometry, quakeToEngine } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { TEXEL_SCALE, buildMapMesh } from './mapMesh.ts'
import { createScene } from './scene.ts'

/**
 * A room with one of each thing that has to be treated differently: a floor, a
 * wall, a pane that is drawn but not collided, and a clip brush that is
 * collided but not drawn.
 */
const MAP: MapSource = {
  name: 'meshtest',
  title: 'Mesh test',
  author: 'test',
  surfaces: [
    { name: 'floor', material: 'concrete', tint: [0.3, 0.3, 0.3] },
    { name: 'wall', material: 'concrete', tint: [0.2, 0.2, 0.25] },
    { name: 'glass', material: 'glass', tint: [0.5, 0.7, 0.8] },
    { name: 'clip', material: 'clip', tint: [1, 0, 1] },
  ],
  brushes: [
    { kind: 'box', surface: 'floor', mins: [-256, -256, -64], maxs: [256, 256, 0] },
    { kind: 'box', surface: 'wall', mins: [256, -256, 0], maxs: [320, 256, 256] },
    { kind: 'box', surface: 'glass', mins: [-8, -64, 0], maxs: [8, 64, 128], nonSolid: true },
    { kind: 'box', surface: 'clip', mins: [-128, -8, 0], maxs: [-64, 8, 192], noRender: true },
  ],
  spawns: [],
  lights: [],
  props: [],
}

function build() {
  const scene = createScene(new NullEngine())
  const geometry = mapGeometry(MAP)
  // No grid texture: drawing one needs a canvas, and this is about the
  // geometry. `createGridTexture` is exercised in the browser smoke test.
  return { geometry, mesh: buildMapMesh(scene, MAP, geometry, null) }
}

describe('buildMapMesh', () => {
  it('draws one submesh per surface that has a visible face', () => {
    const { mesh } = build()
    // `clip` is `noRender`, so it contributes nothing; `glass` is `nonSolid`,
    // so it contributes here and nowhere else.
    expect(mesh.surfaces).toEqual(['floor', 'wall', 'glass'])
    expect(mesh.mesh.subMeshes).toHaveLength(3)
  })

  it('merges everything into one vertex and index buffer', () => {
    const { geometry, mesh } = build()
    expect(mesh.vertices).toBe(geometry.positions.length / 3)
    expect(mesh.triangles).toBe(geometry.indices.length / 3)
    expect(mesh.mesh.getTotalIndices()).toBe(geometry.indices.length)
  })

  it('applies the Quake-to-engine map exactly once, to positions and normals', () => {
    const { geometry, mesh } = build()
    const positions = mesh.mesh.getVerticesData('position')
    const normals = mesh.mesh.getVerticesData('normal')
    expect(positions).not.toBeNull()
    expect(normals).not.toBeNull()

    for (let v = 0; v < mesh.vertices; v += 1) {
      const quake = [
        geometry.positions[v * 3] ?? 0,
        geometry.positions[v * 3 + 1] ?? 0,
        geometry.positions[v * 3 + 2] ?? 0,
      ] as const
      const [ex, ey, ez] = quakeToEngine(quake)
      expect(positions?.[v * 3]).toBeCloseTo(ex, 3)
      expect(positions?.[v * 3 + 1]).toBeCloseTo(ey, 3)
      expect(positions?.[v * 3 + 2]).toBeCloseTo(ez, 3)
    }

    for (let v = 0; v < mesh.vertices; v += 1) {
      const quake = [
        geometry.normals[v * 3] ?? 0,
        geometry.normals[v * 3 + 1] ?? 0,
        geometry.normals[v * 3 + 2] ?? 0,
      ] as const
      const [nx, ny, nz] = quakeToEngine(quake)
      expect(normals?.[v * 3]).toBeCloseTo(nx, 3)
      expect(normals?.[v * 3 + 1]).toBeCloseTo(ny, 3)
      expect(normals?.[v * 3 + 2]).toBeCloseTo(nz, 3)
    }
  })

  it('declares the winding it was given, rather than taking Babylon at its word', () => {
    // A hand-built `Mesh` defaults to `ClockWiseSideOrientation`, which in a
    // right-handed scene reverses the cull face. The symptom is not a broken
    // picture: inside a sealed room you go on seeing a room, because the near
    // face of every wall is culled and the far face of the same wall is drawn
    // behind it, unlit. This line is the fix, so this test is the lock.
    expect(build().mesh.mesh.sideOrientation).toBe(Material.CounterClockWiseSideOrientation)
  })

  it('keeps the triangle winding the simulation produced', () => {
    // `det(QUAKE_TO_ENGINE) = +1`, so the conversion is a rotation and the
    // winding survives it. Reversing the indices here would turn every face
    // inside out — the classic symptom of a mirrored axis map.
    const { geometry, mesh } = build()
    expect([...(mesh.mesh.getIndices() ?? [])]).toEqual([...geometry.indices])
  })

  it('projects the texture axially, in Quake units', () => {
    const { geometry, mesh } = build()
    const uvs = mesh.mesh.getVerticesData('uv')
    expect(uvs).not.toBeNull()

    for (let v = 0; v < mesh.vertices; v += 1) {
      const [x, y, z] = [
        geometry.positions[v * 3] ?? 0,
        geometry.positions[v * 3 + 1] ?? 0,
        geometry.positions[v * 3 + 2] ?? 0,
      ]
      const [nx, ny, nz] = [
        Math.abs(geometry.normals[v * 3] ?? 0),
        Math.abs(geometry.normals[v * 3 + 1] ?? 0),
        Math.abs(geometry.normals[v * 3 + 2] ?? 0),
      ]
      const expected =
        nz >= nx && nz >= ny
          ? [x / TEXEL_SCALE, y / TEXEL_SCALE]
          : nx >= ny
            ? [y / TEXEL_SCALE, z / TEXEL_SCALE]
            : [x / TEXEL_SCALE, z / TEXEL_SCALE]
      expect(uvs?.[v * 2]).toBeCloseTo(expected[0] ?? 0, 4)
      expect(uvs?.[v * 2 + 1]).toBeCloseTo(expected[1] ?? 0, 4)
    }
  })

  it('gives each submesh the index range its surface actually occupies', () => {
    const { geometry, mesh } = build()
    const visible = geometry.groups.filter((group) =>
      mesh.surfaces.includes(group.surface),
    )
    for (const [index, group] of visible.entries()) {
      const submesh = mesh.mesh.subMeshes[index]
      expect(submesh?.indexStart).toBe(group.indexStart)
      expect(submesh?.indexCount).toBe(group.indexCount)
    }
  })
})
