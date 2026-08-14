import { describe, expect, it } from 'vitest'

import { PLAYER_MAXS, PLAYER_MINS } from './bbox.ts'
import { boxBrush, brush, createCollisionWorld } from './collide.ts'
import { SURFACE_CLIP_EPSILON, createTrace, traceBox, traceRay } from './trace.ts'

/** One wall, 64 units thick, its near face at x = 100. No floor: see below. */
const wallWorld = createCollisionWorld([boxBrush([100, -256, 0], [164, 256, 192])])

/** The same wall, eight units thick. */
const thinWallWorld = createCollisionWorld([boxBrush([100, -256, 0], [108, 256, 192])])

describe('traceBox', () => {
  it('reports a clean miss as fraction 1 and the endpoint asked for', () => {
    const trace = traceBox(
      createTrace(),
      wallWorld,
      [0, 0, 0],
      [50, 0, 0],
      PLAYER_MINS,
      PLAYER_MAXS,
    )
    expect(trace.fraction).toBe(1)
    expect(trace.endpos).toEqual([50, 0, 0])
    expect(trace.planeNormal).toEqual([0, 0, 0])
    expect(trace.brushIndex).toBe(-1)
    expect(trace.startsolid).toBe(false)
    expect(trace.allsolid).toBe(false)
  })

  it('stops the box with its face against the wall, not its origin', () => {
    const trace = traceBox(
      createTrace(),
      wallWorld,
      [0, 0, 0],
      [200, 0, 0],
      PLAYER_MINS,
      PLAYER_MAXS,
    )
    // The box is 15 units wide either side of its origin, so the origin stops
    // 15 units (less the epsilon) short of the wall.
    expect(trace.endpos[0]).toBeCloseTo(100 - PLAYER_MAXS[0] - SURFACE_CLIP_EPSILON, 9)
    expect(trace.fraction).toBeCloseTo(84.875 / 200, 12)
    expect(trace.planeNormal).toEqual([-1, 0, 0])
    expect(trace.brushIndex).toBe(0)
  })

  it('leaves exactly the clip epsilon of daylight, so the next tick is not on the boundary', () => {
    const trace = traceBox(
      createTrace(),
      wallWorld,
      [0, 0, 0],
      [200, 0, 0],
      PLAYER_MINS,
      PLAYER_MAXS,
    )
    const gap = 100 - (trace.endpos[0] + PLAYER_MAXS[0])
    expect(gap).toBeCloseTo(SURFACE_CLIP_EPSILON, 9)
    expect(gap).toBeGreaterThan(0)
  })

  it('is swept: a move far longer than the wall is thick still hits it', () => {
    // 500 units in one call, through a wall 8 units thick. A trace that tested
    // the endpoint would find nothing but empty space on the far side.
    const trace = traceBox(
      createTrace(),
      thinWallWorld,
      [0, 0, 0],
      [500, 0, 0],
      PLAYER_MINS,
      PLAYER_MAXS,
    )
    expect(trace.fraction).toBeLessThan(1)
    expect(trace.endpos[0]).toBeCloseTo(100 - PLAYER_MAXS[0] - SURFACE_CLIP_EPSILON, 9)
  })

  it('finds the nearest of several brushes', () => {
    const world = createCollisionWorld([
      boxBrush([300, -256, 0], [364, 256, 192]),
      boxBrush([100, -256, 0], [164, 256, 192]),
    ])
    const trace = traceBox(createTrace(), world, [0, 0, 0], [500, 0, 0], PLAYER_MINS, PLAYER_MAXS)
    expect(trace.brushIndex).toBe(1)
    expect(trace.endpos[0]).toBeCloseTo(84.875, 9)
  })

  it('reports the normal of a 45-degree ramp, not of the box that bounds it', () => {
    // z <= x - 128 over x in [128, 256]. Approached at z = 64, half way up it,
    // so the sloped face is what is hit rather than the knife edge at its foot.
    const rampWorld = createCollisionWorld([
      brush([
        { normal: [0, 0, -1], dist: 0 },
        { normal: [-1, 0, 0], dist: -128 },
        { normal: [1, 0, 0], dist: 256 },
        { normal: [0, 1, 0], dist: 128 },
        { normal: [0, -1, 0], dist: 128 },
        { normal: [-1, 0, 1], dist: -128 },
      ]),
    ])
    const trace = traceBox(
      createTrace(),
      rampWorld,
      [0, 0, 64],
      [300, 0, 64],
      PLAYER_MINS,
      PLAYER_MAXS,
    )
    expect(trace.fraction).toBeLessThan(1)
    expect(trace.planeNormal[0]).toBeCloseTo(-Math.SQRT1_2, 12)
    expect(trace.planeNormal[1]).toBe(0)
    expect(trace.planeNormal[2]).toBeCloseTo(Math.SQRT1_2, 12)
    // The ramp is at z = x - 128, so a box whose feet are at 64 meets it with
    // its leading face at x = 192 — 15 units, less the epsilon, further on.
    expect(trace.endpos[0]).toBeCloseTo(192 - PLAYER_MAXS[0] - SURFACE_CLIP_EPSILON * Math.SQRT2, 6)
  })

  it('counts a box resting exactly on a surface as inside it', () => {
    // Not a quirk to work around — it is the whole reason for the epsilon. A
    // body left *exactly* on a plane is one rounding error away from being
    // under it, so every trace stops an eighth of a unit short and a resting
    // body sits at z = 0.125 rather than at z = 0.
    const floorWorld = createCollisionWorld([boxBrush([-256, -256, -64], [256, 256, 0])])
    const flush = traceBox(
      createTrace(),
      floorWorld,
      [0, 0, 0],
      [50, 0, 0],
      PLAYER_MINS,
      PLAYER_MAXS,
    )
    expect(flush.startsolid).toBe(true)

    const clear = traceBox(
      createTrace(),
      floorWorld,
      [0, 0, SURFACE_CLIP_EPSILON],
      [50, 0, SURFACE_CLIP_EPSILON],
      PLAYER_MINS,
      PLAYER_MAXS,
    )
    expect(clear.startsolid).toBe(false)
    expect(clear.fraction).toBe(1)
  })

  it('reports a box that starts and ends inside solid as allsolid, at fraction 0', () => {
    const trace = traceBox(
      createTrace(),
      wallWorld,
      [130, 0, 60],
      [132, 0, 60],
      PLAYER_MINS,
      PLAYER_MAXS,
    )
    expect(trace.startsolid).toBe(true)
    expect(trace.allsolid).toBe(true)
    expect(trace.fraction).toBe(0)
  })

  it('reports a box leaving solid as startsolid but not allsolid, and lets it go', () => {
    const trace = traceBox(
      createTrace(),
      wallWorld,
      [130, 0, 60],
      [0, 0, 60],
      PLAYER_MINS,
      PLAYER_MAXS,
    )
    expect(trace.startsolid).toBe(true)
    expect(trace.allsolid).toBe(false)
    expect(trace.fraction).toBe(1)
    expect(trace.endpos).toEqual([0, 0, 60])
  })

  it('finds nothing in an empty world', () => {
    const empty = createCollisionWorld([])
    const trace = traceBox(createTrace(), empty, [0, 0, 0], [1000, 0, 0], PLAYER_MINS, PLAYER_MAXS)
    expect(trace.fraction).toBe(1)
  })

  it('refills the result, so a reused trace carries nothing over from the last one', () => {
    const trace = createTrace()
    traceBox(trace, wallWorld, [0, 0, 0], [200, 0, 0], PLAYER_MINS, PLAYER_MAXS)
    expect(trace.brushIndex).toBe(0)
    traceBox(trace, wallWorld, [0, 0, 0], [50, 0, 0], PLAYER_MINS, PLAYER_MAXS)
    expect(trace.fraction).toBe(1)
    expect(trace.brushIndex).toBe(-1)
    expect(trace.planeNormal).toEqual([0, 0, 0])
  })
})

describe('traceRay', () => {
  it('sweeps no volume, so it reaches 15 units further than the player box does', () => {
    const box = traceBox(
      createTrace(),
      thinWallWorld,
      [0, 0, 10],
      [200, 0, 10],
      PLAYER_MINS,
      PLAYER_MAXS,
    )
    const ray = traceRay(createTrace(), thinWallWorld, [0, 0, 10], [200, 0, 10])
    expect(ray.endpos[0]).toBeCloseTo(100 - SURFACE_CLIP_EPSILON, 9)
    expect(ray.endpos[0] - box.endpos[0]).toBeCloseTo(PLAYER_MAXS[0], 9)
  })

  it('passes through a gap a player cannot fit through', () => {
    // Two slabs leaving a 10-unit slot: a rail shot goes through, a body does not.
    const slotted = createCollisionWorld([
      boxBrush([100, -256, 0], [108, -5, 192]),
      boxBrush([100, 5, 0], [108, 256, 192]),
    ])
    expect(traceRay(createTrace(), slotted, [0, 0, 10], [200, 0, 10]).fraction).toBe(1)
    expect(
      traceBox(createTrace(), slotted, [0, 0, 0], [200, 0, 0], PLAYER_MINS, PLAYER_MAXS).fraction,
    ).toBeLessThan(1)
  })
})
