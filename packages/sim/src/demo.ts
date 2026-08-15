/**
 * Demos: a recording of a match that can be played back exactly.
 *
 * When a playtester says "I got yanked backwards", the alternative to this file
 * is a shrug. With it, the exact command stream that produced the moment is on
 * disk and can be re-run into the same world, tick for tick, and stopped at the
 * tick in question.
 *
 * ## It records the *commands*, not the states
 *
 * A world is a function of `(seed, rules, map, command stream)` — that is what
 * `tick()` being deterministic *means*, and `determinism.test.ts` is the
 * standing proof of it. So a demo is the command stream plus the four things it
 * needs to be interpreted, and a minute of duel is about 120 KB of JSON rather
 * than the 40 MB a state stream would be. Recording states would also be
 * recording the *answer*, which makes a demo useless as a determinism check:
 * the interesting question is whether replaying the inputs still produces the
 * states, and a file that carries both is the only file that can be asked.
 *
 * That is why a demo also carries a **hash trace**, sampled on exactly the
 * schedule `replay.ts` uses — every half second. It is 16 bytes per half
 * second, and it turns "this demo replays" from a claim into a check
 * ({@link verifyDemo}).
 *
 * ## What has to be recorded besides the commands
 *
 * Two things the command stream does not contain, both of which are decisions
 * the *host* takes between sub-steps rather than inside one:
 *
 * - **The seed and the rules**, because the PRNG draws the spawn pair and the
 *   rules decide when a round ends. Both are in the header.
 * - **When the match started.** `startMatch` is the one external edge out of
 *   warmup (`match/round.ts`) and it fires when the room fills, which is a fact
 *   about sockets rather than about the world. So the ticks it fired on are
 *   recorded, and replay fires it at the same ones.
 *
 * The map is *not* recorded — only its name and hash. A map is megabytes and
 * both ends already have it; what a demo owes is a refusal to replay against a
 * different one, which is the same reason the handshake exchanges a map hash.
 *
 * ## What it deliberately does not do
 *
 * It does not write files. Nothing in `packages/sim` has a filesystem, and the
 * host that records a demo (`server/src/room.ts`) is isomorphic on purpose —
 * it runs in a browser tab as well as on Fly. {@link encodeDemo} produces a
 * string and somebody else decides where it goes: `server/src/demoFile.ts` on
 * Node, a download in a tab.
 */

import { decodeCmd, encodeCmd } from './protocol.ts'
import type { WireCmd } from './protocol.ts'
import { formatHash } from './hash.ts'
import type { LoadedMap } from './map/load.ts'
import { createMapState } from './map/load.ts'
import { DEFAULT_MATCH_RULES } from './match/match.ts'
import type { MatchRules } from './match/match.ts'
import { isSelfDamageMode } from './match/selfDamage.ts'
import { startMatch } from './match/round.ts'
import { buildSpawnPlan } from './match/spawn.ts'
import type { SpawnPlan } from './match/spawn.ts'
import { firstDivergence, sampleTickAt } from './replay.ts'
import type { TraceDivergence, TraceSample } from './replay.ts'
import { hashState } from './state.ts'
import type { GameState } from './state.ts'
import { tick as simTick } from './kernel.ts'
import { TICK_INTERVAL_MS } from './tick.ts'
import type { UserCmd } from './usercmd.ts'

/**
 * The demo format's own version.
 *
 * Separate from `PROTOCOL_VERSION`, which covers the shapes on the wire: a demo
 * is a file that outlives the session that wrote it, and the two change for
 * different reasons. A demo whose version this build does not know is refused
 * with a sentence rather than replayed into a world it does not describe.
 */
export const DEMO_VERSION = 1

/** One sub-step's inputs: a command per seat, `null` for a seat that sent none. */
export type DemoFrame = readonly (WireCmd | null)[]

export type DemoHeader = {
  readonly version: number
  /** `PROTOCOL_VERSION` at the moment of recording. Informational. */
  readonly protocol: number
  /** The build that recorded it, so a bug report names a commit. */
  readonly build: string
  /** The room code, which is the demo's name in the server log too. */
  readonly room: string
  /** The arena, by name and by hash. Replay refuses a different hash. */
  readonly map: { readonly name: string; readonly hash: string }
  readonly seed: number
  readonly rules: MatchRules
}

export type Demo = {
  readonly header: DemoHeader
  /** One entry per recorded sub-step, in order, starting from tick 0. */
  readonly frames: readonly DemoFrame[]
  /**
   * The world ticks `startMatch` was called *before*.
   *
   * A host takes that edge between sub-steps, so the number here is the tick
   * the world had reached when it did.
   */
  readonly matchStarts: readonly number[]
  /** The hash trace the recording produced, every half second and at tick 0. */
  readonly trace: readonly TraceSample[]
}

export type DemoRecorderOptions = {
  readonly build: string
  readonly room: string
  readonly map: { readonly name: string; readonly hash: string }
  readonly seed: number
  readonly rules?: MatchRules
  readonly protocol: number
  /**
   * How many sub-steps to keep, at most.
   *
   * A room can run for hours and a recorder with no bound is a memory leak with
   * a friendly name. Past the cap the recording *stops* rather than dropping
   * its oldest frames: a demo is only replayable from tick 0, so a ring buffer
   * would produce a file that decodes and cannot be run.
   */
  readonly maxFrames?: number
}

/**
 * How many sub-steps a recording holds by default.
 *
 * 125 Hz means this is twenty minutes, which is far longer than a best-of-five
 * and about 30 MB of JSON at two seats. It is a bound rather than a target; see
 * {@link DemoRecorderOptions.maxFrames}.
 */
export const DEFAULT_MAX_DEMO_FRAMES = 150_000

export type DemoRecorder = {
  /** Sub-steps recorded so far. */
  readonly frames: number
  /** Whether {@link DemoRecorderOptions.maxFrames} has been reached. */
  readonly full: boolean
  /**
   * The host is about to call `startMatch` on a world at `tick`.
   *
   * Called between sub-steps, which is the only place that edge is taken.
   */
  matchStarted(tick: number): void
  /**
   * The inputs of the sub-step about to run, and the world it is about to run
   * on.
   *
   * `state` is read for its tick and hashed on the sample schedule; nothing
   * here writes to it. Call this *before* `tick()`, so the first frame is the
   * one that advances tick 0 to tick 1.
   */
  record(state: GameState, inputs: readonly (UserCmd | null)[]): void
  /**
   * The world after the last sub-step, so the trace ends where the recording
   * does rather than at the last half-second boundary before it.
   */
  finish(state: GameState): Demo
}

export function createDemoRecorder(options: DemoRecorderOptions): DemoRecorder {
  const maxFrames = options.maxFrames ?? DEFAULT_MAX_DEMO_FRAMES
  const rules = options.rules ?? DEFAULT_MATCH_RULES

  const frames: DemoFrame[] = []
  const matchStarts: number[] = []
  const trace: TraceSample[] = []
  /** The next sample's index into the half-second schedule. A cursor, because
   *  a recording does not know how long it will turn out to be. */
  let sampleIndex = 0
  let full = false

  const sample = (state: GameState): void => {
    // `>=` rather than `===`, so a recorder attached to a world that is already
    // past a boundary catches up instead of never sampling again.
    while (sampleTickAt(sampleIndex) < state.tick) sampleIndex += 1
    if (sampleTickAt(sampleIndex) !== state.tick) return
    sampleIndex += 1
    trace.push({
      tick: state.tick,
      timeMs: state.tick * TICK_INTERVAL_MS,
      hash: formatHash(hashState(state)),
    })
  }

  return {
    get frames() {
      return frames.length
    },

    get full() {
      return full
    },

    matchStarted(tick: number) {
      if (full) return
      matchStarts.push(tick)
    },

    record(state: GameState, inputs: readonly (UserCmd | null)[]) {
      if (full) return
      if (frames.length >= maxFrames) {
        full = true
        return
      }
      sample(state)
      frames.push(inputs.map((cmd) => (cmd === null ? null : encodeCmd(cmd))))
    },

    finish(state: GameState): Demo {
      sample(state)
      return {
        header: {
          version: DEMO_VERSION,
          protocol: options.protocol,
          build: options.build,
          room: options.room,
          map: { name: options.map.name, hash: options.map.hash },
          seed: options.seed,
          rules,
        },
        frames: [...frames],
        matchStarts: [...matchStarts],
        trace: [...trace],
      }
    },
  }
}

/* --------------------------------------------------------------------------
 * Playback
 * ----------------------------------------------------------------------- */

export type ReplayDemoOptions = {
  /**
   * The arena. Its hash has to match the demo's, for the same reason the
   * handshake exchanges one: a command stream is a claim about geometry.
   */
  readonly map: LoadedMap
  /** Built from the map when omitted — the same value the host used. */
  readonly plan?: SpawnPlan
  /** Stop after this many sub-steps. The whole demo when omitted. */
  readonly untilFrame?: number
  /** Called after every sub-step, for a caller that wants to watch. */
  readonly onTick?: (state: GameState) => void
}

export type DemoPlayback = {
  /** The world the demo ended in. */
  readonly state: GameState
  /** The hash trace the *replay* produced, on the demo's own schedule. */
  readonly trace: readonly TraceSample[]
  readonly frames: number
}

/**
 * Re-run a demo into a fresh world and produce its hash trace.
 *
 * Throws when the demo cannot be interpreted — a version this build does not
 * know, or a map that is not the one it was recorded on. Both are conditions a
 * caller has to be told about rather than replay past: a demo run against
 * different geometry produces a plausible-looking playback in which the player
 * walks through walls.
 */
export function replayDemo(demo: Demo, options: ReplayDemoOptions): DemoPlayback {
  const { map } = options

  if (demo.header.version !== DEMO_VERSION) {
    throw new Error(
      `demo: recorded by format version ${demo.header.version} and this build reads ${DEMO_VERSION}`,
    )
  }
  if (demo.header.map.hash !== map.hash) {
    throw new Error(
      `demo: recorded on arena ${demo.header.map.name} ${demo.header.map.hash} and this build has ${map.source.name} ${map.hash}`,
    )
  }

  const plan = options.plan ?? buildSpawnPlan(map.source, map.world)
  const state = createMapState(map.source, demo.header.seed, demo.header.rules)
  const world = map.world

  const starts = new Set(demo.matchStarts)
  const trace: TraceSample[] = []
  let sampleIndex = 0

  const sample = (): void => {
    while (sampleTickAt(sampleIndex) < state.tick) sampleIndex += 1
    if (sampleTickAt(sampleIndex) !== state.tick) return
    sampleIndex += 1
    trace.push({
      tick: state.tick,
      timeMs: state.tick * TICK_INTERVAL_MS,
      hash: formatHash(hashState(state)),
    })
  }

  const limit =
    options.untilFrame === undefined
      ? demo.frames.length
      : Math.min(options.untilFrame, demo.frames.length)

  // Reused, for the same reason `room.ts` reuses one: a demo of a long match is
  // a hundred thousand sub-steps and `tick()` allocates nothing in the steady
  // state.
  const inputs: (UserCmd | null)[] = []

  for (let frame = 0; frame < limit; frame += 1) {
    // Between sub-steps, exactly where the host took the edge.
    if (starts.has(state.tick)) startMatch(state, plan)
    sample()

    const recorded = demo.frames[frame] ?? []
    inputs.length = recorded.length
    for (let slot = 0; slot < recorded.length; slot += 1) {
      const wire = recorded[slot]
      inputs[slot] = wire === null || wire === undefined ? null : decodeCmd(wire)
    }

    simTick(state, inputs, world, plan)
    options.onTick?.(state)
  }

  sample()
  return { state, trace, frames: limit }
}

/**
 * Replay a demo and compare the trace against the one it carries.
 *
 * `null` means the recording and the replay agree at every sampled tick, which
 * is the whole claim a demo makes. Anything else names the half-second where
 * they first came apart — which is the same instrument `determinism.test.ts`
 * points at the golden replay, aimed at a real match instead.
 */
export function verifyDemo(demo: Demo, options: ReplayDemoOptions): TraceDivergence | null {
  const playback = replayDemo(demo, options)
  return firstDivergence(demo.trace, playback.trace)
}

/* --------------------------------------------------------------------------
 * The file
 * ----------------------------------------------------------------------- */

/**
 * A demo as JSON text.
 *
 * One line per sub-step is what a human debugging one actually wants — `sed -n
 * 4000p` is a legitimate way to read a demo — so the frames are written one to
 * a line rather than pretty-printed or minified into a single line.
 */
export function encodeDemo(demo: Demo): string {
  const lines: string[] = []
  lines.push('{')
  lines.push(`"header": ${JSON.stringify(demo.header)},`)
  lines.push(`"matchStarts": ${JSON.stringify(demo.matchStarts)},`)
  lines.push(`"trace": ${JSON.stringify(demo.trace)},`)
  lines.push('"frames": [')
  for (let i = 0; i < demo.frames.length; i += 1) {
    lines.push(`${JSON.stringify(demo.frames[i])}${i === demo.frames.length - 1 ? '' : ','}`)
  }
  lines.push(']')
  lines.push('}')
  return `${lines.join('\n')}\n`
}

function fail(what: string): never {
  throw new Error(`demo: ${what}`)
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} is not an object`)
  return value as Record<string, unknown>
}

function asInteger(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) fail(`${what} is not an integer`)
  return value as number
}

function asString(value: unknown, what: string): string {
  if (typeof value !== 'string') fail(`${what} is not a string`)
  return value as string
}

function decodeRules(value: unknown): MatchRules {
  const raw = asObject(value, 'header.rules')
  const selfDamage = asInteger(raw['selfDamage'], 'header.rules.selfDamage')
  if (!isSelfDamageMode(selfDamage)) fail(`header.rules.selfDamage is ${selfDamage}`)
  return {
    roundsToWin: asInteger(raw['roundsToWin'], 'header.rules.roundsToWin'),
    maxRounds: asInteger(raw['maxRounds'], 'header.rules.maxRounds'),
    selfDamage,
    roundTimeLimitTicks: asInteger(raw['roundTimeLimitTicks'], 'header.rules.roundTimeLimitTicks'),
    intermissionTicks: asInteger(raw['intermissionTicks'], 'header.rules.intermissionTicks'),
  }
}

/**
 * Parse a demo, refusing anything that is not one.
 *
 * Strict on the header and lenient on the commands, which is the same split the
 * wire protocol makes and for the same reason: a malformed header means the
 * file is not a demo and there is nothing to do but say so, while a malformed
 * *command* has a legal nearest value (`decodeCmd` clamps it) and a tick is a
 * total function.
 */
export function decodeDemo(text: string): Demo {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    fail(`not JSON: ${String(cause)}`)
  }

  const root = asObject(parsed, 'the file')
  const header = asObject(root['header'], 'header')
  const version = asInteger(header['version'], 'header.version')
  if (version !== DEMO_VERSION) {
    fail(`format version ${version} and this build reads ${DEMO_VERSION}`)
  }
  const map = asObject(header['map'], 'header.map')

  const rawFrames = root['frames']
  if (!Array.isArray(rawFrames)) fail('frames is not an array')
  const frames: DemoFrame[] = (rawFrames as unknown[]).map((frame, index) => {
    if (!Array.isArray(frame)) fail(`frames[${index}] is not an array`)
    return (frame as unknown[]).map((cmd) => (cmd === null ? null : encodeCmd(decodeCmd(cmd))))
  })

  const rawStarts = root['matchStarts']
  if (!Array.isArray(rawStarts)) fail('matchStarts is not an array')

  const rawTrace = root['trace']
  if (!Array.isArray(rawTrace)) fail('trace is not an array')

  return {
    header: {
      version,
      protocol: asInteger(header['protocol'], 'header.protocol'),
      build: asString(header['build'], 'header.build'),
      room: asString(header['room'], 'header.room'),
      map: {
        name: asString(map['name'], 'header.map.name'),
        hash: asString(map['hash'], 'header.map.hash'),
      },
      seed: asInteger(header['seed'], 'header.seed'),
      rules: decodeRules(header['rules']),
    },
    frames,
    matchStarts: (rawStarts as unknown[]).map((tick, i) => asInteger(tick, `matchStarts[${i}]`)),
    trace: (rawTrace as unknown[]).map((entry, i) => {
      const sample = asObject(entry, `trace[${i}]`)
      return {
        tick: asInteger(sample['tick'], `trace[${i}].tick`),
        timeMs: asInteger(sample['timeMs'], `trace[${i}].timeMs`),
        hash: asString(sample['hash'], `trace[${i}].hash`),
      }
    }),
  }
}

/** One line describing a demo, for a log or a CLI. */
export function describeDemo(demo: Demo): string {
  const seconds = ((demo.frames.length * TICK_INTERVAL_MS) / 1000).toFixed(1)
  return (
    `demo ${demo.header.room} — build ${demo.header.build}, arena ${demo.header.map.name} ` +
    `${demo.header.map.hash}, seed ${demo.header.seed}, ${demo.frames.length} sub-steps ` +
    `(${seconds}s), ${demo.trace.length} hash samples`
  )
}
