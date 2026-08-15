# The content pipeline

How an asset gets from a source file to something the game draws, what it is
allowed to cost, and what it is allowed to be licensed as.

Conventions are in [`AGENTS.md`](../AGENTS.md); the renderer's settings are in
[`docs/renderer.md`](./renderer.md). The credits themselves are
[`CREDITS.md`](../CREDITS.md), which is *generated* — the registry is
[`credits.json`](../credits.json).

```
assets/                          pnpm assets:build         packages/client/public/
  models/crate.gltf + .bin  ───────────────────────────►     models/crate.gltf + .bin
  textures/crate_albedo.png ───────────────────────────►     textures/crate_albedo.ktx2
  textures/crate_normal.png ───────────────────────────►     textures/crate_normal.ktx2
credits.json              ───────────────────────────►     credits.json,  ../CREDITS.md
```

Both ends are committed. The sources are, so the artifacts can be reproduced;
the artifacts are, so a build, a Vercel deploy and a fresh clone all work with
no encode step in front of them — the same arrangement, and the same reason, as
`maps/baked/*.json`. `pnpm assets:build --check` re-runs the whole thing in
memory and fails if what is committed is not what these sources produce, which
is what stops the tree holding an artifact nobody can rebuild.

| Command | What it does |
| ------- | ------------ |
| `pnpm assets:build` | compress everything, regenerate the credits, write the artifacts |
| `pnpm assets:build --check` | verify the committed artifacts and the credit coverage, write nothing |
| `pnpm assets:budget` | the size guard: 5 MB per file, 24 MB in total |
| `pnpm assets:vendor` | re-fetch the KTX2 transcoders and the meshopt decoder (only on a Babylon upgrade) |
| `pnpm assets:placeholders` | regenerate the stand-in art under `assets/` |

---

## §1 Exporting from Blender

Export **glTF 2.0**, format **glTF Separate (.gltf + .bin + textures)**.

| Setting | Value | Why |
| ------- | ----- | --- |
| Format | glTF Separate | the pipeline rewrites the texture references, and it can only do that if they are references |
| Include → Selected Objects | on | an export is one prop, not whatever else is in the scene |
| Include → Custom Properties | off | Blender-internal keys travel into the glTF and change its bytes on an unrelated edit |
| Transform → +Y Up | on | glTF's convention. `QUAKE_TO_ENGINE` assumes it; `docs/physics-spec.md` §0.3 |
| Data → Mesh → Apply Modifiers | on | what you see in the viewport is what ships |
| Data → Mesh → UVs, Normals | on | **Tangents off** — Babylon derives them, and a mesh carrying both is bytes for nothing |
| Data → Material → Images | Automatic | keeps the filename, which is how the pipeline matches a texture to its registry entry |
| Data → Material → Materials | Export | |
| Compression (Draco) | **off** | §4 |
| Animation | off unless the asset has one | |

Then move the `.gltf` and `.bin` into `assets/models/`, the `.png` files into
`assets/textures/`, and add an entry per file to `credits.json`. The URI the
`.gltf` uses does not need fixing: the pipeline matches by *filename*, so
wherever Blender wrote the textures relative to the model, the rewrite finds
them. A texture with no registry entry fails the build by name rather than
shipping a model that points at a file nobody deployed.

Keep the `.blend` somewhere backed up. It is gitignored, along with `.psd`,
`.wav` and the rest of the authoring formats — a `.blend` is roughly ten times
the `.gltf` it exports and changes on every save, and committing one puts a
binary nobody can diff into the history of a repository whose whole asset budget
is 24 MB.

---

## §2 Texture classes

What a texture is *for* decides how it is compressed. Four classes, declared per
entry in `credits.json` as `textureClass`, implemented in
`tools/assets/texture.ts`.

| Class | Format | For | Transfer |
| ----- | ------ | --- | -------- |
| `albedo` | UASTC + Zstandard | hero base colour — anything a player's face gets close to | sRGB |
| `normal` | UASTC + Zstandard, normal-map mode | tangent-space normal maps | linear |
| `srgb` | ETC1S | colour a player never inspects: lightmaps, decals, backdrop | sRGB |
| `linear` | ETC1S | masks — roughness, metalness, ambient occlusion, ORM packs | linear |

**UASTC** is a fixed 8 bits per texel that transcodes to ASTC and BC7 without
re-encoding, so on the GPUs that matter it arrives as the format it was designed
against. It is four times ETC1S on disk, which Zstandard takes most of the way
back, and unlike ETC1S it survives the two things that show every artefact: a
normal map, where a wrong texel is a wrong *direction* and the lighting swims;
and a surface seen from two metres.

**ETC1S** is a codebook format — endpoints and selectors shared across the whole
image, then its own LZ. Roughly a quarter of the size, and it looks like a
quarter of the size on anything with fine chroma detail. On a roughness mask or
a lightmap that is low-frequency by construction, the difference is invisible
and the bytes are real.

Two flags are set together, always: `isPerceptual` (weight error the way an eye
does) and the container's sRGB transfer function (sample it back through the
right curve). A texture encoded perceptually and tagged linear is one that gets
brightened twice, and the failure looks like a lighting bug rather than a
texture bug. A normal map is neither, because its channels are a vector.

**Sources must be power-of-two, at least 4x4.** Every block format compresses
4x4 texels at a time; mip chains that halve cleanly are why a distant floor does
not shimmer; and PVRTC — the only compressed format some iOS GPUs expose — is
specified to require it, so a non-power-of-two texture is the one that lands
uncompressed on the device with the least memory to spare.

**A `.ktx2` may be bigger than the `.png` it came from.** That is not a
regression and it is not worth "fixing". PNG is a lossless *transmission*
format that is decoded to 32 bits per texel before it reaches the GPU; a KTX2 is
8 bits per texel *in video memory*, and video memory is the constraint this
pipeline exists for. Compare `.ktx2` against `width x height x 4`, not against
the PNG.

---

## §3 Lightmaps and the second UV set

**A lightmap samples through the second UV set. In Babylon that is `uv2`, and in
glTF it is `TEXCOORD_1`.**

This is the ticket's flagged open item, and it is worth the space because
getting it wrong costs a day. A lightmap is baked into its own unwrap: the first
UV set tiles a material across a surface, the second gives every triangle a
unique, non-overlapping patch of one atlas. They are different unwraps of the
same mesh. Sample the lightmap through the first one and you get a level lit
from an atlas cell belonging to another wall — or, where the tiling UVs run past
`[0,1]` into the atlas gutter, a level that is simply **black**. It looks like a
broken bake, so that is where the day goes.

The chain, and where each link is checked:

| Link | Rule | Verified by |
| ---- | ---- | ----------- |
| Blender | UV maps export in the order of the object's UV Maps list; the **second** becomes `TEXCOORD_1`. Names are not carried — only the order | §1's exporter settings |
| glTF loader | `TEXCOORD_1` → `VertexBuffer.UV2Kind`, whose value is the string `"uv2"` | `render/lightmap.test.ts`, against a `.glb` it builds and the real loader under a real `Scene` |
| Material | `lightmapTexture` samples the set named by `coordinatesIndex`; `1` means `uv2`, and the **default is `0`** | the same test |

So: name the UV maps whatever you like, but the lightmap unwrap goes in the
**second slot**, and nothing assigns `lightmapTexture` except
`applyLightmap` in `packages/client/src/render/lightmap.ts`, which sets
`coordinatesIndex` with it and refuses a mesh that has no `uv2` rather than
drawing something plausible.

glTF 2.0 has no lightmap slot — `occlusionTexture` is ambient occlusion, a
different quantity — so the bake ships as its own `.ktx2` and is attached by
name at load. That is a choice with a payoff: the lightmap belongs to the
*level*, and a prop used in two arenas gets the right one in each without being
exported twice.

---

## §4 Mesh compression: meshopt, not Draco

Draco compresses geometry harder. It is the wrong trade here, for three reasons
that point the same way:

- **Decode cost.** Draco rebuilds mesh connectivity from an entropy-coded
  edgebreaker stream: tens of milliseconds for a prop, on the main thread, at
  the moment a round starts. meshopt's decoder is a byte-oriented delta filter —
  a few hundred microseconds, memory-bandwidth bound, decoding straight into the
  vertex buffer.
- **Decoder size.** Draco's WASM decoder is a few hundred kilobytes every player
  downloads before the first frame. meshopt's is a few kilobytes.
- **What we would win.** An arena's props are a few thousand triangles. The
  difference between the two over the whole game is tens of kilobytes — noise
  beside the Babylon bundle, and paid for with a stall that is not noise.

Draco is right for a scanned asset with a million triangles that loads once
behind a spinner. A duel has neither property.

The output is `.gltf` + `.bin` with `EXT_meshopt_compression` and
`KHR_texture_basisu`, both declared **required**: a viewer that cannot decode
either would draw an untextured or an empty model, and a loud failure beats a
silently wrong picture.

Textures stay *outside* the model, referenced as `../textures/*.ktx2`, rather
than embedded in a single `.glb`. The same wall texture belongs to several
props and should be fetched and cached once — and the arena's own surfaces are
cut from the collision brushes by `map/geometry.ts` and never come through a
glTF at all, so the renderer needs standalone `.ktx2` files whatever the models
do.

One thing deliberately not done: vertex-cache reordering before the meshopt
encode. It wants `@gltf-transform/functions`, which depends on `sharp` — a
native module, and this repository's build tooling is pure JavaScript and WASM
so that installing it never needs a compiler. The compression win without it is
already about half, and the reordering win on a few-thousand-triangle prop is
not worth a native dependency.

---

## §5 The transcoders are ours to serve

A `.ktx2` is not a GPU format. It is transcoded in the browser into whichever
compressed format the GPU actually supports, by a decoder module and a set of
WASM transcoders that Babylon fetches **from `cdn.babylonjs.com`, on an
unversioned path, by default**. That is three problems: a duel that cannot
decode its textures because someone else's CDN is having an afternoon; a
transcoder that changes under a deployed client; and a page load that tells a
third party someone loaded the page.

`pnpm assets:vendor` fetches them once from a *versioned* path, checks each
against a recorded SHA-256, and writes them to `packages/client/public/ktx2/`
and `packages/client/public/meshopt/`. `render/ktx2.ts` points Babylon's
`URLConfig` at those copies, and the vendoring script refuses to finish if that
file does not name every one of them. Re-run it only on a Babylon upgrade —
it will print the new hashes and write nothing until they are recorded in
`tools/assets-vendor.ts`, in the same reviewed commit as the version bump.

### The setting that is the reason this pipeline exists

Babylon picks a transcode target from a decision tree over the engine's
capabilities, and **`useRGBAIfOnlyBC1BC3AvailableWhenUASTC` defaults to `true`**.
On a GPU that exposes S3TC but neither BC7 nor ASTC — every pre-Skylake Intel
part, and a great deal of what is still in laptops — that decodes a UASTC
texture to *uncompressed RGBA32*, because transcoding UASTC to BC3 goes via
uncompressed and Babylon would rather spend the memory than the milliseconds.

On the machines this game exists to run well on, that is backwards. A 1024x1024
albedo is 1 MB as BC3 and 4 MB as RGBA32; an integrated GPU shares its memory
with the operating system, and when the working set stops fitting the cost is
not a slower frame, it is the driver evicting and re-uploading a texture in the
middle of a duel. `configureKtx2` turns it off, along with the same trade one
branch earlier.

`render/ktx2.test.ts` drives Babylon's own `TranscodeDecisionTree` over every
combination of capabilities a browser can report and asserts that a compressed
source never lands uncompressed — and asserts that with the defaults it would
have. It also records the two capability sets the engine's ETC1S tree cannot
serve (ASTC without ETC2, and ETC1 with alpha), neither of which describes a
WebGL2-or-better context, so that the exclusion cannot outlive its reason.

---

## §6 Licensing

Three rules, all enforced by `pnpm assets:build` rather than by memory.
`tools/assets/registry.test.ts` watches each of them reject something.

**Content is CC0 or it does not ship.** Not CC-BY with attribution: an
attribution obligation is one you have to keep honouring, in a notice file that
has to stay correct, forever. CC0 is a public-domain dedication, so the credits
in this repository are courtesy rather than compliance — which is the only
reason they can be generated by a script.

**OpenGameArt and Freesound are mixed-licence.** A link to either proves
nothing; the per-item licence does, and it has to say CC0. Both hosts are named
in the validator so the error explains itself.

**Mixamo is a trap.** Its licence permits *using* the animations and forbids
redistributing the raw asset files — which is exactly what committing one to a
public repository does. Sourced-from-Mixamo is rejected by hostname, with the
reason in the message.

Vendored *code* is the one exception, and it is a different thing: someone
else's work under a permissive licence, whose notice ships beside it
(`public/ktx2/LICENSE`, `public/meshopt/LICENSE`). Apache-2.0, MIT and
BSD-3-Clause are allowed there and nowhere else.

Every committed file under `assets/` and `packages/client/public/` must be
covered by an entry, and every entry must name a file that is committed. Both
directions fail the build: the first stops an uncredited asset shipping, the
second stops the registry rotting into a list of things that used to exist.

---

## §7 The size budget

`pnpm assets:budget`, over `git ls-files` — the question is what this repository
*ships*, and a scratch file in a working tree is not that.

| Limit | Value | Catches |
| ----- | ----- | ------- |
| Per file | 5 MB | an uncompressed 4K PNG or a raw `.wav`: a source that should have been gitignored, or an asset that never went through `pnpm assets:build` |
| In total | 24 MB | the one nobody notices — fifty files of 900 KB, each individually reasonable |

It warns at 75% so the ceiling is never the first anyone hears of it.

Git has no forget. A 40 MB texture committed once and deleted in the next commit
is 40 MB in every clone forever, and the only fix is a history rewrite that
invalidates every fork and every open branch. That is why this runs on the pull
request, where a "no" still costs nothing.

Both this and the credit coverage reach CI through the **`Test`** step —
`tools/assets-budget.test.ts` runs `judge` over the real `git ls-files`, and
`tools/assets-build.test.ts` re-encodes every artifact and re-checks every
credit — so a pull request that commits an oversized or uncredited asset goes
red today with no workflow change. Named steps beside it would read better in a
build log, and are worth adding the next time `.github/workflows/ci.yml` is
touched:

```yaml
      - name: Asset budget
        run: pnpm run assets:budget

      - name: Assets are current and credited
        run: pnpm run assets:build --check
```

The same trade `docs/renderer.md` §2 records for the lockfile check: the gate
holds either way, and `pnpm run ci` runs it directly.

If the budget is genuinely too small, raise it once, in a commit that says what
went in. **If it ever approaches 50 MB, do not raise it again** — move the baked
assets into a release tarball a script fetches. Not Git LFS: LFS bandwidth is
metered per repository and charged to whoever owns it, so a public repo that
gets popular is one whose clones start failing for everybody at once.

---

## §8 The placeholders

`assets/` currently holds art generated by `pnpm assets:placeholders` — a fixed
lattice, a fixed hash, no clock and no `Math.random`, so re-running it produces
byte-identical sources and the committed artifacts do not churn.

That is not only a convenience. An asset a program in this repository wrote is
an asset whose provenance is not a claim: it is CC0 because there is nothing in
it that came from anywhere else, and anyone can check by reading
`tools/assets-placeholders.ts`.

The crate carries a second UV set specifically so the lightmap convention in §3
has something to travel through. When real art arrives, drop the export into
`assets/`, add its entries, and nothing downstream changes — the placeholders
stop being regenerated and the generator stops being run.
