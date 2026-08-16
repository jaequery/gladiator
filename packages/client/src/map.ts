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
import { loadMap, type LoadedMap } from '@gladiator/sim'

import baked from '../../../maps/baked/arena1.json' with { type: 'json' }

/** The loaded map: source, verified hash, and a collision world. */
export const CLIENT_MAP: LoadedMap = loadMap(baked)

/** Eight hex digits, sent in the hello frame and compared by the server. */
export const CLIENT_MAP_HASH: string = CLIENT_MAP.hash
