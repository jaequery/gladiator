/**
 * The acceptance check that says the HUD is pure presentation.
 *
 * "It never writes to `GameState`" is the kind of rule that holds for exactly
 * as long as nobody is in a hurry, so it is checked three ways, weakest last:
 *
 *   1. **A world that cannot be written to.** Every object in a real
 *      `GameState` is wrapped in a proxy whose `set`, `defineProperty` and
 *      `deleteProperty` traps throw, and the entire HUD pipeline is run over
 *      it. A single assignment anywhere fails the test with the property name.
 *   2. **The state hash, before and after.** A belt to the proxy's braces, and
 *      it also catches a write that went through a path the proxy did not wrap.
 *   3. **A source scan.** Only the projection may so much as name `GameState`,
 *      and nothing down here may name a function that mutates a world. That is
 *      what extends the guarantee to `hud.ts`, whose DOM cannot be exercised in
 *      Node: it never receives a `GameState` to write to in the first place.
 */
import {
  EntityKind,
  MatchPhase,
  SPAWN_ARMOR,
  SPAWN_HEALTH,
  Weapon,
  createGameState,
  findPlayer,
  hashState,
  spawnEntity,
} from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { crosshairFor, ringDashOffset } from './crosshair.ts'
import { INITIAL_FEEDBACK, advanceFeedback } from './feedback.ts'
import {
  cooldownOf,
  formatClock,
  healthTier,
  hudModel,
  hudPlayer,
  matchAnnouncement,
  matchHeadline,
  scoreFor,
} from './hudModel.ts'

/* --------------------------------------------------------------------------
 * A world that refuses to be written to
 * ----------------------------------------------------------------------- */

/**
 * Wrap `value` and everything reachable from it so that any write throws.
 *
 * Reads are passed straight through, so anything that only *looks* at the
 * world behaves exactly as it would against the real one — which is the point.
 * Proxies are cached by target so that identity comparisons inside the code
 * under test still work.
 */
function sealDeep<T>(value: T, path: string, seen = new Map<object, unknown>()): T {
  if (value === null || typeof value !== 'object') return value

  const cached = seen.get(value)
  if (cached !== undefined) return cached as T

  const proxy = new Proxy(value as object, {
    get(target, property, receiver) {
      const read = Reflect.get(target, property, receiver) as unknown
      // Bound to the *proxy*, not the target: `entities.find(...)` has to walk
      // the sealed array so that the entity it hands back is sealed too.
      // Binding to the raw target would quietly unwrap everything downstream
      // of a single array method, which is most of this API.
      if (typeof read === 'function') return read.bind(receiver)
      return sealDeep(read, `${path}.${String(property)}`, seen)
    },
    set(_target, property) {
      throw new Error(`the HUD wrote to ${path}.${String(property)}`)
    },
    defineProperty(_target, property) {
      throw new Error(`the HUD redefined ${path}.${String(property)}`)
    },
    deleteProperty(_target, property) {
      throw new Error(`the HUD deleted ${path}.${String(property)}`)
    },
  })

  seen.set(value, proxy)
  return proxy as T
}

/** A world in the middle of a round, with something interesting in every field. */
function midRound() {
  const state = createGameState(11)
  for (const slot of [0, 1]) {
    spawnEntity(state, {
      kind: EntityKind.Player,
      slot,
      health: slot === 0 ? 43 : SPAWN_HEALTH,
      armor: slot === 0 ? 0 : SPAWN_ARMOR,
      weapon: slot === 0 ? Weapon.Railgun : Weapon.RocketLauncher,
      velocity: [120, -80, 0],
      angles: [0, 8192, 0],
      lastFireTick: 40,
      nextFireTick: 228,
    })
  }
  state.tick = 120
  state.match.phase = MatchPhase.Live
  state.match.round = 2
  state.match.wins = [1, 0]
  state.match.phaseEndTick = 900
  return state
}

/**
 * Everything the HUD does with a world, in the order a frame does it.
 *
 * The view is deliberately absent and does not need to be here: it takes a
 * {@link HudModel} and never a `GameState`, which the source scan below is what
 * proves. Everything that *can* touch the world is in this function.
 */
function runTheHud(state: ReturnType<typeof midRound>): void {
  let memory = INITIAL_FEEDBACK
  for (let frame = 0; frame < 8; frame += 1) {
    const model = hudModel(state, 0)
    const result = advanceFeedback(memory, model)
    memory = result.memory

    crosshairFor(model.self.weapon)
    ringDashOffset(model.self.cooldownFraction)
    healthTier(model.self)
    formatClock(model.match.remainingMs)
    scoreFor(model.match, model.slot)
    matchHeadline(model)
    matchAnnouncement(model)

    // The two entity-level doors, called directly as well, so nothing is
    // exercised only through the projection that wraps them.
    const player = findPlayer(state, 0)
    if (player !== null) {
      hudPlayer(player, state.tick)
      cooldownOf(player, state.tick)
    }
  }
}

describe('the HUD never writes to the world', () => {
  it('runs a whole frame over a world whose every write throws', () => {
    const sealed = sealDeep(midRound(), 'state')
    expect(() => {
      runTheHud(sealed)
    }).not.toThrow()
  })

  it('leaves the state hash exactly where it found it', () => {
    const state = midRound()
    const before = hashState(state)
    runTheHud(state)
    expect(hashState(state)).toBe(before)
  })

  it('hands out copies, so writing to the model cannot reach the world', () => {
    const state = midRound()
    const before = hashState(state)
    const model = hudModel(state, 0)

    // Every mutable-looking thing the model exposes, written to. The double
    // casts are deliberate: `readonly` makes each of these a compile error
    // already, and this is the belt to that brace — a write that got past the
    // types lands on a copy and goes nowhere.
    ;(model.self.velocity as unknown as number[])[0] = -1
    ;(model.opponent.velocity as unknown as number[])[2] = -1
    ;(model.match.wins as unknown as number[])[0] = 99

    expect(hashState(state)).toBe(before)
  })

  it('proves the sealed world would have caught a write', () => {
    // The guardrail's own guardrail: a check nobody has watched fire is a
    // check nobody knows is connected. `scripts/guardrails.mjs` makes the same
    // argument for the simulation boundary.
    const sealed = sealDeep(midRound(), 'state')
    expect(() => {
      sealed.tick = 0
    }).toThrow(/wrote to state\.tick/)
    expect(() => {
      const player = findPlayer(sealed, 0)
      if (player !== null) player.health = 0
    }).toThrow(/wrote to state\..*\.health/)
  })
})

/* --------------------------------------------------------------------------
 * The structural half
 * ----------------------------------------------------------------------- */

/** Every module under `ui/`, as text. `?raw` through Vite, so no `node:fs`. */
const RAW: Record<string, string> = import.meta.glob('./*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
})

/**
 * The same, with the prose taken out.
 *
 * The scan is about what the code *does*, and the comments in here talk about
 * `GameState` constantly — saying "this module never touches one" is the point
 * of writing them. Scanning the raw text would make the correct documentation
 * fail the rule it documents.
 */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
}

const SOURCES: Record<string, string> = Object.fromEntries(
  Object.entries(RAW).map(([path, source]) => [path, code(source)]),
)

/** The production modules — the tests are allowed to build worlds. */
const MODULES = Object.entries(SOURCES).filter(([path]) => !path.endsWith('.test.ts'))

/**
 * Simulation functions that change a world.
 *
 * Not exhaustive and does not need to be: it is a tripwire on the handful of
 * names somebody would reach for if they ever decided the HUD should just
 * nudge the state a little.
 */
const MUTATORS = [
  'spawnEntity',
  'removeEntity',
  'applyDamage',
  'radiusDamage',
  'fireWeapon',
  'fireWeapons',
  'spawnRound',
  'spawnPlayer',
  'startMatch',
  'advanceMatch',
  'advanceHost',
  'advanceTicks',
  'moveProjectiles',
  'explodeProjectile',
  'pmove',
  'createKernel',
]

describe('the source says so too', () => {
  it('found the modules to scan', () => {
    expect(MODULES.length).toBeGreaterThanOrEqual(4)
    expect(MODULES.map(([path]) => path)).toContain('./hud.ts')
  })

  it('lets only the projection name `GameState` at all', () => {
    for (const [path, source] of MODULES) {
      if (path === './hudModel.ts') continue
      expect(source, `${path} should not know what a GameState is`).not.toContain('GameState')
    }
  })

  it('names no function that mutates a world, anywhere', () => {
    for (const [path, source] of MODULES) {
      for (const mutator of MUTATORS) {
        expect(source, `${path} names ${mutator}`).not.toMatch(
          new RegExp(`\\b${mutator}\\b`),
        )
      }
    }
  })

  it('keeps the door one function wide', () => {
    const projection = SOURCES['./hudModel.ts'] ?? ''
    // `hudModel` and `hudPlayer` are the only things that take a world or an
    // entity; everything else downstream takes the copy they return.
    expect(projection).toContain('state: GameState')
    expect(projection.match(/: GameState/g) ?? []).toHaveLength(1)
  })
})
