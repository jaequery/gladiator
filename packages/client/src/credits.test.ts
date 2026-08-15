/**
 * The credits screen's logic, over the file the build actually generates.
 *
 * The screen itself — mounting, opening, the fetch — is checked in a real
 * browser by `scripts/e2e.mjs`, for the same reason the renderer is: a DOM
 * simulated in Node would be a second opinion about what the page does, and
 * this repository already has a harness that asks the first one.
 *
 * What is worth asserting here is the part that has to survive a bad file. A
 * stale deploy or an edge proxy answering 200 with an HTML error page is not
 * hypothetical, and a credits screen that throws takes the page with it.
 */

import { describe, expect, it } from 'vitest'

import shipped from '../public/credits.json' with { type: 'json' }
import { creditsRequested, creditsSections, parseCredits } from './credits.ts'

describe('parsing', () => {
  it('reads the file the build generates', () => {
    const credits = parseCredits(shipped)
    expect(credits.entries.length).toBeGreaterThan(0)
    for (const entry of credits.entries) {
      expect(entry.source).toMatch(/^https:\/\//)
      expect(entry.licence).not.toBe('')
      expect(entry.title).not.toBe('')
    }
  })

  it('survives a file that is not the file', () => {
    expect(parseCredits('<!doctype html>').entries).toEqual([])
    expect(parseCredits(null).entries).toEqual([])
    expect(parseCredits({ entries: 'soon' }).entries).toEqual([])
  })

  it('drops an entry that is missing a field rather than the whole list', () => {
    const credits = parseCredits({
      entries: [
        { id: 'a', title: 'A', author: 'x', source: 'https://x', licence: 'CC0-1.0', kind: 'model' },
        { id: 'b', title: 'B' },
      ],
    })
    expect(credits.entries.map((entry) => entry.id)).toEqual(['a'])
  })
})

describe('sections', () => {
  it('shows the shipped credits under headings, in a fixed order', () => {
    const sections = creditsSections(parseCredits(shipped))
    expect(sections.map((section) => section.heading)).toEqual([
      'Models',
      'Textures',
      'Vendored code',
    ])
  })

  it('never drops a credit it has no heading for', () => {
    // Audio arrives in GLAD-26Q67K. Until then its kind is one this screen does
    // not know, and a credit silently dropped is the failure that matters here.
    const sections = creditsSections({
      entries: [
        { id: 'a', title: 'A', author: 'x', source: 'https://x', licence: 'CC0-1.0', kind: 'audio' },
      ],
    })
    expect(sections).toHaveLength(1)
    expect(sections[0]?.heading).toBe('Everything else')
    expect(sections[0]?.entries).toHaveLength(1)
  })
})

describe('the query flag', () => {
  it('opens on ?credits=1 and nothing else', () => {
    expect(creditsRequested('?credits=1')).toBe(true)
    expect(creditsRequested('?credits=0')).toBe(false)
    expect(creditsRequested('')).toBe(false)
  })
})
