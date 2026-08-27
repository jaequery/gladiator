/**
 * The input buffer policy, one failure mode at a time.
 *
 * The four ways a command goes wrong — late, duplicate, out of order, missing —
 * each get a test of their own, because the policy for each is a *decision*
 * (`inputQueue.ts` argues all four) and a decision nobody can see fail is a
 * decision the next person will change by accident.
 *
 * The last two describes are the ones that would catch a real regression: the
 * buffer staying bounded under a client running fast, and a client sending four
 * times the legal rate getting nothing for it.
 */
import {
  BUTTON_ATTACK,
  BUTTON_DASH_LEFT,
  BUTTON_JUMP,
  EntityKind,
  SURFACE_CLIP_EPSILON,
  SKELETON_SEED,
  TICK_RATE,
  type CollisionWorld,
  type GameState,
  type UserCmd,
  boxBrush,
  createCollisionWorld,
  createGameState,
  spawnEntity,
  tick as simTick,
  vec3,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import {
  COMMAND_BUDGET,
  COMMAND_BURST,
  CommandFate,
  CommandFill,
  DRIFT_WINDOW_TICKS,
  JITTER_BUFFER_TICKS,
  MAX_BUFFERED_COMMANDS,
  MAX_REPEAT_TICKS,
  createInputQueue,
  mergeCommands,
} from './inputQueue.ts'

/** A command that is distinguishable from every other one in these tests. */
function cmdWith(patch: Partial<UserCmd> = {}): UserCmd {
  return { forwardMove: 0, sideMove: 0, yaw: 0, pitch: 0, buttons: 0, weapon: 0, ...patch }
}

/** Holding forward, looking down +x. The whole of a straight sprint. */
const SPRINT = cmdWith({ forwardMove: 1 })

describe('a command that arrives late', () => {
  it('is dropped, because the world is only ever rewound for hits', () => {
    const queue = createInputQueue()
    expect(queue.offer(1, cmdWith({ yaw: 1 }), 0)).toBe(CommandFate.Queued)
    expect(queue.offer(2, cmdWith({ yaw: 2 }), 0)).toBe(CommandFate.Queued)
    queue.take()

    // Tick 1 has been executed. Its command turning up again — or a straggler
    // for it that took a scenic route — cannot be applied without rewinding the
    // world for *input*, which would rewind it for the other player too.
    expect(queue.offer(1, cmdWith({ yaw: 9 }), 0)).toBe(CommandFate.Late)
    expect(queue.stats.late).toBe(1)
    expect(queue.depth).toBe(1)
    expect(queue.take().cmd).toEqual(cmdWith({ yaw: 2 }))
  })
})

describe('a command that arrives twice', () => {
  it('is dropped the second time, or it would be a free tick of movement', () => {
    const queue = createInputQueue()
    expect(queue.offer(1, SPRINT, 0)).toBe(CommandFate.Queued)
    expect(queue.offer(1, SPRINT, 0)).toBe(CommandFate.Duplicate)
    expect(queue.stats.duplicate).toBe(1)
    expect(queue.depth).toBe(1)
  })
})

describe('a command that arrives out of order', () => {
  it('is kept and put back in tick order, because its moment has not passed', () => {
    const queue = createInputQueue()
    queue.offer(1, cmdWith({ yaw: 1 }), 0)
    queue.offer(3, cmdWith({ yaw: 3 }), 0)
    // Tick 2 overtaken by tick 3 and still ahead of the server: dropping it
    // would insert a fallback command in its place for no reason at all.
    expect(queue.offer(2, cmdWith({ yaw: 2 }), 0)).toBe(CommandFate.Queued)
    expect(queue.stats.reordered).toBe(1)

    expect([queue.take().cmd, queue.take().cmd, queue.take().cmd]).toEqual([
      cmdWith({ yaw: 1 }),
      cmdWith({ yaw: 2 }),
      cmdWith({ yaw: 3 }),
    ])
  })
})

describe('a command that never arrives', () => {
  it('repeats the last one, so a strafe-jump survives a lost packet', () => {
    const queue = createInputQueue()
    const strafing = cmdWith({ forwardMove: 1, sideMove: 1, yaw: 4096, buttons: BUTTON_JUMP })
    queue.offer(1, strafing, 0)
    expect(queue.take().fill).toBe(CommandFill.Fresh)

    const missing = queue.take()
    expect(missing.fill).toBe(CommandFill.Repeat)
    expect(missing.consumed).toBe(0)
    // The two numbers air control reads carry over. An empty command would zero
    // them and drop the player out of the hop.
    expect(missing.cmd?.forwardMove).toBe(1)
    expect(missing.cmd?.sideMove).toBe(1)
    expect(missing.cmd?.yaw).toBe(4096)
    expect(missing.cmd?.buttons).toBe(BUTTON_JUMP)
  })

  it('never repeats the trigger, because a rocket is an edge and not a state', () => {
    const queue = createInputQueue()
    queue.offer(1, cmdWith({ forwardMove: 1, buttons: BUTTON_ATTACK | BUTTON_JUMP }), 0)
    queue.take()

    const missing = queue.take()
    expect(missing.cmd?.buttons).toBe(BUTTON_JUMP)
    expect((missing.cmd?.buttons ?? 0) & BUTTON_ATTACK).toBe(0)
    expect(missing.cmd?.forwardMove).toBe(1)
  })

  it('never repeats a dash action', () => {
    const queue = createInputQueue()
    queue.offer(1, cmdWith({ sideMove: -1, buttons: BUTTON_DASH_LEFT }), 0)
    queue.take()

    const missing = queue.take()
    expect(missing.cmd?.sideMove).toBe(-1)
    expect((missing.cmd?.buttons ?? 0) & BUTTON_DASH_LEFT).toBe(0)
  })

  it('gives up after half a second, so a dead connection does not keep running', () => {
    const queue = createInputQueue()
    queue.offer(1, cmdWith({ forwardMove: 1, sideMove: -1, yaw: 4096 }), 0)
    queue.take()

    for (let i = 0; i < MAX_REPEAT_TICKS; i += 1) {
      expect(queue.take().fill).toBe(CommandFill.Repeat)
    }
    const stopped = queue.take()
    expect(stopped.fill).toBe(CommandFill.Idle)
    expect(stopped.cmd?.forwardMove).toBe(0)
    expect(stopped.cmd?.sideMove).toBe(0)
    // The view is left where the player left it. Zeroing the yaw would snap the
    // body to due north, which the other player would watch happen.
    expect(stopped.cmd?.yaw).toBe(4096)
    expect(queue.take().fill).toBe(CommandFill.Idle)
  })

  it('hands out nothing at all for a peer that has never sent a command', () => {
    const queue = createInputQueue()
    const nothing = queue.take()
    expect(nothing.cmd).toBe(null)
    expect(nothing.fill).toBe(CommandFill.Empty)
  })

  it('never stalls: a take always returns something', () => {
    // The one failure mode the policy will not accept. A stall on one peer's
    // socket is a hitch in the *other* peer's game.
    const queue = createInputQueue()
    for (let i = 0; i < 1000; i += 1) expect(() => queue.take()).not.toThrow()
  })
})

describe('the buffer never grows without bound', () => {
  it('consumes two commands in a tick when the client is running fast', () => {
    const queue = createInputQueue()
    // Three commands offered per tick, one tick taken: 200 ticks of a client
    // whose clock runs 3x fast, which is well past anything jitter produces.
    let deepest = 0
    for (let tick = 1; tick <= 200; tick += 1) {
      for (let i = 0; i < 3; i += 1) queue.offer(tick * 3 + i, SPRINT, tick * 8)
      queue.take()
      deepest = Math.max(deepest, queue.depth)
    }

    expect(queue.stats.merged).toBeGreaterThan(0)
    expect(deepest).toBeLessThanOrEqual(MAX_BUFFERED_COMMANDS)
    expect(queue.stats.executed).toBe(200)
  })

  it('walks a standing surplus back down, one tick at a time', () => {
    const queue = createInputQueue()
    // Twelve deep and *kept* there: one command offered per take, so nothing
    // the queue does can bring the trough back to the target. That is a clock
    // running fast rather than a frame arriving, and it is what the drain is
    // for.
    for (let tick = 1; tick <= 12; tick += 1) queue.offer(tick, SPRINT, 0)
    expect(queue.depth).toBe(12)

    let next = 13
    const depths: number[] = []
    for (let i = 0; i < DRIFT_WINDOW_TICKS + 6; i += 1) {
      queue.offer(next, SPRINT, next * 8)
      next += 1
      queue.take()
      depths.push(queue.depth)
    }

    // Nothing for a whole window — the surplus has not lasted long enough to be
    // one — and then a tick of it drained per tick.
    expect(depths.slice(0, DRIFT_WINDOW_TICKS)).toEqual(
      new Array(DRIFT_WINDOW_TICKS).fill(12),
    )
    expect(depths.slice(DRIFT_WINDOW_TICKS)).toEqual([11, 10, 9, 8, 7, 6])
    expect(queue.stats.merged).toBe(6)
  })

  it('leaves a frame-sized clump alone, because that is jitter and not drift', () => {
    // The regression this window exists for. A browser hands over a whole
    // frame's worth of commands at once — four here, a client at 30 fps — and
    // the host drains one per sub-step. Depth therefore sawtooths above the
    // target every single frame on a link with no jitter at all, and draining
    // on that peak empties the buffer into the gap it exists to cover: measured
    // on the browser smoke test at 36% of sub-steps on the missing-command
    // fallback, over a *localhost* socket.
    const queue = createInputQueue()
    let next = 1
    let starved = 0
    // The lead the client is told to run (`client/net/clockSync.ts`), already
    // established: without it there is no buffer to drain and nothing to prove.
    for (let i = 0; i < JITTER_BUFFER_TICKS; i += 1) {
      queue.offer(next, SPRINT, 0)
      next += 1
    }
    for (let frame = 0; frame < 40; frame += 1) {
      for (let i = 0; i < 4; i += 1) {
        queue.offer(next, SPRINT, frame * 32)
        next += 1
      }
      // Four sub-steps per frame, which is what 30 fps costs at 125 Hz.
      for (let step = 0; step < 4; step += 1) {
        if (queue.take().consumed === 0) starved += 1
      }
    }

    // Not one command doubled up on, and not one sub-step left without one.
    expect(queue.stats.merged).toBe(0)
    expect(starved).toBe(0)
    // And the buffer is still holding what it is supposed to hold, rather than
    // having been drained to nothing between frames.
    expect(queue.depth).toBeGreaterThanOrEqual(JITTER_BUFFER_TICKS)
  })

  it('merges rather than discards, so a press in the dropped command survives', () => {
    const queue = createInputQueue()
    // Deep, and kept deep for a window, so the drain is armed when the two
    // commands under test come round.
    for (let tick = 1; tick <= 8; tick += 1) queue.offer(tick, SPRINT, 0)
    for (let i = 0; i < DRIFT_WINDOW_TICKS; i += 1) {
      queue.offer(100 + i, SPRINT, (100 + i) * 8)
      expect(queue.take().fill).toBe(CommandFill.Fresh)
    }

    const merged = queue.take()
    expect(merged.fill).toBe(CommandFill.Merged)
    expect(merged.consumed).toBe(2)

    // And the fold itself: the newer command's angles — a state value is
    // superseded — and the buttons of both, because a jump nobody executed is a
    // jump nobody made.
    expect(mergeCommands(cmdWith({ buttons: BUTTON_JUMP, yaw: 1 }), cmdWith({ yaw: 2 }))).toEqual(
      cmdWith({ buttons: BUTTON_JUMP, yaw: 2 }),
    )
  })

  it('refuses to hold more than the ceiling, however fast a client sends', () => {
    const queue = createInputQueue({ budgetPerSecond: 0 })
    for (let tick = 1; tick <= 500; tick += 1) queue.offer(tick, SPRINT, 0)
    expect(queue.depth).toBe(MAX_BUFFERED_COMMANDS)
    expect(queue.stats.overflow).toBe(500 - MAX_BUFFERED_COMMANDS)
  })

  it('applies the fallback for a client that is running slow', () => {
    const queue = createInputQueue()
    // One command every other tick: half rate, which is what a client whose
    // clock is running slow looks like from here.
    const fills: string[] = []
    for (let tick = 1; tick <= 8; tick += 1) {
      if (tick % 2 === 1) queue.offer(tick, SPRINT, tick * 8)
      fills.push(queue.take().fill)
    }
    expect(fills).toEqual([
      CommandFill.Fresh,
      CommandFill.Repeat,
      CommandFill.Fresh,
      CommandFill.Repeat,
      CommandFill.Fresh,
      CommandFill.Repeat,
      CommandFill.Fresh,
      CommandFill.Repeat,
    ])
    expect(queue.depth).toBe(0)
  })
})

/* --------------------------------------------------------------------------
 * The anti-speedhack, measured in units travelled
 * ----------------------------------------------------------------------- */

/** A floor and nothing else, so a sprint measures the movement and not a wall. */
const OPEN_FLOOR: CollisionWorld = createCollisionWorld([
  boxBrush([-16384, -16384, -64], [16384, 16384, 0]),
])

function standingPlayer(): GameState {
  const state = createGameState(SKELETON_SEED)
  spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    origin: vec3(0, 0, SURFACE_CLIP_EPSILON),
    health: 100,
  })
  return state
}

function distanceTravelled(state: GameState): number {
  const origin = state.entities[0]?.origin ?? [0, 0, 0]
  return Math.sqrt((origin[0] ?? 0) * (origin[0] ?? 0) + (origin[1] ?? 0) * (origin[1] ?? 0))
}

describe('a client sending 500 Hz of input gains nothing by it', () => {
  it('travels exactly as far in a wall-clock second as one sending 62.5 Hz', () => {
    // One wall-clock second of a server ticking at 125 Hz. The honest client
    // sends two commands per 16 ms frame — a 62.5 fps browser, which is 125
    // commands a second. The cheat sends four per tick: 500 a second, the
    // client-side speedhack this whole file exists to stop.
    const honest = { state: standingPlayer(), queue: createInputQueue() }
    const cheat = { state: standingPlayer(), queue: createInputQueue() }

    // What a server with no policy would have done: one tick per command it
    // received. Here to give the assertion teeth — without it, "both travelled
    // 320 units" would pass just as happily on a build that had no rate limit.
    const naive = standingPlayer()

    let sentByCheat = 0
    for (let tick = 1; tick <= TICK_RATE; tick += 1) {
      const nowMs = tick * 8

      if (tick % 2 === 1) {
        honest.queue.offer(tick, SPRINT, nowMs)
        honest.queue.offer(tick + 1, SPRINT, nowMs)
      }
      for (let i = 0; i < 4; i += 1) {
        cheat.queue.offer(tick * 4 + i, SPRINT, nowMs)
        sentByCheat += 1
        simTick(naive, [SPRINT], OPEN_FLOOR)
      }

      simTick(honest.state, [honest.queue.take().cmd], OPEN_FLOOR)
      simTick(cheat.state, [cheat.queue.take().cmd], OPEN_FLOOR)
    }

    const honestDistance = distanceTravelled(honest.state)
    const cheatDistance = distanceTravelled(cheat.state)

    // A sprint that went nowhere would make the comparison meaningless.
    expect(honestDistance).toBeGreaterThan(250)
    expect(cheatDistance).toBe(honestDistance)

    // And the policy is what did it: the honest client had every command
    // accepted, the cheat had most of them refused at the door.
    expect(honest.queue.stats.rateLimited).toBe(0)
    expect(honest.queue.stats.starved).toBe(0)
    expect(cheat.queue.stats.rateLimited + cheat.queue.stats.overflow).toBeGreaterThan(
      sentByCheat - COMMAND_BUDGET - COMMAND_BURST,
    )

    // Without the policy the same input stream is four seconds of running.
    expect(distanceTravelled(naive)).toBeGreaterThan(honestDistance * 3)
  })

  it('lets an honest client send a whole frame of commands in one clump', () => {
    // A browser that missed a frame produces eight commands at once. A bucket
    // with no burst allowance would refuse seven of them and stutter a player
    // for a dropped frame, which is the opposite of the point.
    const queue = createInputQueue()
    for (let tick = 1; tick <= COMMAND_BURST; tick += 1) {
      expect(queue.offer(tick, SPRINT, 0), `command ${tick}`).toBe(CommandFate.Queued)
    }
  })

  it('refuses commands past the budget until the clock catches up', () => {
    const queue = createInputQueue({ capacity: 1024 })
    for (let tick = 1; tick <= COMMAND_BURST; tick += 1) queue.offer(tick, SPRINT, 0)
    expect(queue.offer(999, SPRINT, 0)).toBe(CommandFate.RateLimited)
    // One tick of wall-clock buys exactly one more command, which is the rate
    // the world has room for and not a millisecond's worth more.
    expect(queue.offer(999, SPRINT, 8)).toBe(CommandFate.Queued)
    expect(queue.offer(1000, SPRINT, 8)).toBe(CommandFate.RateLimited)
  })
})

describe('the jitter buffer target', () => {
  it('is the same number the client leads by', () => {
    // `client/net/clockSync.ts` imports this rather than restating it. Two
    // names for one number is the drift this repo is built to prevent.
    expect(JITTER_BUFFER_TICKS).toBe(2)
  })
})
