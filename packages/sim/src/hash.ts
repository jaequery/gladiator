/**
 * FNV-1a, 32-bit.
 *
 * The state hash is a desync *canary*, not a checksum against an adversary:
 * two peers exchange it every so often, and the first tick where they disagree
 * is the tick the bug is in. What that job needs is cheap, allocation-free and
 * bit-identical on every engine — which is why this is FNV-1a and not
 * something with a better avalanche.
 *
 * Every operation here is integer: XOR, and `Math.imul`, which is specified to
 * return the low 32 bits of the exact product. There is no floating point in
 * the hash at all, so V8 and JavaScriptCore cannot disagree about it.
 */

export const FNV_OFFSET_BASIS_32 = 0x811c9dc5
export const FNV_PRIME_32 = 0x01000193

/**
 * Fold one byte into a running hash.
 *
 * `h` and the result are signed int32; call `fnv1aFinish` before comparing or
 * printing so the value is the conventional unsigned one.
 */
export function fnv1aByte(h: number, byte: number): number {
  return Math.imul(h ^ (byte & 0xff), FNV_PRIME_32)
}

/** Reinterpret a running hash as the conventional unsigned 32-bit value. */
export function fnv1aFinish(h: number): number {
  return h >>> 0
}

/** FNV-1a over a byte range. Returns an unsigned 32-bit integer. */
export function hashBytes(bytes: Uint8Array, seed: number = FNV_OFFSET_BASIS_32): number {
  let h = seed | 0
  for (const byte of bytes) h = fnv1aByte(h, byte)
  return fnv1aFinish(h)
}

/**
 * FNV-1a over a string's UTF-16 code units, low byte first.
 *
 * Deliberately *not* UTF-8: encoding would need `TextEncoder`, which is not in
 * the ECMAScript standard library and so is not available inside the sim. Code
 * units are what `charCodeAt` gives, on every engine, for free.
 */
export function hashString(text: string, seed: number = FNV_OFFSET_BASIS_32): number {
  let h = seed | 0
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    h = fnv1aByte(h, unit & 0xff)
    h = fnv1aByte(h, unit >>> 8)
  }
  return fnv1aFinish(h)
}

/** A hash as the fixed-width lower-case hex a trace or a log line wants. */
export function hashHex(hash: number): string {
  return (hash >>> 0).toString(16).padStart(8, '0')
}
