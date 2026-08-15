# Browser support

Which browsers Gladiator is playable in, what each one does with the two APIs a
duel cannot be played without — **pointer lock** and **raw mouse input** — and
what the game does where the answer is no.

Raw mouse input has been called mandatory here since the movement was ported,
and which browsers actually give it has been an open question the whole time —
[`docs/renderer.md`](./renderer.md) §10 deferred it to "the settings screen can
be honest about it". This document is what closes it: the matrix below is
measured by a script anybody can run, and the fallback for every "no" in it is
implemented and tested rather than described.

Vocabulary is in [`CONTEXT.md`](../CONTEXT.md); the renderer's own backend
fallback is [`docs/renderer.md`](./renderer.md) §1.

---

## §1 The target

**A desktop browser, from the last two years, with a mouse.**

That is not a hedge — it is the smallest set the game is honest in. Everything
below is a consequence of one sentence in the goal: *movement a Quake player
would recognise*. A duel is decided by flicks, and a flick is a learned physical
gesture: the same hand movement has to produce the same angle every time. Three
things have to be true for that, and each one is a row in this document.

| Requirement | API | Where a "no" is handled |
| ----------- | --- | ----------------------- |
| The mouse can be captured | Pointer Lock | `ui/unsupported.ts` — the bounce page |
| The deltas are unaccelerated | `unadjustedMovement` | `input/pointerLock.ts` — retry plain, and warn |
| The arena can be drawn | WebGPU or WebGL2 | `render/renderer.ts` — WebGPU first, WebGL2 second |
| The sounds can be played | Web Audio | `audio/engine.ts` — a quiet game, never a broken one |

A phone satisfies none of the first two and never will, which is why it gets a
page of its own rather than a degraded game: §5.

---

## §2 Raw mouse input, and why it is two questions

By default a browser hands a page the deltas the desktop gets, with the
operating system's pointer acceleration already applied: move the mouse faster
and the same physical distance turns you further. Correct for a cursor,
disqualifying for a shooter — with acceleration on, the skill that separates two
players is partly the mouse driver's.

`Element.requestPointerLock({ unadjustedMovement: true })` asks for the raw
device deltas instead. Whether a page *gets* them is two questions, and
conflating them is the bug this document exists to prevent:

1. **Does `requestPointerLock()` return a promise?** The current Pointer Lock
   specification reports success through `pointerlockchange` and
   `pointerlockerror` events and returns nothing; [a proposed
   update](https://github.com/w3c/pointerlock/pull/49) returns a `Promise`. A
   browser on the older shape takes the options object, ignores the member it
   does not know, and locks — and there is no other feature detection, so it can
   neither confirm nor deny that the flag was applied.
2. **Does that promise resolve?** Resolving is the browser saying it applied raw
   input. Rejecting with `NotSupportedError` is it saying this **platform**
   cannot — which is why the matrix has an operating system in it. Gecko
   implements `unadjustedMovement` on macOS and Windows and rejects on Linux and
   Android ([Bugzilla 1829401](https://bugzilla.mozilla.org/show_bug.cgi?id=1829401)).

So the game keeps three states and not two — `granted`, `refused`, `unknown` —
and the fallback warning covers `unknown` as well as `refused`. Promising raw
input on a browser that never said it applied it is the same bug as promising it
on one that said it did not.

### What is documented

Per [MDN's compatibility data](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestPointerLock)
and [caniuse](https://caniuse.com/mdn-api_element_requestpointerlock_options_unadjustedmovement_parameter),
read 2026-08-15:

| Engine | `unadjustedMovement` | Notes |
| ------ | -------------------- | ----- |
| Chrome, Edge (Blink) | **88+** | The original implementation; the promise form came with it. |
| Firefox (Gecko) | **152+** | macOS and Windows only — Linux and Android reject with `NotSupportedError`. Firefox 152 also added the promise-returning form. |
| Safari (WebKit), desktop | **18.4+** | |
| Safari on iOS | **never** | Pointer lock itself is unavailable; §5 bounces these anyway. |

A browser older than those is not broken here — it is accelerated, it says so on
the settings screen, and it plays.

### What was measured

The block below is written by `pnpm run raw-input`, which opens each browser
Playwright can start, takes a real pointer lock from a real click, and records
the browser's own answer. It is the same question `input/pointerLock.ts` asks at
run time, so the table and the game cannot disagree.

A run fills in the row for **the platform it ran on** and no other. The Windows
and macOS columns are the ones most players are on and the ones CI cannot reach;
run the command there and add the block if you have such a machine.

<!-- probe:start -->

Measured on **linux x64** by `pnpm run raw-input`.

| Engine | Build | Verdict | What the browser did |
| ------ | ----- | ------- | -------------------- |
| Chromium | 151.0.7922.34 | `refused` | rejected with NotSupportedError; the plain retry locked |
| Firefox | 153.0 | `refused` | rejected with NotSupportedError; the plain retry locked |
| WebKit | — | `not measured` | could not be launched here: Error: browserType.launch: Target page, context or browser has been closed |

<!-- probe:end -->

**The finding, stated plainly: on Linux there is no raw mouse input, in any
browser.** Both engines that would start here refused the flag with
`NotSupportedError` and locked without it — Gecko because it implements the
option on macOS and Windows only, and Blink for the same reason on the same
platform. That is not a headless artefact of the kind the caveats below cover:
it is the request being answered, in words, by the browser. A Linux player gets
accelerated input, the settings screen says so, and the game plays.

It also means **CI can never see a `granted`**, which is worth knowing before
reading a green run as coverage. The rows that matter to most players — Windows
and macOS — are documentation until somebody runs the command on one.

Two caveats worth knowing before reading too much into any row:

- **Playwright's "WebKit" on Linux is not Safari.** It is a WPE build of the same
  engine with different platform code underneath, and raw input is precisely the
  part that is platform code. The Safari row above is documentation, not
  measurement, and that is the honest state of it.
- **A headless browser has no mouse.** What is measured is whether the browser
  *claims* it applied raw input, not whether the deltas that follow are
  unaccelerated — there is no way to measure the second without a physical mouse
  and a known acceleration curve. The claim is what a page can act on, so the
  claim is what is recorded.

---

## §3 What the game does about it

`packages/client/src/input/pointerLock.ts`, and it is sixty lines because the
interesting part is the failure:

- The lock is requested with `{ unadjustedMovement: true }`.
- On **any** rejection — not only `NotSupportedError` — the request is retried
  without the flag. Accelerated input is much better than no game, and an engine
  that rejects for a reason nobody anticipated must still leave the player able
  to play.
- The verdict is recorded as `granted`, `refused` or `unknown` and put on the
  settings screen in words, with a warning under it for the two that are not
  `granted`. The warning says what it actually means for the player: their
  cm/360 is then only exact at a steady hand speed.
- The verdict is a property of the *browser*, so it survives the lock being
  dropped and retaken. A warning that flickered on every escape is a warning
  nobody reads.

`input/pointerLock.test.ts` drives all three answers through fakes shaped like
the engines above — a promise that resolves, one that rejects, and a
`requestPointerLock` that returns `undefined` — so the fallback is tested on
every engine's behaviour, including the ones this machine cannot start.

---

## §4 Pointer lock, escape, and why nothing retries on a timer

Every browser refuses to re-lock for a moment after the *player* released the
lock with escape. MDN is explicit that a transient activation is not enough:

> If calling `requestPointerLock()` immediately after releasing the pointer lock
> via the default unlock gesture (instead of through an `exitPointerLock()`
> call), the call will fail, even if a transient activation is available.

This is deliberate — it stops a page trapping a pointer the player just freed —
and it is the reason the pause screen is shaped the way it is. Escape drops the
lock, `ui/menu.ts` puts the pause screen up over a match that is *still running*,
and getting back in is a fresh click on a button. There is no `setTimeout`
anywhere in that path, because a re-lock on a timer fails in every browser. A
refusal is reported (`PointerLock.onDenied`) and turned into a sentence asking
for another click.

Nothing is torn down while the screen is up: the socket, the room code, the
settings and the match all outlive it, which is what `scripts/e2e.mjs` checks by
comparing the session either side of a release.

---

## §5 Phones, tablets, and everything with no mouse

A room code is a link sent through a chat app, and a chat app is mostly read on
a phone — so the second player's *first* contact with this game is, more often
than not, a device it cannot be played on. They get `ui/unsupported.ts`: one
sentence saying why, the room code, and the link with a copy button so they can
open it on a machine with a mouse.

What is detected is capability, never the user-agent string:

| Signal | Meaning |
| ------ | ------- |
| No `Element.prototype.requestPointerLock` | No mouselook is possible at all. |
| `(pointer: coarse)` and not `(pointer: fine)` | The primary input is a finger. |
| `navigator.maxTouchPoints > 0` and not `(pointer: fine)` | The same, for browsers that answer one and not the other. |

A touchscreen laptop matches both `coarse` and `fine` and is let through, which
is the case a user-agent sniff gets wrong. A browser that answers neither media
query is also let through: a false bounce turns a working machine away, while a
false pass shows a player a menu that does not respond, which they can at least
see and leave.

---

## §6 The renderer and the audio

Both already degrade, and neither is this document's to argue:

- **WebGPU first, WebGL2 second** (`render/renderer.ts`,
  [`docs/renderer.md`](./renderer.md) §1). A machine with neither gets a
  sentence on the page rather than a blank canvas — `hud.fail`.
- **Web Audio, or a quiet game.** A context that cannot be created, or sounds
  that cannot be fetched, is a warning and a counter in the debug snapshot; the
  match plays. [`docs/audio.md`](./audio.md).

---

## §7 Re-measuring

```
pnpm run raw-input             # print the table for this machine
pnpm run raw-input -- --write  # write it into §2 and commit the diff
pnpm run raw-input -- --check  # fail if the committed table has drifted
```

It needs Playwright's browsers (`pnpm exec playwright install --with-deps
chromium firefox webkit`) and is deliberately outside `pnpm run ci` for the same
reason `pnpm run e2e` is: a browser download has no business slowing down a
typecheck. An engine that will not start on the machine is recorded as *not
measured* rather than as a verdict — an incomplete run must not read as a
finding.

### The CI job it wants

Not committed, because the token that opened the pull request this arrived in
had no `workflow` scope and GitHub refuses the push outright. It is four minutes
of somebody's time and belongs in `.github/workflows/ci.yml` beside the
`e2e` job:

```yaml
  # Does a browser actually hand a page raw mouse deltas? Measured on every push
  # rather than assumed. It reports rather than gates, and the reason is in the
  # table above: raw input is a property of the browser *and* the operating
  # system, so a Linux runner can only ever confirm the Linux rows.
  raw-input:
    name: raw mouse input matrix
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v5
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v5
        with:
          node-version-file: .nvmrc
          cache: pnpm
      - name: Install
        run: pnpm install --frozen-lockfile
      - name: Install browsers
        run: pnpm exec playwright install --with-deps chromium firefox webkit
      - name: Probe
        run: pnpm run raw-input | tee -a "$GITHUB_STEP_SUMMARY"
```

`--check` rather than a bare run would gate it, and it is safe to: the check
compares *verdicts* and only for engines both the runner and the document have
one for, so a Playwright upgrade that moves a build number does not turn the
build red.
