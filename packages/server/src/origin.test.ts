import { describe, expect, it } from 'vitest'

import { readConfig, type ServerConfig } from './config.ts'
import { createOriginPolicy, vercelOriginPattern } from './origin.ts'

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...readConfig({}), ...overrides }
}

describe('vercelOriginPattern', () => {
  it('matches the project and its previews, and nothing else on vercel.app', () => {
    const pattern = vercelOriginPattern('gladiator')
    expect(pattern.test('https://gladiator.vercel.app')).toBe(true)
    expect(pattern.test('https://gladiator-git-main-jae.vercel.app')).toBe(true)
    expect(pattern.test('https://gladiator-9f3c1d2-jae.vercel.app')).toBe(true)

    // The whole reason the pattern is project-scoped: a bare
    // `*.vercel.app` allowlist would admit every Vercel user on earth.
    expect(pattern.test('https://someone-elses-app.vercel.app')).toBe(false)
    expect(pattern.test('https://evil.com')).toBe(false)
    // Not a suffix match, either.
    expect(pattern.test('https://gladiator.vercel.app.evil.com')).toBe(false)
    expect(pattern.test('http://gladiator.vercel.app')).toBe(false)
  })

  it('escapes a project name that contains regex metacharacters', () => {
    const pattern = vercelOriginPattern('a.b')
    expect(pattern.test('https://a.b.vercel.app')).toBe(true)
    expect(pattern.test('https://axb.vercel.app')).toBe(false)
  })
})

describe('origin policy', () => {
  it('refuses an upgrade with no Origin header', () => {
    // A browser always sends one. Something that does not is not a browser.
    const verdict = createOriginPolicy(config())(undefined)
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('no Origin')
  })

  it('allows an origin listed explicitly', () => {
    const policy = createOriginPolicy(config({ allowedOrigins: ['https://gladiator.example'] }))
    expect(policy('https://gladiator.example').allowed).toBe(true)
    expect(policy('https://gladiator.example.evil').allowed).toBe(false)
  })

  it('allows localhost outside production and refuses it inside', () => {
    expect(createOriginPolicy(config({ allowLocalhost: true }))('http://localhost:5173').allowed)
      .toBe(true)
    expect(createOriginPolicy(config({ allowLocalhost: true }))('http://127.0.0.1:4173').allowed)
      .toBe(true)
    expect(createOriginPolicy(config({ allowLocalhost: false }))('http://localhost:5173').allowed)
      .toBe(false)
  })

  it('says why it refused, so a failing preview is not mistaken for an outage', () => {
    const verdict = createOriginPolicy(config())('https://not-ours.vercel.app')
    expect(verdict.allowed).toBe(false)
    expect(verdict.reason).toContain('https://not-ours.vercel.app')
  })
})

describe('readConfig', () => {
  it('defaults to the local dev port and a dev build', () => {
    expect(readConfig({})).toMatchObject({ port: 8787, build: 'dev', allowLocalhost: true })
  })

  it('takes PORT from the environment, which is how Fly injects it', () => {
    expect(readConfig({ PORT: '8080' }).port).toBe(8080)
    expect(readConfig({ PORT: 'nonsense' }).port).toBe(8787)
  })

  it('turns localhost off in production', () => {
    expect(readConfig({ NODE_ENV: 'production' }).allowLocalhost).toBe(false)
  })

  it('splits ALLOWED_ORIGINS on commas and drops the whitespace', () => {
    expect(readConfig({ ALLOWED_ORIGINS: ' https://a.example , https://b.example ,, ' })
      .allowedOrigins).toEqual(['https://a.example', 'https://b.example'])
  })

  it('records nothing unless GLADIATOR_DEMO_DIR names somewhere', () => {
    // Off by default and off for the empty string, because a machine holding
    // two hundred rooms should not be holding two hundred growing arrays
    // because somebody exported a variable and left it blank. `demoFile.ts`.
    expect(readConfig({}).demoDir).toBeNull()
    expect(readConfig({ GLADIATOR_DEMO_DIR: '  ' }).demoDir).toBeNull()
    expect(readConfig({ GLADIATOR_DEMO_DIR: ' /data/demos ' }).demoDir).toBe('/data/demos')
  })
})
