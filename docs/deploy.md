# Deploying Gladiator

The client bundle and the long-lived Node server ship together on **Fly.io**.
The page and its WebSocket use one origin.

This document is the **runbook**: what to run, in what order, and what each
setting is for. The decisions behind it — which region and the latency budget by
geography, how loose the origin allowlist is, which machine class and what it
costs, and what a deploy does to a match in progress — are recorded in
[`NOTES.md`](../NOTES.md), with the numbers they were made from.

---

## The shape

```
  browser ── https + wss ──► Fly.io
                              ├─ packages/client/dist (static)
                              └─ packages/server/dist/index.js (rooms)
```

One container builds both packages. The Node HTTP edge serves Vite's files and
upgrades WebSockets on the same listener; `Room` remains behind the transport
boundary and knows nothing about either job.

---

## Fly.io

### First deploy

```sh
flyctl launch --no-deploy --copy-config      # reads the committed fly.toml
flyctl deploy --build-arg GLADIATOR_BUILD="$(git rev-parse --short HEAD)"
```

Two secrets are required:

```sh
# Signs the resume tickets a drain hands out. It must be the SAME on every
# machine, because the machine that reads a ticket is never the one that minted
# it. Without it, every deploy ends every live match.
flyctl secrets set RESUME_SECRET="$(openssl rand -hex 32)"

# Lets GitHub deploy the one application after CI.
flyctl tokens create deploy | gh secret set FLY_API_TOKEN
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
failing on the two things a rollback would not fix. CI runs it immediately after
each Fly deploy.

### The deploy gate in CI

`flyctl deploy` exiting 0 says a machine started. It does not say the machine is
serving *this* commit, that it can hold a tick rate, or that a deploy will not
end every match on it — and those are the three ways this deploy is known to be
able to go wrong, so the deploy job should read `/healthz` rather than trust an
exit code.

The `deploy-server` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
runs the verification after `flyctl deploy`. A missing `FLY_API_TOKEN` fails
that job: silently skipping it would leave the public application absent or
stale while CI appeared green.

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

Three things may be allowed by the reusable policy. The shipping configuration
uses only the first and third; the decision is [`NOTES.md` §2](../NOTES.md):
`packages/server/src/origin.ts`:

1. **Anything in `ALLOWED_ORIGINS`** — `https://gladiator.fly.dev`, verbatim.
2. **`^https://gladiator-[a-z0-9][a-z0-9-]*-<scope>\.vercel\.app$`** — this
   project's preview deployments *in this Vercel account*. The scope is what
   makes it a control: anybody may create a project called `gladiator-x` and be
   handed `gladiator-x.vercel.app`, which a project-only pattern would admit.
   With `VERCEL_SCOPE` unset, as it is in the Fly deployment, there is no
   preview pattern at all.
3. **`http://localhost:*`, and only when `NODE_ENV !== 'production'`.**

A missing `Origin` header is refused. A browser always sends one; something that
does not is not a browser, and this server has no non-browser clients.

None of this is authentication — `Origin` is set by browsers, not by people, and
a native client can send whatever it likes. It stops browser-based abuse and
nothing else. What stops the rest is **Limits**, below.

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
definitionally consistent because there is only one of it. Scaling out — to a
second region, which is the only reason this deploy would want it — needs a
room-to-machine directory and a way to route an upgrade at it; the sketch and
what would justify building it are [`NOTES.md` §1](../NOTES.md).

It is also why a deploy has to hand the score to the players rather than to the
next machine: there is nowhere else to put it. [`NOTES.md` §4](../NOTES.md).

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
# the client and server health, from the same app
curl -sfo /dev/null -w '%{http_code}\n' https://gladiator.fly.dev/

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
