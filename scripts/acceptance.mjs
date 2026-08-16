#!/usr/bin/env node
/**
 * The game's acceptance criteria, in a real browser, against the real bundles.
 *
 * `scripts/e2e.mjs` proves the *platform* — that the page loads, that the
 * pointer locks, that the client and the server agree on a hash. This proves
 * the **game**: that the thing the platform is carrying is a Rocket Arena duel
 * with two weapons in it, playable alone against a bot and playable against
 * another person over a socket.
 *
 *   1. the arena renders — a WebGL2 or WebGPU context, `arena1` loaded, frames
 *      drawn, and a screenshot written so a human can look at it
 *   2. exactly two weapons, and no third one reachable from an input
 *   3. neither weapon's ammo depletes over a sustained burst
 *   4. two independent browser contexts join one room by code and duel
 *   5. single-player seats a bot that moves, arms itself and hunts — the
 *      both-weapons half of that criterion is asserted deterministically over a
 *      full match in `packages/client/src/net/botPeer.test.ts`
 *
 * Two browser *contexts* rather than two tabs for check 4, because the room
 * code travels through `localStorage` and a shared context would let the second
 * page inherit the first one's session — which is the one way the check could
 * pass without the netcode working.
 *
 *     pnpm run acceptance
 *
 * It needs a browser download (`pnpm exec playwright install chromium`) and so
 * is its own job rather than part of `pnpm run ci`, exactly like `e2e`.
 */
import { spawn } from 'node:child_process'
import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const CLIENT_DIST = join(ROOT, 'packages', 'client', 'dist')
const SERVER_BUNDLE = join(ROOT, 'packages', 'server', 'dist', 'index.js')
const SHOT_DIR = join(ROOT, 'artifacts')
const SHOT_FILE = join(SHOT_DIR, 'acceptance-arena.png')

const SERVER_PORT = 8796
const STATIC_PORT = 8797
const STATIC_ORIGIN = `http://127.0.0.1:${STATIC_PORT}`
const BUILD = 'acceptance'
const VIEWPORT = { width: 1280, height: 800 }

/** The map the game is supposed to be played on. */
const ARENA = 'arena1'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
  '.ktx2': 'image/ktx2',
  '.glb': 'model/gltf-binary',
  '.bin': 'application/octet-stream',
}

let failures = 0
function check(what, ok, detail = '') {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${what}${detail === '' ? '' : `  — ${detail}`}`)
  if (!ok) failures += 1
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

async function waitFor(what, predicate, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await predicate()) return true
    } catch {
      /* a page mid-navigation; try again */
    }
    if (Date.now() > deadline) {
      console.log(`       timed out waiting for ${what}`)
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
}

const snap = (tab) => tab.evaluate(() => window.__gladiator?.snapshot() ?? null)

/** Hold a key for `ms`, so the page sees a real press and a real release. */
async function hold(tab, key, ms) {
  await tab.keyboard.down(key)
  await new Promise((resolve) => setTimeout(resolve, ms))
  await tab.keyboard.up(key)
}

/**
 * Get past the menu and take pointer lock.
 *
 * A page opened with `?room=CODE` lands on the room screen with the code
 * already in it and one button to press — which is the whole point of the room
 * link, and which means a harness that goes straight for the canvas clicks the
 * menu instead and never locks. `ui/menu.ts`.
 */
async function enterArena(tab) {
  const enter = tab.locator('[data-hud="menu-enter"]')
  if (await enter.isVisible().catch(() => false)) {
    await enter.click().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  if ((await snap(tab))?.locked === true) return true
  await tab.click('canvas', { position: { x: 300, y: 300 } }).catch(() => {})
  return waitFor('pointer lock', async () => (await snap(tab))?.locked === true, 8000)
}

/**
 * Hold the trigger for `ms` and report how hot the weapon was in each third of
 * the burst.
 *
 * The measurement is a **level**, not an edge, and that is the whole design.
 * Counting shots means catching the rising edge of the HUD's cooldown ring, and
 * a rising edge is exactly what a sampler misses when the machine running the
 * test is loaded — a browser at 15 fps steps straight over the trough between
 * two shots, the count comes out low, and the check reports a weapon that ran
 * out of ammo when nothing of the kind happened. That failure mode makes the
 * harness the thing under test.
 *
 * The ring is high for most of a refire interval and only reaches zero when the
 * weapon is *idle*. So "was the ring ever hot during this window" answers the
 * actual question — is it still firing — and answers it correctly from a single
 * lucky sample per window rather than needing every edge.
 */
async function burst(tab, ms) {
  await tab.evaluate((total) => {
    window.__hot = [0, 0, 0]
    window.__began = performance.now()
    const sample = () => {
      const elapsed = performance.now() - window.__began
      const third = Math.min(2, Math.floor((elapsed / total) * 3))
      const fraction = window.__gladiator?.snapshot().hud?.self?.cooldownFraction ?? 0
      window.__hot[third] = Math.max(window.__hot[third], fraction)
      window.__raf = requestAnimationFrame(sample)
    }
    sample()
  }, ms)
  await tab.mouse.down()
  await new Promise((resolve) => setTimeout(resolve, ms))
  const hot = await tab.evaluate(() => {
    cancelAnimationFrame(window.__raf)
    return window.__hot
  })
  await tab.mouse.up()
  return hot
}

console.log(`acceptance: building the client against ws://127.0.0.1:${SERVER_PORT}`)
await run('pnpm', ['--filter', '@gladiator/client', 'run', 'build'], {
  env: { ...process.env, VITE_SERVER_URL: `ws://127.0.0.1:${SERVER_PORT}`, VITE_BUILD: BUILD },
})
console.log('acceptance: building the server bundle')
await run('pnpm', ['--filter', '@gladiator/server', 'run', 'build'])

console.log('acceptance: starting the server bundle and a static host')
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
    const response = await fetch(`http://127.0.0.1:${SERVER_PORT}/healthz`)
    return response.ok
  })
  check('the game server boots', healthy)

  browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  })

  /* ---------------------------------------------------------------------- *
   * 1. The arena renders in a WebGL-capable browser
   * ---------------------------------------------------------------------- */
  console.log('\nacceptance: 1 — the arena renders')
  const soloContext = await browser.newContext({ viewport: VIEWPORT })
  const solo = await soloContext.newPage()
  const consoleErrors = []
  solo.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text())
  })
  solo.on('pageerror', (e) => consoleErrors.push(`uncaught: ${e.message}`))

  // `?local=1` is single-player: the host in this tab, and the bot in the other
  // seat. It is checks 1, 2, 3 and 5's page.
  await solo.goto(`${STATIC_ORIGIN}/?local=1`, { waitUntil: 'load' })

  const ticking = await waitFor('the simulation to start', async () => {
    const s = await snap(solo)
    return (s?.tick ?? 0) > 0
  })
  check('the page loads and the simulation starts', ticking)

  const first = await snap(solo)
  check(
    'a WebGPU or WebGL2 context is acquired',
    first?.render?.backend === 'webgpu' || first?.render?.backend === 'webgl2',
    String(first?.render?.backend),
  )
  check('the duel arena is the loaded map', first?.mapName === ARENA, String(first?.mapName))

  const drawing = await waitFor('frames to be drawn', async () => {
    const s = await snap(solo)
    return (s?.render?.frames ?? 0) > 30
  })
  check('frames are drawn', drawing)
  check('no console errors while loading the arena', consoleErrors.length === 0, consoleErrors[0])

  mkdirSync(SHOT_DIR, { recursive: true })
  writeFileSync(SHOT_FILE, await solo.screenshot())
  console.log(`       screenshot: ${SHOT_FILE}`)

  /* ---------------------------------------------------------------------- *
   * 5. Single-player: a bot in the other seat
   * ---------------------------------------------------------------------- */
  console.log('\nacceptance: 5 — a bot in the other seat')
  const botSeen = await waitFor('the bot to take the second seat', async () => {
    const s = await snap(solo)
    return s?.hud?.opponent?.present === true
  })
  check('single-player seats an opponent', botSeen)

  // Watch it for a while: where it went, and what it was holding. Long enough
  // to see a weapon switch, which the bot makes on range rather than on a timer
  // (`bot/combat/weaponSelect.ts`) — so the window has to be long enough for the
  // fight to travel. The deterministic version of this assertion, over a full
  // 48-second match, is `packages/client/src/net/botPeer.test.ts`.
  const botWeapons = new Set()
  const seenAt = []
  const until = Date.now() + 20_000
  while (Date.now() < until) {
    const s = await snap(solo)
    const other = s?.hud?.opponent
    if (other?.present) {
      botWeapons.add(other.weaponName)
      seenAt.push(other.velocity)
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  const botMoved = seenAt.some((v) => Math.hypot(v[0], v[1], v[2]) > 50)
  check('the bot moves under its own power', botMoved, `${seenAt.length} samples`)
  check(
    'the bot is armed and hunting',
    botWeapons.size > 0 && !botWeapons.has('—'),
    [...botWeapons].join(', '),
  )
  // Which weapons it *chooses* over a whole match is a range-dependent decision
  // (`bot/combat/weaponSelect.ts`) and so is a poor thing to sample from a
  // browser for a fixed number of seconds — a bot that wins at close quarters
  // never reaches for the rail. The deterministic version, over a full
  // 48-second match with both weapons asserted, is
  // `packages/client/src/net/botPeer.test.ts`.
  console.log(`       weapons seen this run: ${[...botWeapons].join(', ')}`)
  await soloContext.close()

  /* ---------------------------------------------------------------------- *
   * 4. Two clients, one room, over the socket
   * ---------------------------------------------------------------------- */
  console.log('\nacceptance: 4 — two clients duel over the socket')
  const hostContext = await browser.newContext({ viewport: VIEWPORT })
  const guestContext = await browser.newContext({ viewport: VIEWPORT })
  const host = await hostContext.newPage()
  const guest = await guestContext.newPage()

  await host.goto(`${STATIC_ORIGIN}/?host=1`, { waitUntil: 'load' })
  const hostLive = await waitFor('the host to be welcomed', async () => {
    const s = await snap(host)
    return s?.net?.status === 'live'
  })
  check('the first client connects over WebSocket', hostLive)

  /* ---------------------------------------------------------------------- *
   * 2 and 3. Two weapons, and neither runs out
   *
   * On this page rather than the single-player one, because here the second
   * seat is still empty: nobody is shooting back, so a burst that runs the full
   * ten seconds is a burst that was not cut short by dying.
   * ---------------------------------------------------------------------- */
  console.log('\nacceptance: 2, 3 — two weapons, unlimited ammo')
  check('the pointer locks so input reaches the game', await enterArena(host))

  // Every digit a player could press. Only 1 and 2 name a weapon
  // (`input/controller.ts`), so anything beyond those two turning up here is a
  // third weapon somebody can reach — which is exactly the check.
  const held = new Set()
  for (const key of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']) {
    await host.keyboard.press(key)
    await new Promise((resolve) => setTimeout(resolve, 120))
    const s = await snap(host)
    if (s?.hud?.self?.present) held.add(s.hud.self.weaponName)
  }
  check(
    'exactly two weapons are reachable from an input',
    held.size === 2 && held.has('rocket launcher') && held.has('railgun'),
    [...held].join(', '),
  )

  // Hold the trigger for twelve seconds on each weapon and compare the rate in
  // the last third against the rate in the first.
  //
  // A rate rather than a total, because the total is a measurement of the
  // *sampler* — a rising edge missed at 60 Hz is a shot uncounted — while the
  // ratio survives a sampler that misses edges evenly. And a rate is the honest
  // statement of the criterion anyway: "unlimited" means the weapon is firing
  // just as fast at the end of a burst as at the start, which is exactly what a
  // magazine, a reserve or a regenerating pool would each break in its own way.
  // The exhaustive version — ten simulated minutes of held trigger, cadence
  // asserted tick for tick — is `packages/sim/src/weapons.test.ts`.
  const BURST_MS = 12_000
  for (const [key, name] of [
    ['1', 'rocket launcher'],
    ['2', 'railgun'],
  ]) {
    await host.keyboard.press(key)
    await new Promise((resolve) => setTimeout(resolve, 200))
    const [opening, middle, closing] = await burst(host, BURST_MS)
    const after = await snap(host)
    check(
      `the ${name} is still firing at the end of a twelve-second burst`,
      after?.hud?.self?.weaponName === name && opening > 0.5 && middle > 0.5 && closing > 0.5,
      `cooldown ring peaked at ${[opening, middle, closing].map((v) => v.toFixed(2)).join(' / ')} across the three thirds`,
    )
  }
  console.log('\nacceptance: 4 — two clients duel over the socket (continued)')

  const room = (await snap(host))?.net?.room ?? null
  check('the host is given a room code to share', typeof room === 'string' && room.length === 6, String(room))

  await guest.goto(`${STATIC_ORIGIN}/?room=${room}`, { waitUntil: 'load' })
  const guestLive = await waitFor('the guest to be welcomed', async () => {
    const s = await snap(guest)
    return s?.net?.status === 'live'
  })
  check('the second client joins by room code', guestLive)
  check(
    'both clients are in the same room',
    (await snap(guest))?.net?.room === room,
    `${room} / ${(await snap(guest))?.net?.room}`,
  )

  const paired = await waitFor('both seats to fill', async () => {
    const a = await snap(host)
    const b = await snap(guest)
    return a?.hud?.opponent?.present === true && b?.hud?.opponent?.present === true
  })
  check('each client sees the other player', paired)
  check(
    'the two clients hold different slots',
    (await snap(host))?.hud?.slot !== (await snap(guest))?.hud?.slot,
  )

  // A match, not two people in a lobby: the host starts the round once both
  // seats are filled by peers that have greeted (`server/src/room.ts`).
  const started = await waitFor('the match to start', async () => {
    const a = await snap(host)
    return (a?.hud?.match?.round ?? 0) > 0
  })
  check('the match starts once both seats are filled', started, `round ${(await snap(host))?.hud?.match?.round}`)

  await enterArena(host)
  await enterArena(guest)

  // Each one moves, and the *other* one has to see it. This is the check that
  // makes it a duel rather than two single-player games: the only path from one
  // browser context to the other is input → socket → authoritative world →
  // snapshot → socket → interpolation.
  for (const [who, mover, watcher] of [
    ['host', host, guest],
    ['guest', guest, host],
  ]) {
    // Watch from inside the *other* page while this one runs, and keep the
    // fastest the opponent was ever seen going. A speed is what the watcher can
    // observe directly (`ui/hudModel.ts` projects the opponent's velocity), and
    // it cannot be produced locally: the watcher is not simulating that body.
    await watcher.evaluate(() => {
      window.__peak = 0
      const sample = () => {
        const v = window.__gladiator?.snapshot().hud?.opponent?.velocity ?? [0, 0, 0]
        window.__peak = Math.max(window.__peak, Math.hypot(v[0], v[1], v[2]))
        window.__peakRaf = requestAnimationFrame(sample)
      }
      sample()
    })
    await hold(mover, 'w', 4000)
    const peak = await watcher.evaluate(() => {
      cancelAnimationFrame(window.__peakRaf)
      return window.__peak
    })
    // Any clearly non-zero speed settles it: the watcher is not simulating that
    // body, so a standing opponent reads exactly 0 and anything above the noise
    // floor can only have come off the wire. The bar is not set at run speed
    // because interpolation and a loaded machine both shave the peak, and this
    // check is about whether motion crosses the socket rather than how fast.
    check(
      `the ${who} running is seen moving by the other client, in real time`,
      peak > 40,
      `${Math.round(peak)} qu/s observed across the socket`,
    )
  }

  // And both are still in it: a duel that dropped one peer is not a duel.
  for (const [who, tab] of [
    ['host', host],
    ['guest', guest],
  ]) {
    const s = await snap(tab)
    check(
      `the ${who} is still live with an opponent in the room`,
      s?.net?.status === 'live' && s?.hud?.opponent?.present === true,
      `${s?.net?.status}`,
    )
  }

  await hostContext.close()
  await guestContext.close()
} finally {
  await browser?.close().catch(() => {})
  staticServer.close()
  server.kill('SIGTERM')
}

console.log(
  `\nacceptance: ${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}`,
)
process.exit(failures === 0 ? 0 : 1)
