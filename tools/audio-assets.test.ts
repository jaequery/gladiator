/**
 * The committed sounds: reproducible, small, and accounted for in `CREDITS.md`.
 *
 * Three properties, and each one is a thing that goes wrong quietly:
 *
 *   1. **Reproducible.** The WAVs in the tree are what `tools/synth-audio.ts`
 *      makes today. A binary nobody can regenerate is a binary nobody can
 *      change; this is the same guarantee `bake-map.test.ts` gives the maps.
 *   2. **Small.** Audio is the easiest thing in a game to let grow. The budget
 *      is asserted so that doubling it is a decision somebody made rather than
 *      a file somebody added.
 *   3. **Licensed.** Every file has a row in `CREDITS.md` naming its source and
 *      its licence. Gladiator will be a public repository, and "where did that
 *      sound come from" has to have an answer that is not archaeology.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { AUDIO_DIR, RECIPES, SAMPLE_RATE, countDiffering, synthesiseAll } from './synth-audio.ts'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CREDITS = join(ROOT, 'CREDITS.md')

/**
 * The whole sound set, in bytes.
 *
 * 320 KiB against 241 KiB committed. The headroom is deliberate — a couple more
 * sounds fit without a conversation — and the ceiling is deliberate too: this is
 * downloaded before a stranger's first duel, on whatever connection they have.
 */
const BUDGET_BYTES = 320 * 1024

const files = readdirSync(AUDIO_DIR).sort()

describe('the committed WAVs', () => {
  it('are exactly what the synthesiser makes today', () => {
    const rendered = synthesiseAll()
    for (const [file, bytes] of rendered) {
      const committed = new Uint8Array(readFileSync(join(AUDIO_DIR, file)))
      expect(committed.length, `${file} is a different length`).toBe(bytes.length)
      expect(countDiffering(committed, bytes), `${file} is stale — run: pnpm audio:bake`).toBe(0)
    }
  })

  it('are the only files in the directory', () => {
    expect(files).toEqual(RECIPES.map((recipe) => recipe.file).sort())
  })

  it('are mono 16-bit PCM at the rate the synthesiser declares', () => {
    for (const file of files) {
      const wav = readFileSync(join(AUDIO_DIR, file))
      expect(wav.toString('ascii', 0, 4)).toBe('RIFF')
      expect(wav.toString('ascii', 8, 12)).toBe('WAVE')
      expect(wav.readUInt16LE(20), `${file} is not PCM`).toBe(1)
      expect(wav.readUInt16LE(22), `${file} is not mono`).toBe(1)
      expect(wav.readUInt32LE(24), `${file} is at the wrong rate`).toBe(SAMPLE_RATE)
      expect(wav.readUInt16LE(34), `${file} is not 16-bit`).toBe(16)
    }
  })

  it('fit the asset budget', () => {
    const total = files.reduce((sum, file) => sum + statSync(join(AUDIO_DIR, file)).size, 0)
    expect(total, `${(total / 1024).toFixed(1)} KiB of audio`).toBeLessThanOrEqual(BUDGET_BYTES)
  })

  it('are none of them silent or empty', () => {
    for (const file of files) {
      const wav = readFileSync(join(AUDIO_DIR, file))
      const samples = (wav.length - 44) / 2
      expect(samples, `${file} has no audio in it`).toBeGreaterThan(1000)
      let peak = 0
      for (let i = 0; i < samples; i += 1) {
        peak = Math.max(peak, Math.abs(wav.readInt16LE(44 + i * 2)))
      }
      // Half of full scale. Everything here is a game sound: short, dry, loud.
      expect(peak / 32767, `${file} is too quiet to hear`).toBeGreaterThan(0.5)
    }
  })
})

describe('CREDITS.md', () => {
  const credits = readFileSync(CREDITS, 'utf8')

  it('has a row for every committed sound, with a source and a licence', () => {
    for (const file of files) {
      // The row names the file by its repo-relative path, because GLAD-PGS73O
      // generates this table from `credits.json` and the same table now carries
      // models, textures and vendored code, which do not share a directory.
      // Everything else this test asks of a row is unchanged — and the entry
      // that produces it is separately required to exist by
      // `pnpm assets:build --check`, which fails on any committed asset the
      // registry does not account for.
      const row = credits
        .split('\n')
        .find((line) => line.startsWith('|') && line.includes(file))
      expect(row, `${file} is not in CREDITS.md`).toBeDefined()
      // A source anyone can follow, and a licence with a URL behind it.
      expect(row ?? '', `${file}'s row does not name where it came from`).toMatch(
        /tools\/synth-audio\.ts|https?:\/\//,
      )
      expect(row ?? '', `${file}'s row does not name a licence`).toMatch(
        /CC0|CC-BY|public domain/i,
      )
      expect(row ?? '', `${file}'s licence has no URL`).toMatch(/https?:\/\/\S+/)
    }
  })

  it('names the trap it exists to stop somebody walking into', () => {
    expect(credits).toMatch(/Mixamo/)
  })
})
