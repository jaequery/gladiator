#!/usr/bin/env node
/**
 * The browser smoke test — this ticket's acceptance criteria, in a real
 * browser, against the real production bundle and the real server bundle.
 *
 * Everything else in `pnpm run ci` tests the pieces. This runs the artefact:
 *
 *   1. builds the client with `VITE_SERVER_URL` pointing at a local server,
 *      exactly the way Vercel builds it with the URL pointing at Fly
 *   2. runs `packages/server/dist/index.js` — the bundle that goes in the
 *      Docker image, not `tsx` over the source
 *   3. serves the client's `dist` over plain HTTP and curls it for a 200
 *   4. opens it in headless Chromium, failing on any console error
 *   5. checks a real graphics context came up, that `scene.isReady(true)`
 *      resolved, and that frames are actually being drawn
 *   6. clicks to take pointer lock, holds W and space, and checks the box moved
 *   7. measures frame pacing over a window and judges it by percentile and
 *      hitch rate — never by the average, which hides exactly the stutter a
 *      player notices
 *   8. runs for a minute and checks the client and server hashes agree
 *   9. reloads with `?protocol=999` and checks the version-mismatch message is
 *      on screen, rather than the socket closing silently
 *  10. reloads with `?shot=1` and compares the frame against a committed
 *      reference screenshot
 *
 * It is not in `pnpm run ci` because it needs a browser download; CI runs it as
 * its own job. Locally:
 *
 *     pnpm run e2e                       # the full minute
 *     pnpm run e2e -- --seconds 10       # while iterating
 *     pnpm run e2e -- --update-reference # re-shoot the reference screenshot
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_DIST = join(ROOT, 'packages', 'client', 'dist')
const SERVER_BUNDLE = join(ROOT, 'packages', 'server', 'dist', 'index.js')
const REFERENCE_DIR = join(ROOT, 'packages', 'client', 'reference')
const REFERENCE_NAME = 'testbed.png'
const REFERENCE_FILE = join(REFERENCE_DIR, REFERENCE_NAME)

const SERVER_PORT = 8798
const STATIC_PORT = 8799
const STATIC_ORIGIN = `http://127.0.0.1:${STATIC_PORT}`
const BUILD = 'e2e'

/**
 * The size the reference screenshot is compared at.
 *
 * Smaller than the viewport on purpose: scaling down averages away the
 * single-pixel differences a rasteriser is entitled to have and keeps the
 * differences a *rendering* change makes. It is committed at this size, so the
 * image in the repository is the image the comparison uses.
 */
const REFERENCE_WIDTH = 512
const REFERENCE_HEIGHT = 320

/**
 * How different a pixel may be before it counts as different: 12 of 255 on any
 * channel. Below that is dithering and filtering; above it is a change someone
 * made.
 */
const CHANNEL_TOLERANCE = 12

/** How many pixels may differ by that much: 1%. */
const PIXEL_TOLERANCE = 0.01

/** And how far the whole image may drift on average, of 255. */
const MEAN_TOLERANCE = 2.5

/**
 * The window frame pacing is measured in.
 *
 * Small on purpose, and this is the whole trick that makes the measurement
 * mean anything in CI. Headless Chromium renders on SwiftShader, a *software*
 * rasteriser: at 1024x640 it spends 40-70 ms a frame colouring pixels, which
 * measures the runner's CPU and nothing about this renderer. Shrinking the
 * window by ten times takes fill rate out of the picture and leaves everything
 * that actually regresses — the simulation, the accumulator, Babylon's draw
 * submission, garbage collection, our own per-frame work.
 *
 * At this size the loop sits on the 60 Hz vsync with room to spare, which is
 * why {@link FRAME_BUDGET_MS} below can be the *real* budget rather than an
 * apology for the runner.
 */
const PACING_VIEWPORT = { width: 320, height: 200 }

/** What the rest of the run uses. */
const VIEWPORT = { width: 1024, height: 640 }

/**
 * The three shapes the HUD has to hold, and why these three.
 *
 * 16:9 is what almost everybody has; 4:3 is the narrowest thing anybody still
 * plays on and is where a centred element is closest to a corner one; 21:9 is
 * the shortest, and is where anything positioned as a percentage of the height
 * — the round banner — comes closest to the middle of the screen. Between them
 * they bracket every layout mistake this HUD can make. GLAD-BHNPOE.
 */
const HUD_VIEWPORTS = [
  { name: '16:9', width: 1280, height: 720 },
  { name: '21:9', width: 1280, height: 549 },
  { name: '4:3', width: 1024, height: 768 },
]

/**
 * The frame budget the browser is held to, in milliseconds.
 *
 * 50 — three 60 Hz frames. The budget that *ships* is one (`FRAME_BUDGET_MS`
 * in `render/frameStats.ts`, 16.7 ms), and on a quiet machine this renderer
 * holds it exactly: measured at 320x200 in headless Chromium, mean 16.7, p99
 * 16.8, worst 16.8 over six hundred frames. The extra here is headroom for a
 * shared CI runner, where the browser is one process among several and a
 * hundred milliseconds of descheduling is the runner's doing rather than the
 * renderer's.
 *
 * It is still a gate with teeth: a renderer that got three times as expensive
 * misses it, twice in a row. Pass `--frame-budget 20` on a machine you are not
 * sharing, which is where the number that matters is measured.
 */
const FRAME_BUDGET_MS = 50

/** How many pacing windows to try before calling it. See the loop that uses it. */
const PACING_ATTEMPTS = 2

/** How long the baseline loop runs. Long enough to see the machine's cadence. */
const BASELINE_SECONDS = 5

/**
 * How much worse than an empty loop this renderer may be.
 *
 * The budget is the larger of {@link FRAME_BUDGET_MS} and this multiple of what
 * an empty loop managed, so a machine whose display is not 60 Hz — or whose
 * headless compositor decides otherwise — is not failed for a cadence it does
 * not control. See {@link measureBaseline}.
 */
const BASELINE_FACTOR = 1.5

const argv = process.argv.slice(2)
const numeric = (flag, fallback) => {
  const index = argv.indexOf(flag)
  if (index === -1) return fallback
  const parsed = Number.parseFloat(argv[index + 1] ?? '')
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const seconds = Math.round(numeric('--seconds', 60))
const frameSeconds = Math.round(numeric('--frame-seconds', 30))
const frameBudgetMs = numeric('--frame-budget', FRAME_BUDGET_MS)
const updateReference = argv.includes('--update-reference')

const failures = []
let checks = 0

function check(label, condition, detail = '') {
  checks += 1
  if (condition) {
    console.log(`  ok   ${label}`)
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
  // The vendored KTX2 transcoders and the compressed textures they decode.
  // `application/wasm` is not politeness: `WebAssembly.instantiateStreaming`
  // rejects anything else, and Vercel serves it correctly, so a stand-in that
  // did not would be testing a page the deploy never shows anyone.
  '.wasm': 'application/wasm',
  '.ktx2': 'image/ktx2',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
}

/**
 * Where the reference screenshot is served from.
 *
 * Same origin as the page, so the comparison can `fetch` it and decode it with
 * `createImageBitmap` — which means the whole diff happens inside the browser
 * and neither image ever crosses into Node. That is what lets this repository
 * compare PNGs without adding a PNG decoder to it.
 */
const REFERENCE_ROUTE = '/__reference__/'

/** A static file server for `packages/client/dist`, standing in for Vercel. */
function serveDist() {
  const server = createServer((request, response) => {
    const requested = new URL(request.url ?? '/', STATIC_ORIGIN).pathname

    const root = requested.startsWith(REFERENCE_ROUTE) ? REFERENCE_DIR : CLIENT_DIST
    const path = requested.startsWith(REFERENCE_ROUTE)
      ? requested.slice(REFERENCE_ROUTE.length - 1)
      : requested
    const rel = normalize(path === '/' ? '/index.html' : path).replace(/^(\.\.[/\\])+/, '')

    const file = join(root, rel)
    if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(response)
  })
  return new Promise((resolve) => server.listen(STATIC_PORT, () => resolve(server)))
}

/**
 * Compare the frame on screen against a reference PNG, inside the page.
 *
 * Returns the fraction of pixels that differ by more than `channelTolerance` on
 * any channel, and the mean absolute difference over every channel. Both,
 * because they catch different things: a handful of hard edges moving shows up
 * in the fraction, and a change of exposure or tone mapping shows up in the
 * mean while barely registering in the fraction.
 */
const compareToReference = async ({ url, width, height, channelTolerance }) => {
  const shot = window.__gladiator.capture(width, height)

  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) return { error: `reference fetch failed: ${response.status}` }
  const bitmap = await createImageBitmap(await response.blob())
  if (bitmap.width !== width || bitmap.height !== height) {
    return { error: `reference is ${bitmap.width}x${bitmap.height}, expected ${width}x${height}` }
  }

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  context.drawImage(bitmap, 0, 0)
  const reference = context.getImageData(0, 0, width, height)

  let differing = 0
  let total = 0
  for (let i = 0; i < shot.data.length; i += 4) {
    let worst = 0
    for (let channel = 0; channel < 3; channel += 1) {
      const delta = Math.abs(shot.data[i + channel] - reference.data[i + channel])
      total += delta
      if (delta > worst) worst = delta
    }
    if (worst > channelTolerance) differing += 1
  }
  const pixels = shot.data.length / 4
  return { differing, pixels, fraction: differing / pixels, mean: total / (pixels * 3) }
}

/**
 * Measure every HUD box, inside the page, at whatever size the window is now.
 *
 * Two failures matter and they are different: a box hanging off the edge of the
 * screen is information the player cannot read, and two boxes on top of each
 * other is information they cannot read *either*, which is worse because it
 * looks deliberate.
 *
 * Everything marked `data-hud-box` is revealed for the measurement and put back
 * afterwards. Without that the check would only ever see whatever the page
 * happened to be showing at that instant — never the round banner, which is up
 * for three seconds in twenty and is the element most likely to land on
 * something. The next frame rewrites all of it regardless.
 */
const measureHudBoxes = ({ width, height }) => {
  const root = document.querySelector('[data-hud="match"]')
  const nodes = [...document.querySelectorAll('[data-hud-box]')]
  const shown = root === null ? nodes : [root, ...nodes]

  const restore = shown.map((node) => {
    const previous = node.dataset.visible
    const wasHidden = node.hasAttribute('hidden')
    node.dataset.visible = 'yes'
    node.removeAttribute('hidden')
    return { node, previous, wasHidden }
  })

  const boxes = nodes
    .map((node) => {
      const rect = node.getBoundingClientRect()
      return {
        name: node.dataset.hud ?? node.getAttribute('class') ?? node.tagName,
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      }
    })
    .filter((box) => box.width > 0 && box.height > 0)

  for (const { node, previous, wasHidden } of restore) {
    if (previous === undefined) delete node.dataset.visible
    else node.dataset.visible = previous
    if (wasHidden) node.setAttribute('hidden', '')
  }

  // Half a pixel of slack, because a box centred with `translateX(-50%)` in an
  // odd-width window lands on a half pixel by construction.
  const clipped = boxes
    .filter(
      (box) =>
        box.left < -0.5 || box.top < -0.5 || box.right > width + 0.5 || box.bottom > height + 0.5,
    )
    .map((box) => `${box.name} at ${Math.round(box.left)},${Math.round(box.top)} ${Math.round(box.width)}x${Math.round(box.height)}`)

  const overlaps = []
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]
      const b = boxes[j]
      if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) {
        overlaps.push(`${a.name} over ${b.name}`)
      }
    }
  }

  return { measured: boxes.length, names: boxes.map((box) => box.name), clipped, overlaps }
}

/**
 * The cadence this machine hands out: an empty `requestAnimationFrame` loop in
 * the same browser, drawing nothing.
 *
 * A frame interval can never be shorter than the display's refresh, and not
 * every machine refreshes at 60 Hz — a headless compositor, a 50 Hz panel or a
 * VM with a virtual display can hand out something else entirely. Failing a
 * renderer for a cadence it does not control would be measuring the wrong
 * thing, so the budget is the larger of the real one and this, times
 * {@link BASELINE_FACTOR}.
 *
 * It deliberately does *not* try to normalise away CPU contention, because it
 * cannot: an empty loop needs no CPU and so keeps perfect time on a machine at
 * a load average of thirty, while any page doing real work per frame is
 * descheduled. That is what {@link FRAME_BUDGET_MS}'s headroom is for.
 */
async function measureBaseline(context, seconds) {
  const control = await context.newPage()
  await control.setContent('<!doctype html><title>baseline</title>')
  const p99 = await control.evaluate(async (seconds) => {
    const intervals = []
    let last = performance.now()
    await new Promise((resolve) => {
      const deadline = last + seconds * 1000
      const frame = (now) => {
        intervals.push(now - last)
        last = now
        if (now < deadline) requestAnimationFrame(frame)
        else resolve()
      }
      requestAnimationFrame(frame)
    })
    intervals.sort((a, b) => a - b)
    const rank = Math.ceil(0.99 * intervals.length)
    return intervals[Math.min(intervals.length - 1, Math.max(0, rank - 1))] ?? 0
  }, seconds)
  await control.close()
  return p99
}

/**
 * Give the mouse back, the way a player does — or the way a test has to.
 *
 * Escape is handled by the browser's own *chrome* rather than by the page, and
 * a synthesised key event does not reach it in headless Chromium. Where that is
 * the case the lock is dropped through the API instead: what everything after
 * this is about is the state on the other side of a release, and the release
 * itself is not the claim. Which one happened is returned rather than hidden,
 * because "escape did nothing" must not read as a pass.
 */
async function releaseLock(page) {
  await page.keyboard.press('Escape')
  const byEscape = await waitFor(
    'escape to release the pointer',
    async () => page.evaluate(() => document.pointerLockElement === null),
    2000,
  )
  if (byEscape) return { released: true, byEscape: true }
  await page.evaluate(() => document.exitPointerLock())
  const released = await waitFor('the pointer to be released', async () =>
    page.evaluate(() => document.pointerLockElement === null),
  )
  return { released, byEscape: false }
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

console.log(`e2e: building the client against ws://127.0.0.1:${SERVER_PORT}`)
await run('pnpm', ['--filter', '@gladiator/client', 'run', 'build'], {
  env: {
    ...process.env,
    VITE_SERVER_URL: `ws://127.0.0.1:${SERVER_PORT}`,
    VITE_BUILD: BUILD,
  },
})

if (!existsSync(SERVER_BUNDLE)) {
  console.log('e2e: building the server bundle')
  await run('pnpm', ['--filter', '@gladiator/server', 'run', 'build'])
}

console.log('e2e: starting the server bundle and a static host')
const server = spawn(process.execPath, [SERVER_BUNDLE], {
  cwd: ROOT,
  stdio: ['ignore', 'inherit', 'inherit'],
  env: {
    ...process.env,
    PORT: String(SERVER_PORT),
    GLADIATOR_BUILD: BUILD,
    ALLOWED_ORIGINS: STATIC_ORIGIN,
    NODE_ENV: 'production',
  },
})

const staticServer = await serveDist()
let browser = null

try {
  const healthy = await waitFor('the server to answer /healthz', async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/healthz`)
      return response.ok
    } catch {
      return false
    }
  })
  check('the server bundle boots and answers /healthz', healthy)

  const page = await fetch(`${STATIC_ORIGIN}/`)
  check('GET / returns 200 with the built bundle', page.status === 200)
  const html = await page.text()
  check('the served page references the built module', /<script type="module"/.test(html))

  try {
    browser = await chromium.launch({
      // SwiftShader, so WebGL2 exists in a headless container. A real browser
      // on a real GPU is the deployed case; this is the automatable
      // approximation.
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    })
  } catch (cause) {
    console.error(
      'e2e: could not start Chromium. If that is a missing shared library, run\n' +
        '  pnpm exec playwright install --with-deps chromium\n',
    )
    throw cause
  }
  const context = await browser.newContext({ viewport: VIEWPORT })
  const tab = await context.newPage()

  const consoleErrors = []
  tab.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  tab.on('pageerror', (error) => consoleErrors.push(`uncaught: ${error.message}`))

  // `?host=1`: a room opened and no menu in front of it, which is the state
  // everything below measures. The menu itself — and the room-code flow that is
  // the reason it exists — is its own section further down. `ui/roomFlow.ts`.
  await tab.goto(`${STATIC_ORIGIN}/?host=1`, { waitUntil: 'load' })

  const booted = await waitFor('the client to start simulating', async () =>
    tab.evaluate(() => (window.__gladiator?.snapshot().tick ?? 0) > 0),
  )
  check('the page boots and the simulation starts ticking', booted)

  const connected = await waitFor('the client to connect', async () =>
    tab.evaluate(() => window.__gladiator?.snapshot().net.status === 'live'),
  )
  check('the client connects over WebSocket and is welcomed', connected)

  // --- the renderer came up ------------------------------------------------
  // A graphics context, every shader compiled, and frames actually reaching
  // the screen. `scene.isReady(true)` is the real gate: it is what forces the
  // shaders to compile now rather than the first time something is drawn.
  const backend = await tab.evaluate(() => window.__gladiator?.snapshot().render.backend)
  check(
    'a WebGPU or WebGL2 context is acquired',
    backend === 'webgpu' || backend === 'webgl2',
    `backend ${String(backend)}`,
  )

  const sceneReady = await waitFor('scene.isReady(true)', async () =>
    tab.evaluate(() => window.__gladiator?.snapshot().render.ready === true),
  )
  check('every shader compiles and every texture loads — scene.isReady(true)', sceneReady)

  const drawn = await waitFor('the renderer to draw 30 frames', async () =>
    tab.evaluate(() => (window.__gladiator?.snapshot().render.frames ?? 0) > 30),
  )
  const drawnSnapshot = await tab.evaluate(() => window.__gladiator?.snapshot().render)
  check(
    'more than 30 frames render',
    drawn,
    `${drawnSnapshot?.frames ?? 0} frames of ${drawnSnapshot?.triangles ?? 0} triangles`,
  )

  // --- pointer lock -------------------------------------------------------
  await tab.locator('#stage').click()
  const locked = await waitFor('pointer lock', async () =>
    tab.evaluate(() => document.pointerLockElement !== null),
  )
  check('clicking the canvas locks the pointer', locked)
  // Reported rather than gated: the lock is *requested* with
  // `unadjustedMovement: true` (`input/pointerLock.ts`), and whether a browser
  // grants raw deltas is the browser's business — headless Chromium has no
  // physical mouse to be unaccelerated.
  console.log(
    `  ...  raw mouse input: ${await tab.evaluate(() => window.__gladiator?.snapshot().raw)}`,
  )

  // --- running ------------------------------------------------------------
  const before = await tab.evaluate(() => window.__gladiator?.snapshot())
  await tab.keyboard.down('w')
  await tab.waitForTimeout(1000)
  await tab.keyboard.up('w')
  const afterRun = await tab.evaluate(() => window.__gladiator?.snapshot())
  // Horizontal distance, not distance along +x: a player now spawns facing the
  // way the map's spawn point says (`match/spawn.ts`), so "forward" is whatever
  // yaw that was and projecting it on to one axis would be measuring the map.
  const ran = Math.hypot(
    afterRun.origin[0] - before.origin[0],
    afterRun.origin[1] - before.origin[1],
  )
  // A second at 320 qu/s, minus whatever the first frames cost.
  check('holding W runs the box across the plane', ran > 150, `moved ${ran.toFixed(1)} qu in a second`)

  // --- jumping ------------------------------------------------------------
  let peak = 0
  await tab.keyboard.down(' ')
  for (let i = 0; i < 20; i += 1) {
    await tab.waitForTimeout(25)
    const sample = await tab.evaluate(() => window.__gladiator?.snapshot())
    peak = Math.max(peak, sample.origin[2])
  }
  await tab.keyboard.up(' ')
  check('space jumps', peak > 20, `peak height ${peak.toFixed(1)} qu`)

  // --- the tick rate ------------------------------------------------------
  const rateStart = await tab.evaluate(() => window.__gladiator?.snapshot().tick)
  await tab.waitForTimeout(2000)
  const rateEnd = await tab.evaluate(() => window.__gladiator?.snapshot().tick)
  const rate = (rateEnd - rateStart) / 2
  check(
    'the accumulator runs the simulation at 125 Hz',
    rate > 118 && rate < 132,
    `measured ${rate.toFixed(1)} ticks/s`,
  )

  // --- frame pacing --------------------------------------------------------
  // Measured on a live page: connected, simulating at 125 Hz and sending
  // commands, which is the workload that matters. Judged by percentile and
  // hitch rate rather than by the average — a frame graph that averages 144 fps
  // and drops a 30 ms frame twice a second averages beautifully and stutters
  // visibly. `packages/client/src/render/frameStats.ts`.
  const baselineMs = await measureBaseline(context, BASELINE_SECONDS)
  const budgetMs = Math.max(frameBudgetMs, baselineMs * BASELINE_FACTOR)
  await tab.bringToFront()

  console.log(
    `  ...  measuring frame pacing for ${frameSeconds}s at ${PACING_VIEWPORT.width}x${PACING_VIEWPORT.height} — an empty loop on this machine managed p99 ${baselineMs.toFixed(1)} ms, so the budget is ${budgetMs.toFixed(1)} ms`,
  )
  await tab.setViewportSize(PACING_VIEWPORT)
  // The client resizes the engine from the window's own resize event, which is
  // the path a player takes; going through it means this measures what they
  // would get rather than a state only a test can reach.
  await tab.evaluate(() => window.dispatchEvent(new Event('resize')))
  await tab.waitForTimeout(500)

  // Up to two windows, and the second only if the first missed. Frame pacing is
  // the one measurement here that a *neighbour* can fail: another job landing
  // on the runner mid-window deschedules the browser for a few hundred
  // milliseconds and the percentile remembers it. A renderer that genuinely got
  // more expensive misses both windows; a storm rarely lands on both.
  let pacing = null
  let paceStats = null
  for (let attempt = 1; attempt <= PACING_ATTEMPTS; attempt += 1) {
    await tab.evaluate(() => window.__gladiator?.resetFrameStats())
    await tab.waitForTimeout(frameSeconds * 1000)
    pacing = await tab.evaluate((budget) => window.__gladiator?.frameVerdict(budget), budgetMs)
    paceStats = await tab.evaluate(() => window.__gladiator?.snapshot().render)
    // Printed whether or not it passes: a frame-pacing gate whose numbers only
    // appear on failure cannot be watched drifting towards one.
    console.log(
      `  ...  attempt ${attempt}: p99 ${paceStats?.p99Ms.toFixed(1)} ms, median ${paceStats?.medianMs.toFixed(1)} ms, mean ${paceStats?.meanMs.toFixed(1)} ms, worst ${paceStats?.worstMs.toFixed(1)} ms, ${pacing?.hitches} hitches, ${paceStats?.pixelRatio}x`,
    )
    if (pacing?.ok === true) break
  }

  check(
    `frame pacing holds over ${frameSeconds}s`,
    pacing?.ok === true,
    `${pacing?.reason ?? '(no verdict)'} — mean ${paceStats?.meanMs.toFixed(1)} ms, worst ${paceStats?.worstMs.toFixed(1)} ms, ${paceStats?.pixelRatio}x`,
  )
  await tab.setViewportSize(VIEWPORT)
  await tab.evaluate(() => window.dispatchEvent(new Event('resize')))

  // The lock again, because the pacing measurement above took it away: the
  // baseline runs in a second tab, and a browser drops pointer lock the moment
  // the page stops being the front one. Nothing below is worth measuring
  // without it — a client with a loose pointer sends a player who is standing
  // still (`input/controller.ts`: no lock, no movement), and "the hashes agree
  // over a minute of movement" would then be a minute of nothing.
  await tab.locator('#stage').click()
  const lockedForHashes = await waitFor(
    'the pointer lock to come back for the hash run',
    async () => tab.evaluate(() => document.pointerLockElement !== null),
  )
  check('the pointer is locked for the hash comparison', lockedForHashes)

  // --- hash agreement, for real, for a minute ------------------------------
  console.log(`  ...  moving for ${seconds}s and comparing hashes`)
  const deadline = Date.now() + seconds * 1000
  const keys = ['w', 'a', 's', 'd']
  let keyIndex = 0
  while (Date.now() < deadline) {
    const key = keys[keyIndex % keys.length]
    keyIndex += 1
    await tab.keyboard.down(key)
    await tab.mouse.move(200 + keyIndex * 7, 200)
    await tab.waitForTimeout(400)
    await tab.keyboard.up(key)
    if (keyIndex % 5 === 0) {
      await tab.keyboard.press(' ')
    }
  }

  const final = await tab.evaluate(() => window.__gladiator?.snapshot())
  // Not "mismatched === 0", and the reason is the jitter buffer in front of the
  // host's tick scheduler. A hash frame says what the *host* simulated; the
  // client's ring says what it predicted, and those differ on any sub-step the
  // host had no command for and ran the fallback on, or had two and merged
  // (`@gladiator/server/inputQueue.ts`). That is the buffer doing its job, it
  // is corrected within a frame, and over a real localhost socket it happens a
  // handful of times a minute. A real desync is every hash after the first bad
  // one, which is nowhere near this bound — the same 2% the HUD's own indicator
  // judges on (`client/src/hud.ts`, MISPREDICTION_TOLERANCE).
  const mispredictionRate = final.net.compared === 0 ? 1 : final.net.mismatched / final.net.compared
  check(
    `the client and server hashes agree after ${seconds}s of movement`,
    final.net.compared > 50 && mispredictionRate <= 0.02,
    `compared ${final.net.compared}, mismatched ${final.net.mismatched} ` +
      `(${(mispredictionRate * 100).toFixed(2)}%), last agree ${String(final.net.agree)}`,
  )
  check(
    'the authoritative world reached this client, whole',
    final.net.snapshots > 50,
    `${final.net.snapshots} snapshots`,
  )
  // By the attribute, not the text: "MISMATCH" contains "MATCH".
  check(
    'the HUD reports agreement',
    (await tab.locator('[data-hud="agreement"]').getAttribute('data-state')) === 'match',
    await tab.locator('[data-hud="agreement"]').textContent(),
  )
  check(
    'no command was simulated and then dropped',
    final.net.dropped === 0,
    `dropped ${final.net.dropped}`,
  )

  // --- the in-match HUD says what the world says ---------------------------
  // GLAD-BHNPOE's first acceptance check, on a live page. `snapshot().hud` is
  // projected fresh at the moment of the call rather than being the copy the
  // HUD last drew from, so this compares the pixels against the world *now*.
  const hudAgrees = await tab.evaluate(() => {
    const read = (key) => document.querySelector(`[data-hud="${key}"]`)?.textContent ?? null
    const model = window.__gladiator.snapshot().hud
    const them = model.slot === 1 ? 0 : 1
    return [
      ['health', read('health'), String(Math.max(0, Math.round(model.self.health)))],
      ['armour', read('armor'), String(Math.max(0, Math.round(model.self.armor)))],
      ['weapon', read('weapon'), model.self.weaponName],
      ['your score', read('score-you'), String(model.match.wins[model.slot])],
      ['their score', read('score-them'), String(model.match.wins[them])],
    ]
  })
  for (const [what, onScreen, inTheWorld] of hudAgrees) {
    check(
      `the HUD's ${what} is what the world says it is`,
      onScreen === inTheWorld,
      `screen ${JSON.stringify(onScreen)}, world ${JSON.stringify(inTheWorld)}`,
    )
  }

  // Redrawn every frame rather than on a timer, which is the difference
  // between "within one frame" and "within a tenth of a second". The
  // diagnostics panel beside it deliberately runs at 10 Hz; if this HUD ever
  // inherits that throttle, the two counts stop tracking and this fails.
  const paceBefore = await tab.evaluate(() => window.__gladiator?.snapshot())
  // Waited for rather than timed: what is being measured is the *ratio*, and a
  // software rasteriser on a busy runner can want twenty seconds to draw thirty
  // frames. A fixed window would fail this for the machine's frame rate, which
  // is the one thing it is not about.
  const sampled = await waitFor(
    'thirty more rendered frames',
    async () =>
      tab.evaluate(
        (base) => (window.__gladiator?.snapshot().render.frames ?? 0) - base >= 30,
        paceBefore.render.frames,
      ),
    60_000,
  )
  const paceAfter = await tab.evaluate(() => window.__gladiator?.snapshot())
  const hudDrawn = paceAfter.hudFrames - paceBefore.hudFrames
  const rendered = paceAfter.render.frames - paceBefore.render.frames
  check(
    'the HUD is redrawn once per rendered frame, not on a timer',
    sampled && hudDrawn >= rendered - 2,
    `${hudDrawn} HUD updates against ${rendered} rendered frames`,
  )
  // Displacement from where this session actually began, not from the world
  // origin: the player spawns where the map says, so distance from (0, 0) would
  // be true before a key was pressed.
  const travelled = Math.hypot(final.origin[0] - before.origin[0], final.origin[1] - before.origin[1])
  check(
    'the player ended up somewhere other than where they started',
    travelled > 50,
    `moved ${travelled.toFixed(1)} qu from ${before.origin.map((v) => v.toFixed(1)).join(', ')}`,
  )
  check(
    'the page logged no console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 5).join(' | '),
  )

  // --- the version mismatch path ------------------------------------------
  await tab.goto(`${STATIC_ORIGIN}/?host=1&protocol=999`, { waitUntil: 'load' })
  const banner = tab.locator('[data-hud="banner"]')
  const shown = await waitFor('the version-mismatch banner', async () => {
    const text = await banner.textContent()
    return text !== null && text.includes('server is on build')
  })
  const bannerText = await banner.textContent()
  check('a protocol mismatch puts a readable message on screen', shown, bannerText ?? '(empty)')
  check(
    'the message names the build and says to reload',
    (bannerText ?? '').includes(`build ${BUILD}`) && (bannerText ?? '').includes('reload'),
    bannerText ?? '(empty)',
  )

  // --- the map mismatch path ----------------------------------------------
  // The deploy race: Vercel ships the client and Fly ships the server, and for
  // a minute or two after either one, a page can be holding a different arena
  // than the server is authoritative over. `?map=` forces that state.
  await tab.goto(`${STATIC_ORIGIN}/?host=1&map=deadbeef`, { waitUntil: 'load' })
  const mapShown = await waitFor('the map-mismatch banner', async () => {
    const text = await banner.textContent()
    return text !== null && text.includes('deadbeef')
  })
  const mapBanner = await banner.textContent()
  check('a map mismatch puts a readable message on screen', mapShown, mapBanner ?? '(empty)')
  check(
    'the message names both arenas and says to reload',
    (mapBanner ?? '').includes('deadbeef') && (mapBanner ?? '').includes('reload'),
    mapBanner ?? '(empty)',
  )

  const refused = await tab.evaluate(() => window.__gladiator?.snapshot())
  check(
    'a refused client does not simulate a world nobody is authoritative over',
    refused !== undefined && refused.net.status === 'map-mismatch' && refused.tick === 0,
    `status ${refused?.net.status ?? '(none)'}, tick ${refused?.tick ?? '(none)'}`,
  )

  // --- the credits screen --------------------------------------------------
  // The licensing half of GLAD-PGS73O, checked where it is actually visible.
  // `credits.json` is generated by `pnpm assets:build` and fetched by the page,
  // so this is the one place the generated file, the deployed bundle and the
  // screen meet — and a deploy that shipped one without the other shows up here
  // as an empty panel rather than in a takedown request.
  await tab.goto(`${STATIC_ORIGIN}/?credits=1`, { waitUntil: 'load' })
  const creditsShown = await waitFor(
    'the credits screen to render its entries',
    async () => (await tab.locator('#credits [data-credit-id]').count()) > 0,
  )
  check('the credits screen renders what the build generated', creditsShown)

  const creditsMatch = await tab.evaluate(async () => {
    const response = await fetch('/credits.json', { cache: 'no-store' })
    const generated = await response.json()
    const rows = [...document.querySelectorAll('#credits [data-credit-id]')]
    const links = [...document.querySelectorAll('#credits a.credits-name')]
    return {
      status: response.status,
      expected: generated.entries?.length ?? 0,
      rendered: rows.length,
      linked: links.filter((link) => link.href.startsWith('https://')).length,
      licensed: rows.filter((row) => row.querySelector('.credits-licence')?.textContent).length,
    }
  })
  check(
    'every entry in credits.json is on screen, with a source link and a licence',
    creditsMatch.status === 200 &&
      creditsMatch.expected > 0 &&
      creditsMatch.rendered === creditsMatch.expected &&
      creditsMatch.linked === creditsMatch.expected &&
      creditsMatch.licensed === creditsMatch.expected,
    `${creditsMatch.rendered}/${creditsMatch.expected} rendered, ${creditsMatch.linked} linked, ${creditsMatch.licensed} licensed`,
  )

  // --- the menu, and the room-code flow ------------------------------------
  // GLAD-NPCTU8, and the acceptance list this ticket is judged on. Everything
  // here is the *deployed* flow rather than a unit of it: a stranger opens the
  // page, creates a match, copies the link, and somebody else opens that link
  // and is in the same room with nothing to type.
  //
  // The static host is `http://127.0.0.1`, which every browser treats as a
  // secure context exactly as it treats the deployed HTTPS origin — so the
  // asynchronous clipboard is the same code path here as on Vercel.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: STATIC_ORIGIN,
  })
  await tab.goto(`${STATIC_ORIGIN}/`, { waitUntil: 'load' })

  const menuUp = await waitFor('the main menu', async () =>
    tab.evaluate(() => window.__gladiator?.snapshot().menu === 'main'),
  )
  check('a page with nothing in the URL opens on the menu', menuUp)
  const idle = await tab.evaluate(() => window.__gladiator?.snapshot())
  check(
    'the menu opens no socket and simulates nothing until a match is picked',
    idle?.net.status === 'idle' && idle.tick === 0,
    `status ${idle?.net.status ?? '(none)'}, tick ${idle?.tick ?? '(none)'}`,
  )

  await tab.locator('[data-hud="menu-create"]').click()
  // Waited for on the *screen* rather than in the snapshot: the host answers
  // with the code the moment the socket opens, and what this section is about
  // is the player having something to send. The menu is written from the
  // session ten times a second, with everything else that changes slowly.
  const minted = await waitFor('the room code to reach the screen', async () =>
    tab.evaluate(
      () => (document.querySelector('[data-hud="menu-room-link"]')?.value ?? '') !== '',
    ),
  )
  const room = await tab.evaluate(() => window.__gladiator?.snapshot().net.room)
  check('creating a match gets a room code from the host', minted, `room ${String(room)}`)

  const onScreen = await tab.locator('[data-hud="menu-room-code"]').textContent()
  const link = await tab.locator('[data-hud="menu-room-link"]').inputValue()
  check(
    'the code is on screen, grouped so it can be read out',
    onScreen === `${String(room).slice(0, 3)}-${String(room).slice(3)}`,
    `screen ${JSON.stringify(onScreen)}, room ${String(room)}`,
  )
  check(
    'the link is this page with the room on it, and nothing else',
    link === `${STATIC_ORIGIN}/?room=${String(room)}`,
    link,
  )
  check(
    'the room is in the address bar, so a reload rejoins rather than opening another',
    (await tab.evaluate(() => window.location.search)).includes(`room=${String(room)}`),
    await tab.evaluate(() => window.location.search),
  )

  await tab.locator('[data-hud="menu-copy"]').click()
  const copied = await waitFor('the copy to land', async () =>
    tab.evaluate(
      () => document.querySelector('[data-hud="menu-copy"]')?.dataset.state === 'copied',
    ),
  )
  const clipboard = await tab.evaluate(() => navigator.clipboard.readText())
  check(
    'the copy affordance puts the link on the clipboard on a secure origin',
    copied && clipboard === link,
    `clipboard ${JSON.stringify(clipboard)}`,
  )

  // The second player. A separate tab, opening nothing but the link.
  const friend = await context.newPage()
  const friendErrors = []
  friend.on('console', (message) => {
    if (message.type() === 'error') friendErrors.push(message.text())
  })
  friend.on('pageerror', (error) => friendErrors.push(`uncaught: ${error.message}`))
  await friend.goto(link, { waitUntil: 'load' })

  const joining = await waitFor('the second player to reach the room screen', async () =>
    friend.evaluate(() => window.__gladiator?.snapshot().menu === 'room'),
  )
  const prefilled = await friend.locator('[data-hud="menu-code-input"]').inputValue()
  check(
    'opening a room link goes straight into the join, with the code prefilled',
    joining && prefilled.replace('-', '') === String(room),
    `menu ${await friend.evaluate(() => window.__gladiator?.snapshot().menu)}, box ${JSON.stringify(prefilled)}`,
  )
  const friendLive = await waitFor('the second player to be welcomed', async () =>
    friend.evaluate(() => window.__gladiator?.snapshot().net.status === 'live'),
  )
  check(
    'the link connects on its own — nothing is typed and nothing is pressed first',
    friendLive && (await friend.evaluate(() => window.__gladiator?.snapshot().net.room)) === room,
  )

  // One click: the browser will not lock a pointer or start an audio context
  // without a gesture, and this is the same one. `audio/gesture.ts`.
  await friend.locator('[data-hud="menu-enter"]').click()
  const friendPlaying = await waitFor('the second player to be in the arena', async () =>
    friend.evaluate(
      () => document.pointerLockElement !== null && window.__gladiator?.snapshot().menu === 'hidden',
    ),
  )
  check('one click from the link puts the second player in the arena', friendPlaying)
  check('the second player’s page logged no console errors', friendErrors.length === 0,
    friendErrors.slice(0, 5).join(' | '))

  // --- escape, and taking the mouse back -----------------------------------
  // The lock is the browser's to give, and every browser refuses to hand it
  // straight back after the player released it with escape — a *fresh* click is
  // the only thing that works. What must survive that is everything else: the
  // match keeps running, the settings are untouched, and resuming is one click.
  const paused = await friend.evaluate(() => window.__gladiator?.snapshot())
  const { released, byEscape } = await releaseLock(friend)
  const pausedUp =
    released &&
    (await waitFor('the pause screen', async () =>
      friend.evaluate(() => window.__gladiator?.snapshot().menu === 'paused'),
    ))
  check(
    'losing the pointer lock puts the pause screen up over a running match',
    pausedUp,
    byEscape
      ? 'released with escape'
      : 'released with exitPointerLock — this browser does not deliver a synthesised escape to its own chrome',
  )

  const ticking = await waitFor('the match to carry on ticking while paused', async () =>
    friend.evaluate((tick) => (window.__gladiator?.snapshot().tick ?? 0) > tick + 20, paused.tick),
  )
  check('the match keeps running behind the pause screen', ticking)

  // Clicked, not retried on a timer: after the default unlock gesture a browser
  // refuses even with a transient activation available, so the honest response
  // is to ask for another click and take the lock on that one.
  let relocked = false
  for (let attempt = 0; attempt < 5 && !relocked; attempt += 1) {
    await friend.locator('[data-hud="menu-resume"]').click()
    relocked = await waitFor(
      'the pointer lock to come back',
      async () => friend.evaluate(() => document.pointerLockElement !== null),
      2000,
    )
  }
  const after = await friend.evaluate(() => window.__gladiator?.snapshot())
  check('the pointer lock is reacquired after escape', relocked)
  check(
    'nothing was lost across the escape: same match, same session, same settings',
    after.net.status === 'live' &&
      after.net.room === room &&
      after.tick > paused.tick &&
      JSON.stringify(after.settings) === JSON.stringify(paused.settings),
    `status ${after.net.status}, room ${String(after.net.room)}, settings ${JSON.stringify(after.settings)}`,
  )

  // --- the settings a competitive player expects ---------------------------
  await releaseLock(friend)
  await waitFor('the pause screen again', async () =>
    friend.evaluate(() => window.__gladiator?.snapshot().menu === 'paused'),
  )
  await friend.locator('[data-hud="menu-pause-settings"]').click()
  await friend.locator('[data-hud="menu-cm360"]').fill('40')
  await friend.locator('[data-hud="menu-cm360"]').press('Enter')
  const set = await waitFor('the sensitivity to be taken', async () =>
    friend.evaluate(() => window.__gladiator?.snapshot().settings.cm360 === 40),
  )
  const derived = await friend.locator('[data-hud="menu-derived"]').textContent()
  check(
    'sensitivity is set in cm/360, and the counts it comes to are shown beside it',
    // 40 cm at the default 800 CPI is 40/2.54 x 800 = 12598 counts per 360.
    set && (derived ?? '').includes('12598 counts per 360'),
    `${JSON.stringify(derived)}`,
  )
  const rawLine = await friend.locator('[data-hud="menu-raw"]').textContent()
  const warned = await friend.evaluate(() => {
    const node = document.querySelector('[data-hud="menu-raw-warning"]')
    const state = window.__gladiator?.snapshot().rawInput
    return { state, hidden: node?.hasAttribute('hidden') ?? true, text: node?.textContent ?? '' }
  })
  // The verdict itself is the browser's and the platform's — `docs/browser-support.md`
  // is the matrix, and `pnpm run raw-input` is what measures it. What is checked
  // here is that the page is *honest* about whichever answer it got.
  check(
    'the raw-input state is on the settings screen, with a warning when it is not raw',
    (rawLine ?? '').includes(warned.state === 'granted' ? 'raw' : warned.state) &&
      warned.hidden === (warned.state === 'granted') &&
      (warned.state === 'granted' || warned.text.length > 0),
    `${warned.state}: ${JSON.stringify(rawLine)}, warning hidden ${warned.hidden}`,
  )

  const persisted = await friend.evaluate(() => window.localStorage.getItem('gladiator.settings.v1'))
  check(
    'settings are kept in this browser and nowhere else',
    (persisted ?? '').includes('"cm360":40'),
    String(persisted),
  )

  // --- the phone that opens the room link ----------------------------------
  // Somebody will. The bounce page is what they get instead of a canvas that
  // never locks a pointer. `ui/unsupported.ts`.
  const phone = await context.browser().newContext({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 3,
  })
  const phoneTab = await phone.newPage()
  const phoneErrors = []
  phoneTab.on('pageerror', (error) => phoneErrors.push(`uncaught: ${error.message}`))
  await phoneTab.goto(link, { waitUntil: 'load' })
  const bounced = await waitFor('the bounce page', async () =>
    phoneTab.evaluate(() => document.querySelector('[data-hud="bounce"]') !== null),
  )
  const phoneState = await phoneTab.evaluate(() => ({
    canvas: document.querySelector('#stage') !== null,
    locked: document.pointerLockElement !== null,
    booted: window.__gladiator !== undefined,
    code: document.querySelector('[data-hud="bounce-code"]')?.textContent ?? '',
    link: document.querySelector('[data-hud="bounce-link"]')?.value ?? '',
  }))
  check(
    'a phone gets the bounce page rather than a broken pointer-lock attempt',
    bounced && !phoneState.canvas && !phoneState.locked && !phoneState.booted,
    `canvas ${phoneState.canvas}, locked ${phoneState.locked}, game ${phoneState.booted}`,
  )
  check(
    'the bounce page hands the match back, so the link can be opened elsewhere',
    phoneState.code.replace('-', '') === String(room) && phoneState.link === link,
    `code ${JSON.stringify(phoneState.code)}, link ${JSON.stringify(phoneState.link)}`,
  )
  check('the bounce page logged no errors', phoneErrors.length === 0, phoneErrors.join(' | '))
  await phone.close()

  // --- the code in the address bar survives a reload -----------------------
  await friend.reload({ waitUntil: 'load' })
  const rejoined = await waitFor('the reloaded page to rejoin the same room', async () =>
    friend.evaluate(() => window.__gladiator?.snapshot().net.status === 'live'),
  )
  const rejoinedState = await friend.evaluate(() => window.__gladiator?.snapshot())
  check(
    'a reload rejoins the same match, with the settings intact',
    rejoined && rejoinedState.net.room === room && rejoinedState.settings.cm360 === 40,
    `room ${String(rejoinedState?.net.room)}, cm360 ${String(rejoinedState?.settings.cm360)}`,
  )
  await friend.close()

  // --- the HUD at three aspect ratios --------------------------------------
  // GLAD-BHNPOE. A fresh load into a match, so the pointer is unlocked and the
  // "click to play" prompt is on screen with everything else.
  await tab.goto(`${STATIC_ORIGIN}/?host=1`, { waitUntil: 'load' })
  await waitFor('the HUD to be drawn', async () =>
    tab.evaluate(() => (window.__gladiator?.snapshot().hudFrames ?? 0) > 0),
  )

  for (const shape of HUD_VIEWPORTS) {
    await tab.setViewportSize({ width: shape.width, height: shape.height })
    await tab.evaluate(() => window.dispatchEvent(new Event('resize')))
    // A frame at the new size, so the measurement is of the laid-out page.
    await tab.waitForTimeout(250)

    const layout = await tab.evaluate(measureHudBoxes, {
      width: shape.width,
      height: shape.height,
    })
    check(
      `every HUD element is on screen at ${shape.name} (${shape.width}x${shape.height})`,
      layout.measured >= 6 && layout.clipped.length === 0,
      layout.clipped.length > 0
        ? `off the edge: ${layout.clipped.join(', ')}`
        : `only measured ${layout.measured} boxes: ${layout.names.join(', ')}`,
    )
    check(
      `no two HUD elements overlap at ${shape.name}`,
      layout.overlaps.length === 0,
      layout.overlaps.join(', '),
    )
  }
  await tab.setViewportSize(VIEWPORT)

  // --- hit feedback, on a page that can actually produce some --------------
  // `?hud=demo` drives the readout from a script instead of from the world, so
  // that the states nobody can reach until there is a match to play — a landed
  // hit, a damage arc, armour gone, a round won — are on screen to be looked
  // at. The reviewer's half of the acceptance check is done in a browser at
  // this URL; this is the half that says the chain from the fold to the pixels
  // is connected. `packages/client/src/ui/demo.ts`.
  await tab.goto(`${STATIC_ORIGIN}/?hud=demo`, { waitUntil: 'load' })
  const opacityOf = (selector) =>
    tab.evaluate((sel) => {
      const node = document.querySelector(sel)
      if (node === null || node.dataset.visible === 'no') return 0
      return Number.parseFloat(getComputedStyle(node).opacity)
    }, selector)

  check(
    'the crosshair changes shape with the weapon in hand',
    await waitFor('the railgun crosshair', async () =>
      tab.evaluate(
        () => document.querySelector('[data-hud="crosshair"]')?.dataset.crosshair === 'rail',
      ),
    ),
  )
  check(
    'a landed hit lights the hit marker',
    await waitFor('a hit confirmation', async () => (await opacityOf('[data-hud="hitmarker"]')) > 0.05),
  )
  check(
    'taking damage shows the direction it came from',
    await waitFor('a damage arc', async () => (await opacityOf('[data-hud="damage"]')) > 0.05),
  )
  check(
    'losing the armour and going critical changes the health readout',
    await waitFor('the critical state', async () =>
      tab.evaluate(() => document.querySelector('[data-hud="vitals"]')?.dataset.state === 'critical'),
    ),
  )
  check(
    'winning a round puts the result across the middle',
    await waitFor('the round banner', async () =>
      tab.evaluate(() => {
        const banner = document.querySelector('[data-hud="announce"]')
        return banner?.dataset.visible === 'yes' && (banner.textContent ?? '') !== ''
      }),
    ),
  )
  check(
    'the railgun’s longer wait is on screen as a number and a ring',
    await waitFor('a rail cooldown', async () =>
      tab.evaluate(() => {
        const text = document.querySelector('[data-hud="cooldown"]')?.textContent ?? ''
        const ring = document.querySelector('[data-hud="cooldown-ring"]')
        const offset = Number.parseFloat(ring?.getAttribute('stroke-dashoffset') ?? 'NaN')
        // A second or more still to wait, and more than half the ring closed
        // to say so. The ring is ~119 units round; see `ui/crosshair.ts`.
        return /^1\.[0-5]s$/.test(text) && Number.isFinite(offset) && offset < 60
      }),
    ),
  )

  // --- the reference screenshot -------------------------------------------
  // `?shot=1` is a page with nothing moving in it: no socket, no simulation,
  // no HUD, no adaptive quality, one device pixel per CSS pixel, WebGL pinned,
  // and the camera nailed to `REFERENCE_VIEW`. Everything a screenshot could
  // otherwise differ by is held still, so a difference is a rendering change.
  //
  // Re-shoot deliberately (`--update-reference`) when a renderer or Babylon
  // upgrade legitimately changes the picture, and put the new image in the
  // commit that changed it — that is the whole point of the gate.
  await tab.goto(`${STATIC_ORIGIN}/?shot=1`, { waitUntil: 'load' })
  const shotReady = await waitFor('the reference scene to be ready', async () =>
    tab.evaluate(() => window.__gladiator?.snapshot().render.ready === true),
  )
  check('the reference scene reaches scene.isReady(true)', shotReady)
  // A few frames after readiness, so the first-frame texture upload is done.
  await tab.waitForTimeout(500)

  if (updateReference) {
    const dataUrl = await tab.evaluate(
      ({ width, height }) => window.__gladiator?.captureDataUrl(width, height),
      { width: REFERENCE_WIDTH, height: REFERENCE_HEIGHT },
    )
    mkdirSync(REFERENCE_DIR, { recursive: true })
    writeFileSync(REFERENCE_FILE, Buffer.from(String(dataUrl).split(',')[1] ?? '', 'base64'))
    console.log(`  ...  wrote ${relative(ROOT, REFERENCE_FILE)} — commit it with this change`)
  }

  if (!existsSync(REFERENCE_FILE)) {
    check(
      'a reference screenshot is committed',
      false,
      `no ${relative(ROOT, REFERENCE_FILE)} — run: pnpm run e2e -- --update-reference`,
    )
  } else {
    const diff = await tab.evaluate(compareToReference, {
      url: `${REFERENCE_ROUTE}${REFERENCE_NAME}`,
      width: REFERENCE_WIDTH,
      height: REFERENCE_HEIGHT,
      channelTolerance: CHANNEL_TOLERANCE,
    })
    check(
      'the frame matches the committed reference screenshot',
      diff?.error === undefined &&
        diff.fraction <= PIXEL_TOLERANCE &&
        diff.mean <= MEAN_TOLERANCE,
      diff?.error ??
        `${((diff?.fraction ?? 1) * 100).toFixed(2)}% of pixels differ by more than ${CHANNEL_TOLERANCE}/255 (limit ${(PIXEL_TOLERANCE * 100).toFixed(1)}%), mean ${(diff?.mean ?? 0).toFixed(2)}/255 (limit ${MEAN_TOLERANCE}) — re-shoot with: pnpm run e2e -- --update-reference`,
    )
  }
} finally {
  await browser?.close()
  staticServer.close()
  server.kill('SIGTERM')
}

console.log(`\ne2e: ${checks - failures.length}/${checks} checks passed`)
if (failures.length > 0) {
  console.error(`e2e failed:\n  - ${failures.join('\n  - ')}`)
  process.exit(1)
}
