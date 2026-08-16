/**
 * The weapons, as shapes.
 *
 * "Does it look like Quake's rocket launcher" is a question about a picture, and
 * a picture is not something a test can look at. What a test *can* do is pin the
 * claims the picture rests on — the bore is the widest thing on the weapon and
 * it is at the front, the body is a tube longer than it is wide, the sight is
 * above it and the grip below and behind, and the launcher's outline cannot be
 * mistaken for the railgun's at arena distance.
 *
 * Each of those is a property somebody could quietly undo while tuning a number,
 * and none of them would fail anything else in this suite.
 */
import { NullEngine } from '@babylonjs/core/Engines/nullEngine'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Scene } from '@babylonjs/core/scene'
import { describe, expect, it } from 'vitest'

import {
  RAILGUN_VIEW,
  RAILGUN_WORLD,
  ROCKET_LAUNCHER_VIEW,
  ROCKET_LAUNCHER_WORLD,
  TUBE_SIDES,
  type WeaponPart,
  buildWeapon,
  finishMaterials,
  partSpan,
  partWidth,
  weaponFinishes,
} from './weaponModel.ts'

const LAUNCHERS: readonly (readonly [string, readonly WeaponPart[]])[] = [
  ['first person', ROCKET_LAUNCHER_VIEW],
  ['world', ROCKET_LAUNCHER_WORLD],
]

function named(parts: readonly WeaponPart[], name: string): WeaponPart {
  const part = parts.find((candidate) => candidate.name === name)
  if (part === undefined) throw new Error(`no part named ${name}`)
  return part
}

/** How far the whole list reaches: `[front, back]`, front being lower. */
function outline(parts: readonly WeaponPart[]): readonly [number, number] {
  let front = Number.POSITIVE_INFINITY
  let back = Number.NEGATIVE_INFINITY
  for (const part of parts) {
    const [partFront, partBack] = partSpan(part)
    front = Math.min(front, partFront)
    back = Math.max(back, partBack)
  }
  return [front, back]
}

describe.each(LAUNCHERS)('the rocket launcher (%s)', (_which, parts) => {
  it('is a tube: a body longer than it is wide, running most of the weapon', () => {
    const body = named(parts, 'body')
    expect(body.kind).toBe('tube')

    const [front, back] = outline(parts)
    const [bodyFront, bodyBack] = partSpan(body)
    expect(bodyBack - bodyFront).toBeGreaterThan(partWidth(body) * 2)
    // Most of the weapon's length is barrel, which is what a launcher is.
    expect(bodyBack - bodyFront).toBeGreaterThan((back - front) * 0.55)
  })

  it('carries its bore at the muzzle, wider than anything else on it', () => {
    const bore = named(parts, 'bore')
    const [front] = outline(parts)
    const [boreFront] = partSpan(bore)

    // Nothing but the mouth and the rocket in it reaches further forward.
    expect(boreFront).toBeLessThan(front + 3)
    for (const part of parts) {
      if (part.name === 'bore') continue
      expect(partWidth(part)).toBeLessThan(partWidth(bore))
    }
  })

  it('flares forward, and has a rocket in the mouth standing proud of it', () => {
    const bore = named(parts, 'bore')
    const mouth = named(parts, 'mouth')
    const warhead = named(parts, 'warhead')

    if (bore.kind !== 'tube' || warhead.kind !== 'tube') throw new Error('not tubes')
    // The bore opens out towards the muzzle and the warhead tapers to a point.
    expect(bore.diameterFront ?? bore.diameter).toBeGreaterThan(bore.diameter)
    expect(warhead.diameterFront ?? warhead.diameter).toBeLessThan(warhead.diameter)

    // In front of the metal, in front of the dark: an orange nose you can see.
    expect(partSpan(warhead)[0]).toBeLessThan(partSpan(mouth)[0])
    expect(partSpan(mouth)[0]).toBeLessThan(partSpan(bore)[0])
    expect(warhead.finish).toBe('accent')
    expect(mouth.finish).toBe('dark')
  })

  it('has exactly one accent-coloured part, and it is the rocket', () => {
    const accents = parts.filter((part) => part.finish === 'accent')
    expect(accents.map((part) => part.name)).toEqual(['warhead'])
  })

  it('wears its sight above the barrel and its grip below and behind it', () => {
    const body = named(parts, 'body')
    const rail = named(parts, 'sight.rail')
    const front = named(parts, 'sight.front')
    const grip = named(parts, 'grip')

    const axis = body.at[1]
    const radius = partWidth(body) / 2
    expect(rail.at[1]).toBeGreaterThan(axis + radius * 0.6)
    // The blade stands above the rail it is mounted on, and ahead of it.
    expect(front.at[1]).toBeGreaterThan(rail.at[1])
    expect(front.at[2]).toBeLessThan(rail.at[2])

    expect(grip.at[1]).toBeLessThan(axis - radius)
    // Set back: behind the middle of the barrel, which is what puts the
    // weapon's weight out in front of the hand.
    expect(grip.at[2]).toBeGreaterThan((partSpan(body)[0] + partSpan(body)[1]) / 2)
  })

  it('is longer than it is tall, the way a launcher is', () => {
    const [front, back] = outline(parts)
    let top = Number.NEGATIVE_INFINITY
    let bottom = Number.POSITIVE_INFINITY
    for (const part of parts) {
      const half = (part.kind === 'box' ? part.size[1] : partWidth(part)) / 2
      top = Math.max(top, part.at[1] + half)
      bottom = Math.min(bottom, part.at[1] - half)
    }
    expect((back - front) / (top - bottom)).toBeGreaterThan(1.4)
  })
})

describe('the two weapons', () => {
  it('cannot be confused: one is a fat tube, the other a thin rod', () => {
    for (const [launcher, rail] of [
      [ROCKET_LAUNCHER_VIEW, RAILGUN_VIEW],
      [ROCKET_LAUNCHER_WORLD, RAILGUN_WORLD],
    ] as const) {
      const launcherWidth = Math.max(...launcher.map(partWidth))
      const railWidth = Math.max(...rail.map(partWidth))
      // Twice as wide is a difference that survives being a few dozen pixels.
      expect(launcherWidth).toBeGreaterThan(railWidth * 2)
    }
  })

  it('draws the world model no wider than the launcher a player holds is long', () => {
    // A sanity bound rather than a design claim: a weapon that has grown by an
    // order of magnitude is a typo, and a typo here is invisible until somebody
    // looks at an opponent.
    for (const parts of [ROCKET_LAUNCHER_WORLD, RAILGUN_WORLD]) {
      for (const part of parts) expect(partWidth(part)).toBeLessThan(20)
    }
  })
})

describe('building one', () => {
  function built(parts: readonly WeaponPart[]) {
    const scene = new Scene(new NullEngine())
    const finishes = weaponFinishes((name) => new StandardMaterial(name, scene), 'w')
    const root = new TransformNode('root', scene)
    buildWeapon(scene, parts, root, finishes, { namePrefix: 'w:rocket' })
    return { scene, root, finishes }
  }

  it('names every mesh after its part, under the rig that owns it', () => {
    const { root } = built(ROCKET_LAUNCHER_VIEW)
    const names = root.getChildMeshes().map((mesh) => mesh.name)
    expect(names).toContain('w:rocket.body')
    expect(names).toContain('w:rocket.bore')
    expect(names).toHaveLength(ROCKET_LAUNCHER_VIEW.length)
  })

  it('lays every tube down the barrel, so a bore flares forwards', () => {
    const { root } = built(ROCKET_LAUNCHER_VIEW)
    const bore = root.getChildMeshes().find((mesh) => mesh.name === 'w:rocket.bore')
    bore?.computeWorldMatrix(true)
    // A tube's own `+y` is its `diameterTop` end; the quarter turn has to put
    // that on `-z`, or every taper on the weapon points the wrong way.
    const up = bore?.getWorldMatrix().getRow(1)
    expect(up?.z).toBeCloseTo(-1, 6)
  })

  it('makes an octagon, not a cylinder', () => {
    const body = named(ROCKET_LAUNCHER_VIEW, 'body')
    if (body.kind !== 'tube') throw new Error('not a tube')

    const { root } = built([body, { ...body, name: 'smooth', sides: 32 }])
    const meshes = root.getChildMeshes()
    const faceted = meshes.find((mesh) => mesh.name === 'w:rocket.body')
    const smooth = meshes.find((mesh) => mesh.name === 'w:rocket.smooth')

    // The default is the low number and it is what `sides` overrides, so a
    // tube that stopped being faceted would show up here as a vertex count
    // that had caught up with the smooth one.
    expect(TUBE_SIDES).toBe(8)
    expect(faceted?.getTotalVertices()).toBeLessThan((smooth?.getTotalVertices() ?? 0) / 2)
  })

  it('hands back every material it made, so a rig can dispose them', () => {
    const { finishes } = built(RAILGUN_VIEW)
    expect(finishMaterials(finishes)).toHaveLength(3)
    expect(new Set(finishMaterials(finishes)).size).toBe(3)
  })
})
