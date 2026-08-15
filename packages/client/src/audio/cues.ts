/**
 * What to play, derived from what the network says happened.
 *
 * This is `animState.ts`'s twin, for ears instead of eyes, and it exists for the
 * same reason. The tempting shortcut is to play a sound where the sound is
 * *caused*: call `playFeedback` in the input handler when the fire button goes
 * down, play a footstep from the animation system when a leg comes round. Every
 * one of those is a guess about a simulation that is authoritative somewhere
 * else, and each is wrong in its own way — the shot you heard was rejected by
 * the server, the opponent you heard running was standing still and their
 * snapshot was late.
 *
 * So the input is {@link PlayerNetState}, the same deeply-readonly copy the
 * renderer draws from, and the output is a list of cues. Under packet loss the
 * sound is exactly as stale as the state it came from, which is the correct
 * amount of stale.
 *
 * ## It is a fold, because sound is made of *edges*
 *
 * An animation is a function of the current state; a sound is a function of a
 * *change* in it. "They fired" is `lastFireTick` differing from the one we last
 * saw. "They landed" is being on the ground after not being. "You hit them" is
 * their health going down. None of those can be read off a single snapshot, so
 * the fold carries the previous observation forward — and a player seen for the
 * first time produces no cues at all, which is what stops a spawn from sounding
 * like a landing, a hit and a shot all at once.
 *
 * ## Footsteps come from distance, not from a timer
 *
 * A footstep every N milliseconds is a footstep that speeds up when the frame
 * rate does. Steps here are emitted every {@link STRIDE_QU} of horizontal ground
 * travel, so a player crossing the arena makes the same number of them at 60 Hz
 * and at 240 Hz, and a player being pushed backwards by a rocket does not sprint
 * in place.
 */

import { EntityFlag, NEVER_FIRED, PLAYER_VIEW_HEIGHT, RUN_SPEED, type Vec3, Weapon } from '@gladiator/sim'

import { horizontalSpeed, type PlayerNetState } from '../render/animState.ts'
import type { AudioEngine } from './engine.ts'
import { Bus, SoundId } from './sounds.ts'

/** One sound to play, and everything needed to play it. */
export type SoundCue = {
  readonly sound: SoundId
  readonly bus: Bus
  /** Where it happened, Quake frame. `null` for feedback, which has no place. */
  readonly origin: Vec3 | null
  /** Multiplies the sound's catalogue gain. */
  readonly gain: number
}

/**
 * Quake units of ground travel between footsteps.
 *
 * 128 qu at the 320 qu/s run speed is two and a half steps a second, which is
 * about what a person running in boots does and — more to the point — is slow
 * enough that two players moving at once do not turn into a drum roll.
 */
export const STRIDE_QU = 128

/** Below this speed nobody is walking, they are being nudged. */
export const STEP_SPEED = 60

/** What the fold remembers about one player between observations. */
export type CueMemory = {
  /** `false` until the first observation, which deliberately emits nothing. */
  readonly seen: boolean
  readonly lastFireTick: number
  readonly airborne: boolean
  readonly health: number
  readonly origin: Vec3
  /** Ground travel since the last footstep, in Quake units. */
  readonly stride: number
  /** Which of the two footstep samples is next. */
  readonly step: number
}

/** What a player nobody has seen yet folds from. */
export const INITIAL_MEMORY: CueMemory = {
  seen: false,
  lastFireTick: NEVER_FIRED,
  airborne: false,
  health: 0,
  origin: [0, 0, 0],
  stride: 0,
  step: 0,
}

/** The fire sound for a weapon, or `null` for one that makes none. */
export function fireSound(weapon: Weapon): SoundId | null {
  if (weapon === Weapon.RocketLauncher) return SoundId.RocketFire
  if (weapon === Weapon.Railgun) return SoundId.RailFire
  return null
}

/** Where a shot leaves the body: the muzzle is at the eye, not at the feet. */
function muzzleOf(net: PlayerNetState): Vec3 {
  return [net.origin[0], net.origin[1], net.origin[2] + PLAYER_VIEW_HEIGHT]
}

/** Horizontal distance between two points. */
function groundDistance(from: Vec3, to: Vec3): number {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  return Math.sqrt(dx * dx + dy * dy)
}

export type CueResult = {
  readonly memory: CueMemory
  readonly cues: readonly SoundCue[]
}

/**
 * Fold one observation of one player into the cues it produces.
 *
 * `self` picks the bus and the vocabulary: your own actions are feedback, and
 * the two health rules invert — losing health is *damage taken* on your own
 * body and a *hit confirmation* on theirs.
 */
export function advanceCues(memory: CueMemory, net: PlayerNetState, self: boolean): CueResult {
  const airborne = (net.flags & EntityFlag.OnGround) === 0
  const origin: Vec3 = [net.origin[0], net.origin[1], net.origin[2]]

  if (!memory.seen) {
    // First sight of this player. Seed and stay quiet — every rule below is an
    // edge, and every edge would fire against a memory of nothing.
    return {
      memory: {
        seen: true,
        lastFireTick: net.lastFireTick,
        airborne,
        health: net.health,
        origin,
        stride: 0,
        step: 0,
      },
      cues: [],
    }
  }

  const cues: SoundCue[] = []
  const bus = self ? Bus.Feedback : Bus.World

  // --- they fired -----------------------------------------------------------
  // The tick changed, so this is a *new* shot rather than the same one still on
  // screen. `lastFireTick` survives a dropped snapshot (`sim/weapon.ts`), so a
  // client that missed the snapshot the shot happened on still hears it, once,
  // from the next one.
  if (net.lastFireTick !== memory.lastFireTick && net.lastFireTick !== NEVER_FIRED) {
    const sound = fireSound(net.weapon)
    if (sound !== null) {
      cues.push({ sound, bus, origin: self ? null : muzzleOf(net), gain: 1 })
    }
  }

  // --- they landed ----------------------------------------------------------
  if (memory.airborne && !airborne) {
    cues.push({ sound: SoundId.Land, bus, origin: self ? null : origin, gain: 1 })
  }

  // --- health moved ---------------------------------------------------------
  // Both directions of this are feedback, never world: the sound of being hurt
  // and the sound of hurting someone are about you, and both have to arrive at
  // full volume from nowhere in particular.
  //
  // Attribution is the honest caveat. Nothing in `EntityState` says *who* took
  // the health, so an opponent who rocket-jumps rings the hit confirmation.
  // Damage events with an owner are GLAD-0QWRYK's and GLAD-5QGO11's; when they
  // land, this rule reads their attribution instead of inferring one.
  if (net.health < memory.health) {
    cues.push({
      sound: self ? SoundId.Damage : SoundId.Hit,
      bus: Bus.Feedback,
      origin: null,
      gain: 1,
    })
  }

  // --- footsteps ------------------------------------------------------------
  // Only other players, and only on the ground. Your own footsteps would mask
  // the one sound in this game that tells you where somebody is when you cannot
  // see them — see `sounds.ts`.
  let stride = memory.stride
  let step = memory.step
  if (airborne || memory.airborne) {
    // Airborne, or landing this very frame. Both reset the stride: nobody takes
    // a step in mid-air, and the whole distance covered by a jump would
    // otherwise be cashed in as footsteps on the frame they touch down —
    // underneath the landing thud, which is the sound that moment already has.
    stride = 0
  } else {
    const speed = horizontalSpeed(net.velocity)
    stride += groundDistance(memory.origin, origin)
    if (!self && speed >= STEP_SPEED && stride >= STRIDE_QU) {
      cues.push({
        sound: step % 2 === 0 ? SoundId.FootstepA : SoundId.FootstepB,
        bus: Bus.World,
        origin,
        // Quieter at a walk than at a sprint, which is most of what makes a
        // footstep read as a distance rather than as an event.
        gain: Math.min(1, 0.45 + (0.55 * speed) / RUN_SPEED),
      })
      step += 1
    }
    if (stride >= STRIDE_QU) stride -= STRIDE_QU
  }

  return {
    memory: {
      seen: true,
      lastFireTick: net.lastFireTick,
      airborne,
      health: net.health,
      origin,
      stride,
      step,
    },
    cues,
  }
}

/* --------------------------------------------------------------------------
 * The stateful shell
 *
 * `advanceCues` is the whole rule set and is pure. This is the twenty lines
 * that remember one memory per entity id, so `main.ts` does not have to.
 * ----------------------------------------------------------------------- */

export type CueObservation = {
  /** The local player, or `null` before they exist. */
  readonly self: PlayerNetState | null
  /** Everybody else the client is drawing. */
  readonly others: readonly PlayerNetState[]
}

export type CueTracker = {
  /** Fold one frame's netstates and return everything that should be heard. */
  observe(observation: CueObservation): readonly SoundCue[]
  /** Drop everything remembered. A new round, a reconnection, a new map. */
  reset(): void
  /** How many players are being remembered. */
  readonly tracked: number
}

export function createCueTracker(): CueTracker {
  const memories = new Map<number, CueMemory>()

  const fold = (net: PlayerNetState, self: boolean, into: SoundCue[]) => {
    const result = advanceCues(memories.get(net.id) ?? INITIAL_MEMORY, net, self)
    memories.set(net.id, result.memory)
    for (const cue of result.cues) into.push(cue)
  }

  return {
    observe(observation) {
      const cues: SoundCue[] = []
      if (observation.self !== null) fold(observation.self, true, cues)
      for (const other of observation.others) fold(other, false, cues)

      // A player who is no longer drawn is forgotten, so that if they come back
      // — a reconnection, a new round — they are seen for the first time again
      // and do not land, fire and bleed in the same frame.
      const present = new Set(observation.others.map((net) => net.id))
      if (observation.self !== null) present.add(observation.self.id)
      for (const id of [...memories.keys()]) {
        if (!present.has(id)) memories.delete(id)
      }

      return cues
    },

    reset() {
      memories.clear()
    },

    get tracked() {
      return memories.size
    },
  }
}

/** Send a frame's cues to the engine. The only place a bus is dispatched on. */
export function playCues(engine: AudioEngine, cues: readonly SoundCue[]): void {
  for (const cue of cues) {
    if (cue.bus === Bus.Feedback || cue.origin === null) {
      engine.playFeedback(cue.sound, { gain: cue.gain })
      continue
    }
    engine.playWorld(cue.sound, cue.origin, { gain: cue.gain })
  }
}
