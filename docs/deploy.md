# Deploying Gladiator

The client is a static bundle on **Vercel**. The server is a long-lived Node
process on **Fly.io**. They talk over `wss://`.

This document is the runbook and the record of the decisions the deploy forced.
Hardening — regions, graceful drain, a real origin policy — is GLAD-G41FQ9.

---

## The shape

```
  browser ──── https ────► Vercel (packages/client/dist, static)
     │
     └──────── wss:// ───► Fly.io (packages/server/dist/index.js, one process)
```

Two hosts, because they are two different things: the client is bytes that never
change between requests, and the server is a process that has to stay alive for
the length of a match. There is no origin they can share that is good at both.

---

## Vercel

### Root Directory is the repo root — not `packages/client`

This is the setting that costs an afternoon. Pointing Vercel's Root Directory at
`packages/client` makes it run `pnpm install` *inside* that directory, where
there is no `pnpm-workspace.yaml`. pnpm then has no workspace, `@gladiator/sim`
is a `workspace:*` dependency with no workspace to resolve it in, and the build
fails with a message about an unresolvable specifier that says nothing about the
real cause.

Root Directory stays at the repo root. `vercel.json`, committed at the root,
carries the rest:

| Field             | Value                                     |
| ----------------- | ----------------------------------------- |
| `installCommand`  | `pnpm install --frozen-lockfile`          |
| `buildCommand`    | `pnpm --filter @gladiator/client run build`|
| `outputDirectory` | `packages/client/dist`                    |
| `framework`       | `null`                                    |

`framework: null` matters too: a framework preset would look for a Vite config
at the root, not find one, and quietly build nothing.

### Environment variables — all three environments

| Variable          | Value                          |
| ----------------- | ------------------------------ |
| `VITE_SERVER_URL` | `wss://gladiator.fly.dev`      |
| `VITE_BUILD`      | `$VERCEL_GIT_COMMIT_SHA`       |

Vite **inlines** these at build time. A preview deploy is its own build, so it
bakes in whatever the *Preview* environment held at that moment — setting the
variable only in Production means every preview ships pointing at nothing.

When `VITE_SERVER_URL` is missing on an `https:` origin the client says so on
screen rather than guessing a URL. A guess produces a browser error that names
no cause, and the page just does not work.

---

## Fly.io

### First deploy

```sh
flyctl launch --no-deploy --copy-config      # reads the committed fly.toml
flyctl deploy --build-arg GLADIATOR_BUILD="$(git rev-parse --short HEAD)"
flyctl secrets set ALLOWED_ORIGINS=https://gladiator.vercel.app
```

Then check it:

```sh
curl -sf https://gladiator.fly.dev/healthz | jq
```

### `auto_stop_machines = "off"` is load-bearing

Fly decides whether to stop a machine from a concurrency soft-limit
calculation. Two players standing still between rounds look exactly like zero
load, and a stopped machine takes every live WebSocket with it. The duel ends
because the scheduler got bored.

It is the first thing that will look like a cost saving to someone reading
`fly.toml` in six months. It is not.

### The image has no workspace in it

The `Dockerfile` bundles `@gladiator/sim` into a single server file with
esbuild, and installs `ws` — the one external dependency — with plain npm into a
directory of real files. Nothing in the runtime stage is a pnpm symlink, because
a pnpm store copied between build stages points at paths that do not exist on
the other side.

`"type": "module"` is written into the runtime `package.json` deliberately:
esbuild emits ESM, and without it Node parses `index.js` as CommonJS and dies on
the first `import`.

---

## The origin allowlist

A WebSocket upgrade is **not** subject to CORS and triggers no preflight. The
browser sends `Origin` and then does whatever the server tells it, so any page
on the internet can open a socket to this server unless the server checks. That
is cross-site WebSocket hijacking, and the check at upgrade is the whole
defence.

Three things are allowed, and the reasoning for each is in
`packages/server/src/origin.ts`:

1. **Anything in `ALLOWED_ORIGINS`** — the production domain.
2. **`^https://gladiator(-[a-z0-9-]+)?\.vercel\.app$`** — the project's preview
   deployments. Deliberately project-scoped: a bare `*.vercel.app` pattern would
   admit every Vercel user on earth, and an allowlist with no preview pattern at
   all means every preview silently fails to connect, which looks exactly like
   the server being down.
3. **`http://localhost:*`, and only when `NODE_ENV !== 'production'`.**

A missing `Origin` header is refused. A browser always sends one; something that
does not is not a browser, and this server has no non-browser clients.

None of this is authentication — `Origin` is set by browsers, not by people, and
a native client can send whatever it likes. It stops browser-based abuse and
nothing else. GLAD-V7M6PQ owns the rest.

## Transport settings

`noDelay` on, `permessage-deflate` off. Every frame this server sends is a few
dozen bytes and every one of them is urgent: Nagle's algorithm would hold them
back waiting for company, and compression would spend a memory allocation and a
CPU burst per message to save nothing.

---

## Server wakeup jitter

The simulation runs at 125 Hz, so the server has 8 ms to be woken, do a tick's
work and go back to sleep. Node's timers are "no earlier than", not real-time,
and a shared-CPU cloud instance competing for a hyperthread can be much later
than asked. A p99 above one tick means the server's idea of "now" lurches, which
players see as the world stuttering — and it is invisible on an idle laptop.

So it is measured, on whatever machine is actually running:

```sh
# locally
pnpm --filter @gladiator/server run jitter -- --seconds 60

# on the real machine class, live
curl -sf https://gladiator.fly.dev/healthz | jq .jitter

# and in the log, at boot and on SIGTERM
flyctl logs --app gladiator | grep 'wakeup jitter'
```

`/healthz` carries a live snapshot, so the p99 on the machine serving players is
one `curl` away, and the process logs the same line at boot and on SIGTERM.

### Recorded measurements

| Where                                              | Samples | p50      | p99      | max      | mean     |
| -------------------------------------------------- | ------- | -------- | -------- | -------- | -------- |
| Dev box — Linux x64, Node 20.20.2, under load       | 5625    | 0.000 ms | 2.833 ms | 6.274 ms | 0.230 ms |
| Fly `shared-cpu-1x`                                 | —       | —        | —        | —        | —        |

The dev-box row was taken with a headless-browser end-to-end run in progress on
the same machine, so it is a loaded number rather than a best case. Even so a
p99 of 2.8 ms is a third of a tick, and the max of 6.3 ms stays inside one.

**The Fly row is empty and has to be filled in from the first deploy.** It is
the number the whole measurement exists for — `shared-cpu-1x` is where CPU steal
lives — and a laptop measures a laptop.

---

## Verifying a deploy

```sh
# the client
curl -sfo /dev/null -w '%{http_code}\n' https://<vercel-url>/

# the server
curl -sf https://gladiator.fly.dev/healthz | jq

# both together, in a real browser
pnpm run e2e
```

`pnpm run e2e` builds the real client bundle, runs the real server bundle, and
drives headless Chromium through the whole acceptance list: the page loads with
no console errors, clicking locks the pointer, W runs and space jumps, the
client and server hashes agree over a minute of movement, and `?protocol=999`
puts a readable version-mismatch message on screen. It is not part of
`pnpm run ci` because it needs a browser download; CI runs it as its own job.

On a machine without the browser's system libraries:

```sh
pnpm exec playwright install --with-deps chromium
```

---

## Open questions

- **Which Fly region.** `primary_region = "iad"` is the owner's nearest, not a
  decision. A room-code game means the other player may be on another continent
  and one of the two eats the whole round-trip. GLAD-G41FQ9 owns picking
  properly, with a latency budget by geography.
- **Client asset budget.** The bundle is ~980 kB (~234 kB gzipped), essentially
  all Babylon. GLAD-PGS73O owns the budget.
