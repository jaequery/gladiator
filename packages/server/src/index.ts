/**
 * The server entry point.
 *
 * Everything interesting is in `server.ts`; this is the part that reads the
 * environment, prints a line, and knows how to die politely.
 */
import { PROTOCOL_VERSION, TICK_INTERVAL_MS, onSpeedClamp } from '@gladiator/sim'

import { systemClock } from './clock.ts'
import { readConfig } from './config.ts'
import { createJitterProbe } from './jitter.ts'
import { describeOriginPolicy } from './origin.ts'
import { generateResumeSecret } from './resume.ts'
import { MAX_ROOMS } from './rooms.ts'
import { HOST_FRAME_MS } from './scheduler.ts'
import { startServer } from './server.ts'
import { drainServer, installSignalHandlers } from './shutdown.ts'

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
    describeOriginPolicy(config),
)

// Said at boot rather than discovered during a deploy. A machine that cannot
// mint a resume ticket is a machine whose deploy ends every match on it, and
// the secret has to be the *same* on both machines — so a per-process fallback
// would be a working test and a broken production. `resume.ts`, `NOTES.md`.
if (server.resume.enabled) {
  console.log('resume: RESUME_SECRET is set — matches survive a deploy')
} else if (config.build === 'dev') {
  console.warn(
    'resume: no RESUME_SECRET, so a restart ends every live match. For local development:\n' +
      `  RESUME_SECRET=${generateResumeSecret()} pnpm --filter @gladiator/server dev`,
  )
} else {
  console.warn(
    'resume: no RESUME_SECRET on a deployed build — every live match ends at the next deploy. ' +
      'Set it with: flyctl secrets set RESUME_SECRET="$(openssl rand -hex 32)"',
  )
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
  console.log(`bare timer: ${jitter.describe()}`)
  console.log(server.scheduler.describe())
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
  log: (line) => console.log(line),
  drain: async (signal) => {
    console.log(
      `${signal} received — ${server.rooms.size} rooms live, ${server.scheduler.describe()}`,
    )
    const report = await drainServer({
      server,
      resume: server.resume,
      clock: systemClock(),
      log: (line) => console.log(line),
    })
    console.log(
      `drained in ${Math.round(report.waitedMs)} ms: ${report.rooms} rooms, ${report.told} peers told, ` +
        `${report.ticketed} ticketed${report.timedOut ? ' — deadline reached' : ''}`,
    )
    return report
  },
})
