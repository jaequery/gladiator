import { describe, expect, it } from 'vitest'

import { type DeviceProbe, bounceBody, bounceHeadline, bounceReason } from './unsupported.ts'

const DESKTOP: DeviceProbe = {
  pointerLock: true,
  finePointer: true,
  coarsePointer: false,
  touchPoints: 0,
}

describe('who gets bounced', () => {
  it('lets a desktop with a mouse through', () => {
    expect(bounceReason(DESKTOP)).toBe(null)
  })

  it('bounces a phone', () => {
    expect(
      bounceReason({ pointerLock: true, finePointer: false, coarsePointer: true, touchPoints: 5 }),
    ).toBe('touch-only')
  })

  it('bounces a phone whose browser reports touch but not the media query', () => {
    expect(
      bounceReason({ pointerLock: true, finePointer: false, coarsePointer: false, touchPoints: 5 }),
    ).toBe('touch-only')
  })

  it('lets a touchscreen laptop through', () => {
    // Both coarse and fine, and it plays perfectly. This is the case a
    // user-agent sniff gets wrong, and the reason there is not one.
    expect(
      bounceReason({ pointerLock: true, finePointer: true, coarsePointer: true, touchPoints: 10 }),
    ).toBe(null)
  })

  it('lets a browser that answers neither media query through', () => {
    // An old engine, a headless one, an embedded view. A false bounce turns a
    // working machine away; a false pass shows a menu that does not respond,
    // which the player can at least see and leave.
    expect({ ...DESKTOP, finePointer: false, coarsePointer: false, touchPoints: 0 }).toSatisfy(
      (probe: DeviceProbe) => bounceReason(probe) === null,
    )
  })

  it('bounces a desktop browser with no pointer lock at all, and says which', () => {
    const reason = bounceReason({ ...DESKTOP, pointerLock: false })
    expect(reason).toBe('no-pointer-lock')
    // Two different sentences on purpose: "get a mouse" is wrong advice for
    // somebody who has one.
    expect(bounceHeadline('no-pointer-lock')).not.toBe(bounceHeadline('touch-only'))
    expect(bounceBody('no-pointer-lock')).toContain('Pointer Lock')
    expect(bounceBody('touch-only')).toContain('desktop')
  })

  it('bounces a phone before it asks whether the pointer is fine', () => {
    // Order matters: on a device with neither, the missing API is the more
    // useful thing to say.
    expect(
      bounceReason({ pointerLock: false, finePointer: false, coarsePointer: true, touchPoints: 5 }),
    ).toBe('no-pointer-lock')
  })
})
