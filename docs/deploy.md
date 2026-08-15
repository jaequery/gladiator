# Deploying Gladiator

The client is a static bundle on **Vercel**. The server is a long-lived Node
process on **Fly.io**. They talk over `wss://`.

This document is the **runbook**: what to run, in what order, and what each
setting is for. The decisions behind it — which region and the latency budget by
geography, how loose the origin allowlist is, which machine class and what it
costs, and what a deploy does to a match in progress — are recorded in
[`NOTES.md`](../NOTES.md), with the numbers they were made from.

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
```

Three secrets, and the deploy is wrong in a different way without each of them:

```sh
# The production origin. Without it, only previews can connect.
flyctl secrets set ALLOWED_ORIGINS=https://gladiator.vercel.app

# The Vercel account slug preview hostnames end with. Without it, no preview
# can connect at all — deliberately: `origin.ts` fails closed rather than
# falling back to a pattern that is not a control.
flyctl secrets set VERCEL_SCOPE=<team-slug>

# Signs the resume tickets a drain hands out. It must be the SAME on every
# machine, because the machine that reads a ticket is never the one that minted
# it. Without it, every deploy ends every live match.
flyctl secrets set RESUME_SECRET="$(openssl rand -hex 32)"
```

Then check it:

```sh
curl -sf https://gladiator.fly.dev/healthz | jq
```

`ready` must be `true` and `canResume` must be `true`. Both, plus the build and
the live jitter budget, are what `scripts/verify-deploy.sh` checks — run it after
every deploy:

```sh
./scripts/verify-deploy.sh https://gladiator.fly.dev "$(git rev-parse --short HEAD)"
```

It exits non-zero when the machine is up but not fit to serve, and warns without
failing on the two things a rollback would not fix. **It is not wired into CI
yet** — see "Wiring the gate into CI" below.

### Wiring the gate into CI

`flyctl deploy` exiting 0 says a machine started. It does not say the machine is
serving *this* commit, that it can hold a tick rate, or that a deploy will not
end every match on it — and those are the three ways this deploy is known to be
able to go wrong, so the deploy job should read `/healthz` rather than trust an
exit code.

The change is two steps at the end of the `deploy-server` job in
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml), and it is **not
applied yet**: modifying a workflow file needs a token with GitHub's `workflow`
scope, which the agent that wrote this did not have. Paste it in:

```yaml
      - name: Deploy
        id: deploy                                  # ← add this line
        env:
          FLY_API_TOKEN: ${{ secrets.FLY_API_TOKEN }}
        run: |
          if [ -z "${FLY_API_TOKEN}" ]; then
            echo "::warning::FLY_API_TOKEN is not set — skipping the Fly deploy."
            echo "Set it with: flyctl tokens create deploy | gh secret set FLY_API_TOKEN"
            echo "deployed=false" >> "$GITHUB_OUTPUT"     # ← and this line
            exit 0
          fi
          flyctl deploy \
            --remote-only \
            --wait-timeout 300 \
            --build-arg "GLADIATOR_BUILD=$(git rev-parse --short HEAD)"
          echo "deployed=true" >> "$GITHUB_OUTPUT"        # ← and this one

      # Reads the machine rather than the exit code. `scripts/verify-deploy.sh`.
      - name: Verify the deployed machine
        if: steps.deploy.outputs.deployed == 'true'
        run: ./scripts/verify-deploy.sh https://gladiator.fly.dev "$(git rev-parse --short HEAD)"
```

Until that lands, run the script by hand after a deploy — it is the same
command either way.

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

Three things are allowed. The decision — and the trap in the obvious version of
it — is [`NOTES.md` §2](../NOTES.md); the code is
`packages/server/src/origin.ts`:

1. **Anything in `ALLOWED_ORIGINS`** — the production domain, verbatim.
2. **`^https://gladiator-[a-z0-9][a-z0-9-]*-<scope>\.vercel\.app$`** — this
   project's preview deployments *in this Vercel account*. The scope is what
   makes it a control: anybody may create a project called `gladiator-x` and be
   handed `gladiator-x.vercel.app`, which a project-only pattern would admit.
   With `VERCEL_SCOPE` unset there is no preview pattern at all.
3. **`http://localhost:*`, and only when `NODE_ENV !== 'production'`.**

A missing `Origin` header is refused. A browser always sends one; something that
does not is not a browser, and this server has no non-browser clients.

None of this is authentication — `Origin` is set by browsers, not by people, and
a native client can send whatever it likes. It stops browser-based abuse and
nothing else. GLAD-V7M6PQ owns the rest.

---

## Health, readiness, and what a deploy does to a live match

Two endpoints, because "is this process alive" and "should new players be sent
here" are different questions and a checker that conflates them makes exactly
the wrong call at least once (`packages/server/src/health.ts`):

| URL | Question | Fails when |
| --- | -------- | ---------- |
| `/healthz` | should new players be sent here? | draining, full, or the tick scheduler has not run a frame in 2 s — `503` with `notReady` naming which |
| `/livez` | is this process alive? | never on purpose; the only correct response to it failing is to kill the process, and this process is holding duels |

Fly's health check reads the first, so a `503` takes the machine out of rotation
for *new* connections and leaves the open WebSockets alone. That asymmetry is
what makes a graceful deploy possible at all.

On SIGTERM (`packages/server/src/shutdown.ts`) the machine stops being ready,
hands every seated player a signed **resume ticket** naming their room, seat and
the scoreline, closes the rooms with a **1001 "going away"**, and waits for the
sockets — all inside 20 s, against a 30 s `kill_timeout`. The client comes back
with `?room=<code>&resume=<ticket>` and the next machine rebuilds the room at
that score. The reasoning, and the one secret it needs, are
[`NOTES.md` §4](../NOTES.md).

```sh
# watch a deploy from the outside
watch -n1 'curl -s -o /dev/null -w "%{http_code}\n" https://gladiator.fly.dev/healthz'
flyctl logs --app gladiator | grep -E 'drain|draining|resume'
```

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
| Dev box — same, ~17 concurrent processes | 8 rooms | 1875 | 0.000 ms | 3.824 ms | 7.683 ms | 0 | 0 ms | 125.0 Hz |
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
definitionally consistent because there is only one of it. Scaling out — to a
second region, which is the only reason this deploy would want it — needs a
room-to-machine directory and a way to route an upgrade at it; the sketch and
what would justify building it are [`NOTES.md` §1](../NOTES.md).

It is also why a deploy has to hand the score to the players rather than to the
next machine: there is nowhere else to put it. [`NOTES.md` §4](../NOTES.md).

Rooms do not leak: one with no peers in it for a minute is closed and forgotten
(`EMPTY_ROOM_TTL_MS`). That is deliberately blunt — *when* a peer counts as
gone, whether a disconnected player may come back to the same room, and what a
forfeit does to the score are the connection lifecycle's questions
(GLAD-DVDV6P), and that ticket will want a longer grace period than this.

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

- **The Fly jitter row is still empty.** Every other number here was measured on
  a laptop, and a laptop measures a laptop. The machine class is a decision made
  from the contended dev-box row and has to be confirmed against the real one
  the first time there are players on it. [`NOTES.md` §3](../NOTES.md).
- **The latency table is nominal.** The round trips by geography that chose
  `iad` are published typicals, not measurements from this deploy; the first
  cross-continent playtest replaces them. [`NOTES.md` §1](../NOTES.md).
- **Client asset budget.** The bundle is ~980 kB (~234 kB gzipped), essentially
  all Babylon. GLAD-PGS73O owns the budget.
