import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { readConfig } from './config.ts'
import { startServer } from './server.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('the combined Fly client and host', () => {
  it('serves the client from the same listener that accepts rooms', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gladiator-client-'))
    roots.push(root)
    writeFileSync(join(root, 'index.html'), '<!doctype html><title>Gladiator</title>')

    const server = await startServer({
      config: { ...readConfig({}), port: 0 },
      staticDir: root,
      log: () => undefined,
    })
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/`)
      expect(response.status).toBe(200)
      expect(response.headers.get('cache-control')).toBe('no-cache')
      expect(await response.text()).toContain('<title>Gladiator</title>')

      const missing = await fetch(`http://127.0.0.1:${server.port}/not-shipped.txt`)
      expect(missing.status).toBe(404)
    } finally {
      await server.close()
    }
  })
})
