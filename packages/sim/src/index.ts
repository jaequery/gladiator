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
export type { CommandSource, Kernel, TickInputs, TickObserver } from './kernel.ts'

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
export type { MapGeometry, SurfaceGroup } from './map/geometry.ts'

export {
  hashMapSource,
  loadMap,
  mapHashOf,
  parseBakedMap,
  parseMapSource,
} from './map/load.ts'
export type { LoadedMap } from './map/load.ts'

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
  subVec3,
  vec3,
} from './math.ts'
export type { MutVec3 } from './math.ts'

export {
  AIR_CONTROL,
  AIR_STOP_ACCELERATE,
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
  MAX_CMDS_PER_BATCH,
  PROTOCOL_VERSION,
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
  ServerFault,
  ServerHash,
  ServerMapMismatch,
  ServerMessage,
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
  sampleTicks,
} from './replay.ts'
export type { Replay, ReplaySpawn, ScriptFrame, TraceDivergence, TraceSample } from './replay.ts'

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

export { snapshotOf } from './snapshot.ts'
export type { Snapshot } from './snapshot.ts'

export {
  EntityFlag,
  EntityKind,
  NEVER_EXPIRES,
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

export { SURFACE_CLIP_EPSILON, createTrace, traceBox, traceRay } from './trace.ts'
export type { TraceResult } from './trace.ts'

export { CloseReason, TransportState, messageSize } from './transport.ts'
export type { Transport, TransportHandlers, TransportMessage } from './transport.ts'

export { cosRad, sinRad } from './trig.ts'

export {
  ANGLE_UNITS,
  ANGLE_UNITS_PER_DEGREE,
  BUTTON_JUMP,
  MAX_PITCH_UNITS,
  NULL_CMD,
  RADIANS_PER_ANGLE_UNIT,
  angleUnitsToRadians,
  pitchUnitsFromDegrees,
  sanitizeUserCmd,
  yawUnitsFromDegrees,
} from './usercmd.ts'
export type { UserCmd } from './usercmd.ts'
