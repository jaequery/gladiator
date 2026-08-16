/**
 * The map this server serves.
 *
 * Loaded from the committed artifact at module load, in plain Node: no GPU, no
 * canvas, no browser globals, no asset pipeline. That is not incidental — it is
 * the property that lets the authoritative simulation run headless on Fly while
 * the identical simulation runs in a tab, and it is why the map format's only
 * consumer inside `packages/sim` reads brushes and spawns and nothing else.
 *
 * The artifact is bundled by esbuild rather than read from disk at runtime, so
 * the container ships one file and cannot start with a map that is not the one
 * it was built with.
 *
 * Which map is a hard-coded `arena1` — **Crucible**, the duel arena
 * (GLAD-B8DI4J). Every room on the machine plays it. `maps/testbed.ts` is still
 * in the tree and still what the map pipeline is proved against, but it is a
 * fixture rather than a level and no room is ever seated on it.
 *
 * Rooms are minted per match (`rooms.ts`) and the map is not, which is why the
 * spawn plan lives out here beside the world rather than inside a room.
 */
import { buildSpawnPlan, loadMap, type LoadedMap, type SpawnPlan } from '@gladiator/sim'

import baked from '../../../maps/baked/arena1.json' with { type: 'json' }

/** The loaded map: source, verified hash, and a collision world to trace against. */
export const SERVER_MAP: LoadedMap = loadMap(baked)

/**
 * The eight hex digits a client has to match to be allowed to play.
 *
 * `PROTOCOL_VERSION` covers the shape of the messages; this covers the world
 * they describe. A map can change without the protocol changing, and a client
 * one deploy behind on the map is exactly as desynchronised as one a protocol
 * behind — it just fails later and much less legibly.
 */
export const SERVER_MAP_HASH: string = SERVER_MAP.hash

/**
 * Every pair of points a round may legally start from, worked out once.
 *
 * `spawns² × 9` traces with the real player box, and a function of the map
 * alone — so it is built here, at module load, and shared by every room on the
 * machine. Building it per room would be paying a level-design question over
 * again for each match, and a machine minting rooms would pay it repeatedly for
 * an answer that cannot change. `sim/src/match/spawn.ts`.
 */
export const SERVER_PLAN: SpawnPlan = buildSpawnPlan(SERVER_MAP.source, SERVER_MAP.world)
