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
nothing else. What stops the rest is **Limits**, below.

## Transport settings

`noDelay` on, `permessage-deflate` off. Every frame this server sends is a few
dozen bytes and every one of them is urgent: Nagle's algorithm would hold them
back waiting for company, and compression would spend a memory allocation and a
CPU burst per message to save nothing.

---

## Limits

This endpoint is on the public internet, it needs no account to reach, and the
origin check above stops a browser on somebody else's page and nothing else. So
the defence is that the server is authoritative and distrusts everything it is
handed. Every number below is enforced, tested, and configurable by environment
variable; the argument for each one lives next to the code, and this table is
the operator's copy. GLAD-V7M6PQ.

| Limit | Value | Env | Where |
| ----- | ----- | --- | ----- |
| one frame | **16 kB** | `MAX_PAYLOAD_BYTES` | `ws` `maxPayload` + `validate.ts` |
| frames per connection | **300/s**, burst 60 | — | `validate.ts` |
| bytes per connection | **128 kB/s**, burst 32 kB | — | `validate.ts` |
| refused frames before a close | **100** | — | `validate.ts` |
| commands executed per peer | **125/s**, burst 32 | — | `inputQueue.ts` |
| buffered commands per peer | **32** | — | `inputQueue.ts` |
| commands per frame | **256** | — | `sim/protocol.ts` |
| connections per address | **1/s**, burst 20 | `CONNECT_BUDGET_PER_SECOND`, `CONNECT_BURST` | `server.ts` |
| open sockets per address | **8** | `MAX_CONNECTIONS_PER_ADDRESS` | `server.ts` |
| rooms on the machine | **200** | — | `rooms.ts` |

Two of those want explaining, because the pairs look redundant and are not.

**Frames per second is not the command rate limit.** The command limit is 125/s
and it exists to stop one player consuming more of the world's time than
everybody else — the speedhack, argued at length in `inputQueue.ts`. The frame
limit is about the *pipe*: a client sending ten thousand empty frames a second
passes the command limit trivially, because none of its frames contain a command
the world would execute, and would still spend a core on `JSON.parse`.

**Bytes per second is not the frame size cap.** 300 frames a second at the 16 kB
cap is 4.8 MB/s per connection, and every one of those frames is individually
legal.

The frame limits **throttle before they disconnect**. A frame over the rate is
dropped in silence — answering a flood with one fault per frame is answering a
flood with a flood, in our own direction — and only a connection that has had a
hundred frames refused is told why and closed. An honest client at 240 Hz sends
245 frames a second and is never refused one.

### What "the address" means

`Fly-Client-IP` behind the proxy, and the socket's own address otherwise
(`TRUSTED_IP_HEADER`, defaulting to `fly-client-ip`). Without the header every
connection on Fly arrives from the proxy, so a per-address limit would put the
whole internet in one bucket and the first twenty players a second would rate
limit the twenty-first.

**That header is only trustworthy behind a proxy that overwrites it**, which
Fly's does. A process reachable directly would be handed whatever an attacker
typed — a fresh bucket per guess, which is the same as no limit at all. Set
`TRUSTED_IP_HEADER=` to the empty string if this ever runs without one.

An IPv6 address is bucketed by its **/64**, because a residential customer is
routinely handed a whole one: limiting per address would let an attacker walk
eighteen quintillion addresses inside their own subnet. The cost is that
everybody behind one NAT or one /64 shares a budget, which is why the numbers are
sized for a household — twenty connections in a burst, one a second after that —
rather than for one browser tab.

### Nothing takes the machine down with it

A hostile client can end its own session. It must not be able to end anybody
else's, and there are two places that could have gone wrong:

- **An exception out of a socket handler.** A `ws` message handler runs inside
  `EventEmitter.emit`, so a throw escaping it unwinds through the event loop and
  takes the *process*. `net/wsTransport.ts` catches at that boundary and closes
  the one connection.
- **An exception out of a room's sub-step.** Every world on the machine is
  advanced by one call from one timer, so a throw would leave every *other* room
  silently un-ticked. `rooms.ts` runs each room behind a try/catch, closes the
  one that threw, and counts it as `rooms.faulted` on `/healthz`.

`rooms.faulted` should be zero forever. A nonzero reading means some frame is
reaching code that treats it as trustworthy, and that is worth finding before it
is found for us.

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
guess lands in the *occupied* part of it, and **a guess costs a WebSocket
upgrade** — which is exactly what the connection limit above bounds. One address
gets a burst of twenty and then one a second:

| Live rooms | Chance per guess | At 1/s (the limit) | At 10/s | At 100/s |
| ---------- | ---------------- | ------------------ | ------- | -------- |
| 1          | 9.3 × 10⁻¹⁰      | **34 years**       | 3.4 years | 124 days |
| 100        | 9.3 × 10⁻⁸       | **124 days**       | 12.4 days | 30 hours |
| 200 (`MAX_ROOMS`) | 1.9 × 10⁻⁷ | **62 days**        | 6.2 days  | 15 hours |

The bold column is what a single attacker actually gets; the other two are what
they would get without the limit, kept so the limit's worth is visible. Rows are
medians of a geometric distribution — an expectation, not a guarantee, and the
attacker who gets lucky on the first try was always possible.

`MAX_ROOMS` is 200, which is `fly.toml`'s `hard_limit` on *connections* — so it
is the number of rooms that could exist if every connection opened one and
nobody ever joined an existing match. It is the worst case, not a capacity plan;
the realistic target is one friend's duel, which is the top row. The arithmetic
is `guessProbability` and `expectedGuessSeconds` in `roomCode.ts` and it is
asserted in `roomCode.test.ts` at the enforced rate, so the table above is a
number this suite can be pointed at rather than a claim somebody made once.

**A distributed attacker is not bounded by this**, and saying so is the point of
writing it down. The limit is per address; a thousand of them is a thousand
guesses a second, which walks into one of two hundred rooms in about an hour and
a half. What that buys them is a seat in a stranger's duel — the room is a lobby,
not an account, and there is nothing behind it to steal. If it ever becomes worth
more than that, the answer is a longer code (seven symbols is 35 bits and another
thirty-two-fold) rather than a bigger limit.

A code is **not a credential** and this is not a security boundary. What the
table says is that at this deploy's size, an attacker spending an upgrade per
guess needs months to walk into one stranger's duel — and that they would then be
told the room is full, because a duel seats two.

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
(`EMPTY_ROOM_TTL_MS`). That is deliberately blunt — *when* a peer counts as
gone, whether a disconnected player may come back to the same room, and what a
forfeit does to the score are the connection lifecycle's questions
(GLAD-DVDV6P), and that ticket will want a longer grace period than this.

---

## Reading the logs, and recording a match

The server writes **one JSON object per line** and every one of them carries
`room` and `tick` — null where the event is not about a room, never absent, so
a query never has to branch on whether a key is there
(`packages/server/src/log.ts`). A bug report arrives as "room 7QK4M2, about a
minute in", and those are the two coordinates it turns into:

```sh
flyctl logs | jq -c 'select(.room == "7QK4M2")'
flyctl logs | jq -c 'select(.level != "info")'
flyctl logs | jq -c 'select(.event == "sim.speed_clamped")'
```

That last one should never print. It is the 3000 qu/s rail in `pmove`, on a game
whose best rocket jump peaks near 1000; if it fires, a command stream produced a
velocity movement cannot (`docs/physics-spec.md` §2.6).

Neither should `registry.room_faulted`, and it is the more alarming of the two:
it means ticking or sweeping a room threw, which means some frame reached code
that treated it as trustworthy. **Limits** above says what that costs and what
contains it.

```sh
# who is being turned away at the door, and why
flyctl logs | jq -c 'select(.event | startswith("upgrade."))'
flyctl logs | jq -c 'select(.event == "room.peer_refused") | {room, peer, fate, refused}'

# what this machine is actually enforcing, from its boot line
flyctl logs | jq -c 'select(.event == "server.limits")'
```

`room.peer_refused` is one line per closed *connection*, never one per refused
frame — a log an attacker can fill is a log nobody can read, which is the same
reason the throttle itself is silent. `fate` says which limit it hit and
`refused` says how many frames it took to get there, so "closed on the first
binary frame" and "closed after a hundred" read differently.

**`GLADIATOR_DEMO_DIR` records every match on the machine to a file.** Off by
default, because a machine holding two hundred rooms would otherwise hold two
hundred growing arrays and write two hundred files. Turn it on when chasing
something a playtester can describe and nobody can reproduce:

```sh
flyctl secrets set GLADIATOR_DEMO_DIR=/data/demos
# ... later, once the match has ended and the room has closed
flyctl ssh sftp get /data/demos/<stamp>-7QK4M2.demo.json
pnpm demo replay <stamp>-7QK4M2.demo.json
```

A demo is the *command stream*, not the state stream, so replaying it re-runs
the exact match rather than showing a recording of it — and `replay` compares
the hash trace it produces against the one the file carries, which is how you
find out whether the two ends disagreed at all. `--until <tick>` stops it where
the report says. `AGENTS.md` under **Observability**.

A recording lands on disk when the room is closed and forgotten, which is when
both players have gone plus the empty-room TTL above. A machine that is
SIGKILLed rather than drained writes nothing.

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
