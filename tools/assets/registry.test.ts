/**
 * The licence rules, watched firing.
 *
 * A rule that has never rejected anything is a rule nobody knows is connected.
 * Every case below is a mistake somebody makes for real: the CC-BY texture that
 * looked free, the OpenGameArt link that proves nothing on its own, and the
 * Mixamo rig whose licence forbids exactly what committing it does.
 */

import { describe, expect, it } from 'vitest'

import {
  parseCredits,
  renderCreditsMarkdown,
  renderPublicCredits,
  validateCredits,
} from './registry.ts'
import type { CreditEntry } from './registry.ts'

const CC0: CreditEntry = {
  id: 'floor',
  title: 'Floor',
  author: 'Someone',
  source: 'https://example.com/floor',
  licence: 'CC0-1.0',
  kind: 'texture',
  textureClass: 'albedo',
  files: ['assets/textures/floor.png'],
}

const entry = (overrides: Partial<CreditEntry>): CreditEntry => ({ ...CC0, ...overrides })

describe('what may not ship', () => {
  it('rejects a Mixamo source, and says why', () => {
    const problems = validateCredits({
      entries: [entry({ id: 'rig', kind: 'model', source: 'https://www.mixamo.com/#/?page=1' })],
    })
    expect(problems.join('\n')).toMatch(/mixamo\.com/)
    expect(problems.join('\n')).toMatch(/redistributing the raw asset files/)
  })

  it('rejects content under an attribution licence', () => {
    const problems = validateCredits({ entries: [entry({ licence: 'CC-BY-4.0' })] })
    expect(problems.join('\n')).toMatch(/CC-BY-4\.0/)
    expect(problems.join('\n')).toMatch(/CC0-1\.0 only/)
  })

  it('rejects a mixed-licence host without a CC0 licence, naming the host', () => {
    const problems = validateCredits({
      entries: [
        entry({ source: 'https://opengameart.org/content/some-pack', licence: 'CC-BY-SA-3.0' }),
      ],
    })
    expect(problems.join('\n')).toMatch(/opengameart\.org/)
    expect(problems.join('\n')).toMatch(/licence varies per item/)
  })

  it('accepts a mixed-licence host when the item itself is CC0', () => {
    const problems = validateCredits({
      entries: [entry({ source: 'https://freesound.org/people/x/sounds/1/' })],
    })
    expect(problems).toEqual([])
  })

  it('lets vendored code be permissive, and content not', () => {
    const vendored: CreditEntry = {
      id: 'lib',
      title: 'A library',
      author: 'Someone else',
      source: 'https://example.com/lib',
      licence: 'Apache-2.0',
      kind: 'vendored',
      files: ['packages/client/public/ktx2/lib.js'],
    }
    expect(validateCredits({ entries: [vendored] })).toEqual([])
    expect(validateCredits({ entries: [entry({ licence: 'Apache-2.0' })] })).not.toEqual([])
  })

  it('rejects two entries claiming the same file', () => {
    const problems = validateCredits({ entries: [CC0, entry({ id: 'other' })] })
    expect(problems.join('\n')).toMatch(/claimed by both floor and other/)
  })
})

describe('parsing', () => {
  const wrap = (entries: unknown) => JSON.stringify({ entries })

  it('requires a texture entry to say which class it is', () => {
    expect(() => parseCredits(wrap([{ ...CC0, textureClass: undefined }]))).toThrow(
      /textureClass must be a non-empty string/,
    )
  })

  it('refuses a textureClass on something that is not a texture', () => {
    expect(() => parseCredits(wrap([{ ...CC0, kind: 'model' }]))).toThrow(
      /only meaningful on a texture entry/,
    )
  })

  it('refuses a path that escapes the repository', () => {
    expect(() => parseCredits(wrap([{ ...CC0, files: ['../secrets.png'] }]))).toThrow(
      /repo-relative and POSIX/,
    )
  })

  it('round-trips a valid registry', () => {
    const credits = parseCredits(wrap([CC0]))
    expect(credits.entries).toEqual([CC0])
  })
})

describe('rendering', () => {
  it('puts the source URL and the licence in CREDITS.md', () => {
    const markdown = renderCreditsMarkdown({ entries: [CC0] })
    expect(markdown).toContain('<https://example.com/floor>')
    expect(markdown).toContain('CC0-1.0')
    expect(markdown).toContain('`assets/textures/floor.png`')
  })

  it('keeps the build fields out of what the player is shown', () => {
    const published: unknown = JSON.parse(renderPublicCredits({ entries: [CC0] }))
    const first = (published as { entries: Array<Record<string, unknown>> }).entries[0]
    expect(first).toMatchObject({ title: 'Floor', licence: 'CC0-1.0' })
    expect(first).not.toHaveProperty('textureClass')
    expect(first).not.toHaveProperty('files')
  })
})
