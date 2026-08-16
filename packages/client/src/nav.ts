/**
 * The navigation graph for the map this page loaded.
 *
 * The sibling of `map.ts`, and bundled the same way: `pnpm run nav:bake`
 * compiles `maps/arena1.nav.ts` to a committed artifact, Vite inlines it, and
 * `loadNav` verifies it before anything walks on it. Only the bot reads it —
 * a human player's feet are steered by a mouse — so nothing in the render or
 * netcode path touches this module.
 *
 * `loadNav` is handed {@link CLIENT_MAP}'s hash and refuses a graph baked
 * against a different one. That check is the whole reason this is a module
 * rather than an import at the bot's call site: every node in a nav graph is a
 * claim about where the geometry is, so a map edit that is not followed by a
 * nav bake has to fail loudly at load rather than quietly send the bot walking
 * into a wall that moved.
 */
import { loadNav, type LoadedNav } from '@gladiator/bot'

import baked from '../../../maps/baked/arena1.nav.json' with { type: 'json' }
import { CLIENT_MAP } from './map.ts'

/** The graph, checked against the loaded map's hash. */
export const CLIENT_NAV: LoadedNav = loadNav(baked, CLIENT_MAP.hash)
