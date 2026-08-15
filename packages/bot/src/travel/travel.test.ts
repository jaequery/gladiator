/**
 * The four traversal controllers, one link kind each.
 *
 * These are the smallest thing in the movement layer and they are tested at that
 * size: given a link and a body, which direction and does it press jump. The
 * follower's part — which link, and whether the ledge guard is on — is
 * `movement/move.test.ts`.
 */

import { JUMP_VELOCITY, horizontalReachOf } from '@gladiator/sim'
import type { Vec3 } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { NAV_LINK_KINDS } from '../nav/schema.ts'
import { NAV_ARRIVE_RADIUS } from '../nav/validate.ts'
import { TRAVELLERS, travellerFor } from './index.ts'
import { createIntent } from './travel.ts'
import type { Travel } from './travel.ts'

const intent = createIntent()

function travel(over: Partial<Travel> = {}): Travel {
  const origin: Vec3 = over.origin ?? [0, 0, 0]
  const to: Vec3 = over.to ?? [200, 0, 0]
  const dx = to[0] - origin[0]
  const dy = to[1] - origin[1]
  return {
    origin,
    velocity: over.velocity ?? [0, 0, 0],
    onGround: over.onGround ?? true,
    from: over.from ?? [0, 0, 0],
    to,
    flat: over.flat ?? Math.sqrt(dx * dx + dy * dy),
    rise: over.rise ?? to[2] - origin[2],
  }
}

describe('the dispatch', () => {
  it('has exactly one controller per link kind, and no more', () => {
    // The table `satisfies Record<NavLinkKind, Traveller>`, so a fifth kind is a type
    // error rather than a review comment. This is the same claim at run time, which
    // is what catches a kind added to the *artifact* format without one.
    expect(Object.keys(TRAVELLERS).sort()).toEqual([...NAV_LINK_KINDS].sort())
    for (const kind of NAV_LINK_KINDS) expect(typeof travellerFor(kind)).toBe('function')
  })
})

describe('every controller', () => {
  it('points at the far end of the hop, as a unit vector', () => {
    for (const kind of NAV_LINK_KINDS) {
      travellerFor(kind)(travel({ to: [300, 400, 0] }), intent)
      expect(intent.wish[0]).toBeCloseTo(0.6, 12)
      expect(intent.wish[1]).toBeCloseTo(0.8, 12)
      expect(intent.wish[2]).toBe(0)
    }
  })

  it('asks for nothing when it is already standing on the far end', () => {
    for (const kind of NAV_LINK_KINDS) {
      travellerFor(kind)(travel({ to: [0, 0, 0] }), intent)
      expect(Array.from(intent.wish)).toEqual([0, 0, 0])
    }
  })
})

describe('walk', () => {
  it('never presses jump — that is what makes it a walk', () => {
    for (const onGround of [true, false]) {
      for (const flat of [0, 24, 200, 2000]) {
        TRAVELLERS.walk(travel({ onGround, flat }), intent)
        expect(intent.jump).toBe(false)
      }
    }
  })

  it('arrives inside the radius, and only within a step vertically', () => {
    expect(TRAVELLERS.walk(travel({ flat: NAV_ARRIVE_RADIUS - 1 }), intent).arrived).toBe(true)
    expect(TRAVELLERS.walk(travel({ flat: NAV_ARRIVE_RADIUS + 1 }), intent).arrived).toBe(false)
    // Standing under a walkway is not standing on it.
    expect(TRAVELLERS.walk(travel({ flat: 10, rise: 48 }), intent).arrived).toBe(false)
    expect(TRAVELLERS.walk(travel({ flat: 10, rise: 18 }), intent).arrived).toBe(true)
  })
})

describe('jump', () => {
  /** `arena1`'s crate link: 80 units across, 40 up. */
  const CRATE_CLIMB = 40
  const CRATE_SPAN = 80

  it('presses jump as soon as the arc reaches, from the ground', () => {
    const reach = horizontalReachOf(JUMP_VELOCITY, CRATE_CLIMB)
    expect(reach).toBeGreaterThan(CRATE_SPAN)
    expect(
      TRAVELLERS.jump(travel({ flat: CRATE_SPAN, rise: CRATE_CLIMB }), intent).jump,
    ).toBe(true)
    // And not from further off than the arc travels: the bot walks in first.
    expect(
      TRAVELLERS.jump(travel({ flat: reach + 1, rise: CRATE_CLIMB }), intent).jump,
    ).toBe(false)
  })

  it('releases the button the moment it is off the ground', () => {
    // `PMF_JUMP_HELD` is only cleared by a sub-step with the button up, so a
    // controller that held jump would jump once and never again.
    expect(
      TRAVELLERS.jump(travel({ flat: CRATE_SPAN, rise: CRATE_CLIMB, onGround: false }), intent)
        .jump,
    ).toBe(false)
  })

  it('treats a climb already made as no climb rather than as a fall', () => {
    // Mid-flight `rise` goes negative, and `horizontalReachOf` of a negative climb is
    // the reach of a *fall*, which is not the question. Clamped, the gate stays about
    // the link — and the bot re-presses on landing if it came down short.
    const wide = horizontalReachOf(JUMP_VELOCITY, 0)
    expect(TRAVELLERS.jump(travel({ flat: wide - 1, rise: -200 }), intent).jump).toBe(true)
    expect(TRAVELLERS.jump(travel({ flat: wide + 100, rise: -200 }), intent).jump).toBe(false)
  })
})

describe('drop', () => {
  it('never presses jump — a drop is a fall, not a leap', () => {
    for (const onGround of [true, false]) {
      TRAVELLERS.drop(travel({ onGround, rise: -128 }), intent)
      expect(intent.jump).toBe(false)
    }
  })

  it('arrives at the bottom rather than at the lip', () => {
    // Over the far node but 128 units above it is not having arrived: handing the
    // next hop to a follower whose bot is still in the air is how a drop turns into
    // a fall into the wrong place.
    expect(TRAVELLERS.drop(travel({ flat: 4, rise: -128 }), intent).arrived).toBe(false)
    expect(TRAVELLERS.drop(travel({ flat: 4, rise: -2 }), intent).arrived).toBe(true)
  })
})

describe('teleport', () => {
  it('arrives on horizontal distance alone, because the far end is elsewhere', () => {
    expect(TRAVELLERS.teleport(travel({ flat: 4, rise: 512 }), intent).arrived).toBe(true)
    expect(TRAVELLERS.teleport(travel({ flat: NAV_ARRIVE_RADIUS + 1, rise: 0 }), intent).arrived)
      .toBe(false)
  })

  it('never presses jump', () => {
    TRAVELLERS.teleport(travel(), intent)
    expect(intent.jump).toBe(false)
  })
})
