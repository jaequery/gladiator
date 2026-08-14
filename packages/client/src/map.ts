/**
 * The map this page loaded.
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

import baked from '../../../maps/baked/testbed.json' with { type: 'json' }

/** The loaded map: source, verified hash, and a collision world. */
export const CLIENT_MAP: LoadedMap = loadMap(baked)

/** Eight hex digits, sent in the hello frame and compared by the server. */
export const CLIENT_MAP_HASH: string = CLIENT_MAP.hash
