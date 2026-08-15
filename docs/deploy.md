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

### The budget: **p99 wakeup lateness ≤ 8 ms**, one tick

`WAKEUP_BUDGET_MS` in `packages/server/src/scheduler.ts`, and the reasoning is
the reason it is written down rather than assumed. A wakeup late by less than a
tick lands in the same 8 ms the world was going to be advanced through anyway:
the accumulator hands the missing milliseconds to the next frame and the tick
count over any second is unchanged. Past one tick, one wakeup in a hundred is a
whole sub-step behind where it believed it was, and every snapshot that frame
produces is a tick stale for everyone in every room on the machine.

A **p99** rather than a maximum, because a maximum on a shared vCPU measures the
worst steal event in the sample window and nothing else, and a budget blown by
one 40 ms hiccough an hour is a budget nobody can act on. The max is recorded
beside it because a *very* large one means something different — a GC pause or a
machine being descheduled — and `resyncs` next to it says how often the
scheduler had to give up on a boundary and re-aim.

### Measuring it

Two numbers, and the second is the one the budget is about.

- **The bare timer** (`jitter.ts`) asks to be woken every 8 ms with nothing to
  do when it is. That is the floor: what the kernel and Node's event loop cost
  on this machine.
- **The tick scheduler** (`scheduler.ts`) is what actually runs, doing what it
  actually does — N rooms of two players, advanced in exact 8 ms sub-steps at
  62.5 Hz. A scheduler that wakes on time and then takes 12 ms to tick its rooms
  is a scheduler whose *next* wakeup is late, and a probe with nothing to do
  would never see it.

```sh
# locally, or over `flyctl ssh console` on the real machine class
pnpm --filter @gladiator/server run jitter -- --seconds 60 --rooms 50

# on the real machine class, live, while players are on it
curl -sf https://gladiator.fly.dev/healthz | jq '.scheduler, .jitter'

# and in the log, at boot and on SIGTERM
flyctl logs --app gladiator | grep -E 'wakeup|tick scheduler'
```

`/healthz` carries a live snapshot of both, including `scheduler.withinBudget` —
the deploy's own verdict — so the p99 on the machine serving players is one
`curl` away. The process logs the same lines at boot and on SIGTERM, and
`pnpm --filter @gladiator/server run jitter` exits non-zero when the loaded p99
is over budget, so it can be a gate rather than a reading.

### Recorded measurements

| Where | Load | Frames | p50 | p99 | max | resyncs | dropped | Rate |
| ----- | ---- | ------ | --- | --- | --- | ------- | ------- | ---- |
| Dev box — Linux x64, Node 20.20.2, 8 cores idle | 8 rooms | 1250 | 0.000 ms | 1.851 ms | 2.955 ms | 0 | 0 ms | 125.0 Hz |
| Dev box — same, with 4 busy-loops competing | 50 rooms | 3745 | 0.000 ms | 2.330 ms | 11.976 ms | 3 | 0 ms | 125.0 Hz |
| Fly `shared-cpu-1x` | — | — | — | — | — | — | — | — |

The bare timer on the same runs was p99 3.4 ms idle and 7.4 ms under
contention, with a max of 37.5 ms — so the *scheduler* is quieter than the probe
that measures the floor, which is what aiming at absolute boundaries buys: a
late wakeup shortens the next sleep instead of being added to it.

Both loaded rows hold **exactly 125.0 Hz** and drop no simulated time. Fifty
rooms is a hundred connections, which is half of `fly.toml`'s `hard_limit`.

**The Fly row is empty and has to be filled in from the first deploy.** It is
the number the whole measurement exists for — `shared-cpu-1x` is where CPU steal
lives — and a laptop measures a laptop. Take it with the `flyctl ssh console`
line above, or read `scheduler` off `/healthz` once there is traffic.

### When it is over budget

In order, cheapest first:

1. **Check `resyncs` and `droppedMs`.** Nonzero `droppedMs` means the machine
   stalled for longer than 250 ms and simulated time was thrown away; that is a
   different problem from ordinary lateness and usually means GC or eviction.
2. **Raise the machine class.** `shared-cpu-1x` is the cheapest thing Fly sells
   and the one most exposed to steal. `performance-1x` is a dedicated core.
3. **Do not raise `HOST_FRAME_MS`.** A slower host frame makes each wakeup do
   more work and hides lateness in the accumulator rather than removing it; the
   snapshots simply arrive in bigger lumps.

---

## Room codes

A match is addressed by six characters of Crockford base32 —
`0123456789ABCDEFGHJKMNPQRSTVWXYZ`, the digits and the letters minus **I**,
**L**, **O** and **U**. The first three go because a person reading a code off a
screen cannot tell them from `1` and `0`; `U` goes so that no draw can spell an
obscenity, which matters for a string strangers send each other.
`packages/server/src/roomCode.ts` reads leniently and writes strictly: lower
case folds up, `O`/`I`/`L` fold to their digits, hyphens and spaces are dropped,
and a `U` is refused rather than folded — it is not ambiguous with anything, so
a `U` is a typo or a guess, and mapping it to something would turn a wrong code
into a *different room*.

### How guessable one is

Six symbols from a 32-symbol alphabet is **32⁶ = 1,073,741,824 codes, exactly 30
bits**. The number that matters is not the size of the space but the chance a
guess lands in the *occupied* part of it, and a guess costs a WebSocket upgrade:

| Live rooms | Chance per guess | At 10 guesses/s | At 100 guesses/s |
| ---------- | ---------------- | --------------- | ---------------- |
| 1          | 9.3 × 10⁻¹⁰      | 3.4 years       | 124 days         |
| 100        | 9.3 × 10⁻⁸       | 12.4 days       | 30 hours         |
| 200 (`MAX_ROOMS`) | 1.9 × 10⁻⁷ | 6.2 days        | 15 hours         |

`MAX_ROOMS` is 200, which is `fly.toml`'s `hard_limit` on *connections* — so it
is the number of rooms that could exist if every connection opened one and
nobody ever joined an existing match. It is the worst case, not a capacity plan.
The arithmetic is `guessProbability` and `expectedGuessSeconds` in `roomCode.ts`
and it is asserted in `roomCode.test.ts`, so the table above is a number this
suite can be pointed at rather than a claim somebody made once.

A code is **not a credential** and this is not a security boundary. What the
table says is that at this deploy's size, an attacker spending an upgrade per
guess needs days to walk into one stranger's duel — and that they would then be
told the room is full, because a duel seats two. Connection-level rate limiting
that would make it worse for them is GLAD-V7M6PQ.

### Why the registry is a `Map` on one machine

Two players in one room have to reach the *same process*, because a room is a
live `GameState` being advanced 125 times a second and there is no version of
that which shards. A registry in Redis would tell a second machine which code
belonged to which room and then have nothing useful to do with the answer. So
v1 pins to one machine — `min_machines_running = 1` with
`auto_stop_machines = "off"` — and the registry is an in-memory `Map`, which is
definitionally consistent because there is only one of it. Scaling out needs a
room-to-machine directory and a way to route an upgrade at it, and that is
GLAD-G41FQ9's.

Rooms do not leak: one with no peers in it for a minute is closed and forgotten
(`EMPTY_ROOM_TTL_MS`). That is deliberately blunt, and it is now downstream of a
policy rather than standing in for one — see the connection lifecycle below.

## The connection lifecycle

`packages/server/src/lifecycle.ts` (GLAD-DVDV6P). Four numbers, and each one is
bounded by the next; `lifecycle.test.ts` asserts the inequalities, because they
are exactly the kind of relationship that survives until somebody tunes one of
them.

| Number | Value | What it bounds |
| ------ | ----- | -------------- |
| `MAX_REPEAT_TICKS` (`inputQueue.ts`) | 62 ticks, ~500 ms | how long a silent peer's last command keeps being repeated, so the body comes to rest rather than running off the map |
| `DEFAULT_IDLE_TIMEOUT_MS` (`room.ts`) | 10 s | how long a socket may say nothing before the room decides the wire is gone. A socket that *closes* skips this entirely |
| `RECONNECT_GRACE_MS` (`lifecycle.ts`) | 30 s | how long the seat is then held, and the countdown the opponent is shown |
| `EMPTY_ROOM_TTL_MS` (`rooms.ts`) | 60 s | how long a room with nobody in it survives — longer than the grace window, so a match both of whose players dropped is not reaped out from under a reconnect |

Worst case from "the wire broke" to "the match is forfeit" is therefore **forty
seconds** (idle + grace), and it is ten seconds and a bit for the common case
where the socket closes properly. On the client the backoff is 250 ms to 4 s with
full jitter and it gives up after 45 s — deliberately past the grace window, so
a player stops because their *seat* expired rather than because the client ran
out of patience (`client/src/net/reconnect.ts`).

### The seat token

Reconnecting means presenting the token the welcome carried:
`wss://…/?room=ABC123&token=…`. It is 128 bits of CSPRNG as hex, minted per seat,
reissued verbatim to whoever comes back with it, and never sent to the other
peer.

It is a **bearer credential, and it is not a security boundary either** — for
the same reason a room code is not, and with a different exposure. Guessing one
is not a thing anybody can do: 128 bits against a room that exists for the length
of one duel. What it buys whoever *holds* it is the ability to take a seat in a
match somebody is already playing — which is the same thing being in the tab
would buy them, and the reason the token never appears in a frame the other
player receives, in a log line, or in a URL anybody shares. The room code is
still what gets shared; the token is what the tab keeps.

A match that has ended answers a late reconnect with a `match-ended` fault and a
4007 close, which the client does *not* retry: it is an answer rather than a
moment. A stale token from a room that has been reaped is treated as no token at
all — its holder is a stranger arriving at a match with a free seat, and refusing
them would turn a leftover value in somebody's tab into a room they cannot join.

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
