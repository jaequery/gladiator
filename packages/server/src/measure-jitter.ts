/**
 * How late does this machine actually wake us up, and can it hold a tick rate?
 *
 *     pnpm --filter @gladiator/server run jitter -- --seconds 60 --rooms 8
 *
 * Run it on the machine class that will actually serve players — on Fly that
 * means `flyctl ssh console` into a running machine, not a laptop. A laptop
 * measures a laptop. `docs/deploy.md` records what the deployed numbers were,
 * what the budget is, and what to do when they are over it.
 *
 * ## Two measurements, and the second is the one that matters
 *
 * The **probe** (`jitter.ts`) is a bare timer asking to be woken every 8 ms with
 * nothing to do when it is. That is the floor: whatever the kernel and Node's
 * event loop cost on this machine when nothing is competing for them.
 *
 * The **scheduler** (`scheduler.ts`) is the thing that actually runs, doing the
 * work it actually does: `--rooms` worlds, each with two seated peers sending a
 * command every tick, advanced in exact 8 ms sub-steps at 62.5 Hz. Its wakeup
 * lateness is the number {@link WAKEUP_BUDGET_MS} is a budget for, because a
 * scheduler that wakes on time and then takes 12 ms to tick its rooms is a
 * scheduler whose *next* wakeup is late — and the probe, doing nothing, would
 * never see it.
 *
 * The two are deliberately separate processes' worth of concern in one script:
 * a gap between them is CPU spent on simulation, and a p99 that is bad in both
 * is a machine class that cannot hold a tick rate at all.
 */
import {
  NULL_CMD,
  PROTOCOL_VERSION,
  TICK_INTERVAL_MS,
  encodeCmd,
  type UserCmd,
} from '@gladiator/sim'

import { systemClock } from './clock.ts'
import { createJitterProbe } from './jitter.ts'
import { SERVER_MAP, SERVER_MAP_HASH, SERVER_PLAN } from './map.ts'
import { createLoopbackPair } from './net/loopbackTransport.ts'
import { createRoom, type Room } from './room.ts'
import { WAKEUP_BUDGET_MS, createTickScheduler } from './scheduler.ts'

/** How many rooms the loaded measurement simulates. A duel each. */
const DEFAULT_ROOMS = 8

function readInteger(argv: readonly string[], flag: string, fallback: number): number {
  const index = argv.indexOf(flag)
  if (index === -1) return fallback
  const parsed = Number.parseInt(argv[index + 1] ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback
}

const seconds = readInteger(process.argv, '--seconds', 30)
const roomCount = readInteger(process.argv, '--rooms', DEFAULT_ROOMS)

const clock = systemClock()

/**
 * A room with two peers in it, both talking.
 *
 * Over loopbacks rather than sockets: what is being measured is the *tick*
 * cost, and a socket would fold the kernel's networking into a number that is
 * supposed to be about the simulation. The peers are real, they say hello, and
 * they send a command per tick, so every room is doing the work a live duel
 * does.
 */
function loadedRoom(index: number): Room {
  const room = createRoom({
    map: SERVER_MAP,
    plan: SERVER_PLAN,
    clock,
    build: 'jitter',
    id: `LOAD${index.toString(36).toUpperCase().padStart(2, '0')}`,
    peerId: (peer) => `load-${index}-${peer}`,
  })

  const hello = JSON.stringify({
    t: 'hello',
    protocol: PROTOCOL_VERSION,
    build: 'jitter',
    mapHash: SERVER_MAP_HASH,
  })

  for (let seat = 0; seat < 2; seat += 1) {
    const pair = createLoopbackPair()
    // The far end reads its frames and drops them. A measurement that let the
    // outbound snapshots pile up would be measuring a memory leak.
    pair.client.setHandlers({ onMessage: () => undefined })
    room.join(pair.server)
    pair.client.send(hello)
    senders.push({ pair, sent: 0 })
  }

  return room
}

type Sender = { readonly pair: ReturnType<typeof createLoopbackPair>; sent: number }
const senders: Sender[] = []

/** A command that keeps a body moving, so the movement phase does real work. */
function movingCommand(tick: number): UserCmd {
  return {
    ...NULL_CMD,
    forwardMove: 1,
    sideMove: tick % 64 < 32 ? 1 : -1,
    yaw: (tick * 37) % 65536,
  }
}

const rooms: Room[] = []
for (let index = 0; index < roomCount; index += 1) rooms.push(loadedRoom(index))

console.log(
  `measuring wakeup jitter for ${seconds}s on ${process.platform}/${process.arch}, ` +
    `node ${process.version}: a bare ${TICK_INTERVAL_MS} ms timer, and the real tick ` +
    `scheduler over ${roomCount} rooms of two players`,
)

const probe = createJitterProbe()
let tick = 0

const scheduler = createTickScheduler({
  clock,
  onFrame: (frame) => {
    // Every peer sends the commands the frame is worth, then the rooms run
    // them. The same order a live session produces, and the reason the buffers
    // stay at their target depth instead of starving all the way through the
    // measurement.
    for (const sender of senders) {
      if (frame.steps === 0) continue
      const cmds = []
      for (let step = 0; step < frame.steps; step += 1) cmds.push(encodeCmd(movingCommand(tick + step)))
      sender.pair.client.send(JSON.stringify({ t: 'cmds', startTick: sender.sent + 1, cmds }))
      sender.sent += frame.steps
    }
    tick += frame.steps
    for (const room of rooms) room.advance(frame.steps)
    for (const room of rooms) room.sweep(frame.nowMs)
  },
})

probe.start()
scheduler.start()

setTimeout(() => {
  probe.stop()
  scheduler.stop()

  const bare = probe.snapshot()
  const loaded = scheduler.stats()

  console.log(`bare timer: ${probe.describe()}`)
  console.log(scheduler.describe())
  // Machine-readable too, so a deploy log can be grepped rather than read.
  console.log(JSON.stringify({ bare, scheduler: loaded, rooms: roomCount }))

  const ticked = rooms[0]?.tick ?? 0
  console.log(
    `simulated ${ticked} sub-steps in ${seconds}s of wall-clock ` +
      `(${(ticked / seconds).toFixed(1)} Hz against a target of ${1000 / TICK_INTERVAL_MS})`,
  )

  if (!loaded.withinBudget) {
    console.warn(
      `warning: p99 wakeup lateness under load (${loaded.p99LatenessMs.toFixed(3)} ms) ` +
        `exceeds the budget of ${WAKEUP_BUDGET_MS} ms — see docs/deploy.md`,
    )
    process.exitCode = 1
  }
}, seconds * 1000)
