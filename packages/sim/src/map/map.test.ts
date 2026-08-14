import { describe, expect, it } from 'vitest'

import { PLAYER_MAXS, PLAYER_MINS } from '../bbox.ts'
import { boxPenetration, planeOffset, plane } from '../collide.ts'
import { createTrace, traceBox, traceRay } from '../trace.ts'
import { createMapWorld, mapBrushPlanes, rampLowHeight, rampSlopePlane } from './collide.ts'
import { mapGeometry } from './geometry.ts'
import { hashMapSource, loadMap, mapHashOf, parseBakedMap, parseMapSource } from './load.ts'
import { MAP_FORMAT_VERSION, RAMP_SLOPES } from './schema.ts'
import type { MapRampBrush, MapSource } from './schema.ts'
import { validateMap } from './validate.ts'

/** A sealed room with one of everything. Mirrors `maps/testbed.ts` in miniature. */
function fixture(over: Partial<MapSource> = {}): MapSource {
  return {
    name: 'fixture',
    title: 'Fixture',
    author: 'test',
    surfaces: [
      { name: 'shell', material: 'concrete', tint: [0.3, 0.3, 0.3] },
      { name: 'metal', material: 'metal', tint: [0.5, 0.4, 0.3] },
    ],
    brushes: [
      { kind: 'box', surface: 'shell', mins: [-512, -512, -64], maxs: [512, 512, 0] },
      { kind: 'box', surface: 'shell', mins: [-512, -512, 256], maxs: [512, 512, 320] },
      {
        kind: 'ramp',
        surface: 'metal',
        mins: [0, -128, -64],
        maxs: [128, 128, 128],
        rise: '+x',
        slope: '1:1',
      },
    ],
    spawns: [
      { origin: [-384, 0, 0], yaw: 0 },
      { origin: [384, 0, 0], yaw: 32768 },
    ],
    lights: [],
    props: [],
    ...over,
  }
}

const RAMP: MapRampBrush = {
  kind: 'ramp',
  surface: 'metal',
  mins: [0, -128, -64],
  maxs: [128, 128, 128],
  rise: '+x',
  slope: '1:1',
}

describe('ramps', () => {
  it('put the sloped face on the top of the box at the high end of the run', () => {
    const p = plane(rampSlopePlane(RAMP).normal, rampSlopePlane(RAMP).dist)
    // The high corner, (128, *, 128), lies on the plane.
    expect(p.normal[0] * 128 + p.normal[2] * 128 - p.dist).toBeCloseTo(0, 9)
  })

  it('fall by exactly the run at 1:1 and half of it at 1:2', () => {
    expect(rampLowHeight(RAMP)).toBe(0)
    expect(rampLowHeight({ ...RAMP, slope: '1:2' })).toBe(64)
  })

  it('have unit normals whose z is the cosine of the authored angle', () => {
    // The whole point of restricting the gradients: 1:1 lands a hair above
    // MIN_WALK_NORMAL (0.7) and 1:2 comfortably above it, and both are exact
    // ratios rather than a human's rounding of a degree measure.
    const steep = plane(rampSlopePlane(RAMP).normal, rampSlopePlane(RAMP).dist)
    const gentle = plane(
      rampSlopePlane({ ...RAMP, slope: '1:2' }).normal,
      rampSlopePlane({ ...RAMP, slope: '1:2' }).dist,
    )
    expect(steep.normal[2]).toBeCloseTo(Math.sqrt(0.5), 12)
    expect(gentle.normal[2]).toBeCloseTo(2 / Math.sqrt(5), 12)
    expect(RAMP_SLOPES['1:1'].degrees).toBe(45)
  })

  it('face back along the rise, whichever way it runs', () => {
    for (const [rise, axis, sign] of [
      ['+x', 0, -1],
      ['-x', 0, 1],
      ['+y', 1, -1],
      ['-y', 1, 1],
    ] as const) {
      const spec = rampSlopePlane({ ...RAMP, rise })
      expect(Math.sign(spec.normal[axis])).toBe(sign)
      expect(spec.normal[2]).toBeGreaterThan(0)
    }
  })

  it('are walkable geometry a trace can land on', () => {
    const world = createMapWorld(fixture())
    const trace = createTrace()
    // Drop a player onto the slope. At 1:1 the surface height is the `x`
    // coordinate, and a 30-wide box centred on x = 64 rests on its leading
    // bottom edge at x = 79 — not on its centre. That the answer is 79 and not
    // 64 is the Minkowski offset doing its job.
    traceBox(trace, world, [64, 0, 200], [64, 0, 0], PLAYER_MINS, PLAYER_MAXS)
    expect(trace.fraction).toBeLessThan(1)
    expect(trace.endpos[2]).toBeGreaterThan(78.9)
    expect(trace.endpos[2]).toBeLessThan(79.3)
    expect(trace.planeNormal[2]).toBeCloseTo(Math.sqrt(0.5), 6)
  })
})

describe('the collision world', () => {
  it('leaves nonSolid brushes out of it, and keeps noRender brushes in', () => {
    const map = fixture({
      brushes: [
        { kind: 'box', surface: 'shell', mins: [-512, -512, -64], maxs: [512, 512, 0] },
        { kind: 'box', surface: 'shell', mins: [-512, -512, 256], maxs: [512, 512, 320] },
        { kind: 'box', surface: 'metal', mins: [0, 0, 0], maxs: [64, 64, 64], nonSolid: true },
        { kind: 'box', surface: 'metal', mins: [128, 0, 0], maxs: [192, 64, 64], noRender: true },
      ],
    })
    const world = createMapWorld(map)
    expect(world.brushes.length).toBe(3)

    const trace = createTrace()
    traceRay(trace, world, [32, -100, 32], [32, 200, 32])
    expect(trace.fraction).toBe(1) // straight through the glass
    traceRay(trace, world, [160, -100, 32], [160, 200, 32])
    expect(trace.fraction).toBeLessThan(1) // stopped by the clip brush
  })

  it('remembers which source brush each collision brush came from', () => {
    const map = fixture({
      brushes: [
        { kind: 'box', surface: 'shell', mins: [-512, -512, -64], maxs: [512, 512, 0] },
        { kind: 'box', surface: 'metal', mins: [0, 0, 0], maxs: [64, 64, 64], nonSolid: true },
        { kind: 'box', surface: 'shell', mins: [-512, -512, 256], maxs: [512, 512, 320] },
      ],
    })
    const loaded = loadMap({ format: MAP_FORMAT_VERSION, hash: mapHashOf(map), map })
    // The nonSolid brush is gone, so world brush 1 is source brush 2.
    expect(Array.from(loaded.sourceBrush)).toEqual([0, 2])
  })
})

/**
 * The load-bearing property of the whole format.
 *
 * Every triangle the client draws was cut out of a plane the trace uses. If
 * these ever come apart, a wall can look solid and not be — which is the class
 * of bug the derived-geometry design exists to make unreachable.
 */
describe('render geometry is derived from the collision planes', () => {
  it('puts every vertex on the surface of the brush it was cut from', () => {
    const map = fixture()
    const geometry = mapGeometry(map)
    expect(geometry.positions.length).toBeGreaterThan(0)

    for (let v = 0; v < geometry.positions.length / 3; v += 1) {
      const point: [number, number, number] = [
        geometry.positions[v * 3] ?? 0,
        geometry.positions[v * 3 + 1] ?? 0,
        geometry.positions[v * 3 + 2] ?? 0,
      ]

      // Some brush of the map has this vertex on its boundary and none of it
      // inside: on at least one plane, and behind (or on) all of them.
      const belongs = map.brushes.some((brushDef) => {
        const planes = mapBrushPlanes(brushDef).map((s) => plane(s.normal, s.dist))
        let touching = false
        for (const p of planes) {
          const d = p.normal[0] * point[0] + p.normal[1] * point[1] + p.normal[2] * point[2] - p.dist
          if (d > 1e-3) return false
          if (d > -1e-3) touching = true
        }
        return touching
      })
      expect(belongs, `vertex ${v} at ${point.join(', ')} is not on any brush`).toBe(true)
    }
  })

  it('draws a nonSolid brush and skips a noRender one', () => {
    const brushes = [
      { kind: 'box', surface: 'metal', mins: [0, 0, 0], maxs: [64, 64, 64] },
    ] as const
    const drawn = mapGeometry(fixture({ brushes: [{ ...brushes[0], nonSolid: true }] }))
    const hidden = mapGeometry(fixture({ brushes: [{ ...brushes[0], noRender: true }] }))
    expect(drawn.indices.length).toBe(36) // six quads, two triangles each
    expect(hidden.indices.length).toBe(0)
  })

  it('gives a box six quads and a ramp one sloped face among its six', () => {
    const boxOnly = mapGeometry(
      fixture({ brushes: [{ kind: 'box', surface: 'metal', mins: [0, 0, 0], maxs: [64, 64, 64] }] }),
    )
    expect(boxOnly.indices.length / 3).toBe(12)

    // A ramp has six planes too — the box's `+z` is *replaced* by the slope,
    // never added to. Nothing in the mesh builder knows that: it finds five
    // axis-aligned faces and one that is not, because that is what the planes
    // say. The plinth the validator insists on is why none of the six is
    // degenerate.
    const rampOnly = mapGeometry(fixture({ brushes: [RAMP] }))
    const faces = new Set<string>()
    for (let v = 0; v < rampOnly.normals.length; v += 3) {
      faces.add(
        `${rampOnly.normals[v]?.toFixed(3)},${rampOnly.normals[v + 1]?.toFixed(3)},${rampOnly.normals[v + 2]?.toFixed(3)}`,
      )
    }
    expect(faces.size).toBe(6)
    const oblique = [...faces].filter((n) => !n.split(',').includes('1.000') && !n.split(',').includes('-1.000'))
    expect(oblique).toEqual([`${(-Math.sqrt(0.5)).toFixed(3)},0.000,${Math.sqrt(0.5).toFixed(3)}`])
  })

  it('winds its triangles counter-clockwise seen from outside the solid', () => {
    const geometry = mapGeometry(
      fixture({ brushes: [{ kind: 'box', surface: 'metal', mins: [0, 0, 0], maxs: [64, 64, 64] }] }),
    )
    for (let t = 0; t < geometry.indices.length; t += 3) {
      const [ia, ib, ic] = [
        geometry.indices[t] ?? 0,
        geometry.indices[t + 1] ?? 0,
        geometry.indices[t + 2] ?? 0,
      ]
      const read = (i: number, k: number): number => geometry.positions[i * 3 + k] ?? 0
      const ux = read(ib, 0) - read(ia, 0)
      const uy = read(ib, 1) - read(ia, 1)
      const uz = read(ib, 2) - read(ia, 2)
      const vx = read(ic, 0) - read(ia, 0)
      const vy = read(ic, 1) - read(ia, 1)
      const vz = read(ic, 2) - read(ia, 2)
      // cross(u, v) should point the same way as the face normal.
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      const dot =
        nx * (geometry.normals[ia * 3] ?? 0) +
        ny * (geometry.normals[ia * 3 + 1] ?? 0) +
        nz * (geometry.normals[ia * 3 + 2] ?? 0)
      expect(dot).toBeGreaterThan(0)
    }
  })

  it('groups triangles by surface, contiguously and in declaration order', () => {
    const geometry = mapGeometry(fixture())
    expect(geometry.groups.map((g) => g.surface)).toEqual(['shell', 'metal'])
    let cursor = 0
    for (const group of geometry.groups) {
      expect(group.indexStart).toBe(cursor)
      cursor += group.indexCount
    }
    expect(cursor).toBe(geometry.indices.length)
  })

  it('agrees with the trace about where a wall is', () => {
    // Fire a ray at the pillar and check the impact point is on a drawn face,
    // which is the same statement as "the wall you see is the wall you hit".
    const map = fixture({
      brushes: [
        { kind: 'box', surface: 'shell', mins: [-512, -512, -64], maxs: [512, 512, 0] },
        { kind: 'box', surface: 'metal', mins: [-64, -64, 0], maxs: [64, 64, 256] },
      ],
    })
    const trace = createTrace()
    traceRay(trace, createMapWorld(map), [-400, 0, 128], [400, 0, 128])
    expect(trace.fraction).toBeLessThan(1)

    const geometry = mapGeometry(map)
    let nearest = Infinity
    for (let v = 0; v < geometry.positions.length; v += 3) {
      const dx = (geometry.positions[v] ?? 0) - trace.endpos[0]
      const dz = (geometry.positions[v + 2] ?? 0) - trace.endpos[2]
      // Only the plane matters: the impact is in the middle of a face, not on
      // a vertex, so compare the `x` the face sits at.
      if (Math.abs(dx) < nearest && Math.abs(dz) < 256) nearest = Math.abs(dx)
    }
    // SURFACE_CLIP_EPSILON is 0.125, and nothing else may be between them.
    expect(nearest).toBeLessThanOrEqual(0.125)
  })
})

describe('the map hash', () => {
  it('changes when any field the sim or the renderer reads changes', () => {
    const base = hashMapSource(fixture())
    expect(hashMapSource(fixture({ name: 'other' }))).not.toBe(base)
    expect(hashMapSource(fixture({ title: 'Other' }))).not.toBe(base)
    expect(
      hashMapSource(fixture({ spawns: [{ origin: [-384, 0, 0], yaw: 1 }, { origin: [384, 0, 0], yaw: 32768 }] })),
    ).not.toBe(base)
    expect(
      hashMapSource(
        fixture({ lights: [{ origin: [0, 0, 128], color: [1, 1, 1], intensity: 1, radius: 512 }] }),
      ),
    ).not.toBe(base)
    expect(
      hashMapSource(fixture({ props: [{ model: 'a.glb', origin: [0, 0, 0], yaw: 0, scale: 1 }] })),
    ).not.toBe(base)
  })

  it('distinguishes maps whose strings would concatenate the same way', () => {
    // The length prefix earning its keep: without it these two hash alike.
    const a = fixture({ name: 'ab', title: 'c' })
    const b = fixture({ name: 'a', title: 'bc' })
    expect(hashMapSource(a)).not.toBe(hashMapSource(b))
  })

  it('is unchanged by a JSON round trip', () => {
    const map = fixture()
    const copy = parseMapSource(JSON.parse(JSON.stringify(map)))
    expect(hashMapSource(copy)).toBe(hashMapSource(map))
  })

  it('separates a nonSolid brush from an identical solid one', () => {
    const solid = fixture({
      brushes: [{ kind: 'box', surface: 'metal', mins: [0, 0, 0], maxs: [64, 64, 64] }],
    })
    const ghost = fixture({
      brushes: [
        { kind: 'box', surface: 'metal', mins: [0, 0, 0], maxs: [64, 64, 64], nonSolid: true },
      ],
    })
    expect(hashMapSource(ghost)).not.toBe(hashMapSource(solid))
  })
})

describe('loading a baked map', () => {
  function bakedFixture(): unknown {
    const map = fixture()
    return JSON.parse(JSON.stringify({ format: MAP_FORMAT_VERSION, hash: mapHashOf(map), map }))
  }

  it('accepts what the baker wrote', () => {
    const loaded = loadMap(bakedFixture())
    expect(loaded.hash).toMatch(/^[0-9a-f]{8}$/)
    expect(loaded.world.brushes.length).toBe(3)
    expect(validateMap(loaded.source)).toEqual([])
  })

  it('refuses an artifact whose contents no longer match its hash', () => {
    const baked = bakedFixture() as { hash: string; map: MapSource }
    const edited = {
      ...baked,
      map: {
        ...baked.map,
        brushes: [
          { kind: 'box', surface: 'shell', mins: [-512, -512, -64], maxs: [512, 512, 1] },
          ...baked.map.brushes.slice(1),
        ],
      },
    }
    expect(() => loadMap(edited)).toThrow(/edited by hand|different build/)
  })

  it('refuses an artifact from another format version', () => {
    const baked = bakedFixture() as Record<string, unknown>
    expect(() => loadMap({ ...baked, format: MAP_FORMAT_VERSION + 1 })).toThrow(/map:bake/)
  })

  it('names the field when the JSON is the wrong shape', () => {
    expect(() => parseBakedMap({ format: MAP_FORMAT_VERSION, hash: 'zzzzzzzz', map: fixture() })).toThrow(
      /eight lowercase hex digits/,
    )
    expect(() =>
      parseMapSource({ ...fixture(), brushes: [{ kind: 'wedge', surface: 'shell', mins: [0, 0, 0], maxs: [1, 1, 1] }] }),
    ).toThrow(/map\.brushes\[0\]\.kind/)
  })
})

describe('the validator', () => {
  it('passes a map with nothing wrong with it', () => {
    expect(validateMap(fixture())).toEqual([])
  })

  it('measures headroom with the player box the game uses', () => {
    // A spawn is clear when a standing player is clear, not when a point is.
    const map = fixture({
      brushes: [
        { kind: 'box', surface: 'shell', mins: [-512, -512, -64], maxs: [512, 512, 0] },
        { kind: 'box', surface: 'shell', mins: [-512, -512, 256], maxs: [512, 512, 320] },
        // Two slabs 20 units apart: a point passes between them, a 30-wide
        // player does not.
        { kind: 'box', surface: 'metal', mins: [-512, -512, 0], maxs: [-394, 512, 128] },
        { kind: 'box', surface: 'metal', mins: [-374, -512, 0], maxs: [512, 512, 128] },
      ],
    })
    const world = createMapWorld(map)
    expect(boxPenetration(world, [-384, 0, 0], PLAYER_MINS, PLAYER_MAXS)).toBeGreaterThan(0)
    expect(validateMap(map).map((d) => d.code)).toContain('spawn-in-solid')
  })

  it('reports every problem it finds, not only the first', () => {
    const map = fixture({
      surfaces: [
        { name: 'shell', material: 'concrete', tint: [1, 1, 1] },
        { name: 'metal', material: 'metal', tint: [1, 1, 1] },
        { name: 'ghost', material: 'nothing', tint: [1, 1, 1] },
        { name: 'phantom', material: 'nothing', tint: [1, 1, 1] },
      ],
    })
    expect(validateMap(map).filter((d) => d.code === 'unreferenced-surface').length).toBe(2)
  })
})

describe('the Minkowski offset the map path shares with the trace', () => {
  it('is the same function the world uses, not a copy of it', () => {
    // A regression guard with a short life: if `map/collide.ts` ever grows its
    // own idea of how a box meets a plane, this is where it shows up.
    const p = plane([0, 0, 1], 0)
    expect(planeOffset(p, PLAYER_MINS, PLAYER_MAXS)).toBe(PLAYER_MINS[2])
  })
})
