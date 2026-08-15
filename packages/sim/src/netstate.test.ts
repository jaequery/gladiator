/**
 * The wire codec, and the one property it has to have: a state that went
 * through it is the *same state*, not a state that looks like it.
 *
 * Reconciliation rebuilds the server's world out of one of these and then
 * compares hashes with the server about the result (GLAD-6RT64L). A field the
 * encoder forgot would make that comparison disagree on every tick, which turns
 * the project's desync canary — the one instrument that catches a foreign value
 * entering gameplay — into permanent noise. So the assertions here are about
 * the *hash*, never about the fields, because the fields are exactly what a
 * test can forget to update in the same way the encoder can.
 */
import { describe, expect, it } from 'vitest'

import { PROVING_GROUND_SPAWN, createProvingGround } from './fixtures/proving-ground.ts'
import { tick } from './kernel.ts'
import {
  WIRE_ENTITY_FIELDS,
  WIRE_HEADER_FIELDS,
  applyWireState,
  decodeState,
  encodeState,
  isWireState,
  wireStateLength,
} from './netstate.ts'
import { EntityFlag, EntityKind, createGameState, hashState, spawnEntity } from './state.ts'
import { BUTTON_ATTACK, BUTTON_JUMP, NULL_CMD } from './usercmd.ts'
import type { UserCmd } from './usercmd.ts'
import { Weapon } from './weapon.ts'

const WORLD = createProvingGround()

/** A world with two players in it, standing where the proving ground says. */
function twoPlayerWorld() {
  const state = createGameState(0x5eed)
  spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 0,
    origin: [PROVING_GROUND_SPAWN[0], PROVING_GROUND_SPAWN[1], PROVING_GROUND_SPAWN[2]],
    health: 100,
    armor: 100,
    weapon: Weapon.RocketLauncher,
    flags: EntityFlag.OnGround,
  })
  spawnEntity(state, {
    kind: EntityKind.Player,
    slot: 1,
    origin: [PROVING_GROUND_SPAWN[0] + 128, PROVING_GROUND_SPAWN[1], PROVING_GROUND_SPAWN[2]],
    health: 100,
    armor: 100,
    weapon: Weapon.Railgun,
    flags: EntityFlag.OnGround,
  })
  return state
}

/** Something for both players to do, so the run visits more than one field. */
function script(slot: number, at: number): UserCmd {
  return {
    ...NULL_CMD,
    forwardMove: at % 40 < 25 ? 1 : -1,
    sideMove: slot === 0 ? 1 : -1,
    yaw: (at * (slot === 0 ? 61 : 977)) % 65536,
    pitch: 0,
    buttons: (at % 17 === 0 ? BUTTON_JUMP : 0) | (at % 29 === 0 ? BUTTON_ATTACK : 0),
    weapon: slot === 0 ? Weapon.RocketLauncher : Weapon.Railgun,
  }
}

describe('the wire state', () => {
  it('is exactly the length its two constants say', () => {
    const state = twoPlayerWorld()
    expect(encodeState(state)).toHaveLength(wireStateLength(2))
    expect(wireStateLength(0)).toBe(WIRE_HEADER_FIELDS)
    expect(wireStateLength(3) - wireStateLength(2)).toBe(WIRE_ENTITY_FIELDS)
  })

  it('rebuilds a state that hashes identically, on every tick of a run', () => {
    const live = twoPlayerWorld()
    const rebuilt = createGameState(0)

    // Long enough for rockets to be spawned, fly, explode and expire, so the
    // run visits the trajectory fields and the entity list changing length —
    // both of which a codec can get away with dropping on a static world.
    let rockets = 0
    for (let at = 1; at <= 600; at += 1) {
      tick(live, [script(0, at), script(1, at)], WORLD)
      if (live.entities.some((entity) => entity.kind === EntityKind.Projectile)) rockets += 1

      expect(applyWireState(rebuilt, encodeState(live))).toBe(true)
      expect(hashState(rebuilt), `tick ${at}`).toBe(hashState(live))
    }

    // A run in which nothing was ever fired would prove much less than it looks
    // like it does.
    expect(rockets).toBeGreaterThan(20)
  })

  it('leaves nothing on the wire that the hash does not read', () => {
    // Every number in the encoding has to matter. A wire field the hash ignores
    // is a field the encoder is writing for nothing; a hash field the wire
    // ignores is a desync waiting to happen, and the run above is what catches
    // that direction. This is the other one.
    const live = twoPlayerWorld()
    tick(live, [script(0, 1), script(1, 1)], WORLD)
    const wire = encodeState(live)
    const original = hashState(live)

    const inert: number[] = []
    for (let index = 0; index < wire.length; index += 1) {
      const nudged = [...wire]
      nudged[index] = (nudged[index] as number) + 1

      const rebuilt = createGameState(0)
      if (index === WIRE_HEADER_FIELDS - 1) {
        // The entity count. One more of them than the array holds is not a
        // shorter world, it is a frame this build cannot read.
        expect(applyWireState(rebuilt, nudged)).toBe(false)
        continue
      }
      expect(applyWireState(rebuilt, nudged)).toBe(true)
      if (hashState(rebuilt) === original) inert.push(index)
    }

    expect(inert).toEqual([])
  })

  it('reuses the entity objects it already has, by id', () => {
    const live = twoPlayerWorld()
    const rebuilt = decodeState(createGameState(0), encodeState(live))
    if (rebuilt === null) throw new Error('the first decode failed')
    const before = rebuilt.entities.map((entity) => entity)
    // Copied now, because the object itself is about to be written through.
    const wasAt = before[0]?.origin.slice()

    for (let at = 1; at <= 8; at += 1) tick(live, [script(0, at), script(1, at)], WORLD)
    applyWireState(rebuilt, encodeState(live))

    // The *same objects*, moved. A snapshot that replaced them would hand the
    // renderer a brand-new opponent to build a rig for several times a second.
    expect(rebuilt.entities[0]).toBe(before[0])
    expect(rebuilt.entities[1]).toBe(before[1])
    expect(rebuilt.entities[0]?.origin).not.toEqual(wasAt)
  })

  it('keeps the entity list in ascending id, whatever order it held before', () => {
    const live = twoPlayerWorld()
    const rebuilt = decodeState(createGameState(0), encodeState(live))
    if (rebuilt === null) throw new Error('the first decode failed')
    rebuilt.entities.reverse()

    applyWireState(rebuilt, encodeState(live))
    expect(rebuilt.entities.map((entity) => entity.id)).toEqual(
      live.entities.map((entity) => entity.id),
    )
  })
})

describe('the door', () => {
  const good = encodeState(twoPlayerWorld())

  it('takes a well-formed state', () => {
    expect(isWireState(good)).toBe(true)
  })

  it.each([
    ['not an array', { length: good.length }],
    ['too short for a header', good.slice(0, WIRE_HEADER_FIELDS - 1)],
    ['a length its count does not explain', good.slice(0, good.length - 1)],
    ['a negative entity count', withField(good, WIRE_HEADER_FIELDS - 1, -1)],
    ['a fractional entity count', withField(good, WIRE_HEADER_FIELDS - 1, 1.5)],
    ['a NaN', withField(good, WIRE_HEADER_FIELDS + 4, Number.NaN)],
    ['an infinity', withField(good, WIRE_HEADER_FIELDS + 5, Number.POSITIVE_INFINITY)],
    ['a string where a number goes', withField(good, 0, 'nine' as unknown as number)],
  ])('turns away %s', (_label, value) => {
    expect(isWireState(value)).toBe(false)
    // And a state that is turned away leaves the world alone rather than
    // half-applied: the simulation has no way to reject a value later.
    const target = twoPlayerWorld()
    const before = hashState(target)
    expect(applyWireState(target, value as number[])).toBe(false)
    expect(hashState(target)).toBe(before)
  })
})

function withField(wire: readonly number[], index: number, value: number): number[] {
  const copy = [...wire]
  copy[index] = value
  return copy
}
