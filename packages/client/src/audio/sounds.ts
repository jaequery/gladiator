/**
 * Every sound the game ships, and what is true about each one.
 *
 * Pure data with no Web Audio import, for the same reason `animState.ts` has no
 * Babylon import: the decisions in here — how loud a footstep is relative to an
 * explosion, how far a rail shot carries, which bus a sound is allowed on — are
 * the ones worth arguing about, and they are worth arguing about in a test
 * rather than in a browser.
 *
 * The files themselves are synthesised by `tools/synth-audio.ts` and committed
 * under `packages/client/public/audio/`. `CREDITS.md` records their licence.
 *
 * ## A sound does not belong to a bus; a *playback* does
 *
 * Your own rocket and the opponent's rocket are the same 24 KiB of samples and
 * two completely different things to hear. Yours is feedback — dry, centred,
 * instant, the confirmation that the button worked. Theirs is information about
 * the world — where they are, how far, in front or behind.
 *
 * So {@link SoundSpec.buses} says which playbacks a sound is *allowed*, and the
 * call site picks. Three sounds are feedback-only on purpose and it is the same
 * purpose each time: a hit confirmation, the damage you just took, and the round
 * bell are all things you must hear at full volume regardless of where in the
 * arena the event happened to occur. Attenuating a hit confirmation by distance
 * loses it at exactly the range where you needed it.
 */

/** The sound ids. String-keyed: these are filenames, not wire values. */
export const SoundId = {
  RocketFire: 'rocket-fire',
  RailFire: 'rail-fire',
  Explosion: 'explosion',
  FootstepA: 'footstep-a',
  FootstepB: 'footstep-b',
  Land: 'land',
  Hit: 'hit',
  Damage: 'damage',
  RoundStart: 'round-start',
  RoundEnd: 'round-end',
  Death: 'death',
  Frag: 'frag',
} as const

export type SoundId = (typeof SoundId)[keyof typeof SoundId]

/** The two paths a sound can take to the speakers. `docs/audio.md`. */
export const Bus = {
  /** Non-positional, no panner, minimum latency. Your own actions. */
  Feedback: 'feedback',
  /** HRTF-panned and distance-attenuated. Everything that happens *out there*. */
  World: 'world',
} as const

export type Bus = (typeof Bus)[keyof typeof Bus]

/**
 * Distance parameters, in **Quake units**.
 *
 * Web Audio's distance model is unitless — it divides by `refDistance` and
 * compares against `maxDistance`, and neither one cares what a unit means. So
 * the whole audio system stays in Quake units and never converts, which is one
 * fewer scale factor to get wrong. For reference, the player box is 30x30x56 qu
 * and Crucible is about 1400 qu across.
 */
export type Distance = {
  /** Full volume within this radius. */
  readonly refDistance: number
  /** Never attenuated further than this. */
  readonly maxDistance: number
  /** How fast it falls off between them. 1 is the physical inverse law. */
  readonly rolloff: number
}

/** What a sound is, and how it is allowed to be played. */
export type SoundSpec = {
  readonly id: SoundId
  /** The file under `public/audio/`. */
  readonly file: string
  /**
   * Mix level, linear. Set by ear against the explosion, which is 1: everything
   * in an arena is quieter than a rocket going off next to you.
   */
  readonly gain: number
  /** Which buses this sound may be played on. */
  readonly buses: readonly Bus[]
  /** How it attenuates when played on the world bus. */
  readonly distance: Distance
}

/**
 * The default falloff: full volume inside 320 qu — one second of running — and
 * inaudible past a couple of arena widths.
 */
const NEARBY: Distance = { refDistance: 320, maxDistance: 4000, rolloff: 1 }

/** A footstep. Deliberately short-ranged: hearing them is a proximity cue. */
const CLOSE: Distance = { refDistance: 220, maxDistance: 1600, rolloff: 1.4 }

/** An explosion is heard across the whole map, and should be. */
const LOUD: Distance = { refDistance: 640, maxDistance: 8000, rolloff: 0.9 }

/** Feedback-only sounds never use these numbers, but the type wants them. */
const UNUSED: Distance = NEARBY

const BOTH: readonly Bus[] = [Bus.Feedback, Bus.World]
const FEEDBACK_ONLY: readonly Bus[] = [Bus.Feedback]
const WORLD_ONLY: readonly Bus[] = [Bus.World]

export const SOUNDS: Readonly<Record<SoundId, SoundSpec>> = {
  [SoundId.RocketFire]: {
    id: SoundId.RocketFire,
    file: 'rocket-fire.wav',
    gain: 0.75,
    buses: BOTH,
    distance: NEARBY,
  },
  [SoundId.RailFire]: {
    id: SoundId.RailFire,
    file: 'rail-fire.wav',
    gain: 0.7,
    buses: BOTH,
    distance: NEARBY,
  },
  [SoundId.Explosion]: {
    id: SoundId.Explosion,
    file: 'explosion.wav',
    gain: 1,
    buses: BOTH,
    distance: LOUD,
  },
  [SoundId.FootstepA]: {
    id: SoundId.FootstepA,
    file: 'footstep-a.wav',
    // Your own footsteps are not played at all (`cues.ts`), so this is always
    // somebody else's, and somebody else's footsteps are a *hint*, not an event.
    gain: 0.5,
    buses: WORLD_ONLY,
    distance: CLOSE,
  },
  [SoundId.FootstepB]: {
    id: SoundId.FootstepB,
    file: 'footstep-b.wav',
    gain: 0.5,
    buses: WORLD_ONLY,
    distance: CLOSE,
  },
  [SoundId.Land]: {
    id: SoundId.Land,
    file: 'land.wav',
    gain: 0.6,
    buses: BOTH,
    distance: NEARBY,
  },
  [SoundId.Hit]: {
    id: SoundId.Hit,
    file: 'hit.wav',
    gain: 0.55,
    buses: FEEDBACK_ONLY,
    distance: UNUSED,
  },
  [SoundId.Damage]: {
    id: SoundId.Damage,
    file: 'damage.wav',
    gain: 0.8,
    buses: FEEDBACK_ONLY,
    distance: UNUSED,
  },
  [SoundId.RoundStart]: {
    id: SoundId.RoundStart,
    file: 'round-start.wav',
    gain: 0.7,
    buses: FEEDBACK_ONLY,
    distance: UNUSED,
  },
  [SoundId.RoundEnd]: {
    id: SoundId.RoundEnd,
    file: 'round-end.wav',
    gain: 0.7,
    buses: FEEDBACK_ONLY,
    distance: UNUSED,
  },
  /**
   * Somebody died. On both buses, and for the usual reason: your own death is
   * feedback, and theirs is the most useful positional sound in the game —
   * it is the only way to learn where a kill happened when you did not see it.
   *
   * Carried further than a footstep and not as far as an explosion: a duel is
   * two people, so a death anywhere in the arena is worth hearing, but it
   * should not arrive at the same volume from across the map as from behind
   * you.
   */
  [SoundId.Death]: {
    id: SoundId.Death,
    file: 'death.wav',
    gain: 0.85,
    buses: BOTH,
    distance: LOUD,
  },
  /**
   * You killed them. Feedback-only for the same reason the hit confirmation
   * is: it is a statement about you, and a kill you had to strain to hear
   * would be a kill the game failed to tell you about.
   *
   * Louder than {@link SoundId.Hit} on purpose. The two are deliberately the
   * same vocabulary — this is the only moment in a round that is worth more
   * than the hit before it, and it has to sound like it.
   */
  [SoundId.Frag]: {
    id: SoundId.Frag,
    file: 'frag.wav',
    gain: 0.9,
    buses: FEEDBACK_ONLY,
    distance: UNUSED,
  },
}

/** Every sound, in a stable order. What {@link AudioEngine.load} preloads. */
export const ALL_SOUNDS: readonly SoundSpec[] = Object.values(SOUNDS)

/** Where the files are served from. Vite copies `public/` to the site root. */
export const AUDIO_BASE = '/audio/'

/** The URL a sound is fetched from. */
export function soundUrl(spec: SoundSpec, base = AUDIO_BASE): string {
  return `${base}${spec.file}`
}

/** Whether a sound is allowed on a bus. Guards the two `play` entry points. */
export function allowedOn(spec: SoundSpec, bus: Bus): boolean {
  return spec.buses.includes(bus)
}
