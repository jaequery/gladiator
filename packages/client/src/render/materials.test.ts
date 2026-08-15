/**
 * The material catalogue, and the two settings that pay for this ticket.
 *
 * `disableLighting` is the one that costs money if it regresses: it removes the
 * light loop from the fragment shader of the biggest thing on screen, which is
 * the whole reason baking the arena's light was worth doing. And the albedo
 * living in `emissiveColor` rather than in `ambientColor` is the one that looks
 * like a mistake and gets "fixed" — so both are asserted against a real Babylon
 * material rather than left to a comment.
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import type { MapSurface } from '@gladiator/sim'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_LOOK,
  SURFACE_LOOKS,
  createSurfaceMaterial,
  lookFor,
  takesLightmap,
} from './materials.ts'
import { createScene } from './scene.ts'

let scene = createScene(new NullEngine())

beforeEach(() => {
  scene = createScene(new NullEngine())
})

const surface = (material: string, tint: [number, number, number] = [0.4, 0.3, 0.2]): MapSurface => ({
  name: `test:${material}`,
  material,
  tint,
})

describe('the catalogue', () => {
  it('has the five materials the ticket budgeted for', () => {
    expect(Object.keys(SURFACE_LOOKS).sort()).toEqual([
      'concrete',
      'glass',
      'light',
      'metal',
      'trim',
    ])
  })

  it('falls back rather than failing on a material it has never heard of', () => {
    // A map naming a material this build does not know is a version skew, and a
    // level that draws beats a level that throws.
    expect(lookFor('adamantium')).toBe(DEFAULT_LOOK)
    expect(lookFor('concrete')).toBe(DEFAULT_LOOK)
  })
})

describe('createSurfaceMaterial', () => {
  it('switches the light loop off, because every photon is already baked', () => {
    const material = createSurfaceMaterial(scene, surface('concrete'), null)
    expect(material.disableLighting).toBe(true)
    // And nothing for a specular to answer to, so there is no specular.
    expect(material.specularColor.asArray()).toEqual([0, 0, 0])
  })

  it('carries the albedo in emissiveColor, outside the scene ambient', () => {
    // `vAmbientColor` is `scene.ambientColor * material.ambientColor`, and the
    // scene half is tuned for the player models. Putting the arena's albedo
    // through it would mean re-grading a model in shadow re-graded every wall.
    const look = SURFACE_LOOKS['metal']
    if (look === undefined) throw new Error('no metal')
    const material = createSurfaceMaterial(scene, surface('metal', [0.4, 0.2, 0.1]), null)
    expect(material.emissiveColor.r).toBeCloseTo(0.4 * look.tintGain, 5)
    expect(material.emissiveColor.g).toBeCloseTo(0.2 * look.tintGain, 5)
    expect(material.ambientColor.asArray()).toEqual([0, 0, 0])
  })

  it('never attaches a lightmap itself', () => {
    // `applyLightmap` is the only thing in the client allowed to.
    // `docs/assets.md` §3.
    const material = createSurfaceMaterial(scene, surface('concrete'), null)
    expect(material.lightmapTexture).toBeNull()
  })

  it('makes glass see-through and visible from both sides', () => {
    const material = createSurfaceMaterial(scene, surface('glass'), null)
    expect(material.alpha).toBeLessThan(1)
    // A pane has two sides and a player can be on either of them.
    expect(material.backFaceCulling).toBe(false)
  })

  it('opts a self-lit surface out of the bake', () => {
    // Nothing lights a light: the bake *multiplies* what it is attached to, so
    // a lamp in a dark corner would be baked dark, which is the opposite of the
    // one thing a lamp has to do.
    expect(takesLightmap(surface('light'))).toBe(false)
    expect(takesLightmap(surface('concrete'))).toBe(true)
    expect(takesLightmap(surface('metal'))).toBe(true)

    // A fixture saturates and a wall does not, which is what makes one read as
    // a source of light and the other as a thing light falls on.
    const lamp = createSurfaceMaterial(scene, surface('light', [1, 0.94, 0.82]), null)
    expect(lamp.emissiveColor.r).toBeGreaterThanOrEqual(1)
    expect(lamp.emissiveColor.b).toBeLessThan(1)
    const wall = createSurfaceMaterial(scene, surface('concrete', [0.22, 0.23, 0.26]), null)
    expect(wall.emissiveColor.r).toBeLessThan(0.5)
  })
})
