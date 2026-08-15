/**
 * The server entry point.
 *
 * Everything interesting is in `server.ts`; this is the part that reads the
 * environment, prints a line, and knows how to die politely.
 */
import { PROTOCOL_VERSION, TICK_INTERVAL_MS, onSpeedClamp } from '@gladiator/sim'

import { readConfig } from './config.ts'
import { createJitterProbe } from './jitter.ts'
import { MAX_ROOMS } from './rooms.ts'
import { HOST_FRAME_MS } from './scheduler.ts'
import { startServer } from './server.ts'
import { BYTE_BUDGET_PER_SECOND, FRAME_BUDGET_PER_SECOND } from './validate.ts'

/** How long to keep reporting jitter into the boot log. */
const JITTER_REPORT_MS = 60_000

const config = readConfig(process.env)
const jitter = createJitterProbe()

// The simulation has no `console` — that is enforced, not conventional — so the
// physics-spec §2.6 safety rail reports through a seam the host fills in.
// Nothing a player can do reaches 3000 qu/s, so a line here means a command
// stream produced a velocity that movement cannot: worth seeing in the log.
onSpeedClamp((speed) => {
  console.warn(`gladiator: clamped a velocity of ${speed.toFixed(0)} qu/s`)
})

const server = await startServer({ config, jitter })

console.log(
  `gladiator server listening on :${server.port} — build ${config.build}, protocol ${PROTOCOL_VERSION}, ` +
    `ticking at ${1000 / HOST_FRAME_MS} Hz into ${1000 / TICK_INTERVAL_MS} Hz sub-steps, ` +
    `up to ${MAX_ROOMS} rooms, ` +
    `origins: ${config.allowedOrigins.length > 0 ? config.allowedOrigins.join(' ') : '(none listed)'} ` +
    `+ ${config.vercelProject}*.vercel.app${config.allowLocalhost ? ' + localhost' : ''}`,
)

// The limits, in the boot log, because "why can this player not connect" and
// "why is this client being throttled" are questions somebody asks about a
// running process rather than about the source. `docs/deploy.md` under
// **Limits** is the same table with the reasoning attached.
console.log(
  `limits: frames ${config.maxPayloadBytes} B / ${FRAME_BUDGET_PER_SECOND} per s / ` +
    `${BYTE_BUDGET_PER_SECOND} B per s, ` +
    `connections ${config.connectBudgetPerSecond}/s burst ${config.connectBurst}, ` +
    `${config.maxConnectionsPerAddress} open per address, ` +
    `address from ${config.trustedIpHeader === '' ? 'the socket' : config.trustedIpHeader}`,
)

// The number that matters is the one measured on the machine class actually
// serving players, so it is measured there and logged there. `/healthz` carries
// the live version; this is the one that ends up in the deploy log.
//
// Both of them: the bare timer is the floor this machine offers, and the tick
// scheduler is what actually runs, measuring its own lateness while doing real
// work. `WAKEUP_BUDGET_MS` is the budget and `docs/deploy.md` says what to do
// when it is over.
const report = setTimeout(() => {
  console.log(`bare timer: ${jitter.describe()}`)
  console.log(server.scheduler.describe())
}, JITTER_REPORT_MS)
report.unref()

/**
 * Fly sends SIGTERM and then waits `kill_timeout` before SIGKILL. Closing the
 * sockets ourselves means clients see a 1001 "going away" and can tell a deploy
 * apart from a crash. Graceful drain proper — finishing the round in flight —
 * is GLAD-G41FQ9.
 */
const shutdown = (signal: string) => {
  console.log(
    `${signal} received — ${server.rooms.size} rooms live, ${server.scheduler.describe()}`,
  )
  void server.close().then(() => {
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
