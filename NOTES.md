# NOTES.md — the operational decisions, and the numbers behind them

Deploying Gladiator is [`docs/deploy.md`](./docs/deploy.md): the runbook, the
commands, the shape of the thing. **This** file is the other half — the four
decisions the deploy forced, each with the number it was made from and the
observation that would change it.

They are here rather than in the runbook because a runbook is read while
something is on fire and a decision is read six months later by somebody
wondering why. Everything below is dated, and every claim is either measured on
a machine named in the row or labelled as nominal.

---

## 1. Region: `iad`, and a latency budget by geography

**Decided 2026-08-15. `primary_region = "iad"` in `fly.toml`.**

### Why a region is a bigger decision here than it looks

One machine holds every room, on purpose: a room is a live `GameState` being
advanced 125 times a second and there is no version of that which shards
(`packages/server/src/rooms.ts`). So both players in a duel connect to the same
region, and **the pair's experience is the worse of their two round trips.** A
room code is a thing you send to a friend, and the friend may be on another
continent — which makes this a gameplay decision wearing an infrastructure hat.

### The budget, and where it comes from

Not invented here. `packages/client/src/net/netcode.test.ts` plays a minute per
link profile against a real host and measures how often the client's predicted
position has to be corrected by more than a unit — the thing a player feels as
the world moving under them:

| Round trip | Corrections over 1 qu | Host sub-steps on the input fallback |
| ---------- | --------------------- | ------------------------------------ |
| LAN        | 0.13%                 | 0.05%                                |
| 40 ms      | 1.4%                  | 1.1%                                 |
| 80 ms      | 4.9%                  | 4.5%                                 |
| 180 ms     | **30%**               | **26%**                              |

The acceptance budget is 5%. So:

> **The budget is 80 ms round trip for *both* players.** Under 40 ms is
> indistinguishable from local. At 180 ms the netcode is measurably outside its
> own budget — a fixed two-tick jitter buffer against ±25 ms of jitter — and the
> fix is an adaptive buffer, not a region.

### Round trips by geography — nominal, and to be replaced by measurement

Typical public-internet figures, not measurements from this deploy. The first
column is the region we run in.

| Player is in    | to `iad` | to `ord` | to `ams` | to `sjc` |
| --------------- | -------- | -------- | -------- | -------- |
| US East         | **15**   | 25       | 90       | 70       |
| US Central      | 30       | **15**   | 105      | 50       |
| US West         | 70       | 55       | 145      | **15**   |
| UK / EU West    | 85       | 100      | **20**   | 145      |
| EU Central      | 100      | 115      | **25**   | 160      |
| Brazil          | 125      | 140      | 200      | 180      |
| Japan           | 165      | 160      | 230      | 105      |
| Australia       | 215      | 205      | 280      | 155      |
| India           | 220      | 230      | 140      | 230      |

**`iad` wins because of the pairs it makes playable, not the individuals.** The
duels this game is for are US↔US and US↔EU: `iad` puts a US player at 15–70 ms
and a European at 85–100 ms, so the worse half of a transatlantic pair is at the
edge of the budget rather than past it. `ams` would invert that and lose the US
West player entirely; `ord` is a worse `iad` for every pair that crosses the
Atlantic and a better one only for a duel played entirely in the Midwest.

**What this deploy is honestly bad at:** any pair with an Asia-Pacific or
Indian player in it. At 165–220 ms that is the 180 ms row above, and the game
will feel like the 180 ms row. It is not a region away from being fixed.

### What would change the answer

- **Two players who both live outside NA/EU.** A second region does not follow
  from that on its own: a room is one process, so multi-region needs a
  room-to-machine directory and a way to route an upgrade at it. The cheap
  version is to put the region in the room code — mint it in the region the
  creator is nearest, and let `wss://` carry the code so the proxy can route on
  it — and the room code is already six characters of the creator's choosing.
  That is a ticket, not a config change.
- **An adaptive jitter buffer.** `packages/server/src/inputQueue.ts` holds two
  ticks for everybody; steering it on the jitter the server already measures
  would move the 180 ms row more than any region can.
- **A measured table.** The one above is nominal. The first cross-continent
  playtest should replace it, and `/healthz` plus the HUD's RTT readout
  (GLAD-BHNPOE) are where the numbers come from.

---

## 2. The origin allowlist: project **and scope** scoped, failing closed

**Decided 2026-08-15. `packages/server/src/origin.ts`, tested in `origin.test.ts`.**

A WebSocket upgrade is not subject to CORS and triggers no preflight: the
browser sends `Origin` and then does whatever the server says, so any page on
the internet can open a socket to this server unless the server checks. That is
cross-site WebSocket hijacking, and this check is the whole defence.

The ticket's framing was exactly right — a regex tight enough to be a control
rejects some preview deployments, and one loose enough to accept all of them is
not a control. Three candidates:

| Candidate | Admits | Verdict |
| --------- | ------ | ------- |
| Production origin only | `gladiator.vercel.app` | Airtight, and every preview fails to connect in a way that looks exactly like the server being down — so the person testing the preview files the wrong bug. |
| `^https://[a-z0-9-]+\.vercel\.app$` | every preview | And every page every other Vercel customer on earth has ever deployed. A wildcard in a regex costume. |
| **`^https://gladiator-[a-z0-9][a-z0-9-]*-<scope>\.vercel\.app$`** | this project's previews in this account | **Chosen.** |

**The scope is the load-bearing half, and it is the part the obvious version
gets wrong.** `^https://gladiator(-[a-z0-9-]+)?\.vercel\.app$` looks
project-scoped and is not: anybody may create a Vercel project called
`gladiator-x` and be handed `gladiator-x.vercel.app`, which that pattern
admits. The account slug Vercel appends to every generated preview hostname is
globally unique, so requiring it means an attacker would have to own our
account.

Three consequences, all deliberate:

1. **Production goes in `ALLOWED_ORIGINS`, not in the pattern.** It is one fixed
   string; a pattern that also matched it would need to allow an empty middle,
   which is the hole above.
2. **No `VERCEL_SCOPE`, no previews.** Not a looser fallback — none. A deploy
   that forgot the variable loses preview connectivity, which is visible and
   recoverable in one command; silently downgrading to the pattern that is not a
   control is neither. The boot log says which state the process is in.
3. **This is not authentication.** `Origin` is set by browsers, not by people.
   It stops browser-based abuse and nothing else, in front of a server that is
   authoritative anyway. The rest is GLAD-V7M6PQ.

```sh
flyctl secrets set ALLOWED_ORIGINS=https://gladiator.vercel.app
flyctl secrets set VERCEL_SCOPE=<team-slug>     # the tail of a preview hostname
```

---

## 3. Machine size: `shared-cpu-1x`, from measured tick jitter

**Decided 2026-08-15. `[[vm]]` in `fly.toml`.**

The budget is a p99 wakeup lateness of one tick — 8 ms, `WAKEUP_BUDGET_MS` in
`packages/server/src/scheduler.ts`, and `docs/deploy.md` argues why p99 and why
one tick. Measured with `pnpm --filter @gladiator/server run jitter`, which runs
the shipping scheduler over real rooms rather than a bare timer:

| Machine | Load | Frames | p50 | p99 | max | resyncs | dropped | Rate |
| ------- | ---- | ------ | --- | --- | --- | ------- | ------- | ---- |
| Dev box, Linux x64, Node 20, idle | 8 rooms | 1250 | 0.000 ms | 1.851 ms | 2.955 ms | 0 | 0 ms | 125.0 Hz |
| Dev box, 4 busy-loops competing | 50 rooms | 3745 | 0.000 ms | 2.330 ms | 11.976 ms | 3 | 0 ms | 125.0 Hz |
| Dev box, ~17 concurrent agent processes (2026-08-15) | 8 rooms | 1875 | 0.000 ms | **3.824 ms** | 7.683 ms | 0 | 0 ms | 125.0 Hz |
| Fly `shared-cpu-1x` | — | — | — | — | — | — | — | — |

The third row is the one this decision rests on: a box with seventeen other
processes fighting it for cores held **3.8 ms at the 99th percentile, no
resyncs, no dropped simulated time, and exactly 125.0 Hz**. That is less than
half the budget under contention of the kind `shared-cpu-1x` exists to expose
you to, so the cheap machine is the right starting point and the expensive one
would be a guess in the other direction.

**The Fly row is still empty and only the first deploy can fill it.** A laptop
measures a laptop. It is filled from the live machine:

```sh
curl -sf https://gladiator.fly.dev/healthz | jq '.scheduler, .jitter'
flyctl ssh console -a gladiator -C "node -e ''"   # or run the jitter tool there
```

### The escalation rule

In order, and only in this order:

1. **`resyncs` or `droppedMs` nonzero** — a different problem from ordinary
   lateness. The machine stalled for longer than 250 ms; suspect GC or eviction
   before spending money.
2. **p99 over 8 ms with clean resyncs** — `performance-1x`, a dedicated core.
   $32.19/month against $3.32, which is the whole of the argument for measuring
   first.
3. **Never raise `HOST_FRAME_MS`.** It hides lateness in the accumulator instead
   of removing it; the snapshots just arrive in bigger lumps.

### What it costs

List prices, US regions, read from Fly's pricing page on 2026-08-15 — check the
[calculator](https://fly.io/calculator/) before quoting them at anybody:

| Item | Price |
| ---- | ----- |
| `shared-cpu-1x`, 512 MB, running 24/7 | **$3.32/month** |
| `performance-1x`, 2 GB (the escalation) | $32.19/month |
| Egress to the public internet, NA/EU | $0.02/GB |

Bandwidth is not the cost, and it is worth knowing by how much. Measured off the
real frames this protocol sends:

| Frame | Size |
| ----- | ---- |
| `snap` (the whole authoritative world) | 225 B |
| `hash` | 39 B |
| `cmds`, one 60 Hz frame's worth | 66 B |

At 62.5 host frames a second down and 60 client frames a second up, that is
**16.1 KiB/s down and 3.9 KiB/s up per player** — a ten-minute duel is 23 MiB
across both players, and its egress costs **$0.0004**. A thousand duels a month
is forty cents. The machine is the bill; the game is a rounding error on it, and
it would take about 8,000 duels a month for egress to match one month of the
cheap machine.

`/healthz` carries a live `traffic` block (`bytesIn`, `bytesOut`, and the
message counts) so this arithmetic can be re-done against reality rather than
against a fixture.

---

## 4. Deploys do not end matches: the drain and the resume ticket

**Decided 2026-08-15. `packages/server/src/shutdown.ts`, `resume.ts`,
`health.ts`; proved end to end in `deploy.test.ts`.**

A room is a live world in one process's memory, so a deploy destroys it. There
is nothing on the new machine to reconnect *to* — which is why "reconnect" alone
was never going to be enough, and why the score travels with the players.

What happens on SIGTERM, in order:

1. `/healthz` answers **503** and new upgrades are refused with a `Retry-After`.
   Fly's proxy stops sending new players within a health-check interval; the
   sockets already open are untouched.
2. Every seated peer is handed a `drain` frame: the room code, when to come back
   (3 s, about a blue/green cutover), and a **resume ticket** — HMAC-SHA256 over
   the room, the seat and the scoreline, signed with `RESUME_SECRET`, good for
   two minutes.
3. Half a second later the rooms are closed with a **1001 "going away"** — the
   code that means "come back", as against 1006's "the wire broke".
4. The process waits for the sockets to finish closing, up to 20 s, and exits.

The client reconnects with `?room=<code>&resume=<ticket>`; the new machine
verifies the signature, rebuilds the room under the same code at the signed
score, and seats each player back in the seat their own ticket names.

**Why the ticket is signed.** Because a score that crosses a machine inside a
client is otherwise a score the client can choose, and "resume me at 2-0" would
be a button. Same reasoning as the round-trip measurement staying on the server:
a number that decides something must not come from the party it decides for.

**What is deliberately not promised.** The drain does not wait for the round to
finish. A best-of-five runs for minutes and `kill_timeout` is thirty seconds, so
waiting is a promise that cannot be kept — and a deploy that waits for the last
duel is a deploy that never ships on a busy evening. What is promised is that
nobody is cut off silently.

**The one thing an operator has to do:** set the secret, once, and never rotate
it during a deploy — a machine cannot read a ticket signed with a key it does
not have.

```sh
flyctl secrets set RESUME_SECRET="$(openssl rand -hex 32)"
./scripts/verify-deploy.sh https://gladiator.fly.dev "$(git rev-parse --short HEAD)"
```

That script is the deploy gate: readiness, the build actually being served, the
live jitter budget, and whether this machine can resume a match. It belongs in
the `deploy-server` job in CI and is not wired in yet — the two-step change, and
why it was left out, are in `docs/deploy.md` under **Wiring the gate into CI**.

Without it the server still sends the drain frame, still closes with 1001, and
carries an empty ticket: a client learns this was a deploy rather than a crash,
and the match is over. The boot log and `/healthz` both say so, and
`scripts/verify-deploy.sh` warns on it after every deploy.

---

## Where the reconnect policy lives

The half of this that runs in the browser — which close codes are worth
retrying, the backoff, the grace window, what a player is shown while it happens
— is GLAD-DVDV6P (`packages/client/src/net/reconnect.ts`). The seam between the
two tickets is the `drain` frame and the two query parameters, and nothing else:
a server that drains and a client that comes back are separate concerns that
meet at a URL.
