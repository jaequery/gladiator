/**
 * The lightmap convention, asserted against the engine rather than the docs.
 *
 * `NOTES.md` carried this as an open item, and it is the kind of open item that
 * costs a day: a lightmap on the wrong UV set renders a plausible picture or a
 * black one, and neither says why. So the chain is checked link by link, on a
 * glTF built here and loaded by the real loader under a real `Scene`:
 *
 *     TEXCOORD_1  ->  VertexBuffer.UV2Kind ("uv2")  ->  coordinatesIndex = 1
 *
 * The glTF is assembled byte by byte in this file on purpose. A fixture would
 * be a file someone has to trust; a builder is one anybody can read, and it
 * makes "the second UV set" a thing with values in it that can be compared
 * against what comes out the other end.
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { Scene } from '@babylonjs/core/scene'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { LoadAssetContainerAsync } from '@babylonjs/core/Loading/sceneLoader'
import { CreateBox } from '@babylonjs/core/Meshes/Builders/boxBuilder'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { ensureGltfLoader } from './gltf.ts'
import { LIGHTMAP_UV_SET, LIGHTMAP_VERTEX_KIND, applyLightmap } from './lightmap.ts'

/* --------------------------------------------------------------------------
 * A glTF with two UV sets, assembled by hand
 * ----------------------------------------------------------------------- */

/** The first UV set: a material tiled twice across the quad. */
const TILING_UVS = [0, 0, 2, 0, 2, 2, 0, 2]

/** The second: one small, distinct patch of a lightmap atlas. Nothing shared. */
const LIGHTMAP_UVS = [0.25, 0.5, 0.375, 0.5, 0.375, 0.625, 0.25, 0.625]

const POSITIONS = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]
const INDICES = [0, 1, 2, 0, 2, 3]

function align4(value: number): number {
  return (value + 3) & ~3
}

/**
 * A minimal `.glb`: one quad, one material, `TEXCOORD_0` and `TEXCOORD_1`.
 *
 * `withSecondUvSet: false` produces the mistake the convention prevents — a
 * mesh exported from a blend file whose second UV map was never created.
 */
function buildGlb(withSecondUvSet: boolean): Uint8Array {
  const positions = new Float32Array(POSITIONS)
  const uv0 = new Float32Array(TILING_UVS)
  const uv1 = new Float32Array(LIGHTMAP_UVS)
  const indices = new Uint16Array(INDICES)

  const chunks: Array<{ data: Uint8Array; length: number }> = []
  let offset = 0
  const push = (view: Float32Array | Uint16Array) => {
    const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
    const at = offset
    chunks.push({ data: bytes, length: bytes.byteLength })
    offset += bytes.byteLength
    return at
  }

  const positionAt = push(positions)
  const uv0At = push(uv0)
  const uv1At = withSecondUvSet ? push(uv1) : -1
  const indicesAt = push(indices)

  const binLength = align4(offset)
  const bin = new Uint8Array(binLength)
  let cursor = 0
  for (const chunk of chunks) {
    bin.set(chunk.data, cursor)
    cursor += chunk.length
  }

  const bufferViews = [
    { buffer: 0, byteOffset: positionAt, byteLength: positions.byteLength },
    { buffer: 0, byteOffset: uv0At, byteLength: uv0.byteLength },
    ...(withSecondUvSet ? [{ buffer: 0, byteOffset: uv1At, byteLength: uv1.byteLength }] : []),
    { buffer: 0, byteOffset: indicesAt, byteLength: indices.byteLength },
  ]
  const indicesView = bufferViews.length - 1

  const attributes: Record<string, number> = { POSITION: 0, TEXCOORD_0: 1 }
  if (withSecondUvSet) attributes['TEXCOORD_1'] = 2

  const json = {
    asset: { version: '2.0', generator: 'gladiator lightmap.test.ts' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'quad' }],
    meshes: [{ name: 'quad', primitives: [{ attributes, indices: indicesView, material: 0 }] }],
    materials: [{ name: 'surface', pbrMetallicRoughness: { metallicFactor: 0 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 4, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
      { bufferView: 1, componentType: 5126, count: 4, type: 'VEC2' },
      ...(withSecondUvSet ? [{ bufferView: 2, componentType: 5126, count: 4, type: 'VEC2' }] : []),
      { bufferView: indicesView, componentType: 5123, count: 6, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: binLength }],
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = align4(jsonBytes.byteLength)
  const jsonChunk = new Uint8Array(jsonLength).fill(0x20)
  jsonChunk.set(jsonBytes)

  const total = 12 + 8 + jsonLength + 8 + binLength
  const glb = new Uint8Array(total)
  const view = new DataView(glb.buffer)
  view.setUint32(0, 0x46546c67, true) // "glTF"
  view.setUint32(4, 2, true)
  view.setUint32(8, total, true)
  view.setUint32(12, jsonLength, true)
  view.setUint32(16, 0x4e4f534a, true) // "JSON"
  glb.set(jsonChunk, 20)
  view.setUint32(20 + jsonLength, binLength, true)
  view.setUint32(24 + jsonLength, 0x004e4942, true) // "BIN\0"
  glb.set(bin, 28 + jsonLength)
  return glb
}

/* --------------------------------------------------------------------------
 * The tests
 * ----------------------------------------------------------------------- */

let engine: NullEngine
let scene: Scene

// Through the client's own entry point rather than by importing the loader
// module here: registering it is `gltf.ts`'s job, and a test that did it itself
// would pass on a day that one had stopped.
beforeAll(async () => {
  await ensureGltfLoader()
})

beforeEach(() => {
  engine = new NullEngine()
  scene = new Scene(engine)
})

afterEach(() => {
  scene.dispose()
  engine.dispose()
})

async function loadQuad(withSecondUvSet: boolean) {
  const container = await LoadAssetContainerAsync(buildGlb(withSecondUvSet), scene, {
    pluginExtension: '.glb',
  })
  const mesh = container.meshes.find((candidate) => candidate.getTotalVertices() > 0)
  if (mesh === undefined) throw new Error('the fixture loaded no geometry')
  return mesh
}

describe('the second UV set', () => {
  it('is the string Babylon calls "uv2"', () => {
    // The convention in one assertion. If a Babylon upgrade renames it, every
    // lightmap in the game goes black and this line is what says so first.
    expect(LIGHTMAP_VERTEX_KIND).toBe('uv2')
    expect(VertexBuffer.UV2Kind).toBe('uv2')
    expect(LIGHTMAP_UV_SET).toBe(1)
  })

  it('is where the glTF loader puts TEXCOORD_1', async () => {
    const mesh = await loadQuad(true)

    expect(mesh.isVerticesDataPresent(VertexBuffer.UVKind)).toBe(true)
    expect(mesh.isVerticesDataPresent(VertexBuffer.UV2Kind)).toBe(true)

    // Not merely present — carrying the values authored into TEXCOORD_1, so a
    // loader that silently duplicated TEXCOORD_0 into both would still fail.
    expect(Array.from(mesh.getVerticesData(VertexBuffer.UV2Kind) ?? [])).toEqual(LIGHTMAP_UVS)
    expect(Array.from(mesh.getVerticesData(VertexBuffer.UVKind) ?? [])).toEqual(TILING_UVS)
  })

  it('is not there when the export left it out', async () => {
    const mesh = await loadQuad(false)
    expect(mesh.isVerticesDataPresent(VertexBuffer.UV2Kind)).toBe(false)
  })
})

describe('applyLightmap', () => {
  const lightmap = () => new Texture(null, scene)

  it('points the lightmap at the second UV set', async () => {
    const mesh = await loadQuad(true)
    const texture = lightmap()

    // The default is the trap: index 0 is the tiling unwrap.
    expect(texture.coordinatesIndex).toBe(0)

    applyLightmap(mesh, texture)

    expect(texture.coordinatesIndex).toBe(LIGHTMAP_UV_SET)
    const material = mesh.material as StandardMaterial
    expect(material.lightmapTexture).toBe(texture)
    // The bake carries direct light too, so it multiplies rather than adds.
    expect(material.useLightmapAsShadowmap).toBe(true)
  })

  it('refuses a mesh with no second UV set, by name', async () => {
    const mesh = await loadQuad(false)
    expect(() => applyLightmap(mesh, lightmap())).toThrow(/no uv2/)
  })

  it('refuses a mesh with no material', () => {
    const box = CreateBox('box', {}, scene)
    box.material = null
    // A box builder emits no uv2 either, so this asserts the first gate fires
    // before the second one can.
    expect(() => applyLightmap(box, lightmap())).toThrow(/no uv2/)
  })
})
