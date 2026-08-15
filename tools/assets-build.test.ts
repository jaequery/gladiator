/**
 * The committed artifacts are what these sources build to, and every committed
 * asset is credited.
 *
 * The first is the same guarantee `maps/baked/*.json` gets from
 * `tools/bake-map.test.ts`, and for the same reason: the artifacts are in the
 * repository so a build needs no encode step in front of it, which is only safe
 * if the tree cannot quietly hold one nobody can reproduce.
 *
 * The second is this ticket's acceptance check, run against the real index: an
 * asset with no credit entry fails, and so does a credit entry for an asset
 * that is not there.
 */

import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { buildArtifacts, checkCoverage } from './assets/build.ts'
import { CREDITS_SOURCE, abs, planBuild } from './assets/plan.ts'
import { parseCredits } from './assets/registry.ts'
import { committedAssets } from './assets-build.ts'

const credits = parseCredits(readFileSync(abs(CREDITS_SOURCE), 'utf8'))

describe('the committed artifacts', () => {
  it('are exactly what these sources build to', async () => {
    const { artifacts } = await buildArtifacts(credits)
    expect(artifacts.length).toBeGreaterThan(0)

    const stale: string[] = []
    for (const artifact of artifacts) {
      const committed = new Uint8Array(readFileSync(abs(artifact.path)))
      if (
        committed.byteLength !== artifact.bytes.byteLength ||
        !committed.every((byte, index) => byte === artifact.bytes[index])
      ) {
        stale.push(artifact.path)
      }
    }

    // A failure here means `pnpm assets:build` and commit, not a threshold to
    // nudge — the encoders are byte-for-byte reproducible.
    expect(stale).toEqual([])
  }, 60_000)
})

describe('credit coverage', () => {
  const plan = planBuild(credits)
  const committed = committedAssets()

  it('accounts for every committed asset', () => {
    expect(checkCoverage(plan, committed)).toEqual([])
  })

  it('fails on an asset nobody credited', () => {
    const problems = checkCoverage(plan, [...committed, 'assets/textures/borrowed.png'])
    expect(problems.join('\n')).toMatch(/borrowed\.png/)
    expect(problems.join('\n')).toMatch(/author, its source URL and its licence/)
  })

  it('fails on a credit entry for an asset that is not there', () => {
    const missing = committed.filter((path) => path !== 'assets/textures/crucible_lightmap.png')
    expect(checkCoverage(plan, missing).join('\n')).toMatch(/claims assets\/textures\/crucible_lightmap\.png/)
  })

  it('covers the vendored transcoders too', () => {
    // They are somebody else's code under somebody else's licence, which is the
    // case where a missing credit is an actual obligation rather than a courtesy.
    expect(plan.outputs.has('packages/client/public/ktx2/msc_basis_transcoder.wasm')).toBe(true)
    expect(plan.outputs.has('packages/client/public/meshopt/meshopt_decoder.js')).toBe(true)
  })
})
