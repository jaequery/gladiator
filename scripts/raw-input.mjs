#!/usr/bin/env node
/**
 * Does this browser, on this operating system, actually give a page raw mouse
 * deltas?
 *
 * Raw mouse input is called mandatory all over this repository and which
 * browsers actually give it was, until this script, nobody's measurement. It
 * opens each browser Playwright can start, takes a real pointer lock from a
 * real click, and records what came back. The table it prints is the one
 * committed in `docs/browser-support.md`.
 *
 *     pnpm run raw-input            # print the table
 *     pnpm run raw-input -- --write # write it into docs/browser-support.md
 *     pnpm run raw-input -- --check # fail if the committed table has drifted
 *
 * ## What is being asked, exactly
 *
 * Two questions, and they are not the same one:
 *
 *   1. **Does `requestPointerLock()` return a promise?** The events-only
 *      specification returns `undefined`, and a browser on that specification
 *      can neither confirm nor deny the option it was handed. There is no other
 *      feature detection — no `supports()`, nothing on the element — so this is
 *      the whole of what a page can know.
 *   2. **Does that promise resolve for `{ unadjustedMovement: true }`?**
 *      Resolving is the browser saying it applied raw input. Rejecting with
 *      `NotSupportedError` is it saying this *platform* cannot.
 *
 * The second is why the table has an operating system in it. Raw input is a
 * property of the pair: Gecko rejects on Linux and Android while accepting on
 * macOS and Windows (Bugzilla 1829401), and a run of this script can only ever
 * fill in the row for the machine it ran on. It says which machine that was.
 *
 * ## What it deliberately does not do
 *
 * Measure whether the deltas *are* unaccelerated. That would need a physical
 * mouse and an operating system whose acceleration curve is known, and neither
 * exists in a headless browser. What is measured is the browser's own answer,
 * which is also exactly what `input/pointerLock.ts` believes at run time — so a
 * disagreement between this table and the game is impossible by construction.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { firefox, chromium, webkit } from 'playwright'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DOC = join(ROOT, 'docs', 'browser-support.md')
const PORT = 8796
const ORIGIN = `http://127.0.0.1:${PORT}`

/** The markers in the document the generated table lives between. */
const START = '<!-- probe:start -->'
const END = '<!-- probe:end -->'

const argv = process.argv.slice(2)
const write = argv.includes('--write')
const checkOnly = argv.includes('--check')

/**
 * The page under test: a button, because pointer lock needs a real gesture, and
 * nothing else at all.
 *
 * Served over HTTP rather than set with `page.setContent`, because pointer lock
 * on `about:blank` is refused by some engines and the answer would then be
 * about the origin rather than about the engine.
 */
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>raw input probe</title></head>
<body style="margin:0">
<button id="go" style="width:100vw;height:100vh;font:16px monospace">click to lock</button>
<script>
window.__probe = { promise: null, resolved: null, error: null, locked: false, plain: null }
document.addEventListener('pointerlockchange', () => {
  window.__probe.locked = document.pointerLockElement !== null
})
document.addEventListener('pointerlockerror', () => {
  if (window.__probe.error === null) window.__probe.error = 'pointerlockerror'
})
document.getElementById('go').addEventListener('click', () => {
  let result
  try {
    result = document.getElementById('go').requestPointerLock({ unadjustedMovement: true })
  } catch (cause) {
    window.__probe.promise = false
    window.__probe.error = String(cause && cause.name ? cause.name : cause)
    return
  }
  window.__probe.promise = result instanceof Promise
  if (!(result instanceof Promise)) return
  result.then(
    () => { window.__probe.resolved = true },
    (cause) => {
      window.__probe.resolved = false
      window.__probe.error = String(cause && cause.name ? cause.name : cause)
      // The fallback the game takes: plain, so that a refused flag is still a
      // playable game rather than no game. See input/pointerLock.ts.
      const retry = document.getElementById('go').requestPointerLock()
      if (retry instanceof Promise) retry.then(() => { window.__probe.plain = true }, () => { window.__probe.plain = false })
    },
  )
})
</script>
</body></html>`

function serve() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
  })
  return new Promise((resolve) => server.listen(PORT, () => resolve(server)))
}

/** Give the page a moment to settle a promise. */
const settle = (page) => page.waitForTimeout(400)

const ENGINES = [
  {
    name: 'Chromium',
    type: chromium,
    // The same flags `scripts/e2e.mjs` uses: a headless container has no GPU,
    // and a browser that will not start measures nothing.
    options: { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  { name: 'Firefox', type: firefox, options: {} },
  { name: 'WebKit', type: webkit, options: {} },
]

async function probe(engine) {
  let browser
  try {
    browser = await engine.type.launch(engine.options)
  } catch (cause) {
    // Not a failure of the browser under test — a machine that cannot start it.
    // Recorded as such, so an incomplete run cannot be read as a verdict.
    return {
      engine: engine.name,
      version: '—',
      note: `could not be launched here: ${String(cause).split('\n')[0].slice(0, 80)}`,
    }
  }

  try {
    const page = await browser.newPage()
    await page.goto(ORIGIN, { waitUntil: 'load' })
    await page.locator('#go').click()
    await settle(page)
    const result = await page.evaluate(() => window.__probe)
    return {
      engine: engine.name,
      version: browser.version(),
      promise: result.promise,
      resolved: result.resolved,
      locked: result.locked,
      plain: result.plain,
      error: result.error,
    }
  } finally {
    await browser.close()
  }
}

/**
 * The verdict a page would reach, in the words a page uses.
 *
 * Deliberately `RawInput`'s three spellings from `input/pointerLock.ts` rather
 * than a vocabulary of this script's own: what this table records is exactly
 * what the settings screen will tell a player on the same machine, and two
 * words for one state is how a table stops being read as one.
 */
function verdict(result) {
  if (result.note !== undefined) return 'not measured'
  if (result.promise !== true) return 'unknown'
  return result.resolved === true ? 'granted' : 'refused'
}

function describe(result) {
  if (result.note !== undefined) return result.note
  if (result.promise !== true) {
    return 'returns no promise, so the browser never says whether the flag was applied'
  }
  if (result.resolved === true) return 'resolved — raw deltas'
  const fallback =
    result.plain === true ? 'the plain retry locked' : 'the plain retry did not report'
  return `rejected with ${String(result.error)}; ${fallback}`
}

function table(results, platform) {
  const rows = results.map(
    (result) =>
      `| ${result.engine} | ${result.version} | \`${verdict(result)}\` | ${describe(result)} |`,
  )
  return [
    `Measured on **${platform}** by \`pnpm run raw-input\`.`,
    '',
    '| Engine | Build | Verdict | What the browser did |',
    '| ------ | ----- | ------- | -------------------- |',
    ...rows,
  ].join('\n')
}

/** The verdicts a committed table records, as `engine -> verdict`. */
function committedVerdicts(markdown) {
  const verdicts = new Map()
  for (const line of markdown.split('\n')) {
    const row = /^\|\s*([A-Za-z]+)\s*\|[^|]*\|\s*`([^`]+)`\s*\|/.exec(line)
    if (row !== null) verdicts.set(row[1], row[2])
  }
  return verdicts
}

const server = await serve()
let block
const measured = []
try {
  for (const engine of ENGINES) measured.push(await probe(engine))
  block = table(measured, `${process.platform} ${process.arch}`)
  console.log(block)
} finally {
  server.close()
}

if (!write && !checkOnly) process.exit(0)

const document = readFileSync(DOC, 'utf8')
const start = document.indexOf(START)
const end = document.indexOf(END)
if (start === -1 || end === -1) {
  console.error(`raw-input: ${DOC} has no ${START} / ${END} markers to write between`)
  process.exit(1)
}

if (write) {
  writeFileSync(
    DOC,
    `${document.slice(0, start + START.length)}\n\n${block}\n\n${document.slice(end)}`,
  )
  console.log('\nraw-input: wrote the table into docs/browser-support.md')
  process.exit(0)
}

/**
 * `--check` compares **verdicts**, and only for engines both this machine and
 * the document have one for.
 *
 * Not the whole block, because two things in it move for reasons that are not
 * findings: the build string changes on a Playwright upgrade, and an engine this
 * machine cannot start has no verdict to compare. Failing on either would train
 * everybody to re-run `--write` without reading the diff, which is the same as
 * having no check.
 */
const recorded = committedVerdicts(document.slice(start, end))
const drifted = []
const missing = []
for (const result of measured) {
  const now = verdict(result)
  const before = recorded.get(result.engine)
  if (now === 'not measured') continue
  if (before === undefined || before === 'not measured') {
    missing.push(`${result.engine} is \`${now}\` here and unrecorded in the document`)
    continue
  }
  if (before !== now) drifted.push(`${result.engine}: document says \`${before}\`, measured \`${now}\``)
}

for (const line of missing) console.log(`\nraw-input: ${line} — run with --write to record it`)
if (drifted.length > 0) {
  console.error(`\nraw-input: the matrix has drifted:\n  - ${drifted.join('\n  - ')}`)
  console.error(
    'A browser upgrade is a `--write` and a commit. A platform difference is a row of its own:\n' +
      'raw input is a property of the browser *and* the operating system.',
  )
  process.exit(1)
}
console.log('\nraw-input: every verdict this machine can measure matches the committed matrix')
