# Making Gladiator more fun

A design proposal for **Gladiator** — the browser-native *Rocket Arena* recreation
in this repository. Ticket GLAD-KOSA8U. Nothing here is implemented; every
recommendation is a proposal with the files it would land in and what it would
cost.

## How to read this

Three decisions were confirmed before drafting, and they shape everything below:

- **Focus: core gameplay mechanics.** Progression, cosmetics, ranking and social
  features are deliberately out of scope — see *What I left out* at the end.
- **The bot comes first.** A room code needs a friend who is awake, and the quick-match
  queue may find nobody; the bot is the opponent that is always there. Where two
  recommendations compete, the one that improves the single-player duel wins.
- **Invariants may be challenged, if the challenge is labelled.** Recommendations that
  would break one of the repo's mechanically-enforced rules are marked **⚠ breaks an
  invariant** and say which one and what it costs. Everything unmarked fits inside the
  rules as they stand.

Each recommendation carries four lines: **Targets** (the game system and the files),
**Why it is more fun**, **Cost**, and **Risk**. Cost is S (about a day), M (a few days),
L (a week or more), XL (a project).

---

## What I found

Five observations, each read off the repository rather than guessed at. They are the
reason the recommendations are ordered the way they are.

**1. Every round of every match opens in the same two corners.** `maps/arena1.ts` has
exactly two spawn points, at `(-352, -352)` and `(352, 352)`. A round start is
"which pair, then which end" — two draws from the seeded PRNG (`docs/physics-spec.md`
§6.2) — but with two spawns there is exactly *one* legal pair, so the first draw picks
from a set of one and only the coin flip for ends survives. Crucible is rotationally
symmetric by half a turn on purpose, which means the two ends are the same opening
mirrored. A best-of-five is five identical openings; the nine-round cap is nine.
Openings are where duel variety comes from, and this game currently has one.

**2. The bot cannot reach the top half of the arena.** `rocketjump` is deliberately
not a nav link kind (`packages/bot/src/nav/schema.ts`), and the positions only a rocket
reaches are tagged `perch` instead of `ground`: five of `arena1.nav.ts`'s sixty-three
nodes — the two corner balconies and the tower. The arena is built around four climbs,
two of which cost a rocket (`docs/physics-spec.md` §5.4), and in single-player the
opponent can use neither. It can shoot at a perch; it can never come up. So the level's
whole vertical layer is a place the player goes to be alone, and the mechanic the game
is named after has no answer from the only always-available opponent.

**3. The rules that would make matches feel different already exist, and no player can
reach them.** `MatchRules` carries `selfDamage` (four implemented modes), `roundsToWin`,
`roundTimeLimitTicks` and `intermissionTicks`; it is hashed with the rest of the state,
it rides in the snapshot the client already reads, and `Room` already accepts a `rules`
option (`packages/server/src/room.ts:182`). The Settings screen offers sensitivity, DPI,
field of view, bot difficulty and a diagnostics checkbox — and nothing about the match.
Four self-damage modes that "change the skill ceiling rather than the numbers" (§7.2)
are sitting finished behind a default.

**4. Winning has almost no punctuation.** The sound set is ten sounds
(`packages/client/src/audio/sounds.ts`): fire, fire, explosion, two footsteps, land,
hit, damage, round start, round end. There is no death sound and nothing that separates
"I hit them" from "I killed them". The moment a round is won — the payoff the whole
round was for — is a hitmarker identical to the two before it, and the word `round won`
fading up in the announce box. The feedback pipeline that would carry more is already
built and already pure (`ui/feedback.ts`, proven by `ui/purity.test.ts`); it is just not
being given a frag to announce.

**5. Warmup is the one place a new player could learn the movement, and it does
nothing.** `MatchPhase.Warmup` lets commands reach the body and scores nothing —
which is exactly right as a rule, and it is also the state a host sits in while waiting
for a friend to open the link. Strafe-jumping and rocket-jumping are named in
`CONTEXT.md` as *the* skill ceiling of this game. A player who has never played Quake
has no way to discover either, no way to measure whether they are getting better at
them, and their first exposure to both is losing a round to them.

---

## The recommendations

### Tier 1 — the most fun per unit of work

#### R1. Give Crucible six to eight spawn points

**Targets** — the core loop, specifically the round opening. `maps/arena1.ts` (the
`spawns` array), `maps/arena1.nav.ts` (a `spawn`-tagged node within `NAV_SPAWN_RADIUS`
of each), `pnpm map:bake && pnpm nav:bake`, and the committed artifacts under
`maps/baked/`. No simulation code changes: `buildSpawnPlan` already asks the geometry
which pairs are 512 units apart and mutually blind, and already draws from whatever it
finds.

**Why it is more fun** — it converts the single opening into a dozen or more. Every
round becomes a small reading problem — where am I, where are they likely to be, which
lane does that give me — instead of a re-run. It is the cheapest possible increase in
the number of distinct games this map can produce, and it makes the map's own geometry
(two rail lanes, the walkway, four ways up the mound) matter differently each round
rather than identically every round.

**Cost** — **S**. Placing eight points on the 16-unit grid in a map that is already
rotationally symmetric is an afternoon; the bake validates them (inside solid, no
headroom, too close together, no blind pair) so bad placements fail loudly rather than
shipping. Re-bake and commit the artifacts. The golden replay does not move: it runs on
`SKELETON_ARENA` in `packages/sim/src/arena.ts`, not on a baked map — `packages/sim`
cannot import `maps/`, so the fixture's world is written in source.

**Risk** — low. The one thing to watch is that spawn pairs are pairs, not points: eight
points do not guarantee twelve *blind* pairs in an arena whose middle is a tower with
sightlines round both sides. Place them, bake, and read the plan size out of
`buildSpawnPlan`; if the count is disappointing it is the placement to change, not the
rule. Telefrag policy already covers the new adjacency risk (§6.4).

> **Correction — this was attempted and does not work as written (GLAD-KOSA8U).**
>
> Two things came back from trying it. First, "six to eight" is impossible:
> `map/validate.ts` holds **every** pair of spawn points to `MIN_SPAWN_SEPARATION`, not
> just the pair a round draws, and in a 1024-unit arena whose fairness rests on
> rotational symmetry an exhaustive search finds that a third antipodal axis never fits.
> The ceiling is **four points — two openings**, double today rather than a dozen.
>
> Second, the risk above named the wrong risk. Every four-point layout tried left the bot
> unable to find a stationary opponent for a whole round (`botPeer.test.ts`: `hunt 885 /
> fight 1053` becomes `roam 2997`, no shot fired in 48 seconds). Candidates were screened
> on blindness, then on visibility, then on player-box clearance, and the best survivor
> still trapped it; swapping only the *order* of the same four points so the draw lands on
> the corners makes the bot play perfectly. That places the fault in a latent,
> path-dependent bot navigation trap in the south-east floor rather than in the spawn
> placement — so R1 is gated behind bot-navigation work, and is not a map edit.

#### R2. Teach the bot to rocket-jump

**Targets** — the bot, and through it the whole vertical half of the level design.
`packages/bot/src/nav/schema.ts` (add `rocketjump` to `NavLinkKind`, bump
`NAV_FORMAT_VERSION`), a new controller under the one-file-per-kind rule,
`maps/arena1.nav.ts` (re-tag the five `perch` nodes and author the links up to them),
`packages/bot/src/combat/selfDamage.ts` (the self-splash allowance has to budget a
deliberate jump, not just tolerate an accident), and the band table in
`tools/bot-bands.ts`.

**Why it is more fun** — it closes the largest gap between what the player can do and
what the opponent can answer. Today the tower is a place you go to be safe from
pursuit; with this it becomes a place you go to be *exposed but high*, which is what an
arena perch is supposed to be. It also gives the bot the one movement flourish that
reads, from the outside, as competence — an opponent that rockets itself onto a balcony
to cut you off is the moment a bot stops feeling like a patrol route.

**Cost** — **L**. The schema calls this "a v2 kind", which is an accurate estimate: it
needs a traversal controller that fires a weapon at its own feet mid-route, a self-damage
budget that can spend health on movement, and a nav format bump that invalidates every
committed graph. Expect the band table to move and to need re-tuning
(`pnpm bot:sweep`).

**Risk** — medium. A bot that rocket-jumps badly kills itself, and the ladder is what
would catch that: the Easy rung (0.45) must not become a bot that suicides while the
Hard rung (0.80) flies. Consider gating the behaviour on skill so it appears with
competence rather than at every difficulty.

#### R3. Let players choose the rules the simulation already implements

**Targets** — the match rules and the room flow. `packages/client/src/ui/menu.ts` (the
room screen, and the bot-match start), `packages/client/src/net/listenServer.ts` and
`packages/server/src/room.ts`'s existing `rules?: MatchRules` option. The client already
receives the rules in the snapshot and already reads `roundsToWin` out of them
(`ui/hudModel.ts`), so this is a room-creation choice and a control, not a protocol
change.

**Why it is more fun** — four self-damage modes are four different games. Under the
default `health_only` a rocket jump costs you health and never armour, which makes
mobility cheap and the arena feel fast; under `full` — Quake's own halving — every
rocket jump is a real bet, and the skill ceiling the docs describe becomes a skill
*cost* you have to be willing to pay. `none` is the version you hand a friend who has
never done this before. Shipping one of them and hiding the other three is leaving
three games in the box. A first-to-1 option is worth as much again: a five-round match
is a big ask of a stranger who clicked a link.

**Cost** — **S–M**. The rules plumbing exists; the work is a small rules panel on the
room screen and on the bot-match start, defaulting to exactly what ships today, and
persisting the choice like the other settings. A caution worth writing into the ticket:
rules are chosen by whoever opens the room, never proposed by the joiner — a client that
could ask the host for `selfDamage: none` mid-match is a client that could ask for other
things (`AGENTS.md`, *What a stranger is allowed to do*).

**Risk** — low. Two peers on different rules already fail loudly at tick zero by design,
which is the failure mode you want.

#### R4. Punctuate the kill

**Targets** — feedback: `packages/client/src/ui/feedback.ts`,
`packages/client/src/audio/cues.ts`, `tools/synth-audio.ts` (the sounds are synthesised,
so new ones cost a function rather than a licence), `credits.json`, and the announce box
in `ui/hud.ts`.

**Why it is more fun** — a duel game is a sequence of two-hit exchanges, and right now
the second hit sounds exactly like the first. A distinct kill confirmation — a different
sting, a heavier hitmarker, the opponent's death audible in the world bus so you can
hear it happen behind you — is the smallest change on this list with the largest effect
on how a round *feels*, because it fires at the exact instant the player was already
paying most attention. Adding a death sound also closes a real information gap: today,
killing someone you cannot see is silent.

**Cost** — **S**. Client-only, no simulation change, no netcode change. The feedback
fold already derives "you hit them" from the opponent's health going down on the tick it
went down; "you killed them" is the same fold noticing it reached zero. New sounds go
through the existing synth pipeline and the asset budget has room.

**Risk** — low. Keep it inside the existing purity rule: feedback reads the HUD model
and keys off the tick, never `performance.now()`, or it decays at a different rate on a
machine whose frames are late.

### Tier 2 — worth doing, once Tier 1 is in

#### R5. Move the bot's skill dial between rounds

**Targets** — the difficulty curve. `packages/bot/src/tuning.ts` (`deriveSkill`,
`BotSkill`), wherever the bot peer is seated
(`packages/client/src/net/botPeer.ts`), and the round boundary as the seam.

**Why it is more fun** — the single-player experience currently has three fixed rungs
and a player who is between two of them is either bored or beaten. Skill is already a
continuous dial in `[0, 1]` whose monotonicity is *proven* by the ladder — which is
exactly the precondition adaptive difficulty normally lacks. Nudging it a little towards
the player after two rounds lost and away after two won keeps the duel near the score
line, which is where duels are fun.

**Cost** — **M**. Skill currently rides on a bot from creation; this needs it to be
re-derivable at a round boundary — the natural seam, and the only one that is not
visible to the player mid-fight. Bounds must stay inside the measured rungs so the
numbers keep meaning what the band table says they mean.

**Risk** — medium, and mostly about honesty: the player's chosen difficulty must remain
the thing they chose. Adapt within a band around the selected rung, keep the selected
name on screen, and make it something Settings can switch off.

#### R6. Make warmup a movement range

**Targets** — onboarding into the movement, and the empty seat while a friend joins.
`packages/client/src/ui/hud.ts` and `hudModel.ts` (a warmup-only readout),
`packages/sim/src/match/match.ts` only to be read, not changed.

**Why it is more fun** — it gives the two techniques the game is built on a place to be
practised and, crucially, a number to chase. A warmup-only readout — current speed, best
speed this warmup, height reached, the four climbs listed with the technique each needs —
turns dead waiting time into the tutorial this game does not have, without adding a
tutorial. The map is already designed to teach the movement by being played
(`maps/arena1.ts` header); this just tells the player what they are looking at.

**Cost** — **S–M**. Client-only: every number is already in the HUD model or one
derivation away from it. It must not appear during a live round — a speedometer is a
crutch in a duel — which the phase already tells you.

**Risk** — low. Watch the HUD layout rule: anything new carrying `data-hud-box` is
measured at three aspect ratios by `pnpm run e2e` and must overlap nothing.

#### R7. Replace three seconds of dead air with a round-end beat

**Targets** — the core loop's rhythm. `ui/feedback.ts`, `ui/hud.ts`, and the
intermission phase that already exists (`RESPAWN_DELAY_TICKS`, three seconds).

**Why it is more fun** — the intermission is currently the camera sitting on your own
corpse. It is also the only moment in a round-based game where a player can be told
something, and round-based duels are re-playable precisely because players read each
other between rounds. A short summary — shots fired and landed, damage dealt, which
weapon did it, the score with the new round on it — costs the player nothing and gives
them something to change.

**Cost** — **M**. The honest constraint: those numbers are not in `GameState` and should
not be added to it lightly, because everything in there is encoded, hashed and rewound.
Derive them client-side in the feedback fold, which already watches health deltas per
tick, and accept that they are the client's account of the round rather than the
server's.

**Risk** — low-medium. A derived stat that disagrees with what the player felt is worse
than no stat; keep it to quantities the fold can be sure of.

#### R8. Let the bot hold an angle

**Targets** — the bot's decision layer. `packages/bot/src/brain.ts` (the `L3 action`
set), `packages/bot/src/movement/roam.ts`, and a `standStill` flag on `BotDecision` —
which `AGENTS.md` already anticipates as the shape this would take.

**Why it is more fun** — the bot is never idle, and its search is uniform rather than
biased, which is the correct fairness choice and also means it never ambushes. A bot
that occasionally parks at the end of a rail lane and waits produces the single best
moment a bot can produce: the one where the player concludes it is playing *them*.
Uniform-random search is unreadable; a bot with two modes is a bot you can learn, and
learning the opponent is the fun.

**Cost** — **M**. The flag and the action are small; the tuning is the work. This is
exactly the kind of change the band table exists to keep honest — a bot that ambushes
too often is a turret, and the table has a floor as well as a ceiling for that reason.

**Risk** — medium. Do not let it read ground truth: the choice of *when* to hold and
*which* lane must come out of the `WorldModel` and the seeded stream, or it becomes
omniscience wearing a personality.

### Tier 3 — bigger swings

#### R9. A second arena — ⚠ breaks an invariant (one map)

**Targets** — content and the core loop. A new `maps/arena2.ts` plus its nav graph, the
bake, and a map choice in the room flow.

**Why it is more fun** — R1 multiplies the openings on one map; a second map multiplies
the *game*. Crucible is one shape — a tower in the middle, two rail lanes, one raised
mound — and every habit a player builds is a habit about that shape. A second arena with
a different answer to the same question (tighter, or more vertical, or with no long lane
at all) is the difference between a game you play and a game you keep playing.

**Cost** — **L**. A map is not just brushes: it is a nav graph, a reachability contract
where every ledge is one of four climbs and nothing is reachable-but-not-escapable, a
lightmap bake, and a spawn plan with legal blind pairs. Crucible's own header calls
itself time-boxed and asks to be iterated on after people have duelled on it, which is
an argument for doing R1 first and this second.

**Risk** — medium. The invariant here is soft — the repo ships one map, it does not
forbid two — but the *reachability* rule is hard and is what makes maps expensive.
Budget for the bake refusing your first draft.

#### R10. Make stalling cost something

**Targets** — the round rules. `packages/sim/src/match/round.ts`, `match/match.ts`
(`roundTimeLimitTicks`), `docs/physics-spec.md` §7.4.

**Why it is more fun** — the current tie-break awards a timed-out round to the higher
`health + armor`, which means the player who is ahead on health is rewarded for running
out two minutes, and the player who is behind is rewarded for hiding until they are not.
Both incentives point away from fighting. A late-round pressure — an escalating drain on
both players once the clock passes a threshold — makes the round resolve by combat
rather than by arithmetic.

**Cost** — **S** in code, and the smallness is the trap. It is a simulation change: it
must be deterministic, it lands in `MatchRules` so both peers agree, and it is expected
to move the golden replay trace (re-bake `GOLDEN_TRACE` and say in the commit why the
world moved).

**Risk** — low impact, medium priority. In a 1024-unit sealed arena most rounds end long
before two minutes, so this corrects an incentive rather than a common experience.
Worth doing after the game has been played enough to know whether stalling actually
happens; ship R3 first and the round timer becomes adjustable anyway.

#### R11. A third weapon — ⚠⚠ breaks a hard invariant, and I would not do it

**Targets** — the weapons layer. `packages/sim/src/weapons.ts`, where `WEAPONS` is a two-element *tuple
type* so that a third entry is a type error rather than a review comment; plus the
weapon netstate, the viewmodel and player-rig part lists, the HUD, the bot's weapon
choice, and `docs/physics-spec.md` §3.

**Why someone would want it** — more weapons is the reflexive answer to "more fun", and
two weapons that both do exactly 100 damage means the choice between them is only ever
about range and prediction.

**Why I recommend against it** — that purity is the design, not a gap in it. Rocket
Arena's whole idea was removing the item scramble; the two-weapon, no-ammo, no-pickup
loadout is what makes every round a test of movement and aim rather than of who got to
the good gun. The invariant is enforced at the type level precisely so this conversation
has to be deliberate. Every fun problem this ticket found has a cheaper answer that does
not spend it. If a third weapon is ever right, it should follow a season of duels that
named the specific thing missing — not lead.

**Cost** — **XL**, and it re-opens the balance of everything above it.

---

## What I would ship first

R1, R3 and R4, in that order, as one slice. They are all S-sized, they touch three
different systems so they can be worked in parallel, and together they change the three
things a player notices in the first ten minutes: rounds stop opening identically, the
match can be set up to suit the two people playing it, and killing someone feels like
killing someone. R2 is the biggest single improvement to single-player and should be the
next ticket after that slice lands, because it is the one that needs a nav format bump
and a re-tune and therefore wants a clear run.

## What I left out, on purpose

The confirmed focus for this proposal is core gameplay mechanics, so the following are
named and not argued: persistent progression and unlocks, cosmetics, ranked matchmaking
and ELO, a spectator or replay-viewer UI built on the existing demo format, chat and
taunts, and anything about acquisition or retention. Several of them — a replay viewer,
in particular, given demos already record the command stream and already verify on
replay — would be cheap and worth their own ticket.
