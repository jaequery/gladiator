/**
 * The bot writes only `UserCmd`. GLAD-TSED8V's fifth acceptance check.
 *
 * The whole ticket rests on one sentence: **the bot emits exactly the struct a human
 * emits**. Buttons, yaw, pitch, two move axes, a weapon — once per sub-step, through
 * the same door the network uses. No teleporting, no setting velocity, no physics
 * shortcuts, and the movement code cannot tell a bot command from a human one.
 *
 * That is worth a static check rather than a comment because of how *tempting* the
 * alternative is. A bot wedged in a wall is four lines from being un-wedged by
 * nudging its origin; a bot that cannot make a jump is one line from having its
 * velocity set. Both work, both pass every other test in the repository, and both are
 * the one thing a player detects immediately — players notice impossible motion long
 * before they notice good aim.
 *
 * ## Two halves, and neither is enough on its own
 *
 * 1. **The names.** Nothing in `packages/bot` may call the functions that move a
 *    body or write a world: `pmove`, `slideMove`, `stepSlideMove`, `tick`,
 *    `applyDamage`, `radiusDamage`, `fireWeapon`, `moveProjectiles`. The list is the
 *    *carriers*, exactly as `GROUND_TRUTH_BANS` in `eslint.config.js` bans the
 *    carriers of an opponent's vitals rather than the leaves.
 * 2. **The assignments.** Nothing in `packages/bot` may assign to `.origin`,
 *    `.velocity`, `.angles`, `.health` or `.armor` on anything that is not one of the
 *    bot's own records. That is what catches the four-line nudge, which needs no
 *    banned function at all.
 *
 * The exemptions are enumerated below rather than pattern-matched, because an
 * exemption nobody has read is a hole. `scripts/guardrails.mjs` is the model for the
 * discipline: a fence nobody has watched fire is a fence nobody knows is connected,
 * so the last test in this file writes a violation of each half and requires the
 * check to reject it.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const BOT_SRC = 'packages/bot/src'

/**
 * The functions that move a body or write a world.
 *
 * `pmove` and the two slide moves are the movement; `tick` is the whole world;
 * `applyDamage`, `radiusDamage` and `fireWeapon` write health and velocity;
 * `moveProjectiles` writes a rocket's. Naming any of them from the bot means the bot
 * is simulating rather than asking.
 */
const MOVERS: readonly string[] = [
  'pmove',
  'slideMove',
  'stepSlideMove',
  'tick',
  'applyDamage',
  'radiusDamage',
  'fireWeapon',
  'fireWeapons',
  'moveProjectiles',
  'spawnProjectile',
  'explodeProjectile',
]

/** The fields a body's state lives in. */
const BODY_FIELDS: readonly string[] = ['origin', 'velocity', 'angles', 'health', 'armor']

/**
 * The files exempt from both halves, and why each one is.
 *
 * Enumerated rather than pattern-matched: an exemption nobody has read is a hole, and
 * a glob is an exemption nobody will read again. Three files, two reasons:
 *
 * - **`nav/validate.ts`** is a bake-time validator. Its whole job is to walk a `walk`
 *   link with the real `pmove` and see whether it arrives (`nav/schema.ts` argues why
 *   a swept box is the wrong instrument), and the body it moves is a scratch
 *   `PmoveBody` that exists for the length of one link. It never runs in a match.
 * - **the two fixtures** drive the movement in order to check the bot *against* it,
 *   which is the opposite of the bot using it to cheat. `movement/fixture.ts` is the
 *   closed loop the follower's tests run in; `perception/fixture.ts` is the two sealed
 *   chambers the fairness harness runs in, and it teleports a body on purpose.
 *
 * Every `*.test.ts` is exempt for the same reason and is not listed, because a test
 * that could not construct a violation could not assert that it is refused.
 */
const EXEMPT: readonly string[] = [
  'nav/validate.ts',
  'movement/fixture.ts',
  'perception/fixture.ts',
]

/**
 * Receivers the bot legitimately writes a body field on, and what each one is.
 *
 * Every one is the bot's own record — a belief, a scratch input — and not a body in
 * the world. Nothing a simulation reads back appears here, and in particular `self`
 * does **not**: inside `perception/perceive.ts` that name is the bot's own
 * `EntityState`, and writing to it is precisely the violation this file exists to
 * refuse.
 */
const OWN_RECORDS: readonly string[] = [
  // `WorldModel.self`, under the name `readSelf` gives it.
  's',
  // What the bot believes about the opponent, and about a rocket it can see.
  'contact',
  'threat',
  // The perception layer's own previous-tick copies.
  'perception',
  // The follower's bookkeeping, and the controller input it fills in each sub-step.
  'move',
  'travel',
]

/** Every `.ts` under `packages/bot/src`, as a repo-relative path. */
function botSources(dir = BOT_SRC, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) botSources(path, out)
    else if (entry.name.endsWith('.ts')) out.push(path)
  }
  return out
}

const SOURCES = botSources()

/** The path under `packages/bot/src`, which is what the exemption lists name. */
function relative(path: string): string {
  return path.slice(BOT_SRC.length + 1)
}

function isTest(path: string): boolean {
  return path.endsWith('.test.ts')
}

/** Lines naming a mover as a *call*, which is the only way one does anything. */
export function moverCalls(source: string): string[] {
  const found: string[] = []
  for (const line of source.split('\n')) {
    if (line.trimStart().startsWith('*') || line.trimStart().startsWith('//')) continue
    for (const name of MOVERS) {
      if (new RegExp(`\\b${name}\\s*\\(`).test(line)) found.push(`${name}: ${line.trim()}`)
    }
  }
  return found
}

/**
 * Assignments to a body field on a receiver that is not one of the bot's own records.
 *
 * Matches `<receiver>.<field>[<index>] =` and `<receiver>.<field> =`, which are the
 * two shapes a vector write takes — the fields are `MutVec3`s, so the interesting
 * write is through an index.
 */
export function foreignBodyWrites(source: string): string[] {
  const found: string[] = []
  const pattern = new RegExp(
    `([A-Za-z_$][\\w$]*)(?:\\.[\\w$]+|\\[[^\\]]*\\])*?\\.(${BODY_FIELDS.join('|')})(?:\\[[^\\]]*\\])?\\s*(?:=[^=]|\\+=|-=)`,
  )
  for (const line of source.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue
    const match = pattern.exec(line)
    if (match === null) continue
    const receiver = match[1] ?? ''
    if (OWN_RECORDS.includes(receiver)) continue
    found.push(trimmed)
  }
  return found
}

describe('the bot writes only UserCmd', () => {
  it('has sources to check, so a broken walk cannot pass by finding none', () => {
    expect(SOURCES.length).toBeGreaterThan(20)
    expect(SOURCES.some((path) => relative(path) === 'movement/move.ts')).toBe(true)
  })

  it('never calls anything that moves a body or writes a world', () => {
    const offences: string[] = []
    for (const path of SOURCES) {
      const rel = relative(path)
      if (isTest(path) || EXEMPT.includes(rel)) continue
      for (const call of moverCalls(readFileSync(path, 'utf8'))) offences.push(`${rel} — ${call}`)
    }
    expect(offences).toEqual([])
  })

  it('never assigns a position, a velocity, an angle or a vital to a foreign record', () => {
    const offences: string[] = []
    for (const path of SOURCES) {
      const rel = relative(path)
      if (isTest(path) || EXEMPT.includes(rel)) continue
      for (const write of foreignBodyWrites(readFileSync(path, 'utf8'))) {
        offences.push(`${rel} — ${write}`)
      }
    }
    expect(offences).toEqual([])
  })

  it('exempts only the files it says it does, and each of them still exists', () => {
    for (const rel of EXEMPT) {
      expect(SOURCES.map(relative)).toContain(rel)
    }
  })
})

describe('the check itself', () => {
  // A fence nobody has watched fire is a fence nobody knows is connected —
  // `scripts/guardrails.mjs`'s argument, applied to a check that lives in a test.
  it('rejects a call to the movement', () => {
    expect(moverCalls('const body = scratch\npmove(world, body, cmd)\n')).toHaveLength(1)
    expect(moverCalls('tick(state, inputs, world)')).toHaveLength(1)
  })

  it('rejects the four-line nudge that needs no banned function', () => {
    expect(foreignBodyWrites('opponent.origin[0] = 100')).toHaveLength(1)
    expect(foreignBodyWrites('  enemy.velocity[2] += 270')).toHaveLength(1)
    expect(foreignBodyWrites('player.health = 0')).toHaveLength(1)
    expect(foreignBodyWrites('ground.state.entities[0].origin[1] = 4')).toHaveLength(1)
  })

  it('allows the bot to write its own records', () => {
    expect(foreignBodyWrites('contact.origin[0] = enemy.origin[0]')).toEqual([])
    expect(foreignBodyWrites('s.velocity[2] = self.velocity[2]')).toEqual([])
    expect(foreignBodyWrites('travel.origin = self.origin')).toEqual([])
  })

  it('refuses a write to the bot’s own body, which is still a body', () => {
    // `self` inside `perception/perceive.ts` is an `EntityState`. Nudging your *own*
    // origin is the same impossible motion as nudging somebody else's.
    expect(foreignBodyWrites('self.origin[2] += 18')).toHaveLength(1)
  })

  it('is not fooled by a comparison, which writes nothing', () => {
    expect(foreignBodyWrites('if (opponent.origin[0] === 100) return')).toEqual([])
    expect(foreignBodyWrites('const dx = opponent.origin[0] - self.origin[0]')).toEqual([])
  })

  it('ignores prose, so a comment naming pmove is still a comment', () => {
    expect(moverCalls(' * `pmove` is the real movement, and pmove(world, body) is how')).toEqual([])
    expect(moverCalls('  // pmove(world, body, cmd) would be cheating')).toEqual([])
  })
})
