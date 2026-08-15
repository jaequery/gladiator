/**
 * Entity interpolation: drawing everyone who is not you.
 *
 * **The remote player is never predicted.** You have no knowledge of their
 * future input, so a prediction of it is a guess, and a guess about a player
 * who then does something else is a rubber band — the artefact every player
 * recognises and nobody can explain. What you do have is their *past*, which is
 * real data, so they are drawn from it: {@link INTERP_DELAY_MS} behind the
 * newest snapshot, between two states the server actually produced.
 *
 * The cost is that you shoot at where they were 80 ms ago, and that cost is
 * paid back by lag compensation on the server (GLAD-5QGO11), which rewinds them
 * to exactly there before deciding whether the railgun connected. The two are
 * halves of one design: this is why the server may rewind, and that is why this
 * is allowed to lag.
 *
 * ## What the buffer covers, and what it does not
 *
 * Jitter and reordering. A snapshot that arrives 30 ms late is still 50 ms
 * early for the purposes of drawing it, and one that arrives out of order is
 * put back in tick order before anybody reads it.
 *
 * It does **not** cover loss. The transport is a WebSocket, so it is TCP, and
 * TCP does not drop data — it retransmits it, which stalls every byte behind
 * the missing one for about a round trip and then delivers the lot in a burst.
 * An 80 ms buffer does not absorb a 180 ms stall; what absorbs it is
 * extrapolation, capped at {@link MAX_EXTRAPOLATION_MS}, and then the honest
 * admission that the opponent's position is a guess. Sizing the buffer to
 * "cover packet loss" is the UDP-flavoured version of this argument and it is
 * wrong here.
 *
 * ## The render clock is its own clock, and it is slewed
 *
 * The obvious implementation renders at `newestSnapshotTick - delay` directly.
 * That is the classic mistake, and it is the one the acceptance check is
 * pointed at: `newestSnapshotTick` advances in whatever lumps the network
 * delivers, so a mathematically correct interpolation between correct states
 * visibly stutters, because the *clock* is stuttering.
 *
 * So there is a clock in here, it advances by wall-clock, and it *tracks*
 * `newestTick - delay` by running a few percent fast or slow rather than by
 * jumping to it — the same argument, and the same shape, as the slew in
 * `net/clockSync.ts`. It is bounded below by `1 - MAX_INTERP_RATE`, which is
 * comfortably above zero, so the render clock never stops and never runs
 * backwards: monotonicity is what keeps the second derivative of the drawn
 * position bounded, and a clock that can reverse is a clock that draws a player
 * moonwalking.
 */
import {
  INTERP_DELAY_MS,
  INTERP_DELAY_TICKS,
  TICK_INTERVAL_MS,
  applyWireState,
  cloneEntity,
  createGameState,
  type EntityState,
  type GameState,
  type WireState,
} from '@gladiator/sim'

import { lerp, lerpAngleUnits } from '../render/view.ts'

/**
 * How far behind the newest snapshot the opponent is drawn, in milliseconds,
 * and the same number in ticks.
 *
 * Re-exported rather than defined here, and that move is the point: it stopped
 * being this module's private constant the moment the host started rewinding by
 * it. `sim/src/lagcomp.ts` owns it now, because the server may not import the
 * client and two copies of this number would drift apart by one edit — with the
 * symptom being rails that miss by a fixed amount nobody could account for.
 */
export { INTERP_DELAY_MS, INTERP_DELAY_TICKS }

/**
 * How far past the newest snapshot a position may be extrapolated, in
 * milliseconds.
 *
 * A quarter of a second. Past that the guess is worth less than the truth of
 * standing still: a player extrapolated for half a second is somewhere they
 * have certainly not gone, and the correction when the data arrives is the
 * rubber band this whole file exists to avoid. Note what this is *for* — a TCP
 * stall, not a lost datagram. See the header.
 */
export const MAX_EXTRAPOLATION_MS = 250

/** {@link MAX_EXTRAPOLATION_MS} in ticks. */
export const MAX_EXTRAPOLATION_TICKS = MAX_EXTRAPOLATION_MS / TICK_INTERVAL_MS

/**
 * The most the render clock may run fast or slow, as a fraction.
 *
 * A tenth. It closes an ordinary jitter-sized error in a fifth of a second and
 * is far under what an eye can pick out of a first-person view — the same trade
 * `MAX_SLEW` makes in `net/clockSync.ts`, at a slightly larger bound because
 * this clock drives a picture rather than a simulation and nothing downstream
 * of it has to agree with another machine.
 */
export const MAX_INTERP_RATE = 0.1

/**
 * How much of the error a tick of rate correction is asked to close.
 *
 * At this gain a two-tick error saturates {@link MAX_INTERP_RATE}, which makes
 * the common case — a lump of snapshots after a jittery gap — a smooth catch-up
 * rather than a proportional-controller wobble.
 */
export const INTERP_RATE_GAIN = 0.05

/**
 * Past this much error the clock jumps instead of slewing, in ticks.
 *
 * 62 ticks is half a second, which is not jitter: it is a stall that has
 * outlasted the extrapolation cap, a tab that was in the background, or a
 * session that has just reconnected. Slewing that at a tenth would take five
 * seconds of a visibly wrong clock, which is worse than the single jump of
 * admitting it. Same line, drawn for the same reason, as `SNAP_TICKS`.
 */
export const INTERP_SNAP_TICKS = 62

/** How many snapshots the history holds. About two seconds of them. */
export const HISTORY_CAPACITY = 128

export type InterpolationClock = {
  /** The fractional tick currently being drawn. Monotonic. */
  readonly renderTick: number
  /** Whether a first snapshot has started it. */
  readonly started: boolean
  /** Clock jumps taken. A working link produces none after the first. */
  readonly snaps: number
  /**
   * Advance by one frame, tracking `newestTick - INTERP_DELAY_TICKS`.
   *
   * `newestTick` is `null` before any snapshot has arrived, which leaves the
   * clock stopped rather than running it off into a future nothing describes.
   */
  advance(elapsedMs: number, newestTick: number | null): void
  reset(): void
}

export function createInterpolationClock(): InterpolationClock {
  let renderTick = 0
  let started = false
  let snaps = 0

  return {
    get renderTick() {
      return renderTick
    },
    get started() {
      return started
    },
    get snaps() {
      return snaps
    },

    advance(elapsedMs: number, newestTick: number | null) {
      if (newestTick === null) return
      const target = newestTick - INTERP_DELAY_TICKS

      if (!started) {
        renderTick = target
        started = true
        return
      }

      const error = target - renderTick
      if (error > INTERP_SNAP_TICKS || error < -INTERP_SNAP_TICKS) {
        renderTick = target
        snaps += 1
        return
      }

      let rate = 1 + error * INTERP_RATE_GAIN
      if (rate > 1 + MAX_INTERP_RATE) rate = 1 + MAX_INTERP_RATE
      if (rate < 1 - MAX_INTERP_RATE) rate = 1 - MAX_INTERP_RATE

      const step = (elapsedMs > 0 ? elapsedMs : 0) / TICK_INTERVAL_MS
      renderTick += step * rate
    },

    reset() {
      renderTick = 0
      started = false
      snaps = 0
    },
  }
}

export type InterpolationSample = {
  /** The entities to draw, interpolated. Excludes the locally predicted slot. */
  readonly entities: readonly EntityState[]
  /** How far past the newest snapshot this sample had to reach, in ticks. */
  readonly extrapolatedTicks: number
}

const NOTHING: InterpolationSample = { entities: [], extrapolatedTicks: 0 }

export type EntityBuffer = {
  /**
   * Take an authoritative state off the wire. Returns whether it was readable
   * and new; a duplicate is dropped, and a frame that arrives below one already
   * held is kept, in tick order.
   */
  push(wire: WireState): boolean
  /** The newest snapshot tick held, or `null` for an empty history. */
  readonly newestTick: number | null
  readonly oldestTick: number | null
  readonly held: number
  /** The world as it was at `renderTick`, interpolated. */
  sample(renderTick: number): InterpolationSample
  clear(): void
}

export type EntityBufferOptions = {
  /**
   * The slot this client predicts, whose entity is therefore *not* drawn from
   * here. Passing a slot nobody holds draws everybody, which is what a
   * spectator wants.
   */
  readonly localSlot: number
  readonly capacity?: number
}

type Frame = {
  tick: number
  entities: EntityState[]
}

export function createEntityBuffer(options: EntityBufferOptions): EntityBuffer {
  const capacity = options.capacity ?? HISTORY_CAPACITY
  const localSlot = options.localSlot

  // Oldest first. Bounded, so an hour-long session costs what a minute does.
  const frames: Frame[] = []

  // One scratch world the wire is decoded into. The entities that matter are
  // then copied out of it, so nothing downstream holds a reference to a world
  // the next snapshot is about to overwrite. Seeded arbitrarily: every field of
  // it is written by `applyWireState` before anything reads one.
  const scratch: GameState = createGameState(0)

  return {
    push(wire: WireState): boolean {
      if (!applyWireState(scratch, wire)) return false
      const tick = scratch.tick

      // Inserted in tick order rather than appended, because a frame that
      // arrives below one already held is still a frame the render clock has
      // not reached — that is what the buffer is for. A duplicate is refused;
      // anything genuinely too old to matter falls off the front below.
      let at = frames.length
      while (at > 0) {
        const held = frames[at - 1] as Frame
        if (held.tick === tick) return false
        if (held.tick < tick) break
        at -= 1
      }

      const entities: EntityState[] = []
      for (const entity of scratch.entities) {
        if (entity.slot === localSlot) continue
        entities.push(cloneEntity(entity))
      }
      frames.splice(at, 0, { tick, entities })
      while (frames.length > capacity) frames.shift()
      return true
    },

    get newestTick() {
      const newest = frames[frames.length - 1]
      return newest === undefined ? null : newest.tick
    },

    get oldestTick() {
      const oldest = frames[0]
      return oldest === undefined ? null : oldest.tick
    },

    get held() {
      return frames.length
    },

    sample(renderTick: number): InterpolationSample {
      if (frames.length === 0) return NOTHING

      const newest = frames[frames.length - 1] as Frame
      const oldest = frames[0] as Frame

      // Past the end: extrapolate, capped. What this covers is a TCP stall, and
      // the cap is the point at which a guess is worth less than the truth of
      // standing still.
      if (renderTick >= newest.tick) {
        const ahead = Math.min(renderTick - newest.tick, MAX_EXTRAPOLATION_TICKS)
        return {
          entities: newest.entities.map((entity) => extrapolated(entity, ahead)),
          extrapolatedTicks: ahead,
        }
      }

      // Before the beginning: the history does not go back that far, which is a
      // clock that has just started or one that has been jumped backwards.
      // Drawing the oldest thing known beats drawing nothing.
      if (renderTick <= oldest.tick) {
        return { entities: oldest.entities.map(cloneEntity), extrapolatedTicks: 0 }
      }

      // The bracketing pair. Walked from the newest end, because the render
      // clock is a fixed distance behind the newest snapshot and the answer is
      // therefore always within a frame or two of it.
      let index = frames.length - 1
      while (index > 0 && (frames[index] as Frame).tick > renderTick) index -= 1
      const before = frames[index] as Frame
      const after = frames[index + 1] as Frame

      const span = after.tick - before.tick
      const alpha = span > 0 ? (renderTick - before.tick) / span : 0

      // The older frame decides who exists. The render clock has passed it, so
      // everything in it is something that was true; an entity that only exists
      // in the newer frame has not happened yet, and drawing it early is drawing
      // a rocket before it was fired.
      const entities = before.entities.map((entity) => {
        const next = after.entities.find((other) => other.id === entity.id)
        return next === undefined ? cloneEntity(entity) : interpolateEntity(entity, next, alpha)
      })

      return { entities, extrapolatedTicks: 0 }
    },

    clear() {
      frames.length = 0
    },
  }
}

/**
 * One entity between two of its states.
 *
 * Continuous fields are interpolated and discrete ones are taken from the newer
 * state, exactly as `render/view.ts` does for a `PlayerNetState` and for the
 * same reason: half a weapon switch is not a thing, and an animation is either
 * playing or it is not.
 */
export function interpolateEntity(
  before: EntityState,
  after: EntityState,
  alpha: number,
): EntityState {
  const entity = cloneEntity(after)
  entity.origin[0] = lerp(before.origin[0], after.origin[0], alpha)
  entity.origin[1] = lerp(before.origin[1], after.origin[1], alpha)
  entity.origin[2] = lerp(before.origin[2], after.origin[2], alpha)
  entity.velocity[0] = lerp(before.velocity[0], after.velocity[0], alpha)
  entity.velocity[1] = lerp(before.velocity[1], after.velocity[1], alpha)
  entity.velocity[2] = lerp(before.velocity[2], after.velocity[2], alpha)
  entity.angles[0] = lerp(before.angles[0], after.angles[0], alpha)
  entity.angles[1] = lerpAngleUnits(before.angles[1], after.angles[1], alpha)
  entity.angles[2] = lerpAngleUnits(before.angles[2], after.angles[2], alpha)
  return entity
}

/**
 * An entity `ahead` ticks past the last state anybody sent for it.
 *
 * Straight-line, from the velocity in the snapshot. Not `pmove`: running the
 * real movement forward would need the commands, which are precisely what a
 * remote player has not sent us, and would produce a confident wrong answer
 * instead of an obviously approximate one.
 */
export function extrapolated(entity: EntityState, ahead: number): EntityState {
  const copy = cloneEntity(entity)
  if (ahead <= 0) return copy
  const seconds = (ahead * TICK_INTERVAL_MS) / 1000
  copy.origin[0] += entity.velocity[0] * seconds
  copy.origin[1] += entity.velocity[1] * seconds
  copy.origin[2] += entity.velocity[2] * seconds
  return copy
}
