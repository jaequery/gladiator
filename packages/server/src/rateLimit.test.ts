import { describe, expect, it } from 'vitest'

import {
  IDLE_BUCKET_MS,
  clientKey,
  createKeyedLimiter,
  createTokenBucket,
} from './rateLimit.ts'

describe('the token bucket', () => {
  it('starts full and refuses once it is empty', () => {
    const bucket = createTokenBucket({ ratePerSecond: 10, burst: 3 })
    expect(bucket.spend(1, 0)).toBe(true)
    expect(bucket.spend(1, 0)).toBe(true)
    expect(bucket.spend(1, 0)).toBe(true)
    expect(bucket.spend(1, 0)).toBe(false)
  })

  it('refills at exactly the budget', () => {
    const bucket = createTokenBucket({ ratePerSecond: 10, burst: 3 })
    for (let i = 0; i < 3; i += 1) bucket.spend(1, 0)

    // A tenth of a second is one token at 10/s.
    expect(bucket.spend(1, 50)).toBe(false)
    expect(bucket.spend(1, 100)).toBe(true)
  })

  it('never refills past the burst, however long it has been idle', () => {
    const bucket = createTokenBucket({ ratePerSecond: 10, burst: 3 })
    bucket.spend(1, 0)
    // An hour later the bucket is full and not three hundred deep. This is the
    // difference between a burst allowance and a savings account.
    for (let i = 0; i < 3; i += 1) expect(bucket.spend(1, 3_600_000)).toBe(true)
    expect(bucket.spend(1, 3_600_000)).toBe(false)
  })

  it('stamps its clock at the first spend, not at construction', () => {
    const bucket = createTokenBucket({ ratePerSecond: 10, burst: 3 })
    // A peer joining a process that has been up for an hour must not find an
    // hour's worth of refill waiting: the burst is all there is.
    for (let i = 0; i < 3; i += 1) expect(bucket.spend(1, 3_600_000)).toBe(true)
    expect(bucket.spend(1, 3_600_000)).toBe(false)
  })

  it('a refused spend takes nothing', () => {
    const bucket = createTokenBucket({ ratePerSecond: 10, burst: 2 })
    bucket.spend(2, 0)
    expect(bucket.spend(1, 0)).toBe(false)
    // The refusal did not drain what was left, so the next token to arrive is
    // spendable. A limiter that charged for refusals would hold a hammering
    // client out forever rather than for the moment it overspent.
    expect(bucket.spend(1, 100)).toBe(true)
  })

  it('adds nothing when the clock goes backwards', () => {
    const bucket = createTokenBucket({ ratePerSecond: 10, burst: 2 })
    bucket.spend(1, 1000)
    bucket.spend(1, 1000)
    expect(bucket.spend(1, 0)).toBe(false)
  })

  it('charges by cost, so a big frame costs more than a small one', () => {
    const bytes = createTokenBucket({ ratePerSecond: 1000, burst: 1000 })
    expect(bytes.spend(900, 0)).toBe(true)
    expect(bytes.spend(200, 0)).toBe(false)
    expect(bytes.spend(100, 0)).toBe(true)
  })

  it('is off at a rate of zero', () => {
    const bucket = createTokenBucket({ ratePerSecond: 0, burst: 0 })
    for (let i = 0; i < 1000; i += 1) expect(bucket.spend(1, 0)).toBe(true)
  })
})

describe('the per-key limiter', () => {
  it('gives every key its own budget', () => {
    const limiter = createKeyedLimiter({ ratePerSecond: 1, burst: 2 })
    expect(limiter.spend('a', 0)).toBe(true)
    expect(limiter.spend('a', 0)).toBe(true)
    expect(limiter.spend('a', 0)).toBe(false)
    // One address exhausting itself must not cost the next player anything —
    // otherwise the limiter is the denial of service.
    expect(limiter.spend('b', 0)).toBe(true)
  })

  it('forgets a bucket that has been idle, and remembers one that has not', () => {
    const limiter = createKeyedLimiter({ ratePerSecond: 1, burst: 2 })
    limiter.spend('a', 0)
    limiter.spend('b', 0)
    expect(limiter.size).toBe(2)

    limiter.spend('b', IDLE_BUCKET_MS)
    limiter.sweep(IDLE_BUCKET_MS)
    expect(limiter.size).toBe(1)
    expect(limiter.spend('b', IDLE_BUCKET_MS)).toBe(true)
  })

  it('evicts rather than growing without bound', () => {
    // The map is keyed by something an attacker supplies, so the backstop is
    // the property that matters: forging addresses costs memory that is capped.
    const limiter = createKeyedLimiter({ ratePerSecond: 1, burst: 1, maxKeys: 4 })
    for (let i = 0; i < 100; i += 1) limiter.spend(`address-${i}`, 0)
    expect(limiter.size).toBeLessThanOrEqual(4)
  })
})

describe('the client key', () => {
  it('is an IPv4 address, however it was spelt', () => {
    expect(clientKey('203.0.113.4')).toBe('203.0.113.4')
    // A dual-stack listener hands back the mapped form; two spellings of one
    // address would otherwise be two budgets.
    expect(clientKey('::ffff:203.0.113.4')).toBe('203.0.113.4')
  })

  it('buckets IPv6 by its /64', () => {
    // A residential customer is routinely handed a whole /64, so limiting per
    // address limits nothing: an attacker walks their own subnet and every
    // address arrives with a full bucket.
    const one = clientKey('2001:db8:1234:5678:1::1')
    const two = clientKey('2001:db8:1234:5678:ffff:ffff:ffff:ffff')
    expect(one).toBe(two)
    expect(clientKey('2001:db8:1234:9999::1')).not.toBe(one)
  })

  it('drops a scope id, which is about this host and not about the peer', () => {
    expect(clientKey('fe80::1%eth0')).toBe(clientKey('fe80::2%wlan0'))
  })

  it('has an answer for an address it did not get', () => {
    expect(clientKey(undefined)).toBe('unknown')
    expect(clientKey('')).toBe('unknown')
  })
})
