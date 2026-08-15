/**
 * glTF in, glTF out — with the textures swapped for their compressed form and
 * the vertex data run through meshopt.
 *
 * ### Why meshopt and not Draco
 *
 * Draco compresses geometry harder. It is also the wrong trade for this game,
 * for three reasons that all point the same way:
 *
 *   - **Decode cost.** Draco's decoder rebuilds the mesh connectivity from an
 *     entropy-coded edgebreaker stream: tens of milliseconds for a prop, on the
 *     main thread, at the moment a round is starting. meshopt's decoder is a
 *     byte-oriented delta filter — a few hundred microseconds, memory-bandwidth
 *     bound, and it decodes straight into the vertex buffer.
 *   - **Decoder size.** Draco's WASM decoder is a few hundred kilobytes that
 *     every player downloads before the first frame. meshopt's is a few
 *     kilobytes.
 *   - **What we would win.** An arena's props are a few thousand triangles.
 *     The difference between the two on that is tens of kilobytes over the
 *     whole game — noise beside the Babylon bundle, and paid for with a stall
 *     that is not noise.
 *
 * Draco is the right answer for a scanned asset with a million triangles that
 * loads once behind a spinner. A duel has neither of those properties.
 *
 * ### Why the textures stay outside the model
 *
 * The output is `.gltf` + `.bin` with `../textures/*.ktx2` beside it, rather
 * than one self-contained `.glb`. Two reasons: the same wall texture belongs to
 * several props and should be fetched and cached once; and the arena's own
 * surfaces are cut from the collision brushes by `map/geometry.ts` and never
 * come through a glTF at all, so the renderer needs standalone `.ktx2` files
 * whatever the models do.
 */

import { Document, NodeIO, Format } from '@gltf-transform/core'
import type { JSONDocument } from '@gltf-transform/core'
import {
  ALL_EXTENSIONS,
  EXTMeshoptCompression,
  KHRTextureBasisu,
} from '@gltf-transform/extensions'
import { MeshoptEncoder } from 'meshoptimizer'

/** The bytes of one written asset, keyed by the URI the glTF refers to it by. */
export type ModelOutput = {
  /** The `.gltf` JSON, formatted and newline-terminated. */
  readonly gltf: string
  /** Companion resources, keyed by URI. Buffers only — textures are dropped. */
  readonly buffers: ReadonlyMap<string, Uint8Array>
  /** Every texture the model referred to, keyed by the URI it now refers to it by. */
  readonly textures: ReadonlyMap<string, Uint8Array>
}

const KTX2_MIME = 'image/ktx2'

function basename(uri: string): string {
  const withoutQuery = uri.split(/[?#]/)[0] ?? uri
  const cut = withoutQuery.lastIndexOf('/')
  return cut === -1 ? withoutQuery : withoutQuery.slice(cut + 1)
}

function io(): NodeIO {
  return new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder })
}

/**
 * Read a source glTF and everything it points at.
 *
 * `resources` carries the companion files by the URI the glTF spells them with
 * — the `.bin` from a "glTF Separate" export, and any texture that came along
 * with it. The caller supplies them because the pipeline reads the filesystem
 * in one place and this function does not read it at all.
 */
export async function readModel(
  gltf: Uint8Array,
  resources: ReadonlyMap<string, Uint8Array>,
): Promise<Document> {
  const json: unknown = JSON.parse(new TextDecoder().decode(gltf))
  // Copied into fresh views: glTF-Transform's `JSONDocument` wants buffers it
  // knows are not shared, and a build tool can afford the copy.
  const owned: Record<string, Uint8Array<ArrayBuffer>> = {}
  for (const [uri, bytes] of resources) owned[uri] = new Uint8Array(bytes)

  const jsonDoc: JSONDocument = { json: json as JSONDocument['json'], resources: owned }
  return await io().readJSON(jsonDoc)
}

/**
 * Point every texture at its compressed form.
 *
 * Matching is by *basename*: a Blender "glTF Separate" export writes the
 * textures beside the `.gltf` and spells the URI however the blend file
 * happened to, and neither of those is a fact worth encoding in the registry.
 * A texture the registry does not carry is an error rather than a passthrough,
 * because the alternative is shipping a model that points at a `.png` nobody
 * put in `public/`.
 */
export function retargetTextures(
  document: Document,
  encoded: ReadonlyMap<string, { readonly uri: string; readonly bytes: Uint8Array }>,
): void {
  for (const texture of document.getRoot().listTextures()) {
    const uri = texture.getURI()
    const key = uri === '' ? `${texture.getName()}.png` : basename(uri)
    const replacement = encoded.get(key)
    if (replacement === undefined) {
      throw new Error(
        `gladiator: the model refers to a texture named ${JSON.stringify(key)}, which credits.json does not carry. Add a texture entry for it, or export the model with "Images: Automatic" so the texture keeps the filename it has in assets/textures/.`,
      )
    }
    texture.setMimeType(KTX2_MIME).setImage(replacement.bytes).setURI(replacement.uri)
  }
}

/**
 * Compress and serialise.
 *
 * `KHR_texture_basisu` and `EXT_meshopt_compression` are both declared
 * *required*, not merely used. A viewer that cannot decode either would draw an
 * untextured or an empty model, and a loud failure beats a silently wrong
 * picture — Babylon supports both, which is the only client this ships to.
 */
export async function writeModel(document: Document, bufferUri: string): Promise<ModelOutput> {
  const buffers = document.getRoot().listBuffers()
  const first = buffers[0]
  if (first === undefined) throw new Error('gladiator: the model has no buffer')
  if (buffers.length > 1) {
    // Two buffers would want two files, and the plan allocates one name. Rather
    // than write both to it and keep whichever landed last, say so: a Blender
    // export produces exactly one, so this means the source is not one.
    throw new Error(
      `gladiator: the model has ${buffers.length} buffers; the pipeline ships one .bin beside a .gltf.`,
    )
  }
  first.setURI(bufferUri)

  document.createExtension(KHRTextureBasisu).setRequired(true)

  await MeshoptEncoder.ready
  document
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE })

  const written = await io().writeJSON(document, { format: Format.GLTF })

  const bufferOut = new Map<string, Uint8Array>()
  const textureOut = new Map<string, Uint8Array>()
  for (const [uri, bytes] of Object.entries(written.resources)) {
    if (uri.endsWith('.ktx2')) textureOut.set(uri, bytes)
    else bufferOut.set(uri, bytes)
  }

  return {
    gltf: `${JSON.stringify(written.json, null, 2)}\n`,
    buffers: bufferOut,
    textures: textureOut,
  }
}
