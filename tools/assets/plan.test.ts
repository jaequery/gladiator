/**
 * Where a source ends up, and what the plan refuses to plan.
 *
 * The mapping is one rule in one place because two consumers depend on it: the
 * build writes what it says, and the credits check asks it who produced a file
 * it found committed. A file the plan does not know about is a file nobody
 * credited, so a hole here is a hole in the licensing.
 */

import { describe, expect, it } from 'vitest'

import { modelOutputFor, planBuild, textureOutputFor } from './plan.ts'
import type { CreditEntry } from './registry.ts'

const texture = (name: string, overrides: Partial<CreditEntry> = {}): CreditEntry => ({
  id: name,
  title: name,
  author: 'test',
  source: 'https://example.com',
  licence: 'CC0-1.0',
  kind: 'texture',
  textureClass: 'albedo',
  files: [`assets/textures/${name}`],
  ...overrides,
})

const model: CreditEntry = {
  id: 'crate',
  title: 'Crate',
  author: 'test',
  source: 'https://example.com',
  licence: 'CC0-1.0',
  kind: 'model',
  files: ['assets/models/crate.gltf', 'assets/models/crate.bin'],
}

describe('where a source ends up', () => {
  it('gives a texture the same name with a .ktx2 on it', () => {
    expect(textureOutputFor('assets/textures/floor_albedo.png')).toBe(
      'packages/client/public/textures/floor_albedo.ktx2',
    )
  })

  it('ships a model as .gltf whatever it was authored as', () => {
    // The output carries external `.ktx2` references, and a `.glb` cannot: the
    // textures would have to be embedded, and then one texture on ten props is
    // ten copies of it. docs/assets.md §4.
    expect(modelOutputFor('assets/models/crate.glb')).toBe(
      'packages/client/public/models/crate.gltf',
    )
  })

  it('plans the buffer that goes beside the model', () => {
    const plan = planBuild({ entries: [model] })
    expect(plan.outputs.has('packages/client/public/models/crate.gltf')).toBe(true)
    expect(plan.outputs.has('packages/client/public/models/crate.bin')).toBe(true)
  })

  it('tells a model how to reach a texture from where it lives', () => {
    const plan = planBuild({ entries: [texture('floor.png')] })
    expect(plan.textureUris.get('floor.png')?.uri).toBe('../textures/floor.ktx2')
  })
})

describe('what it refuses', () => {
  it('refuses two source textures with the same filename', () => {
    // A model refers to a texture by filename, so two of them is a rewrite with
    // no answer — and the wrong one would ship silently.
    expect(() =>
      planBuild({
        entries: [
          texture('floor.png'),
          texture('floor.png', { id: 'other', files: ['assets/props/floor.png'] }),
        ],
      }),
    ).toThrow(/have to be unique/)
  })

  it('refuses a texture that is not a PNG', () => {
    expect(() =>
      planBuild({ entries: [texture('floor.jpg', { files: ['assets/textures/floor.jpg'] })] }),
    ).toThrow(/not a \.png/)
  })

  it('refuses a model entry with no model in it', () => {
    expect(() =>
      planBuild({ entries: [{ ...model, files: ['assets/models/crate.bin'] }] }),
    ).toThrow(/no \.gltf or \.glb/)
  })
})
