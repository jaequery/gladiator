# docs/latency.md — input to photon

The number a duel is won and lost on, what it is made of, what it is allowed to
be, and which parts of it a commit can move.

The executable copy is [`tools/latency-harness.ts`](../tools/latency-harness.ts)
— `pnpm latency` — and its gate is `tools/latency-harness.test.ts`. Everything
below is the argument; the numbers there are the contract, and the two must not
drift apart.

---

## 0. Why this document exists

Every gate in this repository would pass with ninety milliseconds of pipeline
latency in front of it.

`pmove.test.ts` measures a jump apex to nine decimal places. `netcode.test.ts`
plays a minute over a 180 ms link and measures how far prediction was out.
`render/frameStats.ts` measures a frame *interval* and `pnpm run e2e` fails a
build over the 99th percentile of it. Not one of them can tell the difference
between a game that answers a mouse in 40 ms and one that answers it in 130,
because none of them is looking at the wall-clock between a hand moving and a
screen changing.

That gap matters more here than in most games. Gladiator's whole selling point
is Quake movement — strafe jumping is a rhythm and a rocket jump is a timing,
and both are learned against the *feel* of the response. A pipeline that is
uniformly 80 ms slow does not look broken in any screenshot, does not fail any
physics test, and makes the game feel like a video of itself.

So: a number, a budget, and something in CI that prints it.

---

## 1. What "input to photon" means here

The wall-clock between a person moving a mouse and the display showing a world
that has moved in response.

**It is about the local player only.** What you see of your *opponent* is
deliberately 80 ms in the past from real data plus the link's own delay, and
that is a different number with a different owner
(`packages/client/src/net/interpolate.ts`, and the measured budgets in
`AGENTS.md`). The half of the loop measured here is the half prediction exists
to make instant — which means it is also the half a network can never be blamed
for.

---

## 2. The six stages

| # | Stage | Whose | ms at 60 Hz (p50 / p99) |
| - | ----- | ----- | ------ |
| 1 | input transport | the OS and the browser | 4.0 / 4.0 |
| 2 | **sampling wait** | **ours** | 8.7 / 17.5 |
| 3 | **frame build** | **ours** | 4.0 / 9.0 |
| 4 | **render lag** | **ours** | 8.0 / 8.0 |
| 5 | present | the compositor | 16.7 / 16.7 |
| 6 | display response | the panel | 5.0 / 5.0 |
| | **total** | | **46.4 / 60.2** |

Measured by `pnpm latency` on the `60hz` profile. The three in bold are the ones
a commit can change; the other three are declared constants, argued in §4.

### 2.1 Sampling wait — the one that is not half a frame

Input is read **once per frame, not once per tick**. A browser only delivers
mouse and key events between frames, so a per-tick sample would be the same
value read several times with extra steps (`packages/client/src/main.ts`). An
event therefore waits for the next animation frame.

The tempting arithmetic is "half the frame interval", and it is wrong in a way
that matters. An event is more likely to land inside a *long* frame than a short
one, exactly in proportion to how long it is — so the distribution of waits is
length-biased, and its tail is the frame-time tail. At 60 Hz with a 0.2% chance
of a missed frame the mean is 8.7 ms rather than 8.3, and the 99th percentile is
17.5 rather than 16.7. Widen the frame-time distribution and this stage widens
with it, faster than the mean moves.

Which is the practical point: **frame pacing is the lever, not frame rate.** A
machine averaging 90 frames a second with a hitch every two seconds feels worse
than one holding a flat 60, and the 99th percentile is where that shows up.
`render/frameStats.ts` is where pacing is measured and `pnpm run e2e` is where
it is gated; this document is why that gate is a latency gate and not only a
smoothness one.

### 2.2 Frame build

The CPU time inside the animation-frame callback: sample input, run the
sub-steps, fold the effects, write the camera, issue the draw calls. Measured by
`render/frameStats.ts` and gated by `pnpm run e2e` against `FRAME_BUDGET_MS`.
The harness takes 4 ms as the median and 9 ms as the 99th percentile, which is
inside that gate with room to spare.

The harness does **not** re-measure it. A second opinion about a number that
already has a measurement and a gate is a second thing to keep in step.

### 2.3 Render lag — exactly one sub-step, by construction

The frame loop draws the local player interpolated between the origin *before*
the last predicted tick and the origin after it, at `alphaOf(accumulatorMs)`
(`packages/client/src/loop.ts`, and the eye in `main.ts`). The accumulator holds
precisely the wall-clock the simulation has not yet run — which is `alpha` of a
tick — so the moment being drawn is `(tick − 1 + alpha)` sub-steps in while the
wall-clock the frame was handed is `(tick + alpha)` sub-steps in.

The difference is one sub-step: **8.000 ms, on any frame schedule, exactly.**
`packages/client/src/loop.test.ts` asserts it against the real accumulator over
a deliberately ragged schedule, and `tools/latency-harness.ts` states it as
`TICK_INTERVAL_MS` rather than deriving it a second time.

It is worth being clear that this is a *choice* and not an accident: drawing the
newest state directly would remove 8 ms and make 125 Hz motion visibly stepped
on a 144 Hz display. Eight milliseconds is what smooth costs. See §5.

---

## 3. The budget

Two numbers, both 99th-percentile, both on the `60hz` profile:

| Budget | Value | What it covers |
| ------ | ----- | -------------- |
| `CONTROLLED_BUDGET_MS` | **40 ms** | stages 2, 3 and 4 — the ones a commit owns |
| `PIPELINE_BUDGET_MS` | **70 ms** | all six |

**The floor under the first is 33.7 ms** — a whole refresh of sampling wait
(16.7), one sub-step of render lag (8.0), and the frame the renderer is already
gated to build inside (9.0). None of the three can be removed without a design
change, so that is what this pipeline costs when everything is working. The six
milliseconds on top are headroom for the jitter in the model: enough that a
reseed cannot flip the gate, not enough to hide a stage somebody added.

It is a **ratchet**. Its job is to notice a regression — a second render pass, a
frame of buffering, an input path that samples on a timer instead of on the
frame — not to be aimed at. The current measurement is 34.5 ms.

Only the reference profile is gated. A 144 Hz display measures better and
failing a build for one would make the gate about hardware.

### 3.1 What to do when it is over

In the order worth trying, and each with what it costs:

1. **Find the frame-time tail.** `pnpm run e2e` and the `?dev=1` panel's
   `fps · p99` row. A hitch is worth two or three milliseconds of p99 latency,
   for free, and it is nearly always a shader compile, a texture upload or a
   garbage-collection pause rather than steady-state work.
2. **Check nothing was added to the frame path.** A full-screen post-processing
   pass is latency on every frame to make a *still* frame prettier, which is why
   ESLint refuses the names and `render/postprocess.test.ts` asserts the chain
   is empty (`docs/renderer.md` §13).
3. **Check input is still sampled on the frame.** Reading the mouse on a timer,
   or debouncing it, adds a whole stage. `input/controller.ts`.
4. **Only then consider the render lag.** Removing it is 8 ms and costs visibly
   stepped motion; it is the last thing to spend, not the first.

### 3.2 Measuring a real device

The model is a model. `pnpm latency --samples frames.json` takes a JSON array of
real frame intervals in milliseconds and runs the same measurement over them —
which is the honest way to answer "what does this actually cost on the machine
that felt bad".

The intervals come off a running page:

```js
copy(JSON.stringify(window.__gladiator.frameIntervals()))
```

That is the raw window rather than a summary, deliberately — this measurement is
a function of the frame-time *tail*, and a percentile cannot be un-summarised.

---

## 4. The declared stages, and where their numbers come from

CI has no mouse, no compositor and no panel, so three of the six stages cannot
be measured here. They are still in the total, because a budget that omitted
them would be a budget for a number nobody experiences. Each is conservative,
and each is a number a person with a high-speed camera could go and check.

**Input transport, 4 ms.** A 1000 Hz wired mouse polls every millisecond; the OS
coalesces to its input thread and the browser to its compositor thread, and the
event reaches the page's task queue after a frame's worth of plumbing. Four is
the conservative middle of the published measurements. A trackpad or a 125 Hz
mouse is worse and nothing in this repository can help it.

**Present, one refresh interval.** A double-buffered compositor scans out the
frame built during interval *n* during interval *n + 1*. It scales with the
profile because it is a refresh, not a constant.

**Display response, 5 ms.** Grey-to-grey plus half a scanout on a mid-range IPS
gaming monitor. An OLED is nearer 1 ms and an office LCD nearer 15.

Changing one of these changes the reported total, so it is a deliberate act
rather than a drift — which is why the pipeline budget is gated too, even though
CI cannot influence what it is measuring.

---

## 5. What is deliberately not on the list

**The jitter buffer.** The host holds two ticks of a peer's commands on purpose
so that a packet 16 ms late still has something to execute
(`packages/server/src/inputQueue.ts`). That is 16 ms of latency the player paid
for — but they paid it on the *server's* side of the loop, and prediction means
they do not see it: the local world responds immediately and the buffer only
decides when the authoritative world catches up. It is a real cost and it
belongs to the netcode budgets in `AGENTS.md`, not to this one.

**The client's lead.** Same argument, same reason: it is how far ahead of the
server this client simulates, and it is invisible to the hands.

**Anything about the opponent.** §1.

---

## 6. Where the numbers live

| Thing | Where |
| ----- | ----- |
| the measurement, the profiles, the budgets | `tools/latency-harness.ts` |
| the gate, in the suite | `tools/latency-harness.test.ts` |
| the CI-visible number | `pnpm latency`, inside `pnpm run ci` |
| the one-sub-step render lag, proved | `packages/client/src/loop.test.ts` |
| frame pacing, measured in a real browser | `render/frameStats.ts`, `pnpm run e2e` |
| the live readout while playing | `?dev=1` — `packages/client/src/ui/devHud.ts` |
