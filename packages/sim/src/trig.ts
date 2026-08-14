/**
 * Sine and cosine that are bit-identical in every JavaScript engine.
 *
 * `Math.sin` and `Math.cos` are, in the words of the specification,
 * "implementation-approximated": an engine may return any value within an
 * implementation-defined tolerance. V8 and JavaScriptCore genuinely differ in
 * the last bits, and a movement function that turns a view angle into a
 * direction vector feeds that difference straight into position. Two peers
 * running the "same" simulation would drift apart by microns per tick and by
 * metres per round.
 *
 * So the sim computes its own. Every operation below is `+`, `-`, `*`, `/`,
 * `Math.round` or a comparison — the operations IEEE 754 specifies *exactly*,
 * which is what makes the result reproducible rather than merely accurate.
 *
 * The algorithm is fdlibm's: Cody-Waite range reduction onto `[-pi/4, pi/4]`,
 * then a minimax polynomial. Accuracy is around 1e-16 relative, which is far
 * below anything a rocket-jump can feel; reproducibility is the point.
 *
 * `packages/sim` bans `Math.sin`, `Math.cos` and friends in ESLint precisely so
 * this file is the only way to get an angle into a vector. See `AGENTS.md`.
 */

/**
 * `pi/2`, split so that `n * PIO2_HI` is *exact* for small integer `n`.
 *
 * The low 22 bits of its mantissa are zero, leaving 31 significant bits, so
 * `n * PIO2_HI` is exact for any `n` up to 2^22 and the subtraction
 * `x - n * PIO2_HI` loses nothing. `PIO2_LO` carries the rest of `pi/2` to
 * roughly 1e-27, which is well below the precision of the reduced argument.
 */
const PIO2_HI = 1.5707963267341256
const PIO2_LO = 6.077100506506192e-11

/** `2/pi`, used only to pick the quadrant. */
const TWO_OVER_PI = 0.6366197723675814

/* Minimax coefficients for sin(x) on |x| <= pi/4 (fdlibm __kernel_sin). */
const S1 = -1.6666666666666632e-1
const S2 = 0.00833333333332249
const S3 = -1.984126982985795e-4
const S4 = 2.7557313707070068e-6
const S5 = -2.5050760253406863e-8
const S6 = 1.58969099521155e-10

/* Minimax coefficients for cos(x) on |x| <= pi/4 (fdlibm __kernel_cos). */
const C1 = 0.0416666666666666
const C2 = -0.001388888888887411
const C3 = 2.480158728947673e-5
const C4 = -2.7557314351390663e-7
const C5 = 2.0875723212981748e-9
const C6 = -1.1359647557788195e-11

/** sin(x) for |x| <= pi/4. */
function kernelSin(x: number): number {
  const z = x * x
  const r = S2 + z * (S3 + z * (S4 + z * (S5 + z * S6)))
  return x + x * z * (S1 + z * r)
}

/** cos(x) for |x| <= pi/4. */
function kernelCos(x: number): number {
  const z = x * x
  const r = C1 + z * (C2 + z * (C3 + z * (C4 + z * (C5 + z * C6))))
  return 1 - 0.5 * z + z * z * r
}

/**
 * The quadrant index for `x`, as an int32.
 *
 * `Math.round` is exactly specified, so two engines always agree on which
 * quadrant they are in — which matters more than the polynomial's accuracy,
 * because disagreeing here is a sign error, not a rounding error.
 */
function quadrant(x: number): number {
  return Math.round(x * TWO_OVER_PI)
}

/** `x` reduced onto `[-pi/4, pi/4]` for quadrant `n`. */
function reduce(x: number, n: number): number {
  return x - n * PIO2_HI - n * PIO2_LO
}

/**
 * Deterministic `Math.sin`.
 *
 * Defined for finite `x`; the range reduction is designed for the
 * `[-2pi, 2pi]` band that view angles live in and degrades, as fdlibm's does,
 * for arguments in the millions. The sim never has one.
 */
export function sinRad(x: number): number {
  const n = quadrant(x)
  const r = reduce(x, n)
  const q = n & 3
  if (q === 0) return kernelSin(r)
  if (q === 1) return kernelCos(r)
  if (q === 2) return -kernelSin(r)
  return -kernelCos(r)
}

/** Deterministic `Math.cos`. See {@link sinRad}. */
export function cosRad(x: number): number {
  const n = quadrant(x)
  const r = reduce(x, n)
  const q = n & 3
  if (q === 0) return kernelCos(r)
  if (q === 1) return -kernelSin(r)
  if (q === 2) return -kernelCos(r)
  return kernelSin(r)
}
