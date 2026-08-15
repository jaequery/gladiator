/**
 * The pass count, asserted rather than remembered.
 *
 * The agreed number is **zero**, and it is a latency budget rather than a taste
 * preference: a full-screen pass is a round trip through a render target on
 * every frame, paid to make a *still* frame prettier, in a game where a flick
 * has to land. `docs/renderer.md` §5.
 *
 * ESLint bans the names (`scripts/guardrails.mjs` proves it fires), which stops
 * a pass being *imported*. This stops one being *attached* — through a
 * rendering pipeline built somewhere else, through
 * `imageProcessingConfiguration.applyByPostProcess`, or by anything Babylon
 * decides to add on our behalf when a setting is switched on.
 */

import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { type MapSource, mapGeometry } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { buildMapMesh } from './mapMesh.ts'
import { addLighting, createCamera, createScene } from './scene.ts'

/** A room with a light in it, so `addLighting` has something to read. */
const MAP: MapSource = {
  name: 'passtest',
  title: 'Pass test',
  author: 'test',
  surfaces: [{ name: 'floor', material: 'concrete', tint: [0.3, 0.3, 0.3] }],
  brushes: [{ kind: 'box', surface: 'floor', mins: [-256, -256, -64], maxs: [256, 256, 0] }],
  spawns: [],
  lights: [{ origin: [0, 0, 256], color: [1, 1, 1], intensity: 1, radius: 900 }],
  props: [],
}

function build() {
  const scene = createScene(new NullEngine())
  const camera = createCamera(scene)
  // The whole arena, built the way the renderer builds it. No detail textures:
  // drawing one needs a canvas, and this is about what is *not* in the frame.
  const arena = buildMapMesh(scene, MAP, mapGeometry(MAP), null)
  addLighting(scene, MAP, arena.mesh)
  return { scene, camera, arena }
}

describe('the post-processing chain', () => {
  it('is empty on the scene and on the camera', () => {
    const { scene, camera } = build()
    expect(scene.postProcesses).toHaveLength(0)
    expect(camera._postProcesses.filter((pass) => pass !== null)).toHaveLength(0)
  })

  it('has no rendering pipeline attached', () => {
    // The one-line version of "add bloom" registers itself with the scene's
    // pipeline manager rather than with the camera, so the camera check above
    // would not see it.
    //
    // The manager being *undefined* is the stronger answer rather than a hole
    // in the test: Babylon installs that accessor from a side-effect import
    // which building a pipeline would have pulled in, so its absence means
    // nothing in this client has so much as loaded the machinery.
    const { scene } = build()
    const manager = (
      scene as unknown as {
        postProcessRenderPipelineManager?: { supportedPipelines: readonly unknown[] }
      }
    ).postProcessRenderPipelineManager
    expect(manager?.supportedPipelines ?? []).toHaveLength(0)
  })

  it('folds tone mapping into the materials instead of running it as a pass', () => {
    // The one exception, and the reason it is allowed: with
    // `applyByPostProcess` off Babylon compiles ACES into each material's
    // fragment shader, so it costs a few instructions rather than a round trip.
    const { scene } = build()
    const processing = scene.imageProcessingConfiguration
    expect(processing.toneMappingEnabled).toBe(true)
    expect(processing.applyByPostProcess).toBe(false)
  })

  it('lights the arena with no light at all', () => {
    // The other half of the budget this ticket spent: the arena's fragment
    // shader has no light loop in it, because every photon is in the bake. The
    // one real-time light in the scene is for the things that move, and the
    // arena is excluded from it.
    const { scene, arena } = build()
    expect(scene.lights).toHaveLength(1)
    expect(scene.lights[0]?.excludedMeshes).toContain(arena.mesh)
    for (const material of arena.lightmapped) expect(material.disableLighting).toBe(true)
  })
})
