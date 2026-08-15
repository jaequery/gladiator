#!/usr/bin/env node
/**
 * `pnpm run audio:verify` — this ticket's acceptance checks, in a real browser,
 * against the real production bundle.
 *
 * The unit tests prove the shape of the graph against a fake context. They
 * cannot prove the two things a player actually experiences, because both are
 * properties of the browser rather than of our code: whether a sound arrives
 * inside a frame, and whether a source behind the listener sounds behind them.
 * So this builds the client, serves it, opens Chromium and measures:
 *
 *   1. every sound decodes at load, and **nothing decodes afterwards** — the
 *      whole catalogue is played on both buses and the decode counter is read
 *      back
 *   2. one click resumes the `AudioContext` — the same click that takes pointer
 *      lock, which is the wiring that makes the first shot audible
 *   3. a fired weapon is audible within one frame: the voice is scheduled at
 *      `currentTime` (lead 0), the file's first audible sample is measured by an
 *      offline render, and the device's own `baseLatency` is added to both
 *   4. HRTF actually spatialises: front and behind render *identically* through
 *      `equalpower` and measurably differently through `HRTF`, and a source on
 *      the right is louder in the right ear
 *
 * `--write-probe <file>` also writes the rendered probe as a stereo WAV — five
 * positions in a row, so the last word on "does it sound behind you" belongs to
 * a person with headphones rather than to a number.
 *
 * It is not in `pnpm run ci` for the same reason `e2e` is not: it needs a
 * browser download. Locally:
 *
 *     pnpm run audio:verify
 *     pnpm run audio:verify -- --write-probe /tmp/probe.wav
 *     pnpm run audio:verify -- --skip-build      # reuse packages/client/dist
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_DIST = join(ROOT, 'packages', 'client', 'dist')

const STATIC_PORT = 8797
const STATIC_ORIGIN = `http://127.0.0.1:${STATIC_PORT}`

/**
 * One 60 Hz frame. The budget the whole latency chain is held to, because
 * "within one frame" is what the acceptance check says and 60 Hz is the slowest
 * display anyone is playing this on.
 */
const FRAME_BUDGET_MS = 1000 / 60

/**
 * How different an HRTF front/back pair has to be to count, as RMS of the
 * difference relative to the render's own RMS.
 *
 * 5% is far below what a real head-related transfer function produces (the
 * measurement prints what it got) and far above the zero an `equalpower` panner
 * produces, which is the comparison that gives the number meaning.
 */
const FRONT_BACK_MIN_RATIO = 0.05

const argv = process.argv.slice(2)
const flagValue = (flag) => {
  const index = argv.indexOf(flag)
  return index === -1 ? null : (argv[index + 1] ?? null)
}
const writeProbe = flagValue('--write-probe')
const skipBuild = argv.includes('--skip-build')

const failures = []
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
    if (detail !== '') console.log(`       ${detail}`)
    return
  }
  failures.push(label)
  console.log(`  FAIL ${label}`)
  if (detail !== '') console.log(`       ${detail}`)
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.join(' ')} exited ${code}`)),
    )
  })
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.wav': 'audio/wav',
}

/** A static file server for `packages/client/dist`, standing in for Vercel. */
function serveDist() {
  const server = createServer((request, response) => {
    const requested = new URL(request.url ?? '/', STATIC_ORIGIN).pathname
    const rel = normalize(requested === '/' ? '/index.html' : requested).replace(
      /^(\.\.[/\\])+/,
      '',
    )
    const file = join(CLIENT_DIST, rel)
    if (!file.startsWith(CLIENT_DIST) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(response)
  })
  return new Promise((resolve) => server.listen(STATIC_PORT, () => resolve(server)))
}

async function waitFor(what, predicate, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() > deadline) {
      console.log(`       timed out waiting for ${what}`)
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/** Mono/stereo 16-bit PCM WAV, for the probe a human listens to. */
function encodeWav(channels, sampleRate) {
  const frames = channels[0].length
  const count = channels.length
  const bytes = Buffer.alloc(44 + frames * count * 2)
  bytes.write('RIFF', 0, 'ascii')
  bytes.writeUInt32LE(36 + frames * count * 2, 4)
  bytes.write('WAVE', 8, 'ascii')
  bytes.write('fmt ', 12, 'ascii')
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(count, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * count * 2, 28)
  bytes.writeUInt16LE(count * 2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36, 'ascii')
  bytes.writeUInt32LE(frames * count * 2, 40)
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < count; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame] ?? 0))
      bytes.writeInt16LE(Math.round(sample * 32767), 44 + (frame * count + channel) * 2)
    }
  }
  return bytes
}

if (!skipBuild) {
  console.log('audio: building the client')
  await run('pnpm', ['--filter', '@gladiator/client', 'run', 'build'], {
    env: { ...process.env, VITE_BUILD: 'audio-check' },
  })
}
if (!existsSync(join(CLIENT_DIST, 'index.html'))) {
  console.error('audio: no client build to check — drop --skip-build')
  process.exit(1)
}

const staticServer = await serveDist()
let browser = null

try {
  try {
    browser = await chromium.launch({
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        // A silent output device, so an `AudioContext` runs in a container with
        // no sound card. Deliberately *not* `--autoplay-policy=...`: the whole
        // point of check 2 is that the context is suspended until a real
        // gesture resumes it, and disabling the policy would make it vacuous.
        '--mute-audio',
      ],
    })
  } catch (cause) {
    console.error(
      'audio: could not start Chromium. If that is a missing shared library, run\n' +
        '  pnpm exec playwright install --with-deps chromium\n',
    )
    throw cause
  }

  const context = await browser.newContext({ viewport: { width: 640, height: 400 } })
  const tab = await context.newPage()
  const consoleErrors = []
  tab.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  tab.on('pageerror', (error) => consoleErrors.push(`uncaught: ${error.message}`))

  await tab.goto(`${STATIC_ORIGIN}/`, { waitUntil: 'load' })

  const booted = await waitFor('the client to boot', async () =>
    tab.evaluate(() => window.__gladiator !== undefined),
  )
  check('the page boots with an audio engine attached', booted)

  // --- 1. everything is decoded before the match ---------------------------
  const loaded = await waitFor('the sound catalogue to load', async () =>
    tab.evaluate(() => window.__gladiator?.audio.snapshot().loaded === true),
  )
  const afterLoad = await tab.evaluate(() => window.__gladiator?.audio.snapshot())
  check(
    'every sound is fetched and decoded at load',
    loaded && afterLoad.sounds === 10 && afterLoad.decodes === 10,
    `${afterLoad?.sounds ?? 0} sounds from ${afterLoad?.decodes ?? 0} decodes, context ${afterLoad?.state}, ${afterLoad?.sampleRate} Hz`,
  )

  // --- 2. one gesture resumes the context ----------------------------------
  // Suspended first, deliberately. A headless browser has no autoplay policy to
  // hold the context back, so it boots `running` and a click that resumed
  // nothing would pass. Suspending puts the page in the state a *real* browser
  // hands it to a player before their first gesture; the click that follows is
  // an ordinary trusted click on the canvas, through the handler `armGesture`
  // installed, and nothing else is faked.
  console.log(`  ...  context state on load: ${afterLoad?.state} (headless has no autoplay policy)`)
  await tab.evaluate(() => window.__gladiator?.audio.suspend())
  const suspended = await waitFor('the context to suspend', async () =>
    tab.evaluate(() => window.__gladiator?.audio.snapshot().state === 'suspended'),
  )
  check('the context can be put back in its pre-gesture state', suspended)

  await tab.locator('#stage').click()
  const resumed = await waitFor('the context to resume', async () =>
    tab.evaluate(() => window.__gladiator?.audio.snapshot().state === 'running'),
  )
  const locked = await tab.evaluate(() => document.pointerLockElement !== null)
  check(
    'one click resumes the AudioContext and takes pointer lock',
    resumed && locked,
    `state ${await tab.evaluate(() => window.__gladiator?.audio.snapshot().state)}, pointer lock ${locked}`,
  )

  // --- 1 (continued). nothing decodes during a match ------------------------
  const played = await tab.evaluate(() => window.__gladiator?.audio.playAll())
  const afterPlay = await tab.evaluate(() => window.__gladiator?.audio.snapshot())
  check(
    'playing every sound on both buses decodes nothing',
    afterPlay?.decodesAfterLoad === 0 && afterPlay.decodes === afterLoad.decodes,
    `${played} voices started, ${afterPlay?.decodes} decodes total, ${afterPlay?.decodesAfterLoad} after load, ${afterPlay?.dropped} refused (the feedback-only sounds, on the world bus)`,
  )

  // --- 3. audible within one frame -----------------------------------------
  // Three numbers add up to the claim: how far ahead of the audio clock the
  // voice was scheduled (zero, by construction), how long the file takes to
  // become audible once it starts, and what the device adds on the way out.
  const onset = await tab.evaluate(() => window.__gladiator?.audio.onset())
  const latency = await tab.evaluate(() => {
    const audio = window.__gladiator?.audio
    audio?.playAll()
    return audio?.snapshot()
  })
  const totalMs =
    (latency?.lastScheduleLeadMs ?? 0) +
    (latency?.lastPlayCostMs ?? 0) +
    (onset?.onsetMs ?? 0) +
    (latency?.baseLatencyMs ?? 0)

  check(
    'a fired weapon is scheduled on the audio clock, with no lookahead',
    latency?.lastScheduleLeadMs === 0,
    `scheduled ${latency?.lastScheduleLeadMs.toFixed(3)} ms ahead of currentTime`,
  )
  check(
    'a fired weapon is audible within one frame',
    Number.isFinite(onset?.onsetMs) && totalMs < FRAME_BUDGET_MS,
    `${totalMs.toFixed(2)} ms of ${FRAME_BUDGET_MS.toFixed(1)}: ${onset?.onsetMs.toFixed(2)} ms to the first audible sample (peak ${onset?.peak.toFixed(3)}), ${latency?.lastPlayCostMs.toFixed(3)} ms in the play call, ${latency?.baseLatencyMs.toFixed(2)} ms of device baseLatency`,
  )

  // --- 4. HRTF puts a rocket behind you ------------------------------------
  const probe = await tab.evaluate(
    (capture) => window.__gladiator?.audio.probe(capture),
    writeProbe !== null,
  )
  const at = (name) => probe.positions.find((position) => position.name === name)
  const reference = (at('front').leftRms + at('front').rightRms) / 2
  const ratio = probe.frontBackDifference / Math.max(1e-12, reference)

  check(
    'an equalpower panner cannot tell front from behind — the control',
    probe.equalpowerFrontBackDifference === 0,
    `difference ${probe.equalpowerFrontBackDifference.toExponential(2)} (expected exactly 0)`,
  )
  check(
    'HRTF renders a source behind the listener differently from one in front',
    ratio > FRONT_BACK_MIN_RATIO,
    `front/back difference ${(ratio * 100).toFixed(1)}% of the signal (limit ${(FRONT_BACK_MIN_RATIO * 100).toFixed(0)}%), high-frequency ratio ${at('front').highRatio.toFixed(3)} in front vs ${at('behind').highRatio.toFixed(3)} behind`,
  )
  check(
    'a source to the side arrives at the near ear first, and louder',
    at('right').itdMs > 0.2 &&
      at('left').itdMs < -0.2 &&
      at('right').ildDb > 1 &&
      at('left').ildDb < -1,
    `right: ${at('right').itdMs.toFixed(2)} ms earlier in the right ear, ${at('right').ildDb.toFixed(1)} dB louder — left: ${at('left').itdMs.toFixed(2)} ms, ${at('left').ildDb.toFixed(1)} dB — front: ${at('front').itdMs.toFixed(2)} ms, ${at('front').ildDb.toFixed(1)} dB`,
  )
  check(
    'a source overhead is centred rather than silent',
    at('above').leftRms > 0 && Math.abs(at('above').ildDb) < 3,
    `above ${at('above').ildDb.toFixed(1)} dB, rms ${at('above').leftRms.toFixed(4)}`,
  )

  if (writeProbe !== null) {
    // One file, five positions in a row, so a listener hears the difference
    // rather than reading it.
    const gap = Math.round(probe.sampleRate * 0.35)
    const left = []
    const right = []
    for (const position of probe.positions) {
      left.push(...position.samples.left, ...new Array(gap).fill(0))
      right.push(...position.samples.right, ...new Array(gap).fill(0))
    }
    writeFileSync(writeProbe, encodeWav([left, right], probe.sampleRate))
    console.log(
      `  ...  wrote ${writeProbe} — ${probe.positions.map((position) => position.name).join(', ')}, ${probe.sampleRate} Hz. Headphones.`,
    )
  }

  const audioErrors = consoleErrors.filter((message) => !/websocket|ws:\/\//i.test(message))
  check(
    'the page logged no console errors other than the missing server',
    audioErrors.length === 0,
    audioErrors.slice(0, 5).join(' | '),
  )
} finally {
  await browser?.close()
  staticServer.close()
}

console.log(`\naudio: ${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) {
  console.error(`audio-check failed:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
