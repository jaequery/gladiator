/**
 * The Quake -> engine axis map.
 *
 * Canonical definition: `docs/physics-spec.md` §0.3, restated as a literal
 * matrix in `AGENTS.md`. This file is the executable copy — the constant below
 * and the determinant assertion in `axis.test.ts` are what stop the three from
 * drifting apart.
 *
 *     (qx, qy, qz) -> (-qy, qz, -qx)
 *
 * Quake's convention is +X forward, +Y left, +Z up. The engine's is +X right,
 * +Y up, +Z forward. Both are right-handed, so the change of basis is a pure
 * rotation and its determinant is +1. Drop exactly one of the two minus signs —
 * which is what the axis names alone suggest you should do — and the
 * determinant is -1: a mirrored world, where every rocket-jump curves the wrong
 * way and no amount of tuning will fix it.
 */

/** A 3-vector, `[x, y, z]`. */
export type Vec3 = readonly [number, number, number]

/** A 3x3 matrix in row-major order: `m[row][col]`, applied as `e = M * q`. */
export type Mat3 = readonly [Vec3, Vec3, Vec3]

/**
 * Change of basis from Quake coordinates to engine coordinates.
 *
 *     | ex |   |  0  -1   0 | | qx |
 *     | ey | = |  0   0   1 | | qy |
 *     | ez |   | -1   0   0 | | qz |
 */
export const QUAKE_TO_ENGINE: Mat3 = [
  [0, -1, 0],
  [0, 0, 1],
  [-1, 0, 0],
]

/** `det(M)`. +1 for a rotation, -1 for a rotation composed with a mirror. */
export function determinant3(m: Mat3): number {
  const [[a, b, c], [d, e, f], [g, h, i]] = m
  return a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
}

/** `M * v`. */
export function applyMat3(m: Mat3, v: Vec3): Vec3 {
  const [x, y, z] = v
  return [
    m[0][0] * x + m[0][1] * y + m[0][2] * z,
    m[1][0] * x + m[1][1] * y + m[1][2] * z,
    m[2][0] * x + m[2][1] * y + m[2][2] * z,
  ]
}

/** Map a vector from Quake coordinates into engine coordinates. */
export function quakeToEngine(q: Vec3): Vec3 {
  return applyMat3(QUAKE_TO_ENGINE, q)
}
