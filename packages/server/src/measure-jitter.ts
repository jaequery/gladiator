/**
 * Measure this machine's timer wakeup jitter and print it.
 *
 *     pnpm --filter @gladiator/server run jitter -- --seconds 60
 *
 * Run it on the machine class that will actually serve players — on Fly that
 * means `flyctl ssh console` into a running machine, not a laptop. A laptop
 * measures a laptop. `docs/deploy.md` records what the deployed numbers were
 * and what they mean.
 */
import { TICK_INTERVAL_MS } from '@gladiator/sim'

import { createJitterProbe } from './jitter.ts'

function readSeconds(argv: readonly string[]): number {
  const index = argv.indexOf('--seconds')
  if (index === -1) return 30
  const parsed = Number.parseInt(argv[index + 1] ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 30
}

const seconds = readSeconds(process.argv)
const probe = createJitterProbe()

console.log(
  `measuring timer wakeup jitter at ${TICK_INTERVAL_MS} ms for ${seconds}s on ${process.platform}/${process.arch}, node ${process.version}`,
)

probe.start()
setTimeout(() => {
  probe.stop()
  const snapshot = probe.snapshot()
  console.log(probe.describe())
  // Machine-readable too, so a deploy log can be grepped rather than read.
  console.log(JSON.stringify(snapshot))
  // A tick's worth of lateness at the 99th percentile means the server is, one
  // wakeup in a hundred, a whole tick behind where it thinks it is.
  if (snapshot.p99Ms > TICK_INTERVAL_MS) {
    console.warn(
      `warning: p99 wakeup lateness (${snapshot.p99Ms.toFixed(3)} ms) exceeds one tick (${TICK_INTERVAL_MS} ms)`,
    )
  }
}, seconds * 1000)
