/**
 * Replays: a committed input stream, run through the kernel, sampled into a
 * hash trace.
 *
 * This is the determinism test infrastructure every later gameplay ticket
 * reuses, and the shape the recorded-desync tooling in GLAD-2E6PUO will read.
 *
 * A replay is *data*: an initial world, a seed, a duration, and a list of
 * input keyframes. Keyframes rather than one command per tick because 1250
 * lines of identical commands is not a thing a human can review, and a fixture
 * nobody can read is a fixture nobody will notice going wrong.
 *
 * Angles are authored in **degrees** and converted to the angle units a
 * `UserCmd` carries at expansion time. Degrees because a keyframe is read by a
 * person; units because that is what crosses the network.
 *
 * Allocation here is unapologetic — `commandSourceFor` builds a fresh array
 * every tick. Replays run in tests and in tooling, never in a match.
 */

import { formatHash } from './hash.ts'
import { advanceHost, advanceTicks, createKernel } from './kernel.ts'
import type { CommandSource, TickInputs } from './kernel.ts'
import { vec3 } from './math.ts'
import { EntityFlag, EntityKind, createGameState, hashState, spawnEntity } from './state.ts'
import { Weapon } from './weapon.ts'
import type { GameState } from './state.ts'
import { TICK_INTERVAL_MS, TICK_RATE } from './tick.ts'
import { SURFACE_CLIP_EPSILON } from './trace.ts'
import { pitchUnitsFromDegrees, yawUnitsFromDegrees } from './usercmd.ts'
import type { UserCmd } from './usercmd.ts'

/**
 * "From this tick onward, this slot is holding this."
 *
 * A frame applies until the next frame for the same slot. A slot with no frame
 * at or before a tick sends nothing, and the kernel treats that as `NULL_CMD`.
 */
export type ScriptFrame = {
  readonly tick: number
  readonly slot: number
  /** -1 back, 0, +1 forward. */
  readonly forwardMove: number
  /** -1 left, 0, +1 right. */
  readonly sideMove: number
  readonly yawDeg: number
  readonly pitchDeg: number
  readonly buttons: number
  /**
   * The weapon held. Omitted means the rocket launcher, so every replay
   * written before there was a second weapon still says what it meant.
   */
  readonly weapon?: Weapon
}

/** A player present in the world at tick 0. Not a spawn *policy* — GLAD-AKODBZ. */
export type ReplaySpawn = {
  readonly slot: number
  readonly origin: readonly [number, number, number]
  readonly yawDeg: number
  readonly health: number
}

export type Replay = {
  readonly name: string
  readonly seed: number
  readonly durationTicks: number
  readonly spawns: readonly ReplaySpawn[]
  readonly script: readonly ScriptFrame[]
}

/** One entry of a hash trace. `hash` is hex so a git diff is readable. */
export type TraceSample = {
  readonly tick: number
  readonly timeMs: number
  readonly hash: string
}

/**
 * The ticks a trace is sampled at: every half second, plus tick 0.
 *
 * 125 Hz means half a second is 62.5 ticks, which is not a tick. Rounding each
 * multiple — 0, 63, 125, 188, 250, … — keeps the samples half a second apart
 * on average and lands each of them on a real tick. `k * 62.5` is exact in
 * IEEE 754 (62.5 is 125/2), so the schedule is the same everywhere.
 */
export function sampleTicks(durationTicks: number): number[] {
  const perSample = TICK_RATE / 2
  const ticks: number[] = []
  for (let k = 0; ; k++) {
    const at = Math.round(k * perSample)
    if (at > durationTicks) break
    ticks.push(at)
  }
  return ticks
}

/** The world a replay starts from. */
export function createReplayState(replay: Replay): GameState {
  const state = createGameState(replay.seed)
  for (const spawn of replay.spawns) {
    spawnEntity(state, {
      kind: EntityKind.Player,
      slot: spawn.slot,
      // Spawned already standing, so the first tick of the script is a tick
      // the player can act on rather than one spent falling onto the floor.
      flags: EntityFlag.OnGround,
      // A spawn point names a floor height, and a body resting on a floor sits
      // `SURFACE_CLIP_EPSILON` clear of it (`docs/physics-spec.md` §2.2).
      // Authoring the epsilon into every fixture instead would put a number
      // that belongs to the trace into files that know nothing about it.
      origin: vec3(
        spawn.origin[0],
        spawn.origin[1],
        spawn.origin[2] + SURFACE_CLIP_EPSILON,
      ),
      angles: vec3(0, yawUnitsFromDegrees(spawn.yawDeg), 0),
      health: spawn.health,
    })
  }
  return state
}

function highestSlot(replay: Replay): number {
  let highest = -1
  for (const spawn of replay.spawns) if (spawn.slot > highest) highest = spawn.slot
  for (const frame of replay.script) if (frame.slot > highest) highest = frame.slot
  return highest
}

function latestFrame(
  script: readonly ScriptFrame[],
  slot: number,
  atTick: number,
): ScriptFrame | null {
  let best: ScriptFrame | null = null
  for (const frame of script) {
    if (frame.slot !== slot) continue
    if (frame.tick > atTick) continue
    if (best === null || frame.tick >= best.tick) best = frame
  }
  return best
}

function cmdFrom(frame: ScriptFrame): UserCmd {
  return {
    forwardMove: frame.forwardMove,
    sideMove: frame.sideMove,
    yaw: yawUnitsFromDegrees(frame.yawDeg),
    pitch: pitchUnitsFromDegrees(frame.pitchDeg),
    buttons: frame.buttons,
    weapon: frame.weapon ?? Weapon.RocketLauncher,
  }
}

/** Expand a script into the kernel's per-tick command source. */
export function commandSourceFor(replay: Replay): CommandSource {
  const slotCount = highestSlot(replay) + 1
  return (atTick: number): TickInputs => {
    const inputs: (UserCmd | null)[] = []
    for (let slot = 0; slot < slotCount; slot++) {
      const frame = latestFrame(replay.script, slot, atTick)
      inputs.push(frame === null ? null : cmdFrom(frame))
    }
    return inputs
  }
}

function sampler(replay: Replay, into: TraceSample[]): (state: GameState) => void {
  const wanted = new Set(sampleTicks(replay.durationTicks))
  return (state: GameState) => {
    if (!wanted.has(state.tick)) return
    into.push({
      tick: state.tick,
      timeMs: state.tick * TICK_INTERVAL_MS,
      hash: formatHash(hashState(state)),
    })
  }
}

/**
 * Run a replay one sub-step at a time, with no host clock involved at all.
 *
 * This is the reference: whatever host frame pattern a peer happens to have,
 * it must produce this trace.
 */
export function runReplay(replay: Replay): TraceSample[] {
  const kernel = createKernel(createReplayState(replay))
  const trace: TraceSample[] = []
  const sample = sampler(replay, trace)

  sample(kernel.state)
  advanceTicks(kernel, replay.durationTicks, commandSourceFor(replay), sample)
  return trace
}

/**
 * Run a replay through `advanceHost` on a given host frame schedule.
 *
 * `frameMs` is either a fixed delta or a function of the frame index, so a
 * test can drive the same replay at a steady 60 Hz, at a steady 8 ms, and
 * through a scripted jitter pattern, and assert all three agree.
 *
 * The last frame may overshoot `durationTicks` — a host frame does not divide
 * evenly into sub-steps, which is the entire point. Samples past the duration
 * are not collected.
 */
export function runReplayHosted(
  replay: Replay,
  frameMs: number | ((frameIndex: number) => number),
): TraceSample[] {
  const kernel = createKernel(createReplayState(replay))
  const trace: TraceSample[] = []
  const sample = sampler(replay, trace)
  const commands = commandSourceFor(replay)

  sample(kernel.state)

  for (let frame = 0; kernel.state.tick < replay.durationTicks; frame++) {
    const dtMs = typeof frameMs === 'number' ? frameMs : frameMs(frame)
    advanceHost(kernel, dtMs, commands, sample)

    // A schedule that never accumulates a whole sub-step would spin forever;
    // say so rather than hang a test runner.
    if (dtMs <= 0 && kernel.remainderMs < TICK_INTERVAL_MS) {
      throw new RangeError(`runReplayHosted: frame schedule never advances (dtMs=${dtMs})`)
    }
  }

  return trace
}

export type TraceDivergence = {
  readonly index: number
  readonly tick: number
  readonly timeMs: number
  readonly expected: string
  readonly actual: string
}

/**
 * The first sample where two traces disagree, or `null`.
 *
 * The *first* one, not the last, and not just the final hash: once two
 * simulations diverge they stay diverged, so the final hash tells you only
 * that something went wrong at some point in the last ten seconds. The first
 * divergent sample names the half-second to go and look at.
 */
export function firstDivergence(
  expected: readonly TraceSample[],
  actual: readonly TraceSample[],
): TraceDivergence | null {
  const shared = Math.min(expected.length, actual.length)

  for (let i = 0; i < shared; i++) {
    const want = expected[i]
    const got = actual[i]
    if (want === undefined || got === undefined) continue
    if (want.tick === got.tick && want.hash === got.hash) continue
    return {
      index: i,
      tick: want.tick,
      timeMs: want.timeMs,
      expected: `t=${want.tick} ${want.hash}`,
      actual: `t=${got.tick} ${got.hash}`,
    }
  }

  if (expected.length === actual.length) return null

  const index = shared
  const longer = expected.length > actual.length ? expected : actual
  const missing = longer[index]
  return {
    index,
    tick: missing?.tick ?? -1,
    timeMs: missing?.timeMs ?? -1,
    expected:
      expected.length > shared
        ? `t=${expected[index]?.tick} ${expected[index]?.hash}`
        : '<end of trace>',
    actual:
      actual.length > shared ? `t=${actual[index]?.tick} ${actual[index]?.hash}` : '<end of trace>',
  }
}

/**
 * A trace as the literal that belongs in a fixture file.
 *
 * The golden trace is regenerated by copying this out of a failing test — see
 * the note at the top of `determinism.test.ts`. There is no bake script,
 * because a bake script inside `packages/sim` would need a filesystem, and the
 * whole point of this package is that it does not have one.
 */
export function formatTraceLiteral(trace: readonly TraceSample[]): string {
  const lines = trace.map(
    (sample) => `  { tick: ${sample.tick}, timeMs: ${sample.timeMs}, hash: '${sample.hash}' },`,
  )
  return `[\n${lines.join('\n')}\n]`
}
