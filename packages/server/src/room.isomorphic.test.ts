/**
 * The listen server's load-bearing constraint, as a test rather than a comment.
 *
 * `Room` and everything it pulls in has to run unchanged in a browser tab, or
 * single-player goes back to being a second code path and the whole ticket is
 * undone. That is easy to state and very easy to break: one `randomUUID` for a
 * peer id, one `setInterval` for a heartbeat, one `Buffer` for a frame, and the
 * module is Node-only — and nothing fails, because the *server's* build is
 * perfectly happy with all three.
 *
 * So the rule is checked mechanically. This walks the import graph from
 * `room.ts` through every relative import it reaches and fails on the names
 * that would pin it to a runtime. It is the same reasoning as
 * `scripts/guardrails.mjs`: a boundary nobody has watched reject something is a
 * boundary nobody knows is connected.
 *
 * The typechecker catches most of this a second time — `packages/client`
 * compiles what it imports under a tsconfig with no `@types/node` in it — but
 * only for modules the client actually imports today, and only once somebody
 * runs it.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The modules that make up the host, from its one entry point. */
const ENTRY = join(HERE, 'room.ts')

/**
 * What may not appear in a module a browser has to run.
 *
 * Each one is a real mistake somebody would make for a good local reason, which
 * is why the message says where the thing it wanted lives instead.
 */
const FORBIDDEN: ReadonlyArray<{ pattern: RegExp; why: string }> = [
  {
    pattern: /from\s+'node:/,
    why: 'a node: import — the host runs in a browser tab too. Take it as a constructor argument.',
  },
  {
    pattern: /\bfrom\s+'ws'/,
    why: "the ws package — the only module allowed to know what a WebSocket is is net/wsTransport.ts.",
  },
  {
    pattern: /\bprocess\s*\./,
    why: 'process — configuration is read once in config.ts and passed in as a value.',
  },
  {
    pattern: /\bBuffer\b/,
    why: 'Buffer — a frame is a Uint8Array or a string, which is what `TransportMessage` says.',
  },
  {
    pattern: /\bset(Interval|Timeout)\s*\(/,
    why: 'a timer — the beat is injected (loop.ts), so a test can drive a match in microseconds.',
  },
  {
    pattern: /\bDate\.now\s*\(/,
    why: 'Date.now — wall-clock arrives as an injected Clock (clock.ts).',
  },
  {
    pattern: /\bnew\s+WebSocketServer\b/,
    why: 'a server — a room is handed transports and never constructs one.',
  },
]

/** Every relative import in a module, as an absolute path. */
function localImports(source: string, from: string): string[] {
  const found: string[] = []
  const pattern = /from\s+'(\.[^']*)'/g
  let match = pattern.exec(source)
  while (match !== null) {
    const specifier = match[1]
    if (specifier !== undefined) found.push(join(dirname(from), specifier))
    match = pattern.exec(source)
  }
  return found
}

/** `room.ts` and everything it reaches by relative import, transitively. */
function hostModules(): Map<string, string> {
  const modules = new Map<string, string>()
  const queue = [ENTRY]
  while (queue.length > 0) {
    const path = queue.pop()
    if (path === undefined || modules.has(path)) continue
    const source = readFileSync(path, 'utf8')
    modules.set(path, source)
    queue.push(...localImports(source, path))
  }
  return modules
}

describe('the host is isomorphic', () => {
  const modules = hostModules()

  it('reaches the modules it is supposed to, and no more', () => {
    const names = [...modules.keys()].map((path) => relative(HERE, path)).sort()
    expect(names).toEqual(['clock.ts', 'room.ts', 'session.ts'])
  })

  it('names nothing that would pin it to one runtime', () => {
    const offences: string[] = []
    for (const [path, source] of modules) {
      // Comments are prose about the rule — `session.ts` explains why there is
      // no `Date.now()` in it — and prose is not what runs.
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
      for (const { pattern, why } of FORBIDDEN) {
        if (pattern.test(code)) offences.push(`${relative(HERE, path)} names ${why}`)
      }
    }
    expect(offences).toEqual([])
  })

  it('keeps the WebSocket adapter outside that boundary', () => {
    // The other half of the claim: the Node-only code exists, it is one file,
    // and it is not reachable from the room.
    const adapter = readFileSync(join(HERE, 'net', 'wsTransport.ts'), 'utf8')
    expect(adapter).toContain("from 'ws'")
    expect([...modules.keys()].some((path) => path.endsWith('wsTransport.ts'))).toBe(false)
  })
})
