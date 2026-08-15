/**
 * The ledge guard, over a map with a bottomless hole in the middle of its floor.
 *
 * `nav/fixture.ts`'s map is four floor slabs with a 128-unit square missing, sealed
 * above and open below — so "there is no floor there" is a fact about the geometry
 * rather than a mock, and a body that walks in falls out of the world.
 */

import { STEP_SIZE, vec3, yawUnitsFromDegrees } from '@gladiator/sim'
import { describe, expect, it } from 'vitest'

import { fixtureWorld } from './fixture.ts'
import { LEDGE_DROP, guardedAxes, ledgeSafe } from './ledge.ts'
import { axisDirection, createAxes } from './steer.ts'

const world = fixtureWorld()
const axes = createAxes()
const still = vec3()

/** The hole is `x, y` in [-64, 64]; the floor is everything else out to 1024. */
const EDGE = 64

/**
 * Standing with the leading face of the player box just inside the hole.
 *
 * Ten units in rather than exactly on the edge, because a *point* trace against the
 * boundary plane of a brush reports solid — the plane belongs to the floor. Ten units
 * is well inside a 128-unit hole and well outside that ambiguity.
 */
const LIP = -EDGE - 15 + 10

describe('the downward probe', () => {
  it('finds floor under a stride across open ground', () => {
    expect(ledgeSafe(world, [-512, 0, 0.125], 1, 0, 0)).toBe(true)
    expect(ledgeSafe(world, [-512, 0, 0.125], 1, 0, 320)).toBe(true)
  })

  it('finds nothing under a stride into the hole', () => {
    // Standing at the lip, facing it. At rest the probe sits at the leading face of
    // the player box, so a body whose face is already over the hole has nothing under
    // its next footfall. `LIP` is a little inside the edge rather than exactly on it:
    // a point trace against a brush's own boundary plane reports solid, which is
    // correct and is not the question being asked.
    expect(ledgeSafe(world, [LIP, 0, 0.125], 1, 0, 0)).toBe(false)
  })

  it('sees the hole further off the faster the body is going', () => {
    // 45 units short of the lip: at rest the probe lands 30 units short of it, and at
    // run speed the stopping distance carries it 8 units past.
    const nearEdge: [number, number, number] = [-EDGE - 45, 0, 0.125]
    expect(ledgeSafe(world, nearEdge, 1, 0, 0)).toBe(true)
    expect(ledgeSafe(world, nearEdge, 1, 0, 320)).toBe(false)
  })

  it('does not mistake a wall for a ledge', () => {
    // The fixture's 128-tall pillar. A probe that started inside it reports
    // `startsolid`, and calling that a ledge would stop a bot walking up its own
    // staircase — every riser starts a probe inside solid.
    expect(ledgeSafe(world, [0, -256, 128.125], 0, -1, 0)).toBe(true)
  })

  it('accepts a step down and refuses anything deeper', () => {
    // The 48-tall block, from on top of it. Stepping off is a 48-unit drop, which is
    // deeper than {@link LEDGE_DROP} and therefore not the surface this walk is on.
    expect(LEDGE_DROP).toBe(STEP_SIZE)
    expect(ledgeSafe(world, [246, -192, 48.125], 1, 0, 0)).toBe(false)
    // And a stride the other way, along the top of it, is floor.
    expect(ledgeSafe(world, [246, -192, 48.125], -1, 0, 0)).toBe(true)
  })

  it('is happy with a direction of zero length, because that is not a stride', () => {
    expect(ledgeSafe(world, [0, 0, 0], 0, 0, 0)).toBe(true)
  })
})

describe('choosing the axes', () => {
  const yaw = yawUnitsFromDegrees(0)

  it('leaves a safe direction alone', () => {
    const changed = guardedAxes(world, [-512, 0, 0.125], still, yaw, 1, 0, 0, axes)
    expect(changed).toBe(false)
    expect(axes).toEqual({ forwardMove: 1, sideMove: 0 })
  })

  it('re-steers rather than walking into the hole', () => {
    const origin: [number, number, number] = [LIP, 0, 0.125]
    const changed = guardedAxes(world, origin, still, yaw, 1, 0, 0, axes)
    expect(changed).toBe(true)
    // Whatever it picked has to be over floor — which is the property, rather than
    // any particular pair of axes.
    const chosen = axisDirection(yaw, axes.forwardMove, axes.sideMove, vec3())
    expect(ledgeSafe(world, origin, chosen[0], chosen[1], 0)).toBe(true)
    // And it has to be *something*: refusing to move is the brake, and the brake is
    // for when there is nowhere left to go.
    expect(axes.forwardMove === 0 && axes.sideMove === 0).toBe(false)
  })

  it('prefers the side the route is bending towards when both are clear', () => {
    const origin: [number, number, number] = [LIP, 0, 0.125]
    guardedAxes(world, origin, still, yaw, 1, 0, 1, axes)
    const left = { ...axes }
    guardedAxes(world, origin, still, yaw, 1, 0, -1, axes)
    expect(axes).not.toEqual(left)
  })

  it('brakes against its own velocity when every way forward is a hole', () => {
    // Inside the hole's own column, above it, with floor nowhere within a step in
    // any of the five candidate directions. The honest answer is to stop.
    const origin: [number, number, number] = [0, 0, 0.125]
    const velocity: [number, number, number] = [320, 0, 0]
    const changed = guardedAxes(world, origin, velocity, yaw, 1, 0, 0, axes)
    expect(changed).toBe(true)
    // Against `+x` velocity, with the view down `+x`, that is `forwardMove = -1`.
    expect(axes).toEqual({ forwardMove: -1, sideMove: 0 })
  })
})
