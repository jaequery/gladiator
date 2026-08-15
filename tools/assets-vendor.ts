/**
 * `pnpm assets:vendor` — put the KTX2 transcoders and the meshopt decoder in
 * `packages/client/public/`, so the game serves them from its own origin.
 *
 * Babylon's defaults point at `cdn.babylonjs.com`, and every one of those
 * defaults is a request a player's browser makes to a host this project does
 * not run. That is three separate problems and only one of them is taste:
 *
 *   - **Availability.** A duel that cannot decode its textures because someone
 *     else's CDN is having an afternoon is a duel that does not happen.
 *   - **Version skew.** The unversioned CDN path is "latest". A transcoder that
 *     changes under a deployed client is a bug nobody can reproduce, because
 *     the artifact that produced it no longer exists.
 *   - **Privacy.** Loading a page should not tell a third party that someone
 *     loaded it.
 *
 * So the files are fetched once, from a *versioned* path, checked against a
 * recorded SHA-256, and committed. The hashes are the point: they are what makes
 * "we vendored Babylon 9.21.1's transcoders" a fact a reviewer can check rather
 * than a sentence in a commit message.
 *
 * Re-run it when `@babylonjs/core` moves. It will tell you what the new hashes
 * are and refuse to write anything until they are recorded here.
 */

import { createHash } from 'node:crypto'
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { abs } from './assets/plan.ts'

/**
 * The Babylon release the transcoders come from.
 *
 * It has to match `@babylonjs/core` in `packages/client/package.json`: the
 * decoder module and the engine that drives it are two halves of one API, and
 * the CDN's unversioned path would silently give us halves from different
 * releases.
 */
const BABYLON_VERSION = '9.21.1'

const CDN = `https://cdn.babylonjs.com/v${BABYLON_VERSION}`

/** Where the transcoders are served from, relative to the site root. */
export const KTX2_PUBLIC_DIR = 'packages/client/public/ktx2'
export const MESHOPT_PUBLIC_DIR = 'packages/client/public/meshopt'

/** The client's half of the arrangement: the URL table Babylon is pointed at. */
const CLIENT_CONFIG = 'packages/client/src/render/ktx2.ts'

/** Remote path, local filename, and the SHA-256 the download has to have. */
const DOWNLOADS: ReadonlyArray<readonly [remote: string, local: string, sha256: string]> = [
  [
    'babylon.ktx2Decoder.js',
    'babylon.ktx2Decoder.js',
    '358791e176106216a6c1682ce5211ea09ed66b5cb5c4e79f4ae3b66ea26d9f39',
  ],
  [
    'ktx2Transcoders/1/uastc_astc.wasm',
    'uastc_astc.wasm',
    '6846c972b4a52d938866f43896fd2b2450052da807cdd1285e898be80614d612',
  ],
  [
    'ktx2Transcoders/1/uastc_bc7.wasm',
    'uastc_bc7.wasm',
    'be442ab8c0cbf734ded98e6ad38112aaba23c83bfeecac4213ded54631fc4eef',
  ],
  [
    'ktx2Transcoders/1/uastc_rgba8_unorm_v2.wasm',
    'uastc_rgba8_unorm_v2.wasm',
    'b7470b26a847994cdeb9226eeba1e3711688e378ee438b7dd941e83cb598b694',
  ],
  [
    'ktx2Transcoders/1/uastc_rgba8_srgb_v2.wasm',
    'uastc_rgba8_srgb_v2.wasm',
    '1f4d2e8bfef4e31679b23d473e1c410c29f7e485a739e76c5b357628f4190874',
  ],
  [
    'ktx2Transcoders/1/uastc_r8_unorm.wasm',
    'uastc_r8_unorm.wasm',
    '0467c98b150a630e5a51f7810843e8b7fd9aad22e3888baf70aad255c55d02bc',
  ],
  [
    'ktx2Transcoders/1/uastc_rg8_unorm.wasm',
    'uastc_rg8_unorm.wasm',
    'fb45a2c103c59cec21c3708a6534d43cd4381669f66d3292dd8a6e4e1956d773',
  ],
  [
    'ktx2Transcoders/1/msc_basis_transcoder.js',
    'msc_basis_transcoder.js',
    'b8906bae7e55606aba070642eb3bce790a2b5aea774874e120e9fd41f7c7d60b',
  ],
  [
    'ktx2Transcoders/1/msc_basis_transcoder.wasm',
    'msc_basis_transcoder.wasm',
    '29becbf0eef2ce9f6d72109ad217704ec3799c432da0c26e3893b793ecab6bdc',
  ],
  ['zstddec.wasm', 'zstddec.wasm', '67d12d34f82ef700ec3a3795a77590252858c70330908a87ed1e73efc268cb4b'],
]

/**
 * Copied out of `node_modules` rather than downloaded: Babylon already ships
 * the meshopt decoder and both licence texts.
 *
 * The path goes through `packages/client/node_modules` because it has to:
 * `pnpm-workspace.yaml` hoists nothing, so `@babylonjs/core` exists only under
 * the package that declares it. That is the same rule that stops `packages/sim`
 * from importing Babylon, and it applies to build tooling as well.
 */
const BABYLON = 'packages/client/node_modules/@babylonjs/core'

const COPIES: ReadonlyArray<readonly [from: string, to: string]> = [
  [`${BABYLON}/assets/meshopt/meshopt_decoder.js`, `${MESHOPT_PUBLIC_DIR}/meshopt_decoder.js`],
  [`${BABYLON}/assets/meshopt/meshopt.license`, `${MESHOPT_PUBLIC_DIR}/LICENSE`],
  [`${BABYLON}/license.md`, `${KTX2_PUBLIC_DIR}/LICENSE`],
]

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function main(): Promise<number> {
  mkdirSync(abs(KTX2_PUBLIC_DIR), { recursive: true })
  mkdirSync(abs(MESHOPT_PUBLIC_DIR), { recursive: true })

  const mismatches: string[] = []
  const pending: Array<{ path: string; bytes: Uint8Array }> = []

  for (const [remote, local, expected] of DOWNLOADS) {
    const url = `${CDN}/${remote}`
    const response = await fetch(url)
    if (!response.ok) {
      process.stderr.write(`gladiator: ${url} answered ${response.status}\n`)
      return 1
    }
    const bytes = new Uint8Array(await response.arrayBuffer())
    const actual = sha256(bytes)
    if (actual !== expected) {
      mismatches.push(`  ${remote}\n    recorded ${expected}\n    fetched  ${actual}`)
      continue
    }
    pending.push({ path: `${KTX2_PUBLIC_DIR}/${local}`, bytes })
    process.stdout.write(`  ${local.padEnd(30)} ${bytes.byteLength} B\n`)
  }

  if (mismatches.length > 0) {
    process.stderr.write(
      `\ngladiator: ${mismatches.length} file(s) do not match the recorded hashes.\n\n${mismatches.join('\n')}\n\n` +
        `If this is a deliberate Babylon upgrade, update BABYLON_VERSION and the hashes in tools/assets-vendor.ts together, in one reviewed commit.\n`,
    )
    return 1
  }

  for (const { path, bytes } of pending) writeFileSync(abs(path), bytes)

  for (const [from, to] of COPIES) {
    copyFileSync(abs(from), abs(to))
    process.stdout.write(`  ${to.split('/').pop()?.padEnd(30) ?? ''} copied from node_modules\n`)
  }

  // Babylon reaches every one of these by URL, and a URL it cannot resolve
  // falls back to the CDN — silently, and only on the machine that needed the
  // transcoder we forgot. So the client's URL table has to name each file, and
  // that is checked here rather than left to a 404 in someone's browser.
  const config = readFileSync(abs(CLIENT_CONFIG), 'utf8')
  const unreferenced = [
    ...DOWNLOADS.map(([, local]) => local),
    'meshopt_decoder.js',
  ].filter((file) => !config.includes(file))

  if (unreferenced.length > 0) {
    process.stderr.write(
      `\ngladiator: ${CLIENT_CONFIG} does not name ${unreferenced.join(', ')}, so Babylon would fetch ${unreferenced.length === 1 ? 'it' : 'them'} from cdn.babylonjs.com instead.\n`,
    )
    return 1
  }

  process.stdout.write(`\nVendored Babylon ${BABYLON_VERSION} transcoders and the meshopt decoder.\n`)
  return 0
}

process.exitCode = await main()
