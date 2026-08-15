import { quakeToEngine } from '@gladiator/sim'
import type { Vec3 } from '@gladiator/sim'

/**
 * Placeholder so the package has a resolvable entry point and the workspace
 * link is exercised by `pnpm typecheck`. The bot itself lands in GLAD-V7CMHR
 * (perception), GLAD-TSED8V (movement) and GLAD-HK3ATM (combat).
 */
export function debugAxisMap(q: Vec3): Vec3 {
  return quakeToEngine(q)
}

/* --------------------------------------------------------------------------
 * Navigation data — GLAD-OB46VC
 *
 * The graph the bot walks on: authored under `maps/*.nav.ts`, baked by
 * `pnpm nav:bake`, queried by table read. `nav/schema.ts` is where the format
 * and the reasoning behind it live.
 * ----------------------------------------------------------------------- */

export { bakeNav, buildGrid, computeRoutes, computeVisibility, navLinkCost } from './nav/bake.ts'
export type { NavBakeOutcome } from './nav/bake.ts'

export { hashNavSource, loadNav, navHashOf, parseBakedNav, parseNavSource, wordsFor } from './nav/load.ts'
export type { LoadedNav, LoadedNavGrid } from './nav/load.ts'

export {
  canSee,
  hopKind,
  isGround,
  navPath,
  nextHop,
  nodeIndexOf,
  nodeNear,
  nodeOrigin,
  routeCost,
} from './nav/query.ts'

export {
  NAV_FORMAT_VERSION,
  NAV_GRID_CELL,
  NAV_LINK_COST_PERCENT,
  NAV_LINK_KINDS,
  NAV_MAX_STEP,
  NAV_MAX_STRIDE,
  NAV_SPAWN_RADIUS,
  NAV_TAGS,
  NAV_TELEPORT_COST,
  NO_NODE,
} from './nav/schema.ts'
export type {
  BakedNav,
  NavGrid,
  NavLink,
  NavLinkKind,
  NavNode,
  NavRoutes,
  NavSource,
  NavTag,
  NavVisibility,
} from './nav/schema.ts'

export {
  formatNavDiagnostics,
  linkNavDiagnostics,
  placeNodes,
  routingNavDiagnostics,
  structuralNavDiagnostics,
  NAV_ARRIVE_RADIUS,
  NAV_MAX_JUMP,
  NAV_PROBE_SPACING,
} from './nav/validate.ts'
export type { NavDiagnostic, PlacedNodes } from './nav/validate.ts'

/** Re-exported so a `maps/*.nav.ts` file needs one import, not two. */
export type { Vec3 } from '@gladiator/sim'
