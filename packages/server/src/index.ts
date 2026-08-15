/**
 * The server entry point.
 *
 * Everything interesting is in `server.ts`; this is the part that reads the
 * environment, opens the log, and knows how to die politely.
 */
import { PROTOCOL_VERSION, TICK_INTERVAL_MS, countSimEvents } from '@gladiator/sim'

import { systemClock } from './clock.ts'
import { readConfig } from './config.ts'
import { createJitterProbe } from './jitter.ts'
import { createLogger } from './log.ts'
import { describeOriginPolicy } from './origin.ts'
import { generateResumeSecret } from './resume.ts'
import { MAX_ROOMS } from './rooms.ts'
import { HOST_FRAME_MS } from './scheduler.ts'
import { startServer } from './server.ts'
import { drainServer, installSignalHandlers } from './shutdown.ts'
import { BYTE_BUDGET_PER_SECOND, FRAME_BUDGET_PER_SECOND } from './validate.ts'

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
  vercelProject: config.vercelProject,
  // Empty means no preview may connect, which is the fail-closed state and not
  // a default — so it is worth a field of its own rather than an inference.
  vercelScope: config.vercelScope,
  originPolicy: describeOriginPolicy(config),
  allowLocalhost: config.allowLocalhost,
  demoDir: config.demoDir,
})

// The limits, in the boot log, because "why can this player not connect" and
// "why is this client being throttled" are questions somebody asks about a
// running process rather than about the source. Its own line rather than fields
// on `server.listening`, so a `jq 'select(.event=="server.limits")'` answers
// "what was this machine enforcing" without also matching every restart's worth
// of unrelated fields. `docs/deploy.md` under **Limits** is the same table with
// the reasoning attached.
log('server.limits', {
  maxFrameBytes: config.maxPayloadBytes,
  framesPerSecond: FRAME_BUDGET_PER_SECOND,
  bytesPerSecond: BYTE_BUDGET_PER_SECOND,
  connectBudgetPerSecond: config.connectBudgetPerSecond,
  connectBurst: config.connectBurst,
  maxConnectionsPerAddress: config.maxConnectionsPerAddress,
  // Which one, so that "everybody is sharing a bucket" is diagnosable from a
  // boot line rather than from the behaviour.
  addressFrom: config.trustedIpHeader === '' ? 'socket' : config.trustedIpHeader,
})

// Said at boot rather than discovered during a deploy. A machine that cannot
// mint a resume ticket is a machine whose deploy ends every match on it, and
// the secret has to be the *same* on both machines — so a per-process fallback
// would be a working test and a broken production. `resume.ts`, `NOTES.md`.
if (server.resume.enabled) {
  log('resume.enabled', { detail: 'RESUME_SECRET is set — matches survive a deploy' })
} else {
  log('resume.disabled', {
    level: 'warn',
    detail: 'no RESUME_SECRET, so every live match ends at the next deploy',
    fix:
      config.build === 'dev'
        ? `RESUME_SECRET=${generateResumeSecret()} pnpm --filter @gladiator/server dev`
        : 'flyctl secrets set RESUME_SECRET="$(openssl rand -hex 32)"',
  })
}

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
 * Fly sends SIGTERM and then waits `kill_timeout` before SIGKILL, and
 * `shutdown.ts` is what fits inside that window: stop being ready, hand every
 * peer a resume ticket, close the rooms with a 1001, and wait for the sockets
 * before exiting. A second signal skips all of it — see `installSignalHandlers`.
 */
installSignalHandlers({
  process,
  log,
  drain: async (signal) => {
    log('server.shutdown', {
      signal,
      rooms: server.rooms.size,
      speedClamps: counters.speedClamps,
      selfSplashes: counters.selfSplashes,
      scheduler: server.scheduler.describe(),
    })
    const drained = await drainServer({ server, resume: server.resume, clock: systemClock(), log })
    log('server.drained', {
      waitedMs: Math.round(drained.waitedMs),
      rooms: drained.rooms,
      told: drained.told,
      ticketed: drained.ticketed,
      timedOut: drained.timedOut,
    })
    return drained
  },
})
