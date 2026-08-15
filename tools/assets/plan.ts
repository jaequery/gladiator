/**
 * What the build does, worked out before it does any of it.
 *
 * The plan is a pure function of the registry: every authored source under
 * `assets/` maps to a known set of shipped artifacts under
 * `packages/client/public/`, by a rule written down here and nowhere else.
 *
 * Two things read it. The build runs the steps. The credits check walks the
 * committed tree and asks, of every file it finds, which entry produced it —
 * and a file no step in the plan produces is a file nobody credited, which is
 * the thing that check exists to catch.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { CreditEntry, Credits, TextureClass } from './registry.ts'

/** The repository root, from this file's own location. */
export const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** Where assets are authored. Blender, Photoshop and Audacity sources are gitignored. */
export const SOURCE_DIR = 'assets'

/** Where the shipped artifacts go: Vite serves this directory at the site root. */
export const PUBLIC_DIR = 'packages/client/public'

/** The generated credits, in both the forms they take. */
export const CREDITS_SOURCE = 'credits.json'
export const CREDITS_MARKDOWN = 'CREDITS.md'
export const CREDITS_PUBLIC = `${PUBLIC_DIR}/credits.json`

/**
 * Committed files under a watched directory that are not assets.
 *
 * Two entries and no pattern, deliberately: a glob here would be the hole every
 * uncredited asset eventually slips through. `credits.json` is the credits, and
 * requiring the credits to credit themselves is a loop with nothing at the end
 * of it; `assets/README.md` is the note telling an author to add an entry.
 */
export const NOT_AN_ASSET: ReadonlySet<string> = new Set([
  CREDITS_PUBLIC,
  `${SOURCE_DIR}/README.md`,
])

export type TextureStep = {
  readonly kind: 'texture'
  readonly entry: CreditEntry
  readonly textureClass: TextureClass
  /** Repo-relative. */
  readonly source: string
  readonly output: string
  /** How a model beside it refers to the compressed form. */
  readonly uri: string
}

export type ModelStep = {
  readonly kind: 'model'
  readonly entry: CreditEntry
  readonly source: string
  /** The `.gltf`. */
  readonly output: string
  /** The buffer that goes beside it, and the URI the `.gltf` names it by. */
  readonly bufferOutput: string
  readonly bufferUri: string
}

export type BuildStep = TextureStep | ModelStep

export type Plan = {
  readonly steps: readonly BuildStep[]
  /** Every artifact the plan produces, and the entry responsible for it. */
  readonly outputs: ReadonlyMap<string, CreditEntry>
  /** Every authored source the registry claims, and its entry. */
  readonly sources: ReadonlyMap<string, CreditEntry>
  /**
   * Source texture basename to the URI and output a model should point at.
   * Keyed by basename because the URI a `.gltf` spells a texture with is
   * whatever the export happened to write, and that is not worth recording.
   */
  readonly textureUris: ReadonlyMap<string, { readonly uri: string; readonly output: string }>
}

/** Absolute path for a repo-relative one. */
export function abs(relative: string): string {
  return join(ROOT, relative)
}

export function basename(path: string): string {
  const cut = path.lastIndexOf('/')
  return cut === -1 ? path : path.slice(cut + 1)
}

function stem(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot === -1 ? name : name.slice(0, dot)
}

/** Where a source texture's compressed form goes. */
export function textureOutputFor(source: string): string {
  return `${PUBLIC_DIR}/textures/${stem(source)}.ktx2`
}

/** Where a source model's shipped form goes. */
export function modelOutputFor(source: string): string {
  return `${PUBLIC_DIR}/models/${stem(source)}.gltf`
}

function fail(message: string): never {
  throw new Error(`gladiator: ${message}`)
}

/**
 * Work out the build.
 *
 * Textures are planned before models because models refer to them: a `.gltf`
 * that names `crate_albedo.png` has to be rewritten to name
 * `../textures/crate_albedo.ktx2`, and that rewrite is only knowable once the
 * texture steps exist.
 */
export function planBuild(credits: Credits): Plan {
  const steps: BuildStep[] = []
  const outputs = new Map<string, CreditEntry>()
  const sources = new Map<string, CreditEntry>()
  const textureUris = new Map<string, { uri: string; output: string }>()

  for (const entry of credits.entries) {
    for (const file of entry.files) {
      sources.set(file, entry)
      // Vendored code is committed where it is served from, so it is its own
      // artifact: credited, with no step that produces it.
      if (entry.kind === 'vendored' && file.startsWith(`${PUBLIC_DIR}/`)) {
        outputs.set(file, entry)
      }
    }
  }

  for (const entry of credits.entries) {
    if (entry.kind !== 'texture') continue
    for (const source of entry.files) {
      if (!source.endsWith('.png')) {
        fail(
          `${source} is a texture entry but not a .png — the pipeline decodes PNG, which is what the documented Blender and Substance export paths both write.`,
        )
      }
      const output = textureOutputFor(source)
      const uri = `../textures/${basename(output)}`
      const collision = textureUris.get(basename(source))
      if (collision !== undefined) {
        fail(
          `two source textures are both called ${basename(source)}; a model refers to a texture by filename, so the names have to be unique across assets/textures/`,
        )
      }
      textureUris.set(basename(source), { uri, output })
      steps.push({
        kind: 'texture',
        entry,
        textureClass: entry.textureClass ?? 'srgb',
        source,
        output,
        uri,
      })
      outputs.set(output, entry)
    }
  }

  for (const entry of credits.entries) {
    if (entry.kind !== 'model') continue
    const models = entry.files.filter((file) => /\.(gltf|glb)$/i.test(file))
    if (models.length === 0) {
      fail(`${entry.id} is a model entry with no .gltf or .glb among its files`)
    }
    for (const source of models) {
      const output = modelOutputFor(source)
      const bufferUri = `${stem(source)}.bin`
      const bufferOutput = `${PUBLIC_DIR}/models/${bufferUri}`
      steps.push({ kind: 'model', entry, source, output, bufferOutput, bufferUri })
      outputs.set(output, entry)
      outputs.set(bufferOutput, entry)
    }
  }

  return { steps, outputs, sources, textureUris }
}
