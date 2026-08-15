/**
 * The demo format, on its own.
 *
 * What a demo *claims* is that re-running its command stream produces the
 * states it says it produced — so the test is the claim: record a world being
 * driven, write the file, read it back, replay it, and require the hash traces
 * to be equal sample for sample. `tools/demo.test.ts` makes the same assertion
 * against a real `Room` over a real transport; this one is about the format.
 */
import { describe, expect, it } from 'vitest'

import {
  DEMO_VERSION,
  createDemoRecorder,
  decodeDemo,
  describeDemo,
  encodeDemo,
  replayDemo,
  verifyDemo,
} from './demo.ts'
import type { Demo } from './demo.ts'
import { tick as simTick } from './kernel.ts'
import { mapCollisionBrushes } from './map/collide.ts'
import { createMapState, mapHashOf } from './map/load.ts'
import type { LoadedMap } from './map/load.ts'
import type { MapSource } from './map/schema.ts'
import { buildSpawnPlan } from './match/spawn.ts'
import { startMatch } from './match/round.ts'
import { createCollisionWorld } from './collide.ts'
import { ANGLE_UNITS } from './usercmd.ts'
import { PROTOCOL_VERSION } from './protocol.ts'
import { BUTTON_ATTACK, BUTTON_JUMP, NULL_CMD, yawUnitsFromDegrees } from './usercmd.ts'
import type { UserCmd } from './usercmd.ts'
import { Weapon } from './weapon.ts'

/** A sealed room with two spawns far enough apart to be a legal pair. */
function fixtureSource(): MapSource {
  return {
    name: 'demo-fixture',
    title: 'Demo Fixture',
    author: 'test',
    surfaces: [{ name: 'shell', material: 'concrete', tint: [0.3, 0.3, 0.3] }],
    brushes: [
      { kind: 'box', surface: 'shell', mins: [-1024, -1024, -64], maxs: [1024, 1024, 0] },
      { kind: 'box', surface: 'shell', mins: [-1024, -1024, 512], maxs: [1024, 1024, 576] },
      { kind: 'box', surface: 'shell', mins: [960, -1024, -64], maxs: [1024, 1024, 576] },
      { kind: 'box', surface: 'shell', mins: [-1024, -1024, -64], maxs: [-960, 1024, 576] },
      { kind: 'box', surface: 'shell', mins: [-1024, 960, -64], maxs: [1024, 1024, 576] },
      { kind: 'box', surface: 'shell', mins: [-1024, -1024, -64], maxs: [1024, -960, 576] },
      // A divider, so the two spawns cannot see each other and the pair is legal.
      { kind: 'box', surface: 'shell', mins: [-32, -1024, -64], maxs: [32, 1024, 576] },
    ],
    spawns: [
      { origin: [-640, 0, 0], yaw: 0 },
      { origin: [640, 0, 0], yaw: 32768 },
    ],
    lights: [],
    props: [],
  }
}

function fixtureMap(): LoadedMap {
  const source = fixtureSource()
  const { brushes, sourceBrush } = mapCollisionBrushes(source)
  return { source, hash: mapHashOf(source), world: createCollisionWorld(brushes), sourceBrush }
}

const SEED = 0x5eed

function cmd(over: Partial<UserCmd> = {}): UserCmd {
  return { ...NULL_CMD, ...over }
}

/**
 * Drive a world the way a host does, recording as it goes.
 *
 * Deliberately not `runReplay`: what a demo records is the stream a *host*
 * executed, so the fixture is a loop that looks like `room.ts`'s — inputs
 * assembled per sub-step, `startMatch` taken between them.
 */
function record(map: LoadedMap, ticks: number, startAt: number | null): Demo {
  const plan = buildSpawnPlan(map.source, map.world)
  const state = createMapState(map.source, SEED)
  const recorder = createDemoRecorder({
    build: 'test',
    room: 'AB12CD',
    map: { name: map.source.name, hash: map.hash },
    seed: SEED,
    protocol: PROTOCOL_VERSION,
  })

  for (let step = 0; step < ticks; step += 1) {
    if (startAt !== null && state.tick === startAt) {
      recorder.matchStarted(state.tick)
      startMatch(state, plan)
    }
    // Something with an opinion in it: running, turning, jumping and firing, so
    // the stream exercises movement, the weapons phase and splash rather than a
    // player standing still.
    const inputs: (UserCmd | null)[] = [
      cmd({
        forwardMove: 1,
        sideMove: step % 40 < 20 ? 1 : -1,
        yaw: yawUnitsFromDegrees(step * 3),
        pitch: -8000,
        buttons: (step % 16 === 0 ? BUTTON_JUMP : 0) | (step % 25 === 0 ? BUTTON_ATTACK : 0),
        weapon: step % 60 < 30 ? Weapon.RocketLauncher : Weapon.Railgun,
      }),
      step % 3 === 0 ? null : cmd({ forwardMove: -1, yaw: yawUnitsFromDegrees(180) }),
    ]
    recorder.record(state, inputs)
    simTick(state, inputs, map.world, plan)
  }

  return recorder.finish(state)
}

describe('a demo', () => {
  const map = fixtureMap()

  it('replays to the trace it recorded', () => {
    const demo = record(map, 400, 20)
    expect(demo.frames).toHaveLength(400)
    // Every half second plus tick 0: 0, 63, 125, 188, 250, 313, 375, 400.
    expect(demo.trace.length).toBeGreaterThan(6)
    expect(verifyDemo(demo, { map })).toBeNull()
  })

  it('survives the round trip through a file', () => {
    const demo = record(map, 300, 10)
    const text = encodeDemo(demo)
    const read = decodeDemo(text)

    expect(read.header).toEqual(demo.header)
    expect(read.matchStarts).toEqual(demo.matchStarts)
    expect(read.frames).toEqual(demo.frames)
    expect(verifyDemo(read, { map })).toBeNull()
  })

  it('is written one sub-step to a line, so a demo can be read with sed', () => {
    const demo = record(map, 50, null)
    const lines = encodeDemo(demo).trimEnd().split('\n')
    // `{`, header, matchStarts, trace, `"frames": [`, 50 frames, `]`, `}`.
    expect(lines).toHaveLength(50 + 7)
    expect(lines.filter((line) => line.startsWith('[['))).toHaveLength(50)
  })

  it('reproduces the match, not only the physics', () => {
    const demo = record(map, 400, 20)
    const played = replayDemo(demo, { map })
    // `startMatch` is not in the command stream — it is an edge the host takes
    // between sub-steps — so a replay that did not record it would run the
    // whole thing in warmup and still produce a plausible-looking playback.
    expect(demo.matchStarts).toEqual([20])
    expect(played.state.match.round).toBeGreaterThan(0)
  })

  it('stops recording at the cap rather than dropping its oldest frames', () => {
    const recorder = createDemoRecorder({
      build: 'test',
      room: 'AB12CD',
      map: { name: map.source.name, hash: map.hash },
      seed: SEED,
      protocol: PROTOCOL_VERSION,
      maxFrames: 10,
    })
    const state = createMapState(map.source, SEED)
    for (let step = 0; step < 40; step += 1) {
      recorder.record(state, [cmd({ forwardMove: 1 }), null])
      simTick(state, [cmd({ forwardMove: 1 }), null], map.world)
    }
    // A ring buffer would leave a file that decodes and cannot be run: a demo
    // is only replayable from tick 0.
    expect(recorder.full).toBe(true)
    expect(recorder.frames).toBe(10)
    expect(recorder.finish(state).frames).toHaveLength(10)
  })

  it('refuses a different arena rather than replaying into it', () => {
    const demo = record(map, 20, null)
    const other = fixtureMap()
    const moved: LoadedMap = { ...other, hash: 'deadbeef' }
    expect(() => replayDemo(demo, { map: moved })).toThrow(/arena/)
  })

  it('refuses a format version it does not read', () => {
    const demo = record(map, 20, null)
    const future: Demo = { ...demo, header: { ...demo.header, version: DEMO_VERSION + 1 } }
    expect(() => replayDemo(future, { map })).toThrow(/format version/)
    expect(() => decodeDemo(encodeDemo(future))).toThrow(/format version/)
  })

  it('refuses a file that is not a demo, with a sentence', () => {
    expect(() => decodeDemo('not json at all')).toThrow(/not JSON/)
    expect(() => decodeDemo('{}')).toThrow(/header is not an object/)
  })

  it('clamps a command that has been edited into something illegal', () => {
    const demo = record(map, 5, null)
    const lines = encodeDemo(demo).trimEnd().split('\n')
    const first = lines.findIndex((line) => line.startsWith('[['))
    lines[first] = '[["oops",null,999999999,{},true,7],null],'
    // A tick is a total function, so the door is the only place a bad value can
    // be turned away — the same rule `decodeCmd` holds the wire to. The file
    // still decodes and still replays; what it replays is a legal command.
    //
    // Five of the six fields become zero. The yaw does not, and that is the one
    // field in a `UserCmd` that *wraps* rather than clamping (GLAD-V7M6PQ): a
    // yaw has no illegal value, only an unwrapped one, so 999999999 units is
    // 51711 units rather than "facing due north".
    const read = decodeDemo(lines.join('\n'))
    expect(read.frames[0]?.[0]).toEqual([0, 0, 999999999 % ANGLE_UNITS, 0, 0, 1])
    expect(() => replayDemo(read, { map })).not.toThrow()
  })

  it('describes itself in one line', () => {
    const demo = record(map, 125, null)
    expect(describeDemo(demo)).toContain('AB12CD')
    expect(describeDemo(demo)).toContain('125 sub-steps')
  })
})
