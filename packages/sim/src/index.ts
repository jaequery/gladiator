export { QUAKE_TO_ENGINE, applyMat3, determinant3, quakeToEngine } from './axis.ts'
export type { Mat3, Vec3 } from './axis.ts'

export {
  FNV_OFFSET_BASIS,
  FNV_PRIME,
  formatHash,
  hashFloat64,
  hashInit,
  hashPlayerState,
  hashUint32,
} from './hash.ts'

export {
  GRAVITY,
  JUMP_VELOCITY,
  PLANE_HALF_EXTENT,
  PLAYER_HALF_WIDTH,
  PLAYER_HEIGHT,
  RUN_SPEED,
  SPAWN_STATE,
  pmove,
} from './pmove.ts'
export type { PlayerState } from './pmove.ts'

export {
  MAX_CMDS_PER_BATCH,
  PROTOCOL_VERSION,
  decodeCmd,
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
  ServerMessage,
  ServerVersionMismatch,
  ServerWelcome,
  WireCmd,
} from './protocol.ts'

export { TICK_DT, TICK_INTERVAL_MS, TICK_RATE } from './tick.ts'

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
