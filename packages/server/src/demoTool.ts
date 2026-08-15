/**
 * `pnpm demo` — record a match to a file, and replay one back.
 *
 * Demo capture is the debugging tool a netcode project cannot do without. "I
 * got yanked backwards" is unactionable; the same sentence with a file beside
 * it that re-runs the exact command stream is a bug you can watch as many times
 * as you like. `sim/src/demo.ts` is the format and the playback; `demoFile.ts`
 * is the disk; this is the program.
 *
 *     pnpm demo record [--out <path>] [--seconds N] [--seed N]
 *     pnpm demo replay <path> [--until <tick>]
 *     pnpm demo check                 record, write, read back, verify. CI's gate.
 *
 * It lives in `packages/server` rather than in `tools/` for one reason: it
 * drives a real `Room`, and `tools/` may reach `@gladiator/sim` and
 * `@gladiator/bot` and deliberately nothing else (`AGENTS.md`). Same shape as
 * `measure-jitter.ts`, which is here for the same kind of reason.
 *
 * ## `record` drives the real host
 *
 * Two peers over two loopbacks into a real `Room`, handshake and all, with the
 * real input queue in front of it and the real scheduler's accumulator folding
 * frames into sub-steps. What comes out is therefore the same artifact a match
 * on Fly produces, which is the only kind worth testing playback against — a
 * demo assembled by calling `tick()` in a loop would prove that `tick()` is
 * deterministic, which `determinism.test.ts` already does, and nothing about
 * whether a *host* records what it executed.
 *
 * Virtual time throughout: a ten-second match costs a fraction of a second of
 * arithmetic, because a `Room` never reads a clock to decide how far to advance
 * (`packages/server/src/room.ts`).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import {
  BUTTON_ATTACK,
  BUTTON_JUMP,
  DEFAULT_MATCH_RULES,
  MAX_PITCH_UNITS,
  NULL_CMD,
  PROTOCOL_VERSION,
  TICK_RATE,
  Weapon,
  createDemoRecorder,
  describeDemo,
  encodeCmd,
  encodeDemo,
  formatHash,
  hashState,
  replayDemo,
  verifyDemo,
  yawUnitsFromDegrees,
  type Demo,
  type MatchRules,
  type UserCmd,
} from '@gladiator/sim'
import { manualClock } from './clock.ts'
import { readDemoFile } from './demoFile.ts'
import { SERVER_MAP, SERVER_PLAN } from './map.ts'
import { createLoopbackPair, settleLoopback } from './net/loopbackTransport.ts'
import { createRoom } from './room.ts'
import { stepsFor } from './scheduler.ts'

/** The repository root: this file is `packages/server/src/demoTool.ts`. */
const ROOT = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))))

/** Where a recording lands when nobody says. Gitignored; see `.gitignore`. */
export const DEMO_DIR = join(ROOT, 'demos')

/** The file `pnpm demo check` writes and reads back. */
export const CHECK_PATH = join(DEMO_DIR, 'check.demo.json')

/** Milliseconds a client frame is worth. 60 Hz, as a browser gives you. */
const FRAME_MS = 16

/** The room code a recording is made under. Fixed, so the file name is too. */
export const SCRIPT_ROOM = 'DEMO01'

/**
 * A round short enough that a ten-second recording contains several.
 *
 * The point of recording through a real host is to capture the things that are
 * *not* in the command stream — `startMatch`, a round ending on the clock, two
 * bodies being re-spawned — so the script is written to produce them rather
 * than to be a pleasant duel.
 */
export const SCRIPT_RULES: MatchRules = {
  ...DEFAULT_MATCH_RULES,
  roundTimeLimitTicks: 2 * TICK_RATE,
  intermissionTicks: Math.round(0.5 * TICK_RATE),
}

/**
 * What each seat is doing on a given command tick.
 *
 * Written as a pure function of the tick so the script is reproducible and
 * readable: seat 0 runs, turns, hops and rocket-jumps into the floor; seat 1
 * strafes the other way and fires the rail. Between them they exercise
 * movement, both weapons, splash, self-damage and a round decided on damage.
 */
export function scriptedCmd(slot: number, at: number): UserCmd {
  if (slot === 0) {
    return {
      ...NULL_CMD,
      forwardMove: 1,
      sideMove: at % 50 < 25 ? 1 : -1,
      yaw: yawUnitsFromDegrees(at * 2),
      // Straight down every 40 ticks: a rocket at your own feet is the full
      // 100 points and the full launch, which is the most interesting thing a
      // command stream can contain.
      pitch: at % 40 === 0 ? MAX_PITCH_UNITS : 0,
      buttons: (at % 20 === 0 ? BUTTON_JUMP : 0) | (at % 40 === 0 ? BUTTON_ATTACK : 0),
      weapon: Weapon.RocketLauncher,
    }
  }
  return {
    ...NULL_CMD,
    forwardMove: at % 60 < 30 ? 1 : -1,
    sideMove: at % 30 < 15 ? -1 : 1,
    yaw: yawUnitsFromDegrees(180 - at),
    pitch: 0,
    buttons: at % 31 === 0 ? BUTTON_ATTACK : 0,
    weapon: Weapon.Railgun,
  }
}

export type Recording = {
  readonly demo: Demo
  /** The hash the host's world ended on, for a caller that wants to compare. */
  readonly finalHash: number
  readonly ticks: number
}

/**
 * Play a scripted duel through a real `Room` and hand back the recording.
 *
 * Async because a loopback delivers on a microtask — deliberately, so that a
 * client's send cannot re-enter the host mid-tick (`loopbackTransport.ts`).
 */
export async function recordScriptedDuel(
  options: { seconds?: number; seed?: number; room?: string; build?: string } = {},
): Promise<Recording> {
  const seconds = options.seconds ?? 10
  const seed = options.seed ?? 0x6c1d
  const room = options.room ?? SCRIPT_ROOM
  const build = options.build ?? 'demo-tool'

  const clock = manualClock()
  const recorder = createDemoRecorder({
    build,
    room,
    map: { name: SERVER_MAP.source.name, hash: SERVER_MAP.hash },
    seed,
    rules: SCRIPT_RULES,
    protocol: PROTOCOL_VERSION,
  })

  const host = createRoom({
    map: SERVER_MAP,
    plan: SERVER_PLAN,
    clock,
    build,
    id: room,
    seed,
    rules: SCRIPT_RULES,
    peerId: (index) => `demo-${index}`,
    recorder,
  })

  const seats = [0, 1].map(() => createLoopbackPair())
  for (const seat of seats) {
    // The client end has to have handlers, or the loopback has nowhere to put
    // what the host says and never settles.
    seat.client.setHandlers({ onMessage: () => undefined })
    host.join(seat.server)
    seat.client.send(
      JSON.stringify({
        t: 'hello',
        protocol: PROTOCOL_VERSION,
        build,
        mapHash: SERVER_MAP.hash,
      }),
    )
  }
  for (const seat of seats) await settleLoopback(seat)

  // The clients' own command counters. A tick label is the peer's, not the
  // world's (`server/src/room.ts`), which is exactly why there are two of them.
  const labels = [0, 0]
  let remainderMs = 0
  const frames = Math.ceil((seconds * 1000) / FRAME_MS)

  for (let frame = 0; frame < frames; frame += 1) {
    clock.advance(FRAME_MS)
    const fold = stepsFor(remainderMs, FRAME_MS)
    remainderMs = fold.remainderMs

    for (let slot = 0; slot < seats.length; slot += 1) {
      const seat = seats[slot]
      if (seat === undefined) continue
      const cmds: ReturnType<typeof encodeCmd>[] = []
      const startTick = (labels[slot] ?? 0) + 1
      for (let i = 0; i < fold.steps; i += 1) {
        labels[slot] = (labels[slot] ?? 0) + 1
        cmds.push(encodeCmd(scriptedCmd(slot, labels[slot] ?? 0)))
      }
      if (cmds.length > 0) seat.client.send(JSON.stringify({ t: 'cmds', startTick, cmds }))
    }
    for (const seat of seats) await settleLoopback(seat)

    host.advance(fold.steps)
    host.sweep(clock.nowMs())
    for (const seat of seats) await settleLoopback(seat)
  }

  const demo = recorder.finish(host.state)
  const finalHash = hashState(host.state)
  const ticks = host.tick
  for (const seat of seats) seat.close()
  return { demo, finalHash, ticks }
}

/** Write a demo, creating the directory. Returns the path. */
export function writeDemo(path: string, demo: Demo): string {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, encodeDemo(demo), 'utf8')
  return path
}

function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}

function number(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isInteger(parsed) ? parsed : fallback
}

const USAGE = `usage:
  pnpm demo record [--out <path>] [--seconds N] [--seed N]
  pnpm demo replay <path> [--until <tick>]
  pnpm demo check`

export async function main(argv: readonly string[]): Promise<number> {
  const [command] = argv

  if (command === 'record' || command === undefined) {
    const seconds = number(flag(argv, '--seconds'), 10)
    const seed = number(flag(argv, '--seed'), 0x6c1d)
    const out = flag(argv, '--out') ?? join(DEMO_DIR, `${SCRIPT_ROOM}.demo.json`)
    const { demo, ticks } = await recordScriptedDuel({ seconds, seed })
    writeDemo(out, demo)
    console.log(`✓ ${describeDemo(demo)}`)
    console.log(`    ${ticks} sub-steps hosted, written to ${out}`)
    return 0
  }

  if (command === 'replay') {
    const path = argv[1]
    if (path === undefined || path.startsWith('--')) {
      console.error(USAGE)
      return 1
    }
    const demo = readDemoFile(resolve(path))
    const untilRaw = flag(argv, '--until')
    const played = replayDemo(demo, {
      map: SERVER_MAP,
      plan: SERVER_PLAN,
      ...(untilRaw === undefined ? {} : { untilFrame: number(untilRaw, demo.frames.length) }),
    })
    console.log(`· ${describeDemo(demo)}`)
    console.log(
      `    replayed ${played.frames} sub-steps to tick ${played.state.tick}, ` +
        `hash ${formatHash(hashState(played.state))}`,
    )
    if (untilRaw !== undefined) return 0

    const divergence = verifyDemo(demo, { map: SERVER_MAP, plan: SERVER_PLAN })
    if (divergence === null) {
      console.log(`✓ replays exactly — ${demo.trace.length} hash samples agree`)
      return 0
    }
    console.error(
      `✗ diverged at ${divergence.timeMs} ms (tick ${divergence.tick}): ` +
        `recorded ${divergence.expected}, replayed ${divergence.actual}`,
    )
    return 1
  }

  if (command === 'check') {
    const { demo } = await recordScriptedDuel()
    writeDemo(CHECK_PATH, demo)
    // Read back from disk rather than verifying the value in memory: the claim
    // is that a *file* replays, and the encode/decode is part of the claim.
    const read = readDemoFile(CHECK_PATH)
    const divergence = verifyDemo(read, { map: SERVER_MAP, plan: SERVER_PLAN })
    console.log(`· ${describeDemo(read)}`)
    console.log(`    written to ${CHECK_PATH}`)
    if (divergence === null) {
      console.log(`✓ a recorded match replays to the same trace, ${read.trace.length} samples`)
      return 0
    }
    console.error(
      `✗ diverged at ${divergence.timeMs} ms (tick ${divergence.tick}): ` +
        `recorded ${divergence.expected}, replayed ${divergence.actual}`,
    )
    return 1
  }

  console.error(USAGE)
  return 1
}

// Only when run as a program. `demoTool.test.ts` imports the functions above
// and must not trip the CLI on the way in.
const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code
    },
    (cause: unknown) => {
      console.error(`gladiator: the demo tool threw — ${String(cause)}`)
      process.exitCode = 1
    },
  )
}
