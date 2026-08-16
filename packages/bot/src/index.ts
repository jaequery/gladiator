/* --------------------------------------------------------------------------
 * The bot — GLAD-V7CMHR
 *
 * A seeded stream, a perception layer and a brain that reads what the
 * perception layer believes. `bot.ts` is the shape of it; the argument for the
 * boundary — and the four channels that are allowed to cross it — is
 * `perception/worldModel.ts`. Movement execution (GLAD-TSED8V) and combat
 * (GLAD-HK3ATM) are below; both go through `BotDecision` rather than reaching
 * past it.
 * ----------------------------------------------------------------------- */

export { botCommand, createBot } from './bot.ts'
export type { Bot } from './bot.ts'

/* --------------------------------------------------------------------------
 * Tuning — GLAD-6BIYFQ
 *
 * One blob of numbers and one dial over it. `tuning.ts` is the argument;
 * `tools/bot-bands.ts` is what decides whether the numbers are right.
 * ----------------------------------------------------------------------- */

export { SHIPPED_SKILL, TUNING, deriveSkill } from './tuning.ts'
export type {
  BotSkill,
  SkillBand,
  TuningAnchors,
  TuningAxis,
  TuningFixed,
  TuningSource,
} from './tuning.ts'

export {
  BRAIN_INTERVAL_TICKS,
  ENGAGE_RANGE,
  MAX_TURN_UNITS,
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
export type { BotAction, BotBrain, BotDecision } from './brain.ts'

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
  navLinkBudget,
  placeNodes,
  routingNavDiagnostics,
  structuralNavDiagnostics,
  NAV_ARRIVE_RADIUS,
  NAV_MAX_JUMP,
  NAV_PROBE_SPACING,
} from './nav/validate.ts'
export type { NavDiagnostic, PlacedNodes } from './nav/validate.ts'

/* --------------------------------------------------------------------------
 * Movement execution — GLAD-TSED8V
 *
 * A route turned into `UserCmd`s: one traversal controller per link kind in
 * `travel/`, the follower and the three runtime guards in `movement/`, and the
 * stuck detector in `stuck.ts`. `movement/move.ts` is the argument; the rest is
 * one decision each.
 * ----------------------------------------------------------------------- */

export { EVADE_REACH, createMovement, moveBot } from './movement/move.ts'
export type { BotTerrain, MoveState } from './movement/move.ts'

export {
  CIRCLE_JUMP_ALIGN,
  CIRCLE_JUMP_HOLD_TICKS,
  CIRCLE_JUMP_LANDING_SPEED,
  CIRCLE_JUMP_RUN,
  CIRCLE_JUMP_SPEED,
  LEAN_SINE,
  RUN_LOOKAHEAD,
  createStraightRun,
  leanSide,
  straightRun,
  wantsCircleJump,
} from './movement/circleJump.ts'
export type { StraightRun } from './movement/circleJump.ts'

export { LEDGE_DROP, LEDGE_LOOKAHEAD_SECONDS, guardedAxes, ledgeSafe } from './movement/ledge.ts'

export { roamTarget } from './movement/roam.ts'

export {
  MOVE_DEADZONE,
  axisDirection,
  createAxes,
  rotate45,
  steerAxes,
} from './movement/steer.ts'
export type { Axes } from './movement/steer.ts'

export {
  RECOVERY_BACK_TICKS,
  RECOVERY_TICKS,
  STUCK_RADIUS,
  STUCK_REPORT_TICKS,
  STUCK_TICKS,
  createStuck,
  isRecovering,
  onNavStuck,
  recoverySteer,
  resetStuck,
  trackProgress,
} from './stuck.ts'
export type { NavStuck, StuckState } from './stuck.ts'

export {
  TRAVELLERS,
  arrivedAt,
  createIntent,
  dropTravel,
  jumpTravel,
  teleportTravel,
  travellerFor,
  walkTravel,
  wishTowards,
} from './travel/index.ts'
export type { Travel, TravelIntent, Traveller } from './travel/index.ts'

/* --------------------------------------------------------------------------
 * Aim and combat — GLAD-HK3ATM
 *
 * The bang-bang angular servo and its three error sources are `aim/`; which
 * weapon, where to put a rocket, when a rail is worth taking and which way to
 * get out of the way are `combat/`. `aim/error.ts` is the argument for why the
 * bot misses the way a person does, and `combat/rocketAim.ts` for why it aims at
 * the floor.
 * ----------------------------------------------------------------------- */

export {
  AIM_ACCEL_TICKS,
  MAX_AIM_ACCEL,
  aimPitch,
  aimYaw,
  clampPitch,
  createAim,
  holdAim,
  seedAim,
  steerAim,
  subtendedUnits,
} from './aim/controller.ts'
export type { AimState } from './aim/controller.ts'

export {
  AIM_ERROR_FRACTION,
  MAX_AIM_ERROR,
  MOTOR_ERROR,
  NOMINAL_REACTION_TICKS,
  REACTION_MIN_MS,
  REACTION_SPREAD_MS,
  TREMOR_UNITS,
  VERTICAL_ERROR_SHARE,
  ageNoise,
  clearTrack,
  createNoise,
  createTrack,
  displaceAim,
  errorRadius,
  nominalReactionTicks,
  reactionTicks,
  rollNoise,
  trackTarget,
} from './aim/error.ts'
export type { AimNoise, AimTrack } from './aim/error.ts'

export {
  DIRECT_DAMAGE,
  SPLASH_DAMAGE,
  SPLASH_RADIUS,
  TARGET_AREA,
  directChance,
  expectedDirect,
  expectedSplash,
  splashAt,
} from './combat/damage.ts'

export {
  DODGE_CLEAR,
  DODGE_DANGER,
  DODGE_HORIZON_SECONDS,
  DODGE_PROBE,
  nearestThreat,
  planDodge,
} from './combat/dodge.ts'

export {
  ROCKET_TOLERANCE_MAX,
  ROCKET_TOLERANCE_MAX_DEGREES,
  ROCKET_TOLERANCE_RADIUS,
  aimCombat,
  createCombat,
  observeCombat,
  planEvade,
  planShot,
  resetCombat,
  rocketTolerance,
  triggerCombat,
} from './combat/fire.ts'
export type { CombatState } from './combat/fire.ts'

export { RAIL_SETTLE_RATE, RAIL_SETTLE_UNITS, railSettled } from './combat/railDiscipline.ts'

export {
  IMPACT_PROBE,
  LEAD_LAG_SECONDS,
  LEAD_MAX_SECONDS,
  LEAD_STRAIGHTNESS,
  PATH_SAMPLES,
  PATH_SAMPLE_TICKS,
  PATH_WINDOW_TICKS,
  TREMOR_MEAN_SHARE,
  clearPath,
  createPath,
  createPlan,
  interceptSeconds,
  planDirect,
  planRocket,
  predictImpact,
  samplePath,
  straightness,
} from './combat/rocketAim.ts'
export type { ShotMode, ShotPlan, TargetPath } from './combat/rocketAim.ts'

export {
  SELF_SPLASH_ALLOWANCE,
  SELF_SPLASH_RESERVE,
  acceptableSelfSplash,
  predictSelfSplash,
  selfDamageAllows,
} from './combat/selfDamage.ts'

export {
  AIRBORNE_DROP,
  RAIL_MIN_RANGE,
  airborneAt,
  selectWeapon,
} from './combat/weaponSelect.ts'

/** Re-exported so a `maps/*.nav.ts` file needs one import, not two. */
export type { Vec3 } from '@gladiator/sim'
