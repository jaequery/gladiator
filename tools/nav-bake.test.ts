/**
 * The nav baker as a program: what it discovers, and whether what is committed
 * is still what the sources bake to.
 *
 * This is `pnpm nav:bake --check`, run as part of `pnpm test`, so a stale
 * artifact fails in CI rather than in a duel.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { loadNav } from '@gladiator/bot'

import { bakeAllNav, bakedNavPathFor, discoverNavGraphs, loadBakedMap } from './nav-bake.ts'
import { discoverMaps } from './bake-map.ts'

describe('the committed artifacts', () => {
  it('are what the sources bake to', async () => {
    const reports = await bakeAllNav('check')
    expect(reports.length).toBeGreaterThan(0)
    for (const report of reports) {
      expect(report.diagnostics.map((d) => `${d.code} ${d.detail}`)).toEqual([])
      expect(report.changed, `${report.path} is stale — run pnpm nav:bake`).toBe(false)
    }
  })

  it('load against the committed map they were baked for', () => {
    for (const name of discoverNavGraphs()) {
      const map = loadBakedMap(name)
      const nav = loadNav(JSON.parse(readFileSync(bakedNavPathFor(name), 'utf8')), map.hash)
      expect(nav.mapHash).toBe(map.hash)
      expect(nav.source.map).toBe(name)
    }
  })

  it('carry a next-hop, a cost and a visibility table sized to the graph', () => {
    for (const name of discoverNavGraphs()) {
      const baked = JSON.parse(readFileSync(bakedNavPathFor(name), 'utf8'))
      const n = baked.nav.nodes.length
      expect(baked.routes.nextHop.length).toBe(n * n)
      expect(baked.routes.cost.length).toBe(n * n)
      expect(baked.visibility.bits.length).toBe(n * baked.visibility.words)
    }
  })
})

describe('discovery', () => {
  it('finds every nav graph under maps/', () => {
    expect(discoverNavGraphs()).toContain('arena1')
  })

  it('keeps nav graphs out of the map baker, which would not know what to do with one', () => {
    expect(discoverMaps()).not.toContain('arena1.nav.ts')
    expect(discoverMaps()).not.toContain('nav-helpers.ts')
    expect(discoverMaps()).toContain('arena1.ts')
  })
})
