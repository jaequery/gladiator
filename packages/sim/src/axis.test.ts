import { describe, expect, it } from 'vitest'

import { QUAKE_TO_ENGINE, applyMat3, determinant3, quakeToEngine } from './axis.ts'
import type { Mat3, Vec3 } from './axis.ts'

/**
 * `-0` and `0` are the same point in space, but `Object.is` — and therefore
 * `toEqual` — says otherwise, and a matrix multiply produces `-0` wherever a
 * negative coefficient meets a zero component. Position comparisons in the
 * simulation must not care about the sign of zero; the state *hash* in
 * GLAD-OOELC5 will have to, which is why this is spelled out here rather than
 * papered over by picking samples without zeros in them.
 */
function normalizeZero(v: Vec3): Vec3 {
  return [v[0] + 0, v[1] + 0, v[2] + 0]
}

describe('QUAKE_TO_ENGINE', () => {
  it('is a pure rotation (determinant +1)', () => {
    expect(determinant3(QUAKE_TO_ENGINE)).toBe(1)
  })

  it('mirrors the world if either minus sign is dropped', () => {
    // This is the trap the axis names lead you into, and the reason the map is
    // specified as a matrix rather than as prose. Both of these read like
    // plausible transcriptions of "+X forward, +Y left, +Z up".
    const dropFirst: Mat3 = [
      [0, 1, 0],
      [0, 0, 1],
      [-1, 0, 0],
    ]
    const dropSecond: Mat3 = [
      [0, -1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ]
    expect(determinant3(dropFirst)).toBe(-1)
    expect(determinant3(dropSecond)).toBe(-1)
  })

  it('maps the Quake basis onto the engine basis', () => {
    // Quake +X (forward) -> engine -Z.
    expect(quakeToEngine([1, 0, 0])).toEqual([0, 0, -1])
    // Quake +Y (left) -> engine -X.
    expect(quakeToEngine([0, 1, 0])).toEqual([-1, 0, 0])
    // Quake +Z (up) -> engine +Y.
    expect(quakeToEngine([0, 0, 1])).toEqual([0, 1, 0])
  })

  it('agrees with the closed form (qx, qy, qz) -> (-qy, qz, -qx)', () => {
    const samples = [
      [0, 0, 0],
      [1, 2, 3],
      [-7, 11, -13],
      [0.5, -0.25, 1024],
    ] as const
    for (const [qx, qy, qz] of samples) {
      expect(normalizeZero(quakeToEngine([qx, qy, qz]))).toEqual(
        normalizeZero([-qy, qz, -qx]),
      )
    }
  })

  it('preserves length, as a rotation must', () => {
    const [x, y, z] = quakeToEngine([3, 4, 12])
    expect(Math.sqrt(x * x + y * y + z * z)).toBe(13)
  })

  it('applyMat3 is the identity for the identity matrix', () => {
    const identity: Mat3 = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]
    expect(applyMat3(identity, [1, 2, 3])).toEqual([1, 2, 3])
  })
})
