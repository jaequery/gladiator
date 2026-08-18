/**
 * The map this page loaded: `arena1` — **Crucible**, the duel arena.
 *
 * It must be the same map `packages/server/src/map.ts` loads, and the hash
 * exchanged in the handshake is what proves it rather than the fact that both
 * files name the same import. `maps/testbed.ts` still exists and is still what
 * the map pipeline is proved against — it is a fixture, not a level, and
 * nothing plays on it.
 *
 * Bundled by Vite from the same committed artifact the server bundles with
 * esbuild — the *same file*, resolved twice, by two builds that are deployed to
 * two hosts at two different moments. That is exactly why the hash is worth
 * exchanging: for a minute or two after every deploy, a browser holding
 * yesterday's bundle can open a socket to today's server, and nothing else in
 * the handshake would notice.
 *
 * `loadMap` recomputes the hash from the map's contents and refuses an artifact
 * that does not match its own claim, so the number this module exports is a
 * number this build derived rather than one it read.
 *
 * Rendering it is GLAD-0IDR6J's; `mapGeometry` turns `CLIENT_MAP.source` into
 * merged, surface-grouped triangles cut from the same planes the trace uses.
 */
import { buildSpawnPlan, loadMap, type LoadedMap, type SpawnPlan } from '@gladiator/sim'

import baked from '../../../maps/baked/arena1.json' with { type: 'json' }

/** The loaded map: source, verified hash, and a collision world. */
export const CLIENT_MAP: LoadedMap = loadMap(baked)

/** Eight hex digits, sent in the hello frame and compared by the server. */
export const CLIENT_MAP_HASH: string = CLIENT_MAP.hash

/**
 * Where a round may stand its two players — the client's copy of the host's.
 *
 * Level data, like `CLIENT_MAP.world`: a pure function of the map, computed
 * once here and never mutated by a tick. `packages/server/src/map.ts` builds the
 * identical value from the identical artifact, which is what lets both ends run
 * the round rules and agree — `selectSpawnPair` draws from `state.rng`, so the
 * pair is a function of the seed and the plan, and both peers hold both.
 *
 * **The client needs it because the client predicts.** `net/prediction.ts` runs
 * the same `tick()` the host runs, and `tick()` ends in `advanceMatch`, which
 * has to stand two players up when an intermission runs out. Without a plan that
 * throws (`match/round.ts`'s `requirePlan`) — which for a while it did, at the
 * end of every round of every match, taking the whole client down with it
 * (GLAD-G42FEB). Warmup hid it: a world that never starts a round never asks.
 */
export const CLIENT_PLAN: SpawnPlan = buildSpawnPlan(CLIENT_MAP.source, CLIENT_MAP.world)
