/**
 * A little-endian byte writer, and the float canonicalisation the state hash
 * depends on.
 *
 * Endianness is written out explicitly on every call rather than left to a
 * `Float64Array` view. Typed-array byte order is *platform* order, and while
 * every platform this ships to is little-endian, "every platform we tested" is
 * how a determinism bug gets to wait for a user.
 */

/** A growable little-endian buffer. `length` is how much of it is written. */
export type ByteWriter = {
  bytes: Uint8Array
  view: DataView
  length: number
}

export function createWriter(capacity = 512): ByteWriter {
  const buffer = new ArrayBuffer(capacity)
  return { bytes: new Uint8Array(buffer), view: new DataView(buffer), length: 0 }
}

/** Reset a writer for reuse without reallocating. */
export function resetWriter(writer: ByteWriter): void {
  writer.length = 0
}

/** The bytes written so far. A view, not a copy — do not keep it past a reset. */
export function writtenBytes(writer: ByteWriter): Uint8Array {
  return writer.bytes.subarray(0, writer.length)
}

function reserve(writer: ByteWriter, extra: number): void {
  const needed = writer.length + extra
  if (needed <= writer.bytes.length) return

  let capacity = writer.bytes.length
  while (capacity < needed) capacity *= 2

  const buffer = new ArrayBuffer(capacity)
  const bytes = new Uint8Array(buffer)
  bytes.set(writer.bytes.subarray(0, writer.length))
  writer.bytes = bytes
  writer.view = new DataView(buffer)
}

export function writeU8(writer: ByteWriter, value: number): void {
  reserve(writer, 1)
  writer.view.setUint8(writer.length, value & 0xff)
  writer.length += 1
}

export function writeI32(writer: ByteWriter, value: number): void {
  reserve(writer, 4)
  writer.view.setInt32(writer.length, value | 0, true)
  writer.length += 4
}

export function writeU32(writer: ByteWriter, value: number): void {
  reserve(writer, 4)
  writer.view.setUint32(writer.length, value >>> 0, true)
  writer.length += 4
}

/** The bit pattern every NaN is written as: the canonical quiet NaN. */
const CANONICAL_NAN_HIGH = 0x7ff80000

/**
 * Write a double, canonicalised.
 *
 * Two normalisations, both of which exist because a *numerically equal* state
 * must produce an *identical* byte string:
 *
 * - **`-0` becomes `+0`.** They compare equal under `===` and differ in the
 *   sign bit, and the sim manufactures `-0` constantly: `Math.round(-0.4)`,
 *   `0 * -1`, any velocity clamped to rest from below. Without this, two peers
 *   standing still in the same place report different hashes.
 * - **Every NaN becomes one NaN.** ECMA-262 lets an implementation pick any of
 *   the 2^52 NaN payloads, and `DataView.setFloat64` may pass through whichever
 *   it picked. A NaN in the state is always a bug, but it should be *that* bug
 *   and not an unreproducible hash mismatch on top of it.
 *
 * What is deliberately *not* done here is rounding. Quantising to, say, 1/16 of
 * a unit before hashing would make the hash agree for a while after a real
 * divergence had started, which is the one thing a desync canary must never do.
 * The hash is over raw bit patterns.
 */
export function writeF64(writer: ByteWriter, value: number): void {
  reserve(writer, 8)

  if (Number.isNaN(value)) {
    writer.view.setUint32(writer.length, 0, true)
    writer.view.setUint32(writer.length + 4, CANONICAL_NAN_HIGH, true)
  } else {
    // `value === 0` is true for both zeros; `value + 0` would keep `-0`.
    writer.view.setFloat64(writer.length, value === 0 ? 0 : value, true)
  }

  writer.length += 8
}
