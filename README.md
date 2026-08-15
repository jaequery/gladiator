# Gladiator

A browser-native recreation of the 1996 Quake mod *Rocket Arena*. Round-based
1v1 duels on one small map: spawn at full health, no pickups, two weapons —
rocket launcher and railgun — both with unlimited ammo. Play a friend over a
room code, or a bot that plays by the same rules you do.

This repository is currently a **walking skeleton**: a box on a plane that you
can run and jump around with the pointer locked, simulated at a fixed 125 Hz by
`packages/sim`, with the *same* code running on the server and echoing back a
state hash the client compares against its own and prints on screen. No weapons,
no rounds, no map — just the whole platform path, end to end, so that everything
built on it is built on something that has been deployed once.

## Quickstart

```sh
pnpm install
pnpm run ci          # typecheck + lint + test + build + guardrails + latency
```

`pnpm run ci`, not `pnpm ci` — pnpm reserves the bare `ci` verb.

```sh
pnpm --filter @gladiator/server dev    # the authoritative server, on :8787
pnpm --filter @gladiator/client dev    # the browser client, on :5173
```

Open the client, click to lock the pointer, and run around with `W`/`A`/`S`/`D`
and space. The HUD prints both state hashes and whether they agree.

```sh
pnpm run e2e         # the whole acceptance list, in headless Chromium
```

`pnpm run e2e` builds the real bundles, runs the real server, and drives a real
browser through it: the page loads with no console errors, clicking locks the
pointer, the box runs and jumps, the hashes agree over a minute of movement, and
`?protocol=999` and `?map=deadbeef` each put a readable mismatch message on
screen. It needs a browser download
(`pnpm exec playwright install --with-deps chromium`), so it is its own CI job
rather than part of `pnpm run ci`.

```sh
pnpm run map:bake            # compile maps/*.ts to maps/baked/*.json
pnpm run nav:bake            # compile maps/*.nav.ts to maps/baked/*.nav.json
pnpm run map:bake --check    # verify the committed artifacts, write nothing
```

Maps are hand-authored TypeScript. The baker validates them — a spawn inside
solid, a spawn with no headroom, two spawns too close together and an
unreferenced surface all fail the bake — hashes them, and writes JSON that both
the client and the server load. The baked artifacts are committed, and a test
fails if they are stale. `docs/physics-spec.md` §4.

```sh
pnpm demo record             # play a scripted duel through a real host, to a file
pnpm demo replay <file>      # re-run it, and check it lands where it did
pnpm latency                 # the input-to-photon budget, measured
```

A **demo** is the command stream a host executed, not the states it produced —
which is what makes it small and what makes replaying it a *check* rather than a
playback: `replay` compares the hash trace it produces against the one the file
carries. Set `GLADIATOR_DEMO_DIR` and the server records every match; add
`?dev=1` and a tab hosting single-player records its own. `docs/deploy.md`.

`?room=ABC123` joins the match that code names; `?queue=1` asks to be matched
with whoever else is waiting, and says how long it will keep looking before it
gives up and hands back a code to send a friend instead. A code beats the queue
when a page carries both. `AGENTS.md`, "Quick match is a line of rooms".

`?dev=1` also puts the netcode panel on screen: tick, round trip, unacknowledged
commands, prediction error in units, snapshot bytes per second, and two counters
that should never move. `docs/latency.md` is what the response time is made of
and what it is allowed to be.

The bot's navigation data is hand-authored the same way, beside the map it is
for. `pnpm run nav:bake` validates every node against the real player box and
every `walk` link by walking it with the real movement, then precomputes
all-pairs routing and a node-to-node visibility bitset — so at run time a path
query and a line-of-sight query are each one array read. `AGENTS.md`, "The
bot's navigation data".

Requires Node ≥ 20.19 (CI runs the version in [`.nvmrc`](./.nvmrc)) and pnpm 10.

## Layout

```
packages/sim      the deterministic simulation — zero dependencies, no clock
packages/bot      single-player opposition; emits UserCmds like a human does
packages/client   Babylon renderer, prediction, input
packages/server   authoritative tick loop, rooms, WebSocket transport
maps/             hand-authored maps and nav graphs, and the baked JSON they compile to
tools/            bake-map.ts    — compiles, validates and hashes maps/*.ts
                  nav-bake.ts    — validates and precomputes maps/*.nav.ts
                  synth-audio.ts — synthesises the sound set, bit-reproducibly
scripts/          guardrails.mjs        — proves the boundaries reject violations
                  no-physics-plugin.mjs — fails if a physics engine is installed
                  e2e.mjs               — the browser smoke test
                  audio-check.mjs       — the audio checks, in a real browser
docs/             physics-spec.md, renderer.md, audio.md, deploy.md
NOTES.md          the operational decisions: region, origin policy, machine, drain
CREDITS.md        every shipped asset, its source and its licence
Dockerfile        the Fly.io image for packages/server
fly.toml          the Fly.io app
vercel.json       how Vercel builds packages/client from the repo root
```

`packages/sim` runs unchanged in the browser and on the server, and must give
bit-identical results in both. That constraint is enforced mechanically rather
than by convention — see **The simulation boundary** in
[`AGENTS.md`](./AGENTS.md), which is also where the coordinate-system matrix
and the TypeScript conventions live. Vocabulary is in
[`CONTEXT.md`](./CONTEXT.md).

`packages/client` draws that simulation and decides nothing about it: the
camera is written from sim state every frame and never read back, and Babylon's
own collision system and physics API are banned by lint and by a lockfile check
so a second, disagreeing physics cannot quietly appear. Settings and reasoning:
[`docs/renderer.md`](./docs/renderer.md).

Its audio is two buses: your own actions go out dry and centred with the least
latency the browser will give, and everything that happens in the arena is
HRTF-panned so that a rocket fired behind you sounds behind you. The sounds
themselves are synthesised by `tools/synth-audio.ts` rather than downloaded, so
their licence is ours to give. Reasoning and the measurements:
[`docs/audio.md`](./docs/audio.md).

## Deploying

The client is a static bundle on Vercel; the server is a long-lived process on
Fly.io, and they talk over `wss://`. The runbook — what to run, the secrets it
needs, and the recorded server timer jitter — is
[`docs/deploy.md`](./docs/deploy.md). The decisions it rests on are
[`NOTES.md`](./NOTES.md): the region and the latency budget by geography, the
origin allowlist, the machine class and what it costs, and the drain that means
a deploy interrupts a duel rather than ending it.
