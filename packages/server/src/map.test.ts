/**
 * The server loads a baked map and collides against it, in plain Node.
 *
 * This is the acceptance criterion written as a test. Everything here runs in
 * `environment: 'node'` with no canvas, no WebGL context, no `window`, no
 * `document` and no asset loader — because the authoritative simulation has to
 * run on a Fly machine with no GPU, and "it works in the browser" is not the
 * claim being made.
 *
 * The complementary half is mechanical rather than testable from here:
 * `packages/sim` declares zero dependencies, has `lib: ["ES2023"]` and
 * `types: []`, and `pnpm run guardrails` writes a `document.title` into it and
 * fails if the typecheck lets it through. So the map code *cannot* have reached
 * for a browser global on the way to this file.
 */
import {
  MIN_SPAWN_HEADROOM,
  MIN_SPAWN_SEPARATION,
  PLAYER_MAXS,
  PLAYER_MINS,
  boxPenetration,
  createTrace,
  mapGeometry,
  mapHashOf,
  traceBox,
  traceRay,
  validateMap,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { SERVER_MAP, SERVER_MAP_HASH } from './map.ts'

describe('the server map', () => {
  it('loads from the committed artifact without a browser anywhere in sight', () => {
    expect('document' in globalThis).toBe(false)
    expect(SERVER_MAP.source.name).toBe('testbed')
    expect(SERVER_MAP.world.brushes.length).toBeGreaterThan(0)
  })

  it('carries a hash it recomputed rather than one it read', () => {
    expect(SERVER_MAP_HASH).toMatch(/^[0-9a-f]{8}$/)
    expect(mapHashOf(SERVER_MAP.source)).toBe(SERVER_MAP_HASH)
  })

  it('is a map the validator still accepts', () => {
    expect(validateMap(SERVER_MAP.source)).toEqual([])
  })
})

describe('collision against the loaded map', () => {
  it('stops a player who walks into a wall', () => {
    const trace = createTrace()
    // Along an empty lane at y = -300, straight at the +x wall at x = 512.
    traceBox(trace, SERVER_MAP.world, [0, -300, 0], [1024, -300, 0], PLAYER_MINS, PLAYER_MAXS)
    expect(trace.fraction).toBeLessThan(1)
    // Stopped by the wall's inward face, one player half-width short of it.
    expect(trace.endpos[0]).toBeGreaterThan(512 - 16)
    expect(trace.endpos[0]).toBeLessThan(512 - 14)
    expect(trace.planeNormal[0]).toBe(-1)
  })

  it('drops a player onto the floor rather than through it', () => {
    const trace = createTrace()
    traceBox(trace, SERVER_MAP.world, [256, -256, 400], [256, -256, -400], PLAYER_MINS, PLAYER_MAXS)
    expect(trace.fraction).toBeLessThan(1)
    expect(trace.endpos[2]).toBeGreaterThanOrEqual(0)
    expect(trace.endpos[2]).toBeLessThan(1)
    expect(trace.planeNormal[2]).toBe(1)
  })

  it('lands a player on the ramp at the height the slope says', () => {
    const trace = createTrace()
    // The 1:1 ramp runs from x = 0 to x = 128; the surface height is `x`.
    // A box centred on x = 32 rests on its leading edge at x = 47.
    traceBox(trace, SERVER_MAP.world, [32, -128, 300], [32, -128, 0], PLAYER_MINS, PLAYER_MAXS)
    expect(trace.endpos[2]).toBeGreaterThan(46.8)
    expect(trace.endpos[2]).toBeLessThan(47.3)
    expect(trace.planeNormal[2]).toBeCloseTo(Math.sqrt(0.5), 6)
  })

  it('shoots straight through the nonSolid glass and stops at the clip brush', () => {
    const trace = createTrace()
    traceRay(trace, SERVER_MAP.world, [264, -256, 64], [264, 256, 64])
    expect(trace.fraction).toBe(1)

    traceRay(trace, SERVER_MAP.world, [-264, -256, 64], [-264, 256, 64])
    expect(trace.fraction).toBeLessThan(1)
  })

  it('seals the arena: nothing escapes in any of the six directions', () => {
    const trace = createTrace()
    for (const end of [
      [4096, 0, 64],
      [-4096, 0, 64],
      [0, 4096, 64],
      [0, -4096, 64],
      [0, 0, 4096],
      [0, 0, -4096],
    ] as const) {
      // From beside the central pillar, so the ray starts in open space.
      traceRay(trace, SERVER_MAP.world, [200, 200, 64], end)
      expect(trace.fraction, `escaped towards ${end.join(', ')}`).toBeLessThan(1)
    }
  })

  it("has spawns the map's own rules would still accept", () => {
    for (const spawn of SERVER_MAP.source.spawns) {
      expect(boxPenetration(SERVER_MAP.world, spawn.origin, PLAYER_MINS, PLAYER_MAXS)).toBe(0)
    }
    const [a, b] = SERVER_MAP.source.spawns
    if (a === undefined || b === undefined) throw new Error('a duel map has two spawns')
    const dx = b.origin[0] - a.origin[0]
    const dy = b.origin[1] - a.origin[1]
    const dz = b.origin[2] - a.origin[2]
    expect(Math.sqrt(dx * dx + dy * dy + dz * dz)).toBeGreaterThanOrEqual(MIN_SPAWN_SEPARATION)

    // And there is room to stand up and jump in each of them.
    const trace = createTrace()
    for (const spawn of SERVER_MAP.source.spawns) {
      traceBox(
        trace,
        SERVER_MAP.world,
        spawn.origin,
        [spawn.origin[0], spawn.origin[1], spawn.origin[2] + MIN_SPAWN_HEADROOM - PLAYER_MAXS[2]],
        [PLAYER_MINS[0], PLAYER_MINS[1], PLAYER_MAXS[2]],
        PLAYER_MAXS,
      )
      expect(trace.fraction).toBe(1)
    }
  })
})

describe('render geometry, built headless', () => {
  it('comes out of the same brushes without a GPU being involved', () => {
    // The client will upload this to Babylon. The server builds it here only to
    // prove the derivation needs nothing a browser has — which is what makes it
    // testable at all, and what makes the bot able to reason about the same
    // geometry the player sees.
    const geometry = mapGeometry(SERVER_MAP.source)
    expect(geometry.positions.length % 3).toBe(0)
    expect(geometry.indices.length % 3).toBe(0)
    expect(geometry.groups.map((g) => g.surface)).toEqual(['floor', 'wall', 'metal', 'glass'])
  })
})
