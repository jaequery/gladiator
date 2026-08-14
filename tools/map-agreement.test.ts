/**
 * The client and the server agree about the arena.
 *
 * This test lives at the repo root rather than in either package, because it is
 * the one assertion that has to see *both* sides — and neither package is
 * allowed to import the other. `packages/client` may reach for `sim`, `bot` and
 * Babylon; `packages/server` for `sim`, `bot` and `ws`; neither for each other.
 * A test that broke that rule to make its point would be teaching the wrong
 * lesson, so it sits here, in the tooling that already owns both.
 *
 * What it proves is narrow and worth stating precisely: two modules, bundled by
 * two different bundlers (Vite and esbuild) and deployed to two different hosts
 * (Vercel and Fly), each *recompute* a hash from the same committed artifact and
 * arrive at the same eight digits. The refusal path — what happens when they do
 * not — is `packages/server/src/session.test.ts` and
 * `packages/client/src/net.test.ts`, and end to end over a real socket in
 * `packages/server/src/integration.test.ts`.
 *
 * `packages/client/src/map.ts` imports nothing a browser has, which is why it
 * can be loaded here at all. That is the same property the server relies on.
 */
import { describe, expect, it } from 'vitest'

import { mapHashOf, validateMap } from '@gladiator/sim'

import { CLIENT_MAP, CLIENT_MAP_HASH } from '../packages/client/src/map.ts'
import { SERVER_MAP, SERVER_MAP_HASH } from '../packages/server/src/map.ts'
import { bake } from './bake-map.ts'

describe('client and server map agreement', () => {
  it('compute the same hash from the same artifact', () => {
    expect(CLIENT_MAP_HASH).toBe(SERVER_MAP_HASH)
    expect(CLIENT_MAP_HASH).toMatch(/^[0-9a-f]{8}$/)
  })

  it('load the same map, not merely the same digits', () => {
    expect(CLIENT_MAP.source).toEqual(SERVER_MAP.source)
    expect(CLIENT_MAP.world.brushes.length).toBe(SERVER_MAP.world.brushes.length)
  })

  it('recompute the hash rather than trusting the one in the file', () => {
    expect(mapHashOf(CLIENT_MAP.source)).toBe(CLIENT_MAP_HASH)
    expect(mapHashOf(SERVER_MAP.source)).toBe(SERVER_MAP_HASH)
  })

  it('agree with what the baker would write today', () => {
    const outcome = bake(SERVER_MAP.source)
    if (!outcome.ok) throw new Error('the loaded map no longer bakes')
    expect(outcome.baked.hash).toBe(SERVER_MAP_HASH)
    expect(validateMap(CLIENT_MAP.source)).toEqual([])
  })
})
