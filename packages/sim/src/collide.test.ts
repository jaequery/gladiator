import { describe, expect, it } from 'vitest'

import { PLAYER_MAXS, PLAYER_MINS } from './bbox.ts'
import {
  boxBrush,
  boxPenetration,
  brush,
  createCollisionWorld,
  plane,
  planeOffset,
  queryBrushes,
} from './collide.ts'

describe('plane', () => {
  it('normalises the normal and scales the distance to match', () => {
    const p = plane([0, 0, 4], 16)
    expect(p.normal).toEqual([0, 0, 1])
    expect(p.dist).toBe(4)
  })

  it('normalises a diagonal to unit length', () => {
    const p = plane([-1, 0, 1], 0)
    const length = Math.sqrt(
      p.normal[0] * p.normal[0] + p.normal[1] * p.normal[1] + p.normal[2] * p.normal[2],
    )
    expect(length).toBeCloseTo(1, 12)
    expect(p.normal[2]).toBeCloseTo(Math.SQRT1_2, 12)
  })

  it('records signBits so the trace can pick the box corner facing it', () => {
    expect(plane([1, 1, 1], 0).signBits).toBe(0)
    expect(plane([-1, 1, 1], 0).signBits).toBe(1)
    expect(plane([1, -1, 1], 0).signBits).toBe(2)
    expect(plane([-1, -1, -1], 0).signBits).toBe(7)
  })

  it('rejects a zero normal rather than producing NaN', () => {
    expect(() => plane([0, 0, 0], 1)).toThrow(/non-zero normal/)
  })
})

describe('brush', () => {
  it('derives the bounds of a box from its planes', () => {
    const b = boxBrush([-16, -32, 0], [16, 32, 64])
    expect(b.mins[0]).toBeCloseTo(-16, 9)
    expect(b.mins[1]).toBeCloseTo(-32, 9)
    expect(b.mins[2]).toBeCloseTo(0, 9)
    expect(b.maxs[0]).toBeCloseTo(16, 9)
    expect(b.maxs[1]).toBeCloseTo(32, 9)
    expect(b.maxs[2]).toBeCloseTo(64, 9)
  })

  it('derives the bounds of a wedge, whose corners are not its bounds corners', () => {
    // z <= x over x in [0, 64], y in [-8, 8]: a 45-degree ramp.
    const b = brush([
      { normal: [0, 0, -1], dist: 0 },
      { normal: [-1, 0, 0], dist: 0 },
      { normal: [1, 0, 0], dist: 64 },
      { normal: [0, 1, 0], dist: 8 },
      { normal: [0, -1, 0], dist: 8 },
      { normal: [-1, 0, 1], dist: 0 },
    ])
    expect(b.mins[0]).toBeCloseTo(0, 9)
    expect(b.maxs[0]).toBeCloseTo(64, 9)
    expect(b.mins[2]).toBeCloseTo(0, 9)
    // The apex is at (64, *, 64) even though no plane says `z <= 64`.
    expect(b.maxs[2]).toBeCloseTo(64, 9)
  })

  it('refuses a brush with a missing plane rather than deriving bounds that lie', () => {
    // A box with no lid: it runs to infinity in +z, and the corners it does
    // have would happily report `maxs[2] === 0`.
    expect(() =>
      brush([
        { normal: [1, 0, 0], dist: 16 },
        { normal: [-1, 0, 0], dist: 16 },
        { normal: [0, 1, 0], dist: 16 },
        { normal: [0, -1, 0], dist: 16 },
        { normal: [0, 0, -1], dist: 0 },
      ]),
    ).toThrow(/unbounded/)
  })

  it('refuses a brush that escapes along a diagonal, not just along an axis', () => {
    // Bounded in x, and open into the whole +y +z quadrant.
    expect(() =>
      brush([
        { normal: [-1, 0, 0], dist: 0 },
        { normal: [1, 0, 0], dist: 10 },
        { normal: [0, -1, 0], dist: 0 },
        { normal: [0, 0, -1], dist: 0 },
        { normal: [-1, -1, -1], dist: -1 },
      ]),
    ).toThrow(/unbounded/)
  })

  it('refuses an inside-out box', () => {
    expect(() => boxBrush([16, 0, 0], [-16, 8, 8])).toThrow(/strictly greater/)
  })
})

describe('planeOffset', () => {
  it('picks the corner of the box that meets the plane first', () => {
    // A floor: the box's *bottom* is what touches it.
    expect(planeOffset(plane([0, 0, 1], 0), PLAYER_MINS, PLAYER_MAXS)).toBe(PLAYER_MINS[2])
    // A ceiling: its *top*.
    expect(planeOffset(plane([0, 0, -1], 0), PLAYER_MINS, PLAYER_MAXS)).toBe(-PLAYER_MAXS[2])
  })
})

describe('queryBrushes', () => {
  const world = createCollisionWorld([
    boxBrush([-1024, -1024, -64], [1024, 1024, 0]),
    boxBrush([0, 0, 0], [64, 64, 64]),
    boxBrush([512, 512, 0], [576, 576, 64]),
  ])

  it('returns only the brushes whose bounds overlap the query', () => {
    expect(queryBrushes(world, [8, 8, 8], [16, 16, 16])).toEqual([1])
    expect(queryBrushes(world, [520, 520, 8], [530, 530, 16])).toEqual([2])
  })

  it('returns candidates in ascending brush index, whatever order the grid met them', () => {
    const found = queryBrushes(world, [-1024, -1024, -64], [1024, 1024, 512])
    expect(found).toEqual([0, 1, 2])
  })

  it('reports each brush once even when it spans many cells', () => {
    const found = queryBrushes(world, [-1024, -1024, -32], [1024, 1024, -16])
    expect(found).toEqual([0])
  })

  it('finds nothing in empty space, and nothing at all in an empty world', () => {
    expect(queryBrushes(world, [200, 200, 200], [220, 220, 220])).toEqual([])
    expect(queryBrushes(createCollisionWorld([]), [0, 0, 0], [1, 1, 1])).toEqual([])
  })

  it('clamps an out-of-bounds query onto the grid rather than answering nothing', () => {
    // Far outside the world, but reaching back into it.
    const found = queryBrushes(world, [-9000, -9000, -9000], [8, 8, 8])
    expect(found).toContain(0)
    expect(found).toContain(1)
  })
})

describe('boxPenetration', () => {
  const world = createCollisionWorld([boxBrush([-256, -256, -64], [256, 256, 0])])

  it('is zero for a box resting on a surface', () => {
    expect(boxPenetration(world, [0, 0, 0], PLAYER_MINS, PLAYER_MAXS)).toBe(0)
  })

  it('is zero for a box clear of everything', () => {
    expect(boxPenetration(world, [0, 0, 128], PLAYER_MINS, PLAYER_MAXS)).toBe(0)
  })

  it('measures how far a sunken box would have to be lifted', () => {
    expect(boxPenetration(world, [0, 0, -3], PLAYER_MINS, PLAYER_MAXS)).toBeCloseTo(3, 9)
  })

  it('measures the shallowest escape, not the deepest overlap', () => {
    // 1 unit into the floor's top face, but 500 units past its side faces: the
    // way out is up, and it is 1 unit.
    expect(boxPenetration(world, [0, 0, -1], PLAYER_MINS, PLAYER_MAXS)).toBeCloseTo(1, 9)
  })
})
