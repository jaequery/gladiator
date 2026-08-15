export { QUAKE_TO_ENGINE, applyMat3, determinant3, quakeToEngine } from './axis.ts'
export type { Mat3, Vec3 } from './axis.ts'

export {
  LANDMARK_MAXS,
  LANDMARK_MINS,
  PLANE_HALF_EXTENT,
  SKELETON_ARENA,
  SKELETON_BRUSHES,
  SKELETON_SEED,
  createSkeletonState,
} from './arena.ts'

export {
  DAMAGE_ORIGIN_HEIGHT,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  PLAYER_MAXS,
  PLAYER_MINS,
  PLAYER_VIEW_HEIGHT,
  POINT_MAXS,
  POINT_MINS,
} from './bbox.ts'

export {
  boxBrush,
  boxPenetration,
  brush,
  createCollisionWorld,
  plane,
  planeOffset,
  queryBrushes,
} from './collide.ts'
export type { Brush, CollisionWorld, Plane, PlaneSpec } from './collide.ts'

export { countSimEvents } from './counters.ts'
export type { SimCounterHooks, SimCounters } from './counters.ts'

export {
  G_KNOCKBACK,
  KNOCKBACK_DAMAGE_CAP,
  KNOCKBACK_PER_DAMAGE,
  MAX_KNOCKBACK_TIME_MS,
  MIN_KNOCKBACK_TIME_MS,
  PLAYER_MASS,
  SPLASH_UP_BIAS,
  applyDamage,
  canDamage,
  distanceToBox,
  knockbackSpeed,
  knockbackTicksFor,
  onSelfSplash,
  radiusDamage,
} from './damage.ts'
export type { SelfSplash } from './damage.ts'

export {
  createWriter,
  resetWriter,
  writeF64,
  writeI32,
  writeU8,
  writeU32,
  writtenBytes,
} from './encoding.ts'
export type { ByteWriter } from './encoding.ts'

export {
  FNV_OFFSET_BASIS,
  FNV_PRIME,
  formatHash,
  hashByte,
  hashBytes,
  hashFloat64,
  hashInit,
  hashString,
  hashUint32,
} from './hash.ts'

export {
  NO_INPUTS,
  advanceHost,
  advanceTicks,
  clampHostDelta,
  createKernel,
  tick,
} from './kernel.ts'
export type { CommandSource, Kernel, TickHooks, TickInputs, TickObserver } from './kernel.ts'

export {
  INTERP_DELAY_MS,
  INTERP_DELAY_TICKS,
  MAX_REWIND_MS,
  rewindMsFor,
  rewindTicksFor,
} from './lagcomp.ts'
export type { HitscanRewind } from './lagcomp.ts'

export {
  createMapWorld,
  mapBrushPlanes,
  mapCollisionBrush,
  mapCollisionBrushes,
  rampAxis,
  rampDrop,
  rampLowHeight,
  rampSlopePlane,
} from './map/collide.ts'
export type { RampAxis } from './map/collide.ts'

export { mapGeometry } from './map/geometry.ts'
export type { FaceRange, MapGeometry, SurfaceGroup } from './map/geometry.ts'

export {
  DEFAULT_ATLAS_WIDTH,
  DEFAULT_LUXEL_SIZE,
  DEFAULT_MAX_ATLAS_HEIGHT,
  DEFAULT_PADDING,
  lightmapUnwrap,
} from './map/lightmapUv.ts'
export type { LightmapPatch, LightmapUnwrap, LightmapUvOptions } from './map/lightmapUv.ts'

export {
  createMapState,
  hashMapSource,
  loadMap,
  mapHashOf,
  parseBakedMap,
  parseMapSource,
} from './map/load.ts'
export type { LoadedMap } from './map/load.ts'

export {
  MAX_CLIMB,
  ROCKET_JUMP_LAUNCH,
  SAMPLE_SPACING,
  TECHNIQUES,
  analyzeReachability,
  apexOf,
  buildReachabilityGraph,
  horizontalReachOf,
  walkRouteLength,
} from './map/reachability.ts'
export type {
  Ledge,
  ReachabilityGraph,
  ReachabilityReport,
  StandCell,
  Technique,
  TechniqueKey,
} from './map/reachability.ts'

export {
  MAP_FORMAT_VERSION,
  MIN_SPAWN_HEADROOM,
  MIN_SPAWN_SEPARATION,
  RAMP_SLOPES,
} from './map/schema.ts'
export type {
  BakedMap,
  MapBoxBrush,
  MapBrush,
  MapLight,
  MapProp,
  MapRampBrush,
  MapSource,
  MapSpawn,
  MapSurface,
  RampRise,
  RampSlope,
} from './map/schema.ts'

export { formatDiagnostics, validateMap } from './map/validate.ts'
export type { MapDiagnostic } from './map/validate.ts'

export {
  DEFAULT_MATCH_RULES,
  DEFAULT_ROUNDS_TO_WIN,
  MatchPhase,
  NO_DEADLINE,
  NO_WINNER,
  RESPAWN_DELAY_TICKS,
  ROUND_TIME_LIMIT_TICKS,
  acceptsCommands,
  cloneMatchState,
  createMatchState,
  isMatchRunning,
  matchRules,
  maxRoundsFor,
} from './match/match.ts'
export type { MatchRules, MatchState } from './match/match.ts'

export {
  NEW_MATCH_SCORE,
  advanceMatch,
  damageReserve,
  isPlayableScore,
  roundOutcome,
  startMatch,
} from './match/round.ts'
export type { MatchScore } from './match/round.ts'

export {
  ARMOR_PROTECTION,
  DEFAULT_SELF_DAMAGE,
  MIN_DAMAGE,
  SELF_DAMAGE_SCALE,
  SelfDamage,
  armorAbsorbed,
  isSelfDamageMode,
  resolveDamage,
} from './match/selfDamage.ts'
export type { DamageSplit, SelfDamageMode } from './match/selfDamage.ts'

export {
  DUEL_SLOTS,
  SIGHT_TARGETS,
  SPAWN_ARMOR,
  SPAWN_HEALTH,
  SPAWN_PROTECTION_TICKS,
  SPAWN_WEAPON,
  buildSpawnPlan,
  isSpawnProtected,
  playersOverlap,
  selectSpawnPair,
  spawnPlayer,
  spawnRound,
  spawnSeparation,
  spawnsAreBlind,
} from './match/spawn.ts'
export type { SpawnEvent, SpawnPair, SpawnPlan } from './match/spawn.ts'

export {
  MISSILE_PRESTEP_MS,
  explodeProjectile,
  moveProjectiles,
  projectilePosition,
} from './projectile.ts'

export {
  addScaledVec3,
  angleVectors,
  copyVec3,
  crossVec3,
  dotVec3,
  lengthVec2,
  lengthVec3,
  normalizeVec3,
  scaleVec3,
  setVec3,
  snapVector,
  subVec3,
  vec3,
} from './math.ts'
export type { MutVec3 } from './math.ts'

export {
  AIR_CONTROL,
  AIR_STOP_ACCELERATE,
  FELT_GRAVITY,
  GRAVITY,
  JUMP_VELOCITY,
  PM_ACCELERATE,
  PM_AIR_ACCELERATE,
  PM_FRICTION,
  PM_STOPSPEED,
  RUN_SPEED,
  accelerate,
  airAccelerationFor,
  cmdScale,
  createPmoveBody,
  friction,
  onSpeedClamp,
  pmove,
  snapVelocity,
} from './pmove/index.ts'
export type { PmoveBody } from './pmove/index.ts'

export {
  WIRE_ENTITY_FIELDS,
  WIRE_HEADER_FIELDS,
  applyWireState,
  decodeState,
  encodeState,
  isWireState,
  wireStateLength,
} from './netstate.ts'
export type { WireState } from './netstate.ts'

export {
  MAX_CMDS_PER_BATCH,
  MAX_RESUME_TICKET_CHARS,
  MAX_TICK,
  PROTOCOL_VERSION,
  UNKNOWN_RTT,
  decodeCmd,
  describeMapMismatch,
  describeVersionMismatch,
  encodeCmd,
  parseClientMessage,
  parseServerMessage,
} from './protocol.ts'
export type {
  ClientCmds,
  ClientHello,
  ClientMessage,
  ClientPong,
  ServerDrain,
  ServerFault,
  ServerHash,
  ServerMapMismatch,
  ServerMessage,
  ServerPing,
  ServerSnapshot,
  ServerVersionMismatch,
  ServerWelcome,
  WireCmd,
} from './protocol.ts'

export {
  commandSourceFor,
  createReplayState,
  firstDivergence,
  formatTraceLiteral,
  runReplay,
  runReplayHosted,
  sampleTickAt,
  sampleTicks,
} from './replay.ts'
export type { Replay, ReplaySpawn, ScriptFrame, TraceDivergence, TraceSample } from './replay.ts'

export {
  DEFAULT_MAX_DEMO_FRAMES,
  DEMO_VERSION,
  createDemoRecorder,
  decodeDemo,
  describeDemo,
  encodeDemo,
  replayDemo,
  verifyDemo,
} from './demo.ts'
export type {
  Demo,
  DemoFrame,
  DemoHeader,
  DemoPlayback,
  DemoRecorder,
  DemoRecorderOptions,
  ReplayDemoOptions,
} from './demo.ts'

export {
  advanceRng,
  rngChance,
  rngFloat,
  rngInt,
  rngNext,
  rngRange,
  rngUint32,
  rngValue,
  seedFromString,
  seedRng,
} from './rng.ts'
export type { RngHolder, RngState } from './rng.ts'

export {
  GROUND_TRACE_DEPTH,
  MAX_BUMPS,
  MAX_CLIP_PLANES,
  MAX_MOVE_SPEED,
  MIN_WALK_NORMAL,
  OVERCLIP,
  STEP_SIZE,
  clampMoveSpeed,
  clipVelocity,
  createClipPlanes,
  createMoveBody,
  groundTrace,
  slideMove,
  slideVelocityAlongPlanes,
  stepSlideMove,
} from './slidemove.ts'
export type { ClipPlanes, MoveBody } from './slidemove.ts'

export { snapshotFrame } from './snapshot.ts'

export {
  CLEARANCE_MAXS,
  CLEARANCE_MINS,
  SELF_SPLASH_CLEARANCE,
  segmentClearsPlayer,
} from './splash.ts'
export type { SelfSplashPolicy } from './splash.ts'

export {
  EntityFlag,
  EntityKind,
  NEVER_EXPIRES,
  NO_ENTITY,
  NO_SLOT,
  cloneEntity,
  cloneGameState,
  createGameState,
  encodeExact,
  encodeInto,
  findEntity,
  findPlayer,
  hashState,
  removeEntity,
  spawnEntity,
} from './state.ts'
export type { EntityInit, EntityState, GameState } from './state.ts'

export { MAX_HOST_FRAME_MS, TICK_DT, TICK_INTERVAL_MS, TICK_RATE } from './tick.ts'

export {
  SURFACE_CLIP_EPSILON,
  createTrace,
  rayBoxFraction,
  traceBox,
  traceRay,
} from './trace.ts'
export type { TraceResult } from './trace.ts'

export { CloseReason, TransportState, messageSize } from './transport.ts'
export type { Transport, TransportHandlers, TransportMessage } from './transport.ts'

export { cosRad, sinRad } from './trig.ts'

export {
  ANGLE_UNITS,
  ANGLE_UNITS_PER_DEGREE,
  BUTTON_ATTACK,
  BUTTON_JUMP,
  BUTTON_MASK,
  MAX_MOVE,
  MAX_PITCH_UNITS,
  NULL_CMD,
  RADIANS_PER_ANGLE_UNIT,
  angleUnitsToRadians,
  pitchUnitsFromDegrees,
  sanitizeUserCmd,
  yawUnitsFromDegrees,
} from './usercmd.ts'
export type { UserCmd } from './usercmd.ts'

export { NEVER_FIRED, Weapon, isWeapon } from './weapon.ts'

export {
  AMMO_UNLIMITED,
  MUZZLE_FORWARD,
  RAILGUN_RANGE,
  ROCKET_LIFETIME_MS,
  ROCKET_SPEED,
  WEAPONS,
  fireWeapon,
  fireWeapons,
  muzzlePoint,
  refireTicksOf,
  spawnProjectile,
  weaponDef,
} from './weapons.ts'
export type { WeaponDef } from './weapons.ts'
