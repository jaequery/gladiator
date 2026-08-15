/* --------------------------------------------------------------------------
 * The bot — GLAD-V7CMHR
 *
 * A seeded stream, a perception layer and a brain that reads what the
 * perception layer believes. `bot.ts` is the shape of it; the argument for the
 * boundary — and the four channels that are allowed to cross it — is
 * `perception/worldModel.ts`. Movement is GLAD-TSED8V and combat is
 * GLAD-HK3ATM; both fill in `BotDecision` rather than reaching past it.
 * ----------------------------------------------------------------------- */

export { botCommand, createBot } from './bot.ts'
export type { Bot } from './bot.ts'

export {
  BRAIN_INTERVAL_TICKS,
  ENGAGE_RANGE,
  MAX_TURN_UNITS,
  MOVE_DEADZONE,
  TURN_RATE_DEGREES,
  command,
  createBrain,
  decide,
  pitchUnitsToward,
  think,
  wrapDelta,
  wrapUnits,
  yawUnitsToward,
} from './brain.ts'
export type { BotBrain, BotDecision } from './brain.ts'

export { createPerception, observe } from './perception/perceive.ts'
export type { Ground, Perception } from './perception/perceive.ts'

export { ageContact } from './perception/memory.ts'
export { coneCosine, inCone, lineOfSight, visibilityFraction } from './perception/sight.ts'
export { hearContact } from './perception/sound.ts'

export {
  ACQUIRE_VISIBILITY,
  ALERT_FOV_DEGREES,
  ALERT_TICKS,
  DAMAGE_ASSUMED_RANGE,
  DAMAGE_CONFIDENCE,
  FIRE_HEARING_RANGE,
  FOOTSTEP_HEARING_RANGE,
  FOOTSTEP_INTERVAL_TICKS,
  FOOTSTEP_SPEED,
  MAX_THREATS,
  MEMORY_TICKS,
  MIN_SHOVE,
  NEVER_TICK,
  SIGHT_FOV_DEGREES,
  SIGHT_HOLD_TICKS,
  SIGHT_RANGE,
  SIGHT_SAMPLES,
  SOUND_BEARING_ERROR_DEGREES,
  SOUND_CONFIDENCE,
  SOUND_DISTANCE_ERROR,
  SOUND_UNCERTAINTY_FRACTION,
  UNCERTAINTY_GROWTH,
  clearContact,
  confidenceOf,
  createContact,
  createWorldModel,
  fovDegrees,
  hasContact,
  isAlert,
  isRemembered,
} from './perception/worldModel.ts'
export type {
  ContactSource,
  EnemyContact,
  MatchModel,
  SelfModel,
  ThreatContact,
  WorldModel,
} from './perception/worldModel.ts'

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
