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
 *   5. clicks to take pointer lock, holds W and space, and checks the box moved
 *   6. runs for a minute and checks the client and server hashes agree
 *   7. reloads with `?protocol=999` and checks the version-mismatch message is
 *      on screen, rather than the socket closing silently
 *
 * It is not in `pnpm run ci` because it needs a browser download; CI runs it as
 * its own job. Locally:
 *
 *     pnpm run e2e                 # the full minute
 *     pnpm run e2e -- --seconds 10 # while iterating
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_DIST = join(ROOT, 'packages', 'client', 'dist')
const SERVER_BUNDLE = join(ROOT, 'packages', 'server', 'dist', 'index.js')

const SERVER_PORT = 8798
const STATIC_PORT = 8799
const STATIC_ORIGIN = `http://127.0.0.1:${STATIC_PORT}`
const BUILD = 'e2e'

const argv = process.argv.slice(2)
const seconds = (() => {
  const index = argv.indexOf('--seconds')
  if (index === -1) return 60
  const parsed = Number.parseInt(argv[index + 1] ?? '', 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 60
})()

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
}

/** A static file server for `packages/client/dist`, standing in for Vercel. */
function serveDist() {
  const server = createServer((request, response) => {
    const requested = new URL(request.url ?? '/', STATIC_ORIGIN).pathname
    const relative = normalize(requested === '/' ? '/index.html' : requested).replace(
      /^(\.\.[/\\])+/,
      '',
    )
    const file = join(CLIENT_DIST, relative)
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
  const context = await browser.newContext({ viewport: { width: 1024, height: 640 } })
  const tab = await context.newPage()

  const consoleErrors = []
  tab.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text())
  })
  tab.on('pageerror', (error) => consoleErrors.push(`uncaught: ${error.message}`))

  await tab.goto(`${STATIC_ORIGIN}/`, { waitUntil: 'load' })

  const booted = await waitFor('the client to start simulating', async () =>
    tab.evaluate(() => (window.__gladiator?.snapshot().tick ?? 0) > 0),
  )
  check('the page boots and the simulation starts ticking', booted)

  const connected = await waitFor('the client to connect', async () =>
    tab.evaluate(() => window.__gladiator?.snapshot().net.status === 'live'),
  )
  check('the client connects over WebSocket and is welcomed', connected)

  // --- pointer lock -------------------------------------------------------
  await tab.locator('#stage').click()
  const locked = await waitFor('pointer lock', async () =>
    tab.evaluate(() => document.pointerLockElement !== null),
  )
  check('clicking the canvas locks the pointer', locked)

  // --- running ------------------------------------------------------------
  const before = await tab.evaluate(() => window.__gladiator?.snapshot())
  await tab.keyboard.down('w')
  await tab.waitForTimeout(1000)
  await tab.keyboard.up('w')
  const afterRun = await tab.evaluate(() => window.__gladiator?.snapshot())
  const ran = Math.abs(afterRun.origin[0] - before.origin[0])
  // A second at 320 qu/s, minus whatever the first frames cost.
  check(
    'holding W runs the box across the plane',
    ran > 150,
    `moved ${ran.toFixed(1)} qu along +x in a second`,
  )

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
  check(
    `the client and server hashes agree after ${seconds}s of movement`,
    final.net.agree === true && final.net.mismatched === 0 && final.net.compared > 50,
    `compared ${final.net.compared}, mismatched ${final.net.mismatched}, last agree ${String(final.net.agree)}`,
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
  check(
    'the box ended up somewhere other than where it started',
    Math.abs(final.origin[0]) + Math.abs(final.origin[1]) > 50,
    `origin ${final.origin.map((v) => v.toFixed(1)).join(', ')}`,
  )
  check(
    'the page logged no console errors',
    consoleErrors.length === 0,
    consoleErrors.slice(0, 5).join(' | '),
  )

  // --- the version mismatch path ------------------------------------------
  await tab.goto(`${STATIC_ORIGIN}/?protocol=999`, { waitUntil: 'load' })
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
  await tab.goto(`${STATIC_ORIGIN}/?map=deadbeef`, { waitUntil: 'load' })
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
