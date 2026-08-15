/**
 * The server entry point.
 *
 * Everything interesting is in `server.ts`; this is the part that reads the
 * environment, opens the log, and knows how to die politely.
 */
import { PROTOCOL_VERSION, TICK_INTERVAL_MS, countSimEvents } from '@gladiator/sim'

import { readConfig } from './config.ts'
import { createJitterProbe } from './jitter.ts'
import { createLogger } from './log.ts'
import { MAX_ROOMS } from './rooms.ts'
import { HOST_FRAME_MS } from './scheduler.ts'
import { startServer } from './server.ts'

/** How long to keep reporting jitter into the boot log. */
const JITTER_REPORT_MS = 60_000

const config = readConfig(process.env)
const jitter = createJitterProbe()

/**
 * The log. One JSON object per line, and this is the only place that decides
 * where a line goes — see `log.ts` for why the sink and the clock are injected
 * rather than read in there.
 */
const log = createLogger({
  write: (line) => {
    console.log(line)
  },
  time: () => Date.now(),
  context: { build: config.build },
})

// The simulation has no `console` and no counters — that is enforced, not
// conventional — so the two conditions worth noticing are seams a host fills
// in, and `countSimEvents` is the tally on both of them. Nothing a player can
// do reaches 3000 qu/s, so a clamp here means a command stream produced a
// velocity that movement cannot: worth a line, every time, with the count
// beside it so a storm of them reads as one problem rather than a thousand.
const counters = countSimEvents({
  onSpeedClamp: (speed) => {
    log('sim.speed_clamped', {
      level: 'warn',
      speed: Math.round(speed),
      clamps: counters.speedClamps,
    })
  },
})

const server = await startServer({ config, jitter, log })

log('server.listening', {
  port: server.port,
  protocol: PROTOCOL_VERSION,
  hostFrameHz: 1000 / HOST_FRAME_MS,
  tickHz: 1000 / TICK_INTERVAL_MS,
  maxRooms: MAX_ROOMS,
  allowedOrigins: config.allowedOrigins.join(' '),
  vercelProject: `${config.vercelProject}*.vercel.app`,
  allowLocalhost: config.allowLocalhost,
  demoDir: config.demoDir,
})

// The number that matters is the one measured on the machine class actually
// serving players, so it is measured there and logged there. `/healthz` carries
// the live version; this is the one that ends up in the deploy log.
//
// Both of them: the bare timer is the floor this machine offers, and the tick
// scheduler is what actually runs, measuring its own lateness while doing real
// work. `WAKEUP_BUDGET_MS` is the budget and `docs/deploy.md` says what to do
// when it is over.
const report = setTimeout(() => {
  log('jitter.bare_timer', { detail: jitter.describe() })
  log('scheduler.report', { detail: server.scheduler.describe() })
}, JITTER_REPORT_MS)
report.unref()

/**
 * Fly sends SIGTERM and then waits `kill_timeout` before SIGKILL. Closing the
 * sockets ourselves means clients see a 1001 "going away" and can tell a deploy
 * apart from a crash. Graceful drain proper — finishing the round in flight —
 * is GLAD-G41FQ9.
 */
const shutdown = (signal: string) => {
  log('server.shutdown', {
    signal,
    rooms: server.rooms.size,
    speedClamps: counters.speedClamps,
    selfSplashes: counters.selfSplashes,
    scheduler: server.scheduler.describe(),
  })
  void server.close().then(() => {
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
