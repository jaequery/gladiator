import { describe, expect, it } from 'vitest'

import { readConfig, type ServerConfig } from './config.ts'
import { createOriginPolicy, describeOriginPolicy, vercelPreviewPattern } from './origin.ts'

function config(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return { ...readConfig({}), ...overrides }
}

/** The deploy as `docs/deploy.md` describes it: production listed, scope set. */
function production(overrides: Partial<ServerConfig> = {}): ServerConfig {
  return config({
    allowedOrigins: ['https://gladiator.vercel.app'],
    vercelProject: 'gladiator',
    vercelScope: 'jae',
    allowLocalhost: false,
    ...overrides,
  })
}

describe('vercelPreviewPattern', () => {
  it('matches this project’s previews in this scope, in both shapes Vercel mints', () => {
    const pattern = vercelPreviewPattern('gladiator', 'jae')
    expect(pattern).not.toBeNull()
    expect(pattern?.test('https://gladiator-git-main-jae.vercel.app')).toBe(true)
    expect(pattern?.test('https://gladiator-9f3c1d2-jae.vercel.app')).toBe(true)
  })

  it('refuses the hostnames a project-only pattern would have admitted', () => {
    const pattern = vercelPreviewPattern('gladiator', 'jae')
    // The hole in `^https://gladiator(-[a-z0-9-]+)?\.vercel\.app$`: anyone may
    // create a Vercel project called `gladiator-x` and be given this hostname.
    expect(pattern?.test('https://gladiator-x.vercel.app')).toBe(false)
    expect(pattern?.test('https://gladiator-9f3c1d2-someone-else.vercel.app')).toBe(false)
    expect(pattern?.test('https://someone-elses-app.vercel.app')).toBe(false)
    expect(pattern?.test('https://evil.com')).toBe(false)
    // Not a suffix match, and not over plain http.
    expect(pattern?.test('https://gladiator-git-main-jae.vercel.app.evil.com')).toBe(false)
    expect(pattern?.test('http://gladiator-git-main-jae.vercel.app')).toBe(false)
  })

  it('has no pattern at all without a scope, rather than a looser one', () => {
    // Fails closed: a deploy that forgot VERCEL_SCOPE loses its previews, which
    // is visible. Falling back to the project-only pattern would silently
    // downgrade the control to the version above that is not one.
    expect(vercelPreviewPattern('gladiator', '')).toBeNull()
    expect(vercelPreviewPattern('', 'jae')).toBeNull()
  })

  it('escapes names that contain regex metacharacters', () => {
    const pattern = vercelPreviewPattern('a.b', 'c.d')
    expect(pattern?.test('https://a.b-1-c.d.vercel.app')).toBe(true)
    expect(pattern?.test('https://axb-1-cxd.vercel.app')).toBe(false)
  })
})

describe('origin policy', () => {
  it('admits the production origin and a preview of the same project', () => {
    // The two origins the deploy actually has, and the check the ticket asks
    // for: production comes off the explicit list, the preview off the pattern.
    const policy = createOriginPolicy(production())
    expect(policy('https://gladiator.vercel.app')).toMatchObject({ allowed: true })
    expect(policy('https://gladiator-9f3c1d2-jae.vercel.app')).toMatchObject({ allowed: true })
    expect(policy('https://gladiator-x.vercel.app')).toMatchObject({ allowed: false })
  })

  it('refuses every preview when no scope is configured', () => {
    const policy = createOriginPolicy(production({ vercelScope: '' }))
    expect(policy('https://gladiator.vercel.app').allowed).toBe(true)
    expect(policy('https://gladiator-9f3c1d2-jae.vercel.app').allowed).toBe(false)
  })

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

  it('says in one line what it will let through, for the boot log', () => {
    expect(describeOriginPolicy(production())).toContain('gladiator-*-jae.vercel.app')
    expect(describeOriginPolicy(production({ vercelScope: '' }))).toContain('VERCEL_SCOPE')
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

  it('reads the Vercel scope and the resume secret, and defaults both to empty', () => {
    // Empty is the fail-closed state for both: no preview pattern, no resume
    // tickets. Neither has a default that quietly does something.
    expect(readConfig({})).toMatchObject({ vercelScope: '', resumeSecret: '' })
    expect(readConfig({ VERCEL_SCOPE: 'jae', RESUME_SECRET: 'hunter2' })).toMatchObject({
      vercelScope: 'jae',
      resumeSecret: 'hunter2',
    })
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
