import { EntityFlag, NEVER_FIRED, type Vec3, Weapon } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import type { PlayerNetState } from '../render/animState.ts'
import { INITIAL_MEMORY, STRIDE_QU, advanceCues, createCueTracker, playCues } from './cues.ts'
import { Bus, SoundId } from './sounds.ts'

/** A player netstate, with everything not under test held still. */
function net(overrides: Partial<PlayerNetState> = {}): PlayerNetState {
  return {
    id: 1,
    slot: 1,
    origin: [0, 0, 0],
    velocity: [0, 0, 0],
    angles: [0, 0, 0],
    flags: EntityFlag.OnGround,
    health: 100,
    weapon: Weapon.RocketLauncher,
    lastFireTick: NEVER_FIRED,
    ...overrides,
  }
}

/** Fold a sequence of netstates and collect everything it produced. */
function heard(states: readonly PlayerNetState[], self = false) {
  let memory = INITIAL_MEMORY
  const cues = []
  for (const state of states) {
    const result = advanceCues(memory, state, self)
    memory = result.memory
    cues.push(...result.cues)
  }
  return { cues, memory }
}

const running: Vec3 = [320, 0, 0]

/** A body that has just been killed: dead flag set, health at the floor. */
const DEAD = { flags: EntityFlag.Dead, health: 0 } as const

describe('a death', () => {
  it('replaces the hit confirmation rather than doubling it up', () => {
    // The killing blow is one event, so it gets one confirmation. Before R4 it
    // rang the same `hit` as every blow before it and nothing else at all.
    const { cues } = heard([net({ health: 40 }), net(DEAD)])
    const sounds = cues.map((cue) => cue.sound)

    expect(sounds).toContain(SoundId.Frag)
    expect(sounds).toContain(SoundId.Death)
    expect(sounds).not.toContain(SoundId.Hit)
  })

  it('puts the body on the world bus and the frag on feedback', () => {
    // The two halves of the same moment, and the buses are the difference: you
    // hear *where* they fell, and you hear *that you did it* from nowhere.
    const { cues } = heard([net({ health: 40, origin: [300, -200, 0] }), net({ ...DEAD, origin: [300, -200, 0] })])

    const death = cues.find((cue) => cue.sound === SoundId.Death)
    const frag = cues.find((cue) => cue.sound === SoundId.Frag)
    expect(death).toMatchObject({ bus: Bus.World, origin: [300, -200, 0] })
    expect(frag).toMatchObject({ bus: Bus.Feedback, origin: null })
  })

  it('gives your own death no frag, and hears it as feedback', () => {
    // You do not get a kill confirmation for dying.
    const { cues } = heard([net({ health: 40 }), net(DEAD)], true)
    const sounds = cues.map((cue) => cue.sound)

    expect(sounds).toContain(SoundId.Death)
    expect(sounds).not.toContain(SoundId.Frag)
    expect(sounds).not.toContain(SoundId.Damage)
    expect(cues.find((cue) => cue.sound === SoundId.Death)).toMatchObject({
      bus: Bus.Feedback,
      origin: null,
    })
  })

  it('fires once, on the edge, and not for every frame of lying there', () => {
    const { cues } = heard([net({ health: 40 }), net(DEAD), net(DEAD), net(DEAD)])

    expect(cues.filter((cue) => cue.sound === SoundId.Death)).toHaveLength(1)
    expect(cues.filter((cue) => cue.sound === SoundId.Frag)).toHaveLength(1)
  })

  it('says nothing when a round stands the same body back up', () => {
    // Dead to alive is the respawn, and it is not an edge this fold reports.
    const { cues } = heard([net(DEAD), net({ health: 100 })])

    expect(cues.map((cue) => cue.sound)).not.toContain(SoundId.Death)
  })
})

describe('the first sight of a player', () => {
  /**
   * The bug this stops: a player joining, or coming back from a round reset,
   * arrives with `health: 100`, `OnGround` and a `lastFireTick` from before —
   * and every edge rule below would fire against a memory of nothing at once.
   */
  it('makes no sound at all', () => {
    const { cues, memory } = heard([net({ lastFireTick: 40, health: 60 })])
    expect(cues).toEqual([])
    expect(memory.seen).toBe(true)
    expect(memory.lastFireTick).toBe(40)
  })
})

describe('firing', () => {
  it('plays the rocket launcher when lastFireTick moves', () => {
    const { cues } = heard([net(), net({ lastFireTick: 12 })])
    expect(cues.map((cue) => cue.sound)).toEqual([SoundId.RocketFire])
  })

  it('plays the railgun for the railgun', () => {
    const { cues } = heard([
      net({ weapon: Weapon.Railgun }),
      net({ weapon: Weapon.Railgun, lastFireTick: 12 }),
    ])
    expect(cues.map((cue) => cue.sound)).toEqual([SoundId.RailFire])
  })

  it('plays once per shot, not once per frame the pose is up', () => {
    const { cues } = heard([net(), net({ lastFireTick: 12 }), net({ lastFireTick: 12 })])
    expect(cues).toHaveLength(1)
  })

  it('plays again for the next shot', () => {
    const { cues } = heard([net(), net({ lastFireTick: 12 }), net({ lastFireTick: 90 })])
    expect(cues).toHaveLength(2)
  })

  it('puts the opponent"s shot on the world bus, at the muzzle', () => {
    const { cues } = heard([
      net({ origin: [100, 200, 8] }),
      net({ origin: [100, 200, 8], lastFireTick: 3 }),
    ])
    expect(cues[0]?.bus).toBe(Bus.World)
    // The muzzle is at the eye, not at the feet: 50 units up. `bbox.ts`.
    expect(cues[0]?.origin).toEqual([100, 200, 58])
  })

  it('puts your own shot on the feedback bus, with no position at all', () => {
    const { cues } = heard([net(), net({ lastFireTick: 3 })], true)
    expect(cues[0]?.bus).toBe(Bus.Feedback)
    expect(cues[0]?.origin).toBeNull()
  })

  it('says nothing for a weapon that makes no sound', () => {
    const { cues } = heard([
      net({ weapon: Weapon.None }),
      net({ weapon: Weapon.None, lastFireTick: 12 }),
    ])
    expect(cues).toEqual([])
  })
})

describe('landing', () => {
  it('plays on the frame the player touches down, and not after', () => {
    const airborne = net({ flags: 0 })
    const grounded = net({ flags: EntityFlag.OnGround })
    const { cues } = heard([grounded, airborne, grounded, grounded])
    expect(cues.map((cue) => cue.sound)).toEqual([SoundId.Land])
  })
})

describe('health', () => {
  it('is damage taken when it is your own', () => {
    const { cues } = heard([net({ health: 100 }), net({ health: 45 })], true)
    expect(cues.map((cue) => cue.sound)).toEqual([SoundId.Damage])
    expect(cues[0]?.bus).toBe(Bus.Feedback)
  })

  /**
   * Hit confirmation is the loudest argument for the bus split: it is about
   * *your* shot, so it is dry, centred and never attenuated — heard the same
   * whether they were next to you or across the arena.
   */
  it('is a hit confirmation when it is theirs, on the feedback bus', () => {
    const { cues } = heard([net({ health: 100 }), net({ health: 45 })])
    expect(cues.map((cue) => cue.sound)).toEqual([SoundId.Hit])
    expect(cues[0]?.bus).toBe(Bus.Feedback)
    expect(cues[0]?.origin).toBeNull()
  })

  it('says nothing when health goes back up', () => {
    const { cues } = heard([net({ health: 40 }), net({ health: 100 })])
    expect(cues).toEqual([])
  })
})

describe('footsteps', () => {
  /** Walk a player in a straight line, one netstate per step. */
  function walk(steps: number, distancePerStep: number, velocity: Vec3 = running) {
    const states: PlayerNetState[] = []
    for (let i = 0; i <= steps; i += 1) {
      states.push(net({ origin: [i * distancePerStep, 0, 0], velocity }))
    }
    return heard(states).cues.filter((cue) =>
      cue.sound === SoundId.FootstepA || cue.sound === SoundId.FootstepB,
    )
  }

  it('emits one per stride of ground travel', () => {
    // Four strides, walked in eight observations — the count is a function of
    // distance, so how it was sampled makes no difference.
    const coarse = walk(4, STRIDE_QU)
    const fine = walk(8, STRIDE_QU / 2)
    expect(coarse).toHaveLength(4)
    expect(fine).toHaveLength(4)
  })

  it('alternates the two samples, so it is not a machine gun', () => {
    expect(walk(4, STRIDE_QU).map((cue) => cue.sound)).toEqual([
      SoundId.FootstepA,
      SoundId.FootstepB,
      SoundId.FootstepA,
      SoundId.FootstepB,
    ])
  })

  it('is on the world bus, at the feet', () => {
    const [step] = walk(1, STRIDE_QU)
    expect(step?.bus).toBe(Bus.World)
    expect(step?.origin).toEqual([STRIDE_QU, 0, 0])
  })

  it('is quieter at a walk than at a sprint', () => {
    const sprint = walk(1, STRIDE_QU)[0]?.gain ?? 0
    const walked = walk(1, STRIDE_QU, [80, 0, 0])[0]?.gain ?? 0
    expect(walked).toBeLessThan(sprint)
  })

  it('says nothing for a player being shoved across the floor', () => {
    // Moving, but not under their own power: below the walking threshold.
    expect(walk(2, STRIDE_QU, [20, 0, 0])).toHaveLength(0)
  })

  it('never plays your own', () => {
    let memory = INITIAL_MEMORY
    const cues = []
    for (let i = 0; i <= 4; i += 1) {
      const result = advanceCues(memory, net({ origin: [i * STRIDE_QU, 0, 0], velocity: running }), true)
      memory = result.memory
      cues.push(...result.cues)
    }
    expect(cues).toEqual([])
  })

  it('does not fire one on the frame a jump lands', () => {
    const { cues } = heard([
      net({ origin: [0, 0, 0], velocity: running }),
      net({ origin: [STRIDE_QU * 2, 0, 64], velocity: running, flags: 0 }),
      net({ origin: [STRIDE_QU * 4, 0, 0], velocity: running }),
    ])
    expect(cues.map((cue) => cue.sound)).toEqual([SoundId.Land])
  })
})

describe('the tracker', () => {
  it('keeps one memory per entity and folds them independently', () => {
    const tracker = createCueTracker()
    const self = net({ id: 1, slot: 0 })
    const other = net({ id: 2, slot: 1 })

    expect(tracker.observe({ self, others: [other] })).toEqual([])
    expect(tracker.tracked).toBe(2)

    const cues = tracker.observe({
      self: net({ id: 1, slot: 0, health: 30 }),
      others: [net({ id: 2, slot: 1, lastFireTick: 7 })],
    })
    expect(cues.map((cue) => cue.sound)).toEqual([SoundId.Damage, SoundId.RocketFire])
  })

  it('forgets a player who is no longer drawn, so a rejoin is silent again', () => {
    const tracker = createCueTracker()
    tracker.observe({ self: null, others: [net({ id: 2, health: 100 })] })
    tracker.observe({ self: null, others: [] })
    expect(tracker.tracked).toBe(0)

    // Back with less health than before: a memory that survived would ring the
    // hit confirmation for damage taken while they were gone.
    const cues = tracker.observe({ self: null, others: [net({ id: 2, health: 20 })] })
    expect(cues).toEqual([])
  })

  it('reset() drops everything', () => {
    const tracker = createCueTracker()
    tracker.observe({ self: net(), others: [] })
    tracker.reset()
    expect(tracker.tracked).toBe(0)
  })
})

describe('playCues', () => {
  it('sends each cue down the bus it names', () => {
    const feedback: string[] = []
    const world: Array<{ sound: string; origin: Vec3 }> = []
    const engine = {
      playFeedback: (sound: SoundId) => {
        feedback.push(sound)
        return null
      },
      playWorld: (sound: SoundId, origin: Vec3) => {
        world.push({ sound, origin })
        return null
      },
    }

    playCues(engine as never, [
      { sound: SoundId.Hit, bus: Bus.Feedback, origin: null, gain: 1 },
      { sound: SoundId.RocketFire, bus: Bus.World, origin: [1, 2, 3], gain: 1 },
    ])

    expect(feedback).toEqual([SoundId.Hit])
    expect(world).toEqual([{ sound: SoundId.RocketFire, origin: [1, 2, 3] }])
  })
})
