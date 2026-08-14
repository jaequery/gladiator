/**
 * The server entry point.
 *
 * Everything interesting is in `server.ts`; this is the part that reads the
 * environment, prints a line, and knows how to die politely.
 */
import { PROTOCOL_VERSION } from '@gladiator/sim'

import { readConfig } from './config.ts'
import { createJitterProbe } from './jitter.ts'
import { startServer } from './server.ts'

/** How long to keep reporting jitter into the boot log. */
const JITTER_REPORT_MS = 60_000

const config = readConfig(process.env)
const jitter = createJitterProbe()

const server = await startServer({ config, jitter })

console.log(
  `gladiator server listening on :${server.port} — build ${config.build}, protocol ${PROTOCOL_VERSION}, ` +
    `origins: ${config.allowedOrigins.length > 0 ? config.allowedOrigins.join(' ') : '(none listed)'} ` +
    `+ ${config.vercelProject}*.vercel.app${config.allowLocalhost ? ' + localhost' : ''}`,
)

// The number that matters is the one measured on the machine class actually
// serving players, so it is measured there and logged there. `/healthz` carries
// the live version; this is the one that ends up in the deploy log.
const report = setTimeout(() => {
  console.log(jitter.describe())
}, JITTER_REPORT_MS)
report.unref()

/**
 * Fly sends SIGTERM and then waits `kill_timeout` before SIGKILL. Closing the
 * sockets ourselves means clients see a 1001 "going away" and can tell a deploy
 * apart from a crash. Graceful drain proper — finishing the round in flight —
 * is GLAD-G41FQ9.
 */
const shutdown = (signal: string) => {
  console.log(`${signal} received — ${jitter.describe()}`)
  void server.close().then(() => {
    process.exit(0)
  })
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
