/**
 * What a player is allowed to change, and the arithmetic behind the one that
 * matters.
 *
 * ## Sensitivity is cm/360, not a multiplier
 *
 * Every shooter ships a "sensitivity" number and no two of them mean the same
 * thing: Quake's 2.5 is not Counter-Strike's 2.5 is not Overwatch's 2.5,
 * because each is a multiplier on a different per-count angle. A player who has
 * spent a decade learning a flick has learned a *distance* — how far the hand
 * travels to turn all the way round — and that distance is the thing that
 * transfers between games. So this game's setting is that distance:
 * **centimetres of mouse movement per 360 degrees**, which is what every
 * sensitivity converter on the internet speaks and what a competitive player
 * already knows their own number in.
 *
 * The conversion needs one thing the browser cannot tell us and the player has
 * to: the mouse's **counts per inch**. A mouse reports counts, not millimetres,
 * and the same 400 counts is 1.27 cm on an 800 CPI mouse and half that on a
 * 1600 — there is no API that exposes it, so it is a field, defaulted to the
 * 800 that most mice ship at. Get it wrong and every distance below is wrong by
 * the same ratio, which is why the settings screen shows the derived counts per
 * 360 beside it: a player who knows their real figure can check it in one look.
 *
 * ## And it never leaves this machine
 *
 * Sensitivity and FOV are presentation. The server receives *angles* — already
 * quantised to Quake's 16-bit units by `input/controller.ts` — and has no
 * opinion about how a hand produced them, which is exactly why nothing here is
 * ever sent: a client that could tell the host its FOV is a client that could
 * ask for a wider one. The whole file lives behind `localStorage` and the
 * simulation cannot see it.
 */
import { TUNING } from '@gladiator/bot'
import { DEFAULT_MATCH_RULES, SelfDamage, isSelfDamageMode, matchRules } from '@gladiator/sim'
import type { MatchRules, SelfDamageMode } from '@gladiator/sim'

/**
 * Centimetres of mouse movement per 360 degrees.
 *
 * The shipped default is 10.5 cm/360: a fast arena-shooter turn that keeps a
 * rocket-jump landing within one compact mouse motion. Players can still tune
 * this physical distance directly without translating another game's
 * sensitivity multiplier.
 */
export const DEFAULT_CM_360 = 10.5

/** Counts per inch. The shipped mouse baseline, and the number to correct first. */
export const DEFAULT_DPI = 300

/**
 * Horizontal field of view at 4:3, in degrees — Quake's `fov`.
 *
 * Quoted horizontally because that is the number a player carries between
 * games, and pinned to 4:3 because that is what Quake's own is: the renderer
 * fixes the *vertical* angle and lets the horizontal one follow the window
 * ("hor+", `render/scene.ts`), so a wider monitor shows more world rather than
 * the same world squeezed.
 */
export const DEFAULT_FOV_DEGREES = 90

/** The three player-facing names on the bot's existing scalar skill axis. */
export const BOT_DIFFICULTIES = ['easy', 'medium', 'hard'] as const
export type BotDifficulty = (typeof BOT_DIFFICULTIES)[number]

/** The middle rung is the shipped bot players already meet. */
export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'medium'

/**
 * Where each player-facing level sits on `@gladiator/bot`'s `[0, 1]` dial.
 *
 * Easy and Hard are the two measured ladder rungs. Medium is the tuned shipped
 * bot, so adding names does not silently change the existing single-player
 * game for somebody who has never opened Settings.
 */
export const BOT_DIFFICULTY_SKILL: Readonly<Record<BotDifficulty, number>> = {
  easy: TUNING.anchors.novice,
  medium: TUNING.skill,
  hard: TUNING.anchors.expert,
}

export function isBotDifficulty(value: unknown): value is BotDifficulty {
  return typeof value === 'string' && BOT_DIFFICULTIES.some((level) => level === value)
}

/* --------------------------------------------------------------------------
 * The match rules a player is allowed to choose
 *
 * `MatchRules` is the simulation's, hashed with the rest of the state and
 * agreed by both peers at tick zero (`sim/match/match.ts`). Two of its four
 * fields are *game* choices rather than tuning, and until now neither was
 * reachable from anywhere: the game shipped one of four implemented
 * self-damage rules and hid the other three behind a default.
 *
 * These live in Settings beside {@link BOT_DIFFICULTY_SKILL}, and for the same
 * stated reason — they are read when the *next* match is created, never
 * mid-match, because a rule that changed under a running match is a rule the
 * two peers no longer agree about.
 * ----------------------------------------------------------------------- */

/** The self-damage rules, in the order the settings screen offers them. */
export const SELF_DAMAGE_CHOICES = [
  {
    mode: SelfDamage.HealthOnly,
    name: 'Health only',
    hint: 'The default. A rocket jump costs health and never armour, so height is cheap.',
  },
  {
    mode: SelfDamage.Full,
    name: 'Full',
    hint: 'Quake 3’s rule: halved, and armour absorbs its share. Every jump is a real bet.',
  },
  {
    mode: SelfDamage.ArmorOnly,
    name: 'Armour only',
    hint: 'The mirror of the default: free once the armour is gone.',
  },
  {
    mode: SelfDamage.None,
    name: 'None',
    hint: 'Rocket Arena 3’s rule. The push is unchanged; the damage is not there.',
  },
] as const

export function isSelfDamageChoice(value: unknown): value is SelfDamageMode {
  return typeof value === 'number' && isSelfDamageMode(value)
}

/**
 * The simulation's rules for a match created with these settings.
 *
 * The one place the settings screen's vocabulary is turned back into
 * `MatchRules`. `matchRules` fills in the fields nobody chose and re-derives
 * `maxRounds` from `roundsToWin`, which is the reason to go through it rather
 * than spreading over `DEFAULT_MATCH_RULES` here: a first-to-1 whose round cap
 * was still nine would be a match that could not end.
 */
export function rulesFromSettings(settings: Settings): MatchRules {
  return matchRules({ selfDamage: settings.selfDamage, roundsToWin: settings.roundsToWin })
}

/** The match lengths on offer: a single round, the shipped best-of-five, a long one. */
export const ROUNDS_TO_WIN_CHOICES = [1, 3, 5] as const

export function isRoundsToWin(value: unknown): value is number {
  return typeof value === 'number' && ROUNDS_TO_WIN_CHOICES.some((n) => n === value)
}

/** Centimetres in an inch. The whole of the unit conversion. */
export const CM_PER_INCH = 2.54

/**
 * The bounds each setting is clamped to.
 *
 * Clamped rather than rejected: a value out of range is a typo or a stale blob
 * in `localStorage`, and the useful response to either is the nearest playable
 * number rather than a modal. The FOV ceiling is 130 because past it the
 * viewmodel leaves the frame and the arena's walls shear; the floor is 70
 * because below it a rocket at your feet is off screen.
 */
export const SETTINGS_BOUNDS = {
  cm360: { min: 5, max: 120 },
  dpi: { min: 100, max: 32_000 },
  fovDegrees: { min: 70, max: 130 },
} as const

export type Settings = {
  /** Centimetres of mouse per 360 degrees. See the header. */
  readonly cm360: number
  /** The mouse's counts per inch, as the player reports it. */
  readonly dpi: number
  /** Horizontal FOV at 4:3, in degrees. Quake's `fov`. */
  readonly fovDegrees: number
  /** The bot skill used when the next single-player match is created. */
  readonly botDifficulty: BotDifficulty
  /** Which of the four self-damage rules the next match is created with. */
  readonly selfDamage: SelfDamageMode
  /** How many rounds win the next match. `MatchRules.roundsToWin`. */
  readonly roundsToWin: number
  /**
   * Whether the diagnostics panel is on screen.
   *
   * A setting rather than always-on: it is the netcode's instrument and the
   * browser test's, and a player who has never heard of a state hash should not
   * have one in the corner of their duel. Default on until a match starts being
   * something people play rather than something people build.
   */
  readonly diagnostics: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  cm360: DEFAULT_CM_360,
  dpi: DEFAULT_DPI,
  fovDegrees: DEFAULT_FOV_DEGREES,
  botDifficulty: DEFAULT_BOT_DIFFICULTY,
  // Exactly what the simulation ships, so opening Settings for the first time
  // changes nothing about the game somebody was already playing.
  selfDamage: DEFAULT_MATCH_RULES.selfDamage,
  roundsToWin: DEFAULT_MATCH_RULES.roundsToWin,
  diagnostics: true,
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min
  if (value > max) return max
  return value
}

/**
 * Mouse counts in one full turn.
 *
 * `cm360 / 2.54` is the travel in inches and `dpi` is counts per inch, so the
 * product is counts per 360 degrees. This is the number a sensitivity converter
 * prints and the one worth showing on screen: it is device-independent in the
 * only sense that matters — two players with the same counts per 360 and
 * different mice have different *hand* distances, and two with the same cm/360
 * do not.
 */
export function countsPer360(settings: Settings): number {
  return (settings.cm360 / CM_PER_INCH) * settings.dpi
}

/**
 * Degrees of view rotation per raw mouse count — what the input controller
 * actually multiplies by.
 *
 * The whole point of the file in one line: a full turn is 360 degrees over
 * {@link countsPer360} counts.
 */
export function degreesPerCount(settings: Settings): number {
  return 360 / countsPer360(settings)
}

/**
 * The same number as Quake would have written it: the `sensitivity` cvar that,
 * multiplied by `m_yaw 0.022`, produces {@link degreesPerCount}.
 *
 * Shown beside the real setting because a Quake player's muscle memory is
 * recorded in this number and nothing else, and because it makes the claim
 * checkable: at 800 CPI, `sensitivity 2.5` is 21 cm/360, and typing either one
 * in should produce the other.
 */
export const QUAKE_DEGREES_PER_COUNT = 0.022

export function quakeSensitivity(settings: Settings): number {
  return degreesPerCount(settings) / QUAKE_DEGREES_PER_COUNT
}

/**
 * Vertical field of view in radians, from the horizontal-at-4:3 degrees the
 * player set.
 *
 * The inverse of what `render/scene.ts` hard-codes: `2·atan(0.75)` is 90
 * degrees horizontally on a 4:3 screen, so the general form is
 * `2·atan(tan(fov/2) · 3/4)`. Radians because that is what a camera takes.
 */
export function verticalFovRadians(fovDegrees: number): number {
  const horizontal = (fovDegrees * Math.PI) / 180
  return 2 * Math.atan(Math.tan(horizontal / 2) * 0.75)
}

/**
 * Force a value into range, whatever it started as.
 *
 * Every field, every time, because the two ways a `Settings` arrives here are a
 * text input and a JSON blob written by an older build, and both can hold
 * anything at all.
 */
export function normalizeSettings(raw: Partial<Settings> | null | undefined): Settings {
  const number = (value: unknown, fallback: number, bounds: { min: number; max: number }) =>
    typeof value === 'number' && Number.isFinite(value)
      ? clamp(value, bounds.min, bounds.max)
      : fallback

  return {
    cm360: number(raw?.cm360, DEFAULT_CM_360, SETTINGS_BOUNDS.cm360),
    dpi: number(raw?.dpi, DEFAULT_DPI, SETTINGS_BOUNDS.dpi),
    fovDegrees: number(raw?.fovDegrees, DEFAULT_FOV_DEGREES, SETTINGS_BOUNDS.fovDegrees),
    botDifficulty: isBotDifficulty(raw?.botDifficulty)
      ? raw.botDifficulty
      : DEFAULT_BOT_DIFFICULTY,
    selfDamage: isSelfDamageChoice(raw?.selfDamage)
      ? raw.selfDamage
      : DEFAULT_MATCH_RULES.selfDamage,
    roundsToWin: isRoundsToWin(raw?.roundsToWin)
      ? raw.roundsToWin
      : DEFAULT_MATCH_RULES.roundsToWin,
    diagnostics: typeof raw?.diagnostics === 'boolean' ? raw.diagnostics : true,
  }
}

/** Parse whatever was in storage. Anything unreadable is the defaults. */
export function parseSettings(raw: string | null): Settings {
  if (raw === null) return DEFAULT_SETTINGS
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object') return DEFAULT_SETTINGS
    return normalizeSettings(parsed as Partial<Settings>)
  } catch {
    // A half-written blob, or a key some other tool put there. Defaults, and
    // no complaint: a settings file is not worth an error on the page.
    return DEFAULT_SETTINGS
  }
}

/**
 * Where settings live.
 *
 * Versioned in the key rather than in the payload, so a future shape change is
 * a new key and an old build reading a new one finds nothing and uses its own
 * defaults — which is the failure everybody actually wants.
 */
export const SETTINGS_KEY = 'gladiator.settings.v1'

/**
 * The slice of `localStorage` this needs.
 *
 * Injected, because `localStorage` throws outright in a browser with site data
 * blocked and does not exist at all under Node — and a settings screen that
 * takes the page down in private browsing would be a very silly way to lose a
 * player.
 */
export type SettingsStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export type SettingsStore = {
  readonly value: Settings
  /** Merge a change in, clamp it, persist it, and hand back what stuck. */
  update(change: Partial<Settings>): Settings
  /** Called after every {@link SettingsStore.update}, with the new value. */
  onChange(listener: (settings: Settings) => void): void
}

/** Read what is stored, or the defaults if nothing readable is. */
export function loadSettings(storage: SettingsStorage | null): Settings {
  if (storage === null) return DEFAULT_SETTINGS
  try {
    return parseSettings(storage.getItem(SETTINGS_KEY))
  } catch {
    return DEFAULT_SETTINGS
  }
}

/** `localStorage`, or `null` where the browser refuses to hand it over. */
export function browserStorage(): SettingsStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

export function createSettingsStore(storage: SettingsStorage | null): SettingsStore {
  let value = loadSettings(storage)
  const listeners: Array<(settings: Settings) => void> = []

  return {
    get value() {
      return value
    },

    update(change) {
      value = normalizeSettings({ ...value, ...change })
      try {
        storage?.setItem(SETTINGS_KEY, JSON.stringify(value))
      } catch {
        // Quota, private browsing, a policy. The setting still applies to this
        // session; it just will not survive the tab.
      }
      for (const listener of listeners) listener(value)
      return value
    },

    onChange(listener) {
      listeners.push(listener)
    },
  }
}
