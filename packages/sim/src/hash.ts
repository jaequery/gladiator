/**
 * The state hash.
 *
 * A cheap digest of the whole sim state at a tick. Two peers that exchange
 * hashes find a desync *at the tick it happened*, rather than a minute later
 * when one of them is visibly standing in a wall.
 *
 * FNV-1a, 32-bit, over the raw IEEE 754 bytes of every number in the state.
 * Two properties matter and neither is speed:
 *
 *   - **It hashes bits, not values.** A digest built from `toFixed(3)` would
 *     call two positions equal when they differ in the twelfth decimal, and
 *     that difference is exactly the seed a desync grows from.
 *   - **Byte order is written down.** `setFloat64(..., true)` is little-endian
 *     *always*, so the digest does not depend on the host CPU. A big-endian
 *     server agreeing with a little-endian browser is not a scenario anyone
 *     wants to discover in production.
 *
 * The one deliberate normalisation is `-0`: it is numerically equal to `0` and
 * bitwise different, so it is folded to `+0` before hashing. Without that, a
 * peer that reached rest from the left and one that reached rest from the right
 * would report a desync they do not have.
 *
 * This file is the digest itself. The hash over the *full* sim state is
 * `hashState` in `state.ts`, which folds `hashBytes` over a canonical encoding;
 * `hashPlayerState` below is the walking skeleton's one-player version, and
 * goes when the skeleton's `pmove` stub does (GLAD-0B1GDS).
 */
import type { PlayerState } from './pmove.ts'

/** FNV-1a 32-bit offset basis. */
export const FNV_OFFSET_BASIS = 0x811c9dc5

/** FNV-1a 32-bit prime. */
export const FNV_PRIME = 0x01000193

/**
 * Eight bytes of scratch, reused. Module-level mutable state is normally a
 * smell inside the sim; here it is invisible — every write is fully overwritten
 * by the next, and a tick is synchronous, so there is nothing to interleave.
 */
const scratch = new DataView(new ArrayBuffer(8))

/** Fold one byte into the digest. */
export function hashByte(digest: number, byte: number): number {
  return Math.imul(digest ^ (byte & 0xff), FNV_PRIME) >>> 0
}

/** A fresh digest. */
export function hashInit(): number {
  return FNV_OFFSET_BASIS
}

/** Fold a 32-bit integer into the digest, low byte first. */
export function hashUint32(digest: number, value: number): number {
  const v = value >>> 0
  let next = hashByte(digest, v & 0xff)
  next = hashByte(next, (v >>> 8) & 0xff)
  next = hashByte(next, (v >>> 16) & 0xff)
  return hashByte(next, (v >>> 24) & 0xff)
}

/** Fold a double into the digest, by its eight little-endian bytes. */
export function hashFloat64(digest: number, value: number): number {
  // `-0` folds to `+0`; see the note at the top of the file.
  scratch.setFloat64(0, value === 0 ? 0 : value, true)
  let next = digest
  for (let i = 0; i < 8; i += 1) {
    next = hashByte(next, scratch.getUint8(i))
  }
  return next
}

/**
 * Fold a byte range into the digest.
 *
 * What `hashState` uses, over the canonical encoding in `state.ts`. Folding
 * bytes rather than fields keeps the *layout* decision in one place — the
 * encoder — instead of splitting it between an encoder and a hasher that have
 * to agree.
 */
export function hashBytes(bytes: Uint8Array, digest: number = FNV_OFFSET_BASIS): number {
  let next = digest
  for (const byte of bytes) next = hashByte(next, byte)
  return next
}

/**
 * Fold a string's UTF-16 code units into the digest, low byte first.
 *
 * Deliberately *not* UTF-8: encoding would need `TextEncoder`, which is not in
 * the ECMAScript standard library and so does not exist inside the sim. Code
 * units are what `charCodeAt` gives, on every engine, for free.
 *
 * Used to derive a match seed from a room code, so that two peers can compute
 * the same seed from something they already both know.
 */
export function hashString(text: string, digest: number = FNV_OFFSET_BASIS): number {
  let next = digest
  for (let i = 0; i < text.length; i += 1) {
    const unit = text.charCodeAt(i)
    next = hashByte(next, unit & 0xff)
    next = hashByte(next, unit >>> 8)
  }
  return next
}

/** The digest of one player's state at `tick`. */
export function hashPlayerState(tick: number, state: PlayerState): number {
  let digest = hashUint32(hashInit(), tick)
  for (const value of state.origin) digest = hashFloat64(digest, value)
  for (const value of state.velocity) digest = hashFloat64(digest, value)
  return hashUint32(digest, state.onGround ? 1 : 0)
}

/** A digest as eight lowercase hex digits — the form that goes on screen. */
export function formatHash(digest: number): string {
  return (digest >>> 0).toString(16).padStart(8, '0')
}
