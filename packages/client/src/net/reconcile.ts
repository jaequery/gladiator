/**
 * Reconciliation: taking the authoritative world and putting our own
 * unacknowledged input back on top of it.
 *
 * The client predicts. The server decides. When a snapshot arrives it is the
 * truth about a tick that is already in the past for us, so the answer is not
 * to jump back to it — it is to adopt it and re-run every command we have sent
 * since, which lands us back where we already thought we were. That only works
 * because both ends run the identical `tick()`, which is what the whole
 * simulation boundary in `AGENTS.md` exists to guarantee.
 *
 * ## The structural rule
 *
 * **The simulation always takes the authoritative value immediately; only
 * rendering lags.** Never leave the simulation wrong in order to make the
 * picture smooth. A world that is half-corrected is a world the *next* replay
 * starts from, so the error does not decay — it compounds, and the two peers
 * drift apart while every individual correction looks reassuringly small.
 *
 * What the player is spared is a *jump*, and that is a rendering concern:
 * `render/renderOffset.ts` holds the difference and decays it away over a tenth
 * of a second, so the camera travels from where it was to where it should be
 * instead of teleporting there.
 *
 * ## The bands
 *
 * | Distance | What it means | What happens |
 * | -------- | ------------- | ------------ |
 * | `< 0.1 u` | quantisation noise | nothing |
 * | `0.1 to 30 u` | ordinary disagreement | adopt, carry the delta for {@link SOFT_DECAY_MS} |
 * | `30 to 120 u` | something real happened | adopt, carry it for {@link LOUD_DECAY_MS}, and say so |
 * | `> 120 u` | a teleport, a telefrag, or a desync | **hard snap** |
 *
 * The last threshold is one splash radius, imported from the weapon table
 * rather than written out: a correction the size of the biggest thing that can
 * legitimately move a player is a correction there is no honest way to smooth,
 * and if the splash radius ever changes this line has to move with it. Past it
 * the render offset is *cleared* rather than pushed, because carrying 200 units
 * of offset would draw the player somewhere they demonstrably are not — and the
 * frame accumulator is cleared with it, because a snap usually means the two
 * clocks have come apart and the ticks queued behind it are ticks nobody wants.
 *
 * ## Ticks, and whose numbering wins
 *
 * A snapshot carries the world's tick and, separately, the last command of ours
 * it has executed (`ServerSnapshot.ack`). Everything after that ack is still
 * ours to replay. The world's tick is adopted as-is: the server is
 * authoritative about what tick it is, and a client that kept its own count
 * would have two answers to a question that only ever has one.
 *
 * The two numbers are *not* equal and are not in the same numbering: the host
 * advances on its own clock and the ack advances on whatever this peer sent
 * (`server/src/scheduler.ts`). Which is why the client's *command* counter is a
 * third number, free-running and steered by the lead, and why `predict` takes a
 * label rather than reading one off the world it just advanced.
 */
import {
  EntityKind,
  WEAPONS,
  applyWireState,
  findPlayer,
  tick as simTick,
  type CollisionWorld,
  type GameState,
  type ServerSnapshot,
  type UserCmd,
  type Vec3,
} from '@gladiator/sim'

/**
 * Below this, a correction is not a correction.
 *
 * A tenth of a unit is far under the width of the player box, under the
 * integer snap `pmove` puts on velocity, and under anything a person could see
 * at any field of view. Treating it as a correction would mean pushing a render
 * offset on nearly every snapshot for no reason.
 */
export const CORRECTION_NOISE_UNITS = 0.1

/**
 * The top of the ordinary band, in units.
 *
 * Thirty units is under half a player's height and about a quarter of a second
 * of running. Anything inside it is the difference a couple of unpredicted
 * ticks make; anything past it happened *to* the player rather than around
 * them.
 */
export const CORRECTION_SOFT_UNITS = 30

/**
 * Past this, snap. One rocket's splash radius.
 *
 * Derived from the weapon table rather than restated, for the reason
 * `AGENTS.md` gives: two names for one number is the drift everything else is
 * built to prevent. The argument for *this* number is that splash is the
 * largest displacement the game can legitimately hand a player in one tick, so
 * a correction bigger than one is not a correction at all — it is a teleport, a
 * telefrag, or a desync, and none of the three should be smoothed over.
 */
export const CORRECTION_SNAP_UNITS = WEAPONS[0].splashRadius

/** How long an ordinary correction is carried in rendering, in milliseconds. */
export const SOFT_DECAY_MS = 100

/**
 * How long a large correction is carried, in milliseconds.
 *
 * Twice the ordinary window, because the distance is up to four times as far
 * and a fixed window would make a 100-unit correction travel at four times the
 * speed of a 25-unit one — which is the version of this a player notices.
 */
export const LOUD_DECAY_MS = 200

/** What a correction was worth. */
export const CorrectionBand = {
  /** Under {@link CORRECTION_NOISE_UNITS}. Adopted, and nothing else happens. */
  None: 'none',
  /** Ordinary. Adopted, and the delta decays over {@link SOFT_DECAY_MS}. */
  Soft: 'soft',
  /** Large. As soft, over {@link LOUD_DECAY_MS}, and worth logging. */
  Loud: 'loud',
  /** Past a splash radius. Hard snap: no offset, and the accumulator is cleared. */
  Snap: 'snap',
} as const

export type CorrectionBand = (typeof CorrectionBand)[keyof typeof CorrectionBand]

/** Which band a correction of `distance` units falls in. */
export function classifyCorrection(distance: number): CorrectionBand {
  if (!(distance > CORRECTION_NOISE_UNITS)) return CorrectionBand.None
  if (distance <= CORRECTION_SOFT_UNITS) return CorrectionBand.Soft
  if (distance <= CORRECTION_SNAP_UNITS) return CorrectionBand.Loud
  return CorrectionBand.Snap
}

/** How long a band's delta is carried in rendering. Zero for the two extremes. */
export function decayMsFor(band: CorrectionBand): number {
  if (band === CorrectionBand.Soft) return SOFT_DECAY_MS
  if (band === CorrectionBand.Loud) return LOUD_DECAY_MS
  return 0
}

export type Correction = {
  readonly band: CorrectionBand
  /** How far the prediction was out, in Quake units. */
  readonly distance: number
  /**
   * Predicted minus authoritative — what rendering has to add to stay where the
   * player was last drawn. Zero for {@link CorrectionBand.Snap}, which is not
   * smoothed at all.
   */
  readonly offset: Vec3
  /** How many unacknowledged commands were replayed on top of the snapshot. */
  readonly replayed: number
  /** The tick the reconciled world is at — the server's numbering. */
  readonly tick: number
  /** The tick the client had predicted to before the snapshot landed. */
  readonly predictedTick: number
}

export type ReconcileOptions = {
  /** The predicted world. Overwritten in place with the reconciled one. */
  readonly state: GameState
  readonly world: CollisionWorld
  /** The player slot this client steers. */
  readonly slot: number
  readonly snapshot: ServerSnapshot
  /** The unacknowledged commands, oldest first, each with its tick label. */
  readonly pending: readonly PendingCommand[]
  /**
   * The authoritative world, the instant it is adopted and before anything is
   * replayed on top of it.
   *
   * The one moment the server's answer for a tick is readable — a replay
   * overwrites it within microseconds. `net/mispredict.ts` is what reads it,
   * and reads nothing else: this is a hook rather than another field on
   * {@link Correction} because what a counter wants out of a world is its own
   * business, and threading each new field through here would make
   * reconciliation know about instrumentation.
   */
  readonly onAdopt?: (state: GameState) => void
  /** Called after every sub-step this reconciliation replays. */
  readonly onReplayTick?: (state: GameState) => void
}

export type PendingCommand = {
  /** The tick this command was predicted into. */
  readonly tick: number
  readonly cmd: UserCmd
}

/**
 * Adopt `snapshot` into `state` and replay everything after its ack.
 *
 * Returns `null` — leaving `state` untouched — for a snapshot this build cannot
 * read. Everything else has already been checked at the door
 * (`sim/src/protocol.ts`), so the only way here is a version skew, and a client
 * that quietly played on with half a world would be worse than one that ignored
 * the frame and let the hash echo say so.
 */
export function reconcile(options: ReconcileOptions): Correction | null {
  const { state, world, slot, snapshot, pending } = options

  const predictedTick = state.tick
  const predicted = originOf(state, slot)

  if (!applyWireState(state, snapshot.state)) return null

  options.onAdopt?.(state)

  // Every command we sent after the one the server has executed. The ack is a
  // tick *label*, so this is a filter and not an offset into the buffer: a
  // client whose clock has been slewed has labels that are not contiguous with
  // where the buffer starts.
  let replayed = 0
  for (const entry of pending) {
    if (entry.tick <= snapshot.ack) continue
    simTick(state, inputsFor(slot, entry.cmd), world)
    replayed += 1
    options.onReplayTick?.(state)
  }

  const settled = originOf(state, slot)
  if (predicted === null || settled === null) {
    return {
      band: CorrectionBand.None,
      distance: 0,
      offset: [0, 0, 0],
      replayed,
      tick: state.tick,
      predictedTick,
    }
  }

  const dx = predicted[0] - settled[0]
  const dy = predicted[1] - settled[1]
  const dz = predicted[2] - settled[2]
  // Written out rather than `Math.hypot`, which is implementation-approximated
  // — the same rule the simulation is held to, for the same reason: this number
  // decides which band a correction lands in, and a band boundary that moves
  // between two engines is a bug that only happens on one machine.
  const distance = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const band = classifyCorrection(distance)

  return {
    band,
    distance,
    offset: band === CorrectionBand.Snap ? [0, 0, 0] : [dx, dy, dz],
    replayed,
    tick: state.tick,
    predictedTick,
  }
}

/**
 * The local player's origin, copied.
 *
 * A copy because `tick()` mutates in place and keeps the same entity objects, so
 * a reference held across `applyWireState` would be a reference to the answer.
 */
function originOf(state: GameState, slot: number): Vec3 | null {
  const player = findPlayer(state, slot)
  if (player === null || player.kind !== EntityKind.Player) return null
  return [player.origin[0], player.origin[1], player.origin[2]]
}

/**
 * One tick's inputs with `cmd` in `slot` and nothing anywhere else.
 *
 * A fresh one-element array per replay tick. `tick()` reads it and keeps no
 * reference, so a module-level scratch would be safe — it is not shared here
 * because a one-element array is nursery garbage a replay of a dozen ticks
 * makes a dozen of, and the two call sites staying independent is worth more
 * than that.
 */
function inputsFor(slot: number, cmd: UserCmd): (UserCmd | null)[] {
  const inputs: (UserCmd | null)[] = []
  inputs[slot] = cmd
  return inputs
}
