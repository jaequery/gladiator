# Gladiator

A browser-native recreation of the 1996 Quake mod *Rocket Arena*. Round-based
1v1 duels on one small map: spawn at full health, no pickups, two weapons —
rocket launcher and railgun — both with unlimited ammo. Play a friend over a
room code, or a bot that plays by the same rules you do.

This repository is currently the scaffold. The game is being built ticket by
ticket on top of it.

## Quickstart

```sh
pnpm install
pnpm run ci          # typecheck + lint + test + build + guardrails
```

`pnpm run ci`, not `pnpm ci` — pnpm reserves the bare `ci` verb.

```sh
pnpm --filter @gladiator/client dev    # the browser client
pnpm --filter @gladiator/server dev    # the authoritative server
```

Requires Node ≥ 20.19 (CI runs the version in [`.nvmrc`](./.nvmrc)) and pnpm 10.

## Layout

```
packages/sim      the deterministic simulation — zero dependencies, no clock
packages/bot      single-player opposition; emits UserCmds like a human does
packages/client   Babylon renderer, prediction, input
packages/server   authoritative tick loop, rooms, WebSocket transport
scripts/          guardrails.mjs — proves the sim boundary rejects violations
docs/             physics-spec.md
```

`packages/sim` runs unchanged in the browser and on the server, and must give
bit-identical results in both. That constraint is enforced mechanically rather
than by convention — see **The simulation boundary** in
[`AGENTS.md`](./AGENTS.md), which is also where the coordinate-system matrix
and the TypeScript conventions live. Vocabulary is in
[`CONTEXT.md`](./CONTEXT.md).
