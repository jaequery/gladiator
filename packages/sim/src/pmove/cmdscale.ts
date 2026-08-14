/**
 * `PM_CmdScale` — how much of `RUN_SPEED` a given stick position asks for.
 * Quake 3's `bg_pmove.c`, and `docs/physics-spec.md` §1.2.
 *
 * The job is one sentence: **a diagonal must not be faster than a straight
 * line.** Holding W and D produces a wish vector of length `sqrt(2)`, and
 * without this scale the player runs at 452 ups instead of 320 — which is the
 * oldest movement bug in the genre and the reason every id engine since has
 * carried this function.
 *
 * ## The one deliberate departure from Quake 3
 *
 * Quake counts `upmove` — the jump axis — in the normalisation denominator:
 *
 * ```c
 * total = sqrt( forwardmove^2 + rightmove^2 + upmove^2 );
 * scale = ps->speed * max / ( 127.0 * total );
 * ```
 *
 * `upmove` contributes to `total` but never to the wish *vector*, which is
 * horizontal. So the moment a player holds jump, `total` grows and the
 * horizontal wishspeed shrinks: 320 becomes `320 / sqrt(2)` = **226** while
 * jump is held, and `320 * sqrt(2/3)` = 261 while jump and a diagonal are held
 * together.
 *
 * That is not a mechanic. It is a tax on input hardware — the players who beat
 * it are the ones whose keyboard or script releases jump for a tick between
 * hops, not the ones with better movement. Gladiator excludes the jump axis, so
 * air wishspeed is 320 whether or not jump is down.
 *
 * ## Units
 *
 * Quake's move axes are `signed char`, so `127` is full deflection and the
 * `127.0` above is the axis full-scale rather than a magic number. A
 * `UserCmd` here carries -1/0/+1 (`usercmd.ts`), so the full-scale divisor is
 * 1 and drops out. The arithmetic is otherwise identical.
 */

/**
 * The fraction of `speed` this stick position asks for, as a multiplier on the
 * *normalised* wish direction's length.
 *
 * Returns 0 for no input at all, which is the caller's cue that there is no
 * wish direction to accelerate along.
 */
export function cmdScale(forwardMove: number, sideMove: number, speed: number): number {
  const forwardAbs = forwardMove < 0 ? -forwardMove : forwardMove
  const sideAbs = sideMove < 0 ? -sideMove : sideMove

  const max = forwardAbs > sideAbs ? forwardAbs : sideAbs
  if (max === 0) return 0

  const total = Math.sqrt(forwardMove * forwardMove + sideMove * sideMove)
  return (speed * max) / total
}
