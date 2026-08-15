/**
 * The build itself: sources on disk in, artifacts in memory out.
 *
 * Nothing here writes. `tools/assets-build.ts` decides whether to put the
 * artifacts on disk or compare them with what is committed, and that split is
 * what makes `--check` meaningful: the check runs the *same* code the write
 * does, so an artifact that passes it is one this pipeline can reproduce.
 *
 * The encoders are byte-for-byte reproducible — the same PNG and the same class
 * give the same `.ktx2` — which is the property the whole arrangement rests on.
 */

import { readFileSync } from 'node:fs'
import { posix } from 'node:path'

import { encodeTexture } from './texture.ts'
import { readModel, retargetTextures, writeModel } from './model.ts'
import {
  CREDITS_MARKDOWN,
  CREDITS_PUBLIC,
  NOT_AN_ASSET,
  PUBLIC_DIR,
  SOURCE_DIR,
  abs,
  basename,
  planBuild,
} from './plan.ts'
import type { Plan } from './plan.ts'
import type { Credits } from './registry.ts'
import { renderCreditsMarkdown, renderPublicCredits } from './registry.ts'

export type Artifact = {
  /** Repo-relative POSIX path. */
  readonly path: string
  readonly bytes: Uint8Array
  /** What produced it, for the build log. */
  readonly note: string
}

const encoder = new TextEncoder()

function textArtifact(path: string, text: string, note: string): Artifact {
  return { path, bytes: encoder.encode(text), note }
}

/**
 * Every resource a source glTF names, read from beside it.
 *
 * A data URI is already inline and a fallback buffer has no URI at all, so
 * neither is looked for on disk.
 */
function collectResources(source: string, json: unknown): Map<string, Uint8Array> {
  const resources = new Map<string, Uint8Array>()
  const root = posix.dirname(source)
  const document = json as { buffers?: unknown; images?: unknown }

  for (const list of [document.buffers, document.images]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const uri: unknown = (item as { uri?: unknown }).uri
      if (typeof uri !== 'string' || uri.startsWith('data:')) continue
      if (resources.has(uri)) continue
      resources.set(uri, new Uint8Array(readFileSync(abs(posix.normalize(posix.join(root, uri))))))
    }
  }

  return resources
}

/**
 * Run the plan.
 *
 * Textures first, and their bytes are kept: the model step needs the compressed
 * form to write into the glTF, and encoding the same PNG twice would be both
 * slower and one more place for the two copies to differ.
 */
export async function buildArtifacts(
  credits: Credits,
  onProgress: (message: string) => void = () => {},
): Promise<{ readonly plan: Plan; readonly artifacts: Artifact[] }> {
  const plan = planBuild(credits)
  const artifacts: Artifact[] = []
  /** Keyed by source filename: how `retargetTextures` finds a replacement. */
  const encoded = new Map<string, { uri: string; bytes: Uint8Array }>()
  /** Keyed by the URI the rewritten glTF uses, for the round-trip check below. */
  const byUri = new Map<string, Uint8Array>()

  for (const step of plan.steps) {
    if (step.kind !== 'texture') continue
    const png = new Uint8Array(readFileSync(abs(step.source)))
    const ktx2 = await encodeTexture(png, step.textureClass)
    encoded.set(basename(step.source), { uri: step.uri, bytes: ktx2 })
    byUri.set(step.uri, ktx2)
    artifacts.push({
      path: step.output,
      bytes: ktx2,
      note: `${step.textureClass}, ${png.byteLength} B png -> ${ktx2.byteLength} B ktx2`,
    })
    onProgress(`  texture ${step.source} -> ${step.output} (${step.textureClass})`)
  }

  for (const step of plan.steps) {
    if (step.kind !== 'model') continue
    const gltf = new Uint8Array(readFileSync(abs(step.source)))
    const json: unknown = JSON.parse(new TextDecoder().decode(gltf))
    const document = await readModel(gltf, collectResources(step.source, json))
    retargetTextures(document, encoded)
    const written = await writeModel(document, step.bufferUri)

    artifacts.push(textArtifact(step.output, written.gltf, 'meshopt + KHR_texture_basisu'))
    for (const [uri, bytes] of written.buffers) {
      if (uri !== step.bufferUri) {
        throw new Error(
          `gladiator: ${step.source} produced an unexpected companion resource ${JSON.stringify(uri)} — the pipeline writes exactly one buffer beside a model.`,
        )
      }
      artifacts.push({ path: step.bufferOutput, bytes, note: 'meshopt-encoded vertex data' })
    }
    // The textures the writer emitted are the bytes the texture step already
    // produced. Dropping them here rather than writing them twice is what keeps
    // one texture one file, however many models point at it — and comparing
    // them first is what makes "the same bytes" a check rather than a belief.
    for (const [uri, bytes] of written.textures) {
      const owner = byUri.get(uri)
      if (owner === undefined || !equalBytes(owner, bytes)) {
        throw new Error(
          `gladiator: ${step.source} emitted a texture at ${uri} that is not the one the texture step encoded.`,
        )
      }
    }
    onProgress(`  model   ${step.source} -> ${step.output}`)
  }

  artifacts.push(
    textArtifact(CREDITS_MARKDOWN, renderCreditsMarkdown(credits), 'generated from credits.json'),
    textArtifact(CREDITS_PUBLIC, renderPublicCredits(credits), 'generated from credits.json'),
  )

  return { plan, artifacts }
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false
  return true
}

/* --------------------------------------------------------------------------
 * Coverage — the check that makes `CREDITS.md` mean something
 * ----------------------------------------------------------------------- */

/**
 * Which committed files have to be accounted for.
 *
 * `git ls-files` rather than a directory walk, deliberately: the question is
 * what this repository *ships*, and an uncommitted file in a working tree is
 * not that. It is also what makes the answer the same on a contributor's
 * machine and on a CI runner with a clean checkout.
 */
export function watchedDirectories(): readonly string[] {
  return [SOURCE_DIR, PUBLIC_DIR]
}

/** Committed asset files with no credit entry, and unbuilt outputs with one. */
export function checkCoverage(plan: Plan, committed: readonly string[]): string[] {
  const problems: string[] = []

  for (const file of committed) {
    if (NOT_AN_ASSET.has(file)) continue
    if (plan.sources.has(file) || plan.outputs.has(file)) continue
    problems.push(
      `${file} is committed under ${file.startsWith(SOURCE_DIR) ? SOURCE_DIR : PUBLIC_DIR} and no entry in credits.json accounts for it — every asset this repository ships names its author, its source URL and its licence`,
    )
  }

  const present = new Set(committed)
  for (const source of plan.sources.keys()) {
    if (!source.startsWith(`${SOURCE_DIR}/`)) continue
    if (!present.has(source)) {
      problems.push(`credits.json claims ${source}, which is not committed`)
    }
  }

  return problems
}
