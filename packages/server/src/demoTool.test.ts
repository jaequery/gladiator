/**
 * The headline acceptance check: **a match records to a demo file and replays
 * deterministically, reproducing the same state hash trace.**
 *
 * All of it, end to end and with a real file on a real disk. A duel is played
 * through a real `Room` over real transports with the real input queue in front
 * of it; the recording is written, read back, and re-run; and the hash trace
 * the replay produces has to equal the one the recording carries, sample for
 * sample.
 *
 * The file part is not ceremony. Encoding and decoding are the two places a
 * recording can quietly stop being the thing that was recorded — a command
 * clamped on the way out, a number that went through a float — and a check that
 * verified the object in memory would miss both.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MatchPhase, formatHash, hashState, replayDemo, verifyDemo } from '@gladiator/sim'
import { afterAll, describe, expect, it } from 'vitest'

import { readDemoFile, writeDemoFile } from './demoFile.ts'
import { SCRIPT_ROOM, main, recordScriptedDuel, writeDemo } from './demoTool.ts'
import { SERVER_MAP, SERVER_PLAN } from './map.ts'

const scratch = mkdtempSync(join(tmpdir(), 'gladiator-demo-'))

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('a recorded match', () => {
  it('replays from a file to the same hash trace', async () => {
    const { demo, finalHash, ticks } = await recordScriptedDuel({ seconds: 8 })

    // The recording is of a *match*, not of two bodies falling: the host took
    // the one edge out of warmup, and the rules ran rounds inside it.
    expect(demo.matchStarts.length).toBeGreaterThan(0)
    expect(demo.frames.length).toBe(ticks)
    expect(demo.trace.length).toBeGreaterThan(8)

    const path = writeDemoFile(scratch, demo, 0)
    expect(statSync(path).size).toBeGreaterThan(1000)

    const read = readDemoFile(path)
    expect(verifyDemo(read, { map: SERVER_MAP, plan: SERVER_PLAN })).toBeNull()

    // And the world it lands in is the world the host was in, not merely a
    // world whose sampled hashes happened to agree.
    const played = replayDemo(read, { map: SERVER_MAP, plan: SERVER_PLAN })
    expect(played.state.tick).toBe(ticks)
    expect(formatHash(hashState(played.state))).toBe(formatHash(finalHash))
    expect(played.state.match.phase).not.toBe(MatchPhase.Warmup)
    expect(played.state.match.round).toBeGreaterThan(1)
  })

  it('can be stopped at the tick the bug report names', async () => {
    const { demo } = await recordScriptedDuel({ seconds: 3 })
    const half = Math.floor(demo.frames.length / 2)
    const played = replayDemo(demo, { map: SERVER_MAP, plan: SERVER_PLAN, untilFrame: half })
    // The whole point of a demo: stop where it went wrong and look at it.
    expect(played.frames).toBe(half)
    expect(played.state.tick).toBe(half)
  })

  it('is a different match under a different seed, and the same one under the same', async () => {
    const a = await recordScriptedDuel({ seconds: 2, seed: 1 })
    const b = await recordScriptedDuel({ seconds: 2, seed: 1 })
    const c = await recordScriptedDuel({ seconds: 2, seed: 2 })

    expect(a.finalHash).toBe(b.finalHash)
    // Which pair of spawns a round starts on is a draw from the PRNG, so the
    // seed is part of what a demo has to record. A file that left it out would
    // replay into a plausible-looking match that is not the one recorded.
    expect(c.finalHash).not.toBe(a.finalHash)
  })
})

describe('the command line', () => {
  it('records, then replays what it recorded', async () => {
    const out = join(scratch, 'cli.demo.json')
    expect(await main(['record', '--out', out, '--seconds', '2'])).toBe(0)
    expect(await main(['replay', out])).toBe(0)
    expect(await main(['replay', out, '--until', '100'])).toBe(0)
  })

  it('refuses a file that is not a demo, rather than replaying nothing', async () => {
    const bogus = join(scratch, 'bogus.demo.json')
    writeDemo(bogus, {
      header: {
        version: 1,
        protocol: 0,
        build: 'x',
        room: SCRIPT_ROOM,
        map: { name: 'somewhere-else', hash: 'deadbeef' },
        seed: 1,
        rules: {
          roundsToWin: 3,
          maxRounds: 9,
          selfDamage: 1,
          roundTimeLimitTicks: 100,
          intermissionTicks: 10,
        },
      },
      frames: [],
      matchStarts: [],
      trace: [],
    })
    await expect(main(['replay', bogus])).rejects.toThrow(/arena/)
  })

  it('says how to use it when it is not told what to do', async () => {
    expect(await main(['nonsense'])).toBe(1)
    expect(await main(['replay'])).toBe(1)
  })
})
