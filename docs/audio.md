# Audio

Settings, and why each of them is what it is. Conventions are in
[`AGENTS.md`](../AGENTS.md); the axis map is in
[`docs/physics-spec.md`](./physics-spec.md) §0.3; asset licensing is recorded
in [`credits.json`](../credits.json), rendered to
[`CREDITS.md`](../CREDITS.md), and argued in
[`docs/assets.md`](./assets.md) §6.

The audio system is `packages/client/src/audio/`. It is the second consumer of
netstate, beside the renderer, and it obeys the same rule the renderer does: it
plays what the simulation says happened, and it never decides that something
happened. The target is a game you could play with your eyes closed and still
know what just occurred.

---

## §1 Two buses, on purpose

There are exactly two paths from a decoded buffer to the speakers, and which
one a sound takes is a decision about *whose event it is*, not about what the
sound is.

**The feedback bus** (`feedback.ts`) is source → gain → bus → master. No
panner, no distance model, nothing in between. It carries your own weapon fire,
your hit confirmation, the damage you took, and the round bells.

**The world bus** (`positional.ts`) is source → gain → HRTF panner → bus →
master. It carries everything that happened out there: the opponent's weapons,
explosions, their footsteps.

The same rocket-launcher sample goes down both, depending on who fired it —
`sounds.ts` says which buses a sound is *allowed* on and the call site picks.
Three sounds are feedback-only and each for the same reason: a hit confirmation,
the damage you just took and the round bell are all things you must hear at full
volume regardless of where in the arena the event occurred. A hit confirmation
attenuated by distance is quietest at exactly the range where landing the shot
mattered most.

The cost side is real too. An HRTF panner is a pair of convolutions per voice; a
gain node is a multiply. Sounds that gain nothing from being placed do not pay
for it, and the world bus is capped at `MAX_WORLD_VOICES` (24) while feedback
never queues behind anything.

## §2 HRTF, and the control that proves it

`panningModel = 'HRTF'`, always. The alternative, `equalpower`, is a volume knob
per ear: it is a function of azimuth alone, so a rocket fired directly behind
you renders **bit-identically** to one fired directly in front. In a duel that
is the difference between turning around and dying.

That claim is measured rather than asserted. `probe.ts` renders the real asset
through the real world bus into an `OfflineAudioContext`, in front of and behind
the listener, under both models, and `scripts/audio-check.mjs` compares them.
Measured in headless Chromium at 44 100 Hz:

| Measurement | `equalpower` | `HRTF` |
| ----------- | ------------ | ------ |
| front vs behind, RMS of the difference | exactly 0 | 42% of the signal |
| source 90° to the right: interaural delay | 0.00 ms | 0.75 ms, right ear first |
| source 90° to the right: level difference | — | 2.1 dB |

0.75 ms is about the widest delay a human head produces, which is what a source
at 90° should give. Note how small the *level* difference is: a rocket launcher
is mostly bass, and a wavelength longer than a head diffracts around it instead
of being shadowed by it. Panning by volume alone would barely place it at all.

`probe.ts` ships in the production bundle, hung off `window.__gladiator.audio`,
because HRTF quality is a property of the browser's impulse-response database —
being able to run the measurement on the machine that sounds wrong is worth more
than a number measured once in CI.

## §3 The context is ours, and there is no Howler

`createBrowserAudioContext()` is `new AudioContext({ latencyHint: 'interactive' })`
and nothing else. Two decisions:

- **`latencyHint: 'interactive'`** asks for the smallest buffer the browser will
  give. `'playback'` would hand out roughly 20 ms.
- **No `sampleRate` option.** Passing one makes the browser resample every
  render quantum into the device rate, forever, in the audio thread. The
  device's own rate costs nothing.

Howler.js is the obvious import and the wrong one: it is architected around an
HTML5 `<audio>` fallback path, which is right for background music and wrong for
a shooter, and it owns the `AudioContext` — which means it owns both decisions
above.

## §4 Everything is decoded before the match

`AudioEngine.load()` fetches and decodes the whole catalogue up front.
`playFeedback` and `playWorld` do a `Map` lookup and nothing else. There is
deliberately **no lazy path**: a sound that has not been decoded does not play
and increments a counter, rather than teaching the engine to decode mid-match.

`decodeAudioData` is asynchronous and allocates; doing it when a rocket is fired
is a hitch at the moment the player is paying most attention, and the sound
arrives late anyway. `AudioSnapshot.decodesAfterLoad` makes it a measurement:
the browser check plays every sound on both buses and reads it back as zero.

## §5 Scheduling is against `currentTime`

Every voice starts at `AudioContext.currentTime` — the audio clock — and never
via `setTimeout`. A timer is the main thread's clock, which is the one that
stutters when a garbage collection lands; routing sound through it turns a frame
hitch into an audible one.

Measured end to end in headless Chromium, from `playFeedback` to audible output:

| | ms |
| - | -- |
| scheduling lead over `currentTime` | 0.000 |
| main-thread cost of the `play` call | 0.000 |
| the file's own attack, to −40 dBFS | 0.09 |
| the device's `baseLatency` | 10.00 |
| **total** | **10.09** of a 16.7 ms frame |

## §6 One gesture, two things that need one

Browsers will not start an `AudioContext` without a user gesture and will not
grant pointer lock without one either. `gesture.ts` puts both calls in one
handler on the canvas click, so the click that puts a player into the game is
the click that starts their audio. The failure mode it exists to prevent is
subtle and common: a `resume()` on a start button the player never pressed, and
a first rocket that is silent.

Audio resumes *before* the lock is requested, because `requestPointerLock` can
throw synchronously and the resume would then never run — which is precisely the
silence this is about.

## §7 Cues are a fold over netstate

`cues.ts` is `animState.ts`'s twin, for ears. The input is `PlayerNetState` — the
same deeply-readonly copy the renderer draws from — and the output is a list of
cues. Nothing plays a sound where the sound is *caused*: not in the input
handler, not from the animation system.

Sound is made of edges, so it is a fold rather than a function of the current
state. "They fired" is `lastFireTick` differing from the one last seen; "they
landed" is being on the ground after not being; "you hit them" is their health
going down. A player seen for the first time produces **no cues at all**, which
is what stops a spawn from sounding like a landing, a hit and a shot at once.

Two consequences worth knowing:

- **Footsteps come from distance, not from a timer.** One step per 128 qu of
  ground travel, so the rate is the same at 60 Hz and at 240 Hz, and a player
  being shoved by a rocket does not sprint in place. You never hear your own:
  they would mask the one sound that tells you where somebody is when you cannot
  see them.
- **Hit confirmation has no attribution yet.** Nothing in `EntityState` says who
  took the health, so an opponent who rocket-jumps rings your hit confirmation.
  Damage events with an owner belong to GLAD-0QWRYK and GLAD-5QGO11; when they
  land, the rule reads their attribution instead of inferring one.

## §8 The sounds are synthesised, and that is a licensing decision

`tools/synth-audio.ts` generates every WAV from arithmetic — no downloads, no
sample packs. A pack's licence is a promise about provenance made by a stranger,
and the repository that ships the file is the one holding the problem when the
promise is wrong. Mixamo is the well-known version of the trap: free with an
account, and its licence forbids redistributing the raw files.

The artifacts are committed (so a Vercel build needs no bake in front of it) and
the bake is **bit-reproducible**: every operation is one IEEE 754 pins down, and
`sinRad` comes from `packages/sim` precisely because `Math.sin` is
implementation-approximated. `tools/audio-assets.test.ts` re-synthesises in
memory and fails if what is committed is stale, if the set exceeds its 320 KiB
budget, or if anything in `public/audio/` is missing from `CREDITS.md`. That
last one has a second, stronger lock behind it: every sound has an entry in
`credits.json`, and `pnpm assets:build --check` fails on any committed file
under `public/` that no entry accounts for — including a `.wav` somebody drops
in by hand.

22 050 Hz, mono, 16-bit — one honest step up from Quake's own 11 025 Hz 8-bit,
and 241 KiB for the set. Nyquist at 11 kHz keeps the 4–10 kHz band HRTF uses for
front/back and elevation cues.

## §9 Running the checks

```
pnpm run audio:verify                              # build, then check
pnpm run audio:verify -- --skip-build              # reuse packages/client/dist
pnpm run audio:verify -- --write-probe probe.wav   # and write it to listen to
```

It needs Chromium, the same way `pnpm run e2e` does, so it belongs in that CI
job rather than in `pnpm run ci`. **This step is not in
`.github/workflows/ci.yml` yet** — the token this branch was pushed with has no
`workflow` scope, so adding it has to be a separate edit by a human:

```yaml
      # in the `e2e` job, after the End-to-end step
      - name: Audio
        run: pnpm run audio:verify -- --skip-build
```

## §10 What is not here yet

The catalogue is complete and two of its sounds have no caller, because the
events do not exist yet:

- **`explosion`** is fired by whoever detonates a rocket — GLAD-0QWRYK, with
  server-authoritative rockets in GLAD-5QGO11. `playWorld(SoundId.Explosion,
  origin)` is the entry point.
- **`round-start` / `round-end`** belong to the round rules, GLAD-L4SYN9.
  `playFeedback(SoundId.RoundStart)`.

Both are exercised by `scripts/audio-check.mjs`, which plays every sound in the
catalogue, so they are proven to load and play — they are simply waiting for a
game rule to ring them.

A volume control belongs to the settings screen, GLAD-NPCTU8:
`createAudioEngine({ masterGain })` is where it lands.
