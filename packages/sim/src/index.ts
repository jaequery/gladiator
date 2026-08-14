export { QUAKE_TO_ENGINE, applyMat3, determinant3, quakeToEngine } from './axis.ts'
export type { Mat3, Vec3 } from './axis.ts'

export {
  DT,
  GRAVITY,
  JUMP_VELOCITY,
  MAX_HOST_FRAME_MS,
  TICKS_PER_SECOND,
  TICK_HZ,
  TICK_MS,
} from './constants.ts'

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
  FNV_OFFSET_BASIS_32,
  FNV_PRIME_32,
  fnv1aByte,
  fnv1aFinish,
  hashBytes,
  hashHex,
  hashString,
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
  DEG_TO_RAD,
  angleVectors,
  copyVec3,
  lengthVec2,
  lengthVec3,
  setVec3,
  vec3,
  wrapAngle,
} from './math.ts'
export type { MutVec3 } from './math.ts'

export { snapshotOf } from './proto/snapshot.ts'
export type { Snapshot } from './proto/snapshot.ts'

export { CloseReason, TransportState, messageSize } from './proto/transport.ts'
export type { Transport, TransportHandlers, TransportMessage } from './proto/transport.ts'

export {
  Button,
  IDLE_CMD,
  MOVE_AXIS_MAX,
  Weapon,
  clampMoveAxis,
  isPressed,
  wasJustPressed,
} from './proto/usercmd.ts'
export type { UserCmd } from './proto/usercmd.ts'

export {
  commandSourceFor,
  createReplayState,
  firstDivergence,
  formatTraceLiteral,
  runReplay,
  runReplayHosted,
  sampleTicks,
} from './replay.ts'
export type {
  Replay,
  ReplaySpawn,
  ScriptFrame,
  TraceDivergence,
  TraceSample,
} from './replay.ts'

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
