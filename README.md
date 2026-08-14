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
pnpm run ci          # typecheck + lint + test + build + guardrails
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
pnpm run map:bake --check    # verify the committed artifacts, write nothing
```

Maps are hand-authored TypeScript. The baker validates them — a spawn inside
solid, a spawn with no headroom, two spawns too close together and an
unreferenced surface all fail the bake — hashes them, and writes JSON that both
the client and the server load. The baked artifacts are committed, and a test
fails if they are stale. `docs/physics-spec.md` §4.

Requires Node ≥ 20.19 (CI runs the version in [`.nvmrc`](./.nvmrc)) and pnpm 10.

## Layout

```
packages/sim      the deterministic simulation — zero dependencies, no clock
packages/bot      single-player opposition; emits UserCmds like a human does
packages/client   Babylon renderer, prediction, input
packages/server   authoritative tick loop, rooms, WebSocket transport
maps/             hand-authored maps, and the baked JSON both ends load
tools/            bake-map.ts — compiles, validates and hashes maps/*.ts
scripts/          guardrails.mjs        — proves the boundaries reject violations
                  no-physics-plugin.mjs — fails if a physics engine is installed
                  e2e.mjs               — the browser smoke test
docs/             physics-spec.md, renderer.md, deploy.md
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

## Deploying

The client is a static bundle on Vercel; the server is a long-lived process on
Fly.io, and they talk over `wss://`. The runbook, the origin-allowlist decision
and the recorded server timer jitter are in [`docs/deploy.md`](./docs/deploy.md).
