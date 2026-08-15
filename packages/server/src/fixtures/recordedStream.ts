/**
 * One recorded input stream, and the hash it is supposed to produce.
 *
 * The point of a *recorded* stream is that it is the same bytes every time, so
 * two runs that disagree disagree about the simulation rather than about what
 * they were asked to simulate. `net/parity.test.ts` pushes this through an
 * in-process loopback and through a real WebSocket and requires the same hash
 * trace out of both; `net/laggedTransport.test.ts` pushes it through a link
 * with latency and jitter on it and requires the same trace again.
 *
 * The batch sizes alternate between two and three commands on purpose. A 60 Hz
 * browser at a 125 Hz tick rate sends two ticks in one frame and three in the
 * next, forever, and a stream of uniform batches would not exercise the case
 * where a frame boundary and a tick boundary do not line up.
 */
import { type UserCmd, type WireCmd, encodeCmd } from '@gladiator/sim'

export type RecordedBatch = {
  /** The tick the first command in {@link RecordedBatch.cmds} advances the world *to*. */
  readonly startTick: number
  readonly cmds: readonly WireCmd[]
}

export type RecordedStream = {
  /** The tick the world ends on. */
  readonly ticks: number
  readonly batches: readonly RecordedBatch[]
}

/**
 * A movement script: turning, strafing and jumping, so the state keeps moving.
 *
 * The slow continuous turn is what drags every quadrant of the trig through the
 * run — a stream that only ever faced one way would agree about a much smaller
 * part of the simulation than it appears to.
 */
export function scriptedCommand(tick: number): UserCmd {
  return {
    forwardMove: tick % 240 < 200 ? 1 : -1,
    sideMove: tick % 130 < 65 ? 1 : -1,
    yaw: (tick * 37) % 65536,
    pitch: 0,
    buttons: tick % 90 === 0 ? 1 : 0,
    weapon: 0,
  }
}

export function recordStream(ticks: number): RecordedStream {
  const batches: RecordedBatch[] = []
  let tick = 0
  while (tick < ticks) {
    const startTick = tick + 1
    const size = Math.min(ticks - tick, tick % 2 === 0 ? 2 : 3)
    const cmds: WireCmd[] = []
    for (let i = 0; i < size; i += 1) {
      tick += 1
      cmds.push(encodeCmd(scriptedCommand(tick)))
    }
    batches.push({ startTick, cmds })
  }
  return { ticks, batches }
}

/** The frame a client sends for one batch. */
export function batchFrame(batch: RecordedBatch): string {
  return JSON.stringify({ t: 'cmds', startTick: batch.startTick, cmds: batch.cmds })
}
