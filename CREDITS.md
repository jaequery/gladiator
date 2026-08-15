# CREDITS

Every asset that ships in Gladiator, where it came from, and under what licence.

One row per file, and the rule is that the row exists **before** the file does.
`tools/audio-assets.test.ts` fails the build if anything in
`packages/client/public/audio/` is missing from the table below, so this is a
gate rather than a good intention.

> **Mixamo, and things like it, are a trap.** Free with an account is not the
> same as redistributable: Mixamo's licence permits *use* of its animations and
> characters and does not permit redistributing the raw asset files, so
> committing one to a public repository is a violation however the game uses it.
> The same applies to most "free" sample packs whose licence is a sentence on a
> download page. If the licence cannot be quoted in this file, the asset cannot
> be in this repository.

Sections are per asset class so they can be edited independently — models,
textures and fonts belong to GLAD-PGS73O and get their own headings here.

---

## Audio

**Every sound in the game is synthesised by
[`tools/synth-audio.ts`](./tools/synth-audio.ts).** Nothing was downloaded, so
there is no third-party licence to honour and no provenance to take on trust:
the source of each file is a recipe in that program, which anyone can read, and
`pnpm audio:bake --check` reproduces the committed bytes exactly.

They are original works of this repository, released under
[CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) — the public
domain dedication, so anyone may reuse them for anything without attribution.

Format: 22 050 Hz, mono, 16-bit PCM WAV. 241 KiB for the set.

| File | What it is | Source | Licence |
| ---- | ---------- | ------ | ------- |
| `rocket-fire.wav` | Rocket launcher firing | `tools/synth-audio.ts` → `rocketFire()` — original work, this repository | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `rail-fire.wav` | Railgun firing | `tools/synth-audio.ts` → `railFire()` — original work, this repository | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `explosion.wav` | Rocket detonating | `tools/synth-audio.ts` → `explosion()` — original work, this repository | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `footstep-a.wav` | Footstep, first of two | `tools/synth-audio.ts` → `footstep()` — original work, this repository | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `footstep-b.wav` | Footstep, second of two | `tools/synth-audio.ts` → `footstep()` — original work, this repository | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `land.wav` | Landing from a fall | `tools/synth-audio.ts` → `land()` — original work, this repository | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `hit.wav` | Hit confirmation | `tools/synth-audio.ts` → `hit()` — original work, this repository | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `damage.wav` | Damage taken | `tools/synth-audio.ts` → `damage()` — original work, this repository | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `round-start.wav` | Round starting | `tools/synth-audio.ts` → `roundStart()` — original work, this repository | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |
| `round-end.wav` | Round ending | `tools/synth-audio.ts` → `roundEnd()` — original work, this repository | [CC0-1.0](https://creativecommons.org/publicdomain/zero/1.0/) |

Paths are relative to `packages/client/public/audio/`.

### If a downloaded sound is ever added

Add its row here first, with a **direct URL to the asset page** — not to the
site's front page — and the licence spelled out (`CC0-1.0`, `CC-BY-4.0` plus the
attribution line the licence requires, and so on). Then remove it from
`tools/synth-audio.ts`'s `RECIPES` in the same commit, or the bake will delete
it: the baker fails on any file in the output directory that no recipe produces,
which is what stops an unreproducible blob from drifting into the tree.

---

## Code

Gladiator's movement is a port of the `bg_pmove.c` from Quake III Arena
(id Software, GPL-2.0-or-later). What was taken is the *algorithm* — the order
of operations, the acceleration gate, the velocity snapping — reimplemented in
TypeScript from the published source and the behaviour it produces, with the
constants and their reasoning written down in
[`docs/physics-spec.md`](./docs/physics-spec.md). No id Software code, asset,
map or sound is redistributed here.
