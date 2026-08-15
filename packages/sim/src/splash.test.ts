import { describe, expect, it } from 'vitest'

import type { Vec3 } from './axis.ts'
import { PLAYER_MAXS, PLAYER_MINS } from './bbox.ts'
import { boxBrush, createCollisionWorld } from './collide.ts'
import type { CollisionWorld } from './collide.ts'
import type { TickHooks } from './kernel.ts'
import { tick } from './kernel.ts'
import { vec3 } from './math.ts'
import {
  CLEARANCE_MAXS,
  CLEARANCE_MINS,
  SELF_SPLASH_CLEARANCE,
  segmentClearsPlayer,
  type SelfSplashPolicy,
} from './splash.ts'
import { EntityKind, createGameState, spawnEntity } from './state.ts'
import type { EntityState, GameState } from './state.ts'
import { SURFACE_CLIP_EPSILON } from './trace.ts'
import { BUTTON_ATTACK, MAX_PITCH_UNITS, NULL_CMD } from './usercmd.ts'
import type { UserCmd } from './usercmd.ts'
import { Weapon } from './weapon.ts'

/** A sealed box with the floor at z = 0, as `weapons.test.ts` uses. */
function arena(): CollisionWorld {
  return createCollisionWorld([
    boxBrush([-1024, -1024, -64], [1024, 1024, 0]),
    boxBrush([-1024, -1024, 512], [1024, 1024, 576]),
    boxBrush([1024, -1088, -64], [1088, 1088, 576]),
    boxBrush([-1088, -1088, -64], [-1024, 1088, 576]),
    boxBrush([-1024, 1024, -64], [1024, 1088, 576]),
    boxBrush([-1024, -1088, -64], [1024, -1024, 576]),
  ])
}

const WORLD = arena()

/** Firing straight down at your own feet: the rocket jump. */
const ROCKET_AT_FEET: UserCmd = {
  ...NULL_CMD,
  pitch: MAX_PITCH_UNITS,
  buttons: BUTTON_ATTACK,
  weapon: Weapon.RocketLauncher,
}

function stand(state: GameState, slot: number, x: number, y: number): EntityState {
  return spawnEntity(state, {
    kind: EntityKind.Player,
    slot,
    origin: vec3(x, y, SURFACE_CLIP_EPSILON),
    health: 100,
    armor: 100,
  })
}

/**
 * The client's policy, in miniature: refuse the prediction when the rocket's
 * flight came inside the clearance of anybody who is not its owner.
 *
 * The real one (`client/net/rocketPredict.ts`) checks the *drawn* opponent as
 * well as the predicted one and freezes its answer across replays. This is the
 * seam, which is what this file is about.
 */
function policyOver(state: GameState, ownerSlot: number): SelfSplashPolicy & {
  readonly suppressed: number
} {
  let clear = true
  let suppressed = 0
  const others = (): Vec3[] =>
    state.entities
      .filter((entity) => entity.kind === EntityKind.Player && entity.slot !== ownerSlot)
      .map((entity) => entity.origin)

  return {
    observe(_state: GameState, _rocket: EntityState, from: Vec3, to: Vec3) {
      if (!clear) return
      for (const origin of others()) {
        if (!segmentClearsPlayer(from, to, origin)) clear = false
      }
    },
    allow() {
      if (!clear) suppressed += 1
      return clear
    },
    get suppressed() {
      return suppressed
    },
  }
}

/** One rocket jump, and what it did to the person who fired it. */
function rocketJump(options: {
  readonly opponentY: number | null
  readonly hooks: TickHooks | null
}): { readonly launch: number; readonly health: number; readonly opponentHealth: number } {
  const state = createGameState(7)
  const shooter = stand(state, 0, 0, 0)
  const opponent = options.opponentY === null ? null : stand(state, 1, 0, options.opponentY)

  tick(state, [ROCKET_AT_FEET, NULL_CMD], WORLD, null, options.hooks)

  return {
    launch: shooter.velocity[2],
    health: shooter.health + shooter.armor,
    opponentHealth: opponent === null ? 0 : opponent.health + opponent.armor,
  }
}

describe('the clearance predicate', () => {
  it('grows the player box by the clearance on every axis', () => {
    for (let axis = 0; axis < 3; axis += 1) {
      expect(CLEARANCE_MINS[axis]).toBe((PLAYER_MINS[axis] as number) - SELF_SPLASH_CLEARANCE)
      expect(CLEARANCE_MAXS[axis]).toBe((PLAYER_MAXS[axis] as number) + SELF_SPLASH_CLEARANCE)
    }
  })

  it('refuses a segment that passes within the clearance and allows one that does not', () => {
    const target: Vec3 = [0, 0, 0]
    // The box is 15 units either side of the origin in y, so 15 + 32 = 47 is
    // the edge of the fattened one.
    expect(segmentClearsPlayer([-100, 0, 20], [100, 0, 20], target)).toBe(false)
    expect(segmentClearsPlayer([-100, 40, 20], [100, 40, 20], target)).toBe(false)
    expect(segmentClearsPlayer([-100, 46, 20], [100, 46, 20], target)).toBe(false)
    expect(segmentClearsPlayer([-100, 48, 20], [100, 48, 20], target)).toBe(true)
    expect(segmentClearsPlayer([-100, 200, 20], [100, 200, 20], target)).toBe(true)
  })

  it('answers a zero-length segment, which is a rocket that died where it was born', () => {
    expect(segmentClearsPlayer([0, 20, 20], [0, 20, 20], [0, 0, 0])).toBe(false)
    expect(segmentClearsPlayer([0, 400, 20], [0, 400, 20], [0, 0, 0])).toBe(true)
  })

  it('errs toward refusing rather than allowing, at the corners', () => {
    // 32 units out along two axes at once is 45 units of true distance, and the
    // fattened box calls it near anyway. That direction is the safe one: it can
    // only decline a prediction that would have been fine.
    const diagonal = segmentClearsPlayer(
      [15 + 30, 15 + 30, 20],
      [15 + 30, 15 + 30, 21],
      [0, 0, 0],
    )
    expect(diagonal).toBe(false)
  })
})

describe('predicted self-splash', () => {
  it('launches the shooter when nobody is near the rocket', () => {
    const withPolicy = rocketJump({ opponentY: null, hooks: { selfSplash: policyOver(createGameState(0), 0) } })
    expect(withPolicy.launch).toBeGreaterThan(400)
  })

  it('is skipped when an opponent is in the rocket path', () => {
    // The opponent stands 20 units to the side of a rocket fired at the
    // shooter's own feet — well inside the 32-unit clearance — so the host may
    // well detonate this rocket somewhere the client did not, and the launch is
    // left for the snapshot to deliver.
    const state = createGameState(7)
    const shooter = stand(state, 0, 0, 0)
    const opponent = stand(state, 1, 0, 20)
    const policy = policyOver(state, 0)

    tick(state, [ROCKET_AT_FEET, NULL_CMD], WORLD, null, { selfSplash: policy })

    expect(policy.suppressed).toBe(1)
    // No launch, and no self-damage either: the shooter's whole share of this
    // explosion is deferred.
    expect(shooter.velocity[2]).toBeLessThan(1)
    expect(shooter.health + shooter.armor).toBe(200)
    // Everybody else in the blast is damaged exactly as they always were. The
    // uncertainty is about the shooter's launch, not about the explosion.
    expect(opponent.health + opponent.armor).toBeLessThan(200)
  })

  it('is applied, with the same rocket and the same tick, when there is no policy', () => {
    // The authoritative host takes no hooks and is never uncertain. This is the
    // control for the case above: the only difference is who is running it.
    const state = createGameState(7)
    const shooter = stand(state, 0, 0, 0)
    const opponent = stand(state, 1, 0, 20)

    tick(state, [ROCKET_AT_FEET, NULL_CMD], WORLD, null, null)

    expect(shooter.velocity[2]).toBeGreaterThan(400)
    expect(shooter.health + shooter.armor).toBeLessThan(200)
    expect(opponent.health + opponent.armor).toBeLessThan(200)
  })

  it('leaves the shooter where a rocket that was never fired would have', () => {
    const suppressed = rocketJump({
      opponentY: 20,
      hooks: { selfSplash: { observe: () => undefined, allow: () => false } },
    })
    const unfired = (() => {
      const state = createGameState(7)
      const shooter = stand(state, 0, 0, 0)
      stand(state, 1, 0, 20)
      tick(state, [NULL_CMD, NULL_CMD], WORLD, null, null)
      return { launch: shooter.velocity[2], health: shooter.health + shooter.armor }
    })()

    expect(suppressed.launch).toBe(unfired.launch)
    expect(suppressed.health).toBe(unfired.health)
  })
})
