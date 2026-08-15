/**
 * The size guard, watched firing.
 *
 * `judge` is pure so the limits can be tested without arranging for a 6 MB file
 * to exist in the tree — and so the failure modes can be tested at all, which a
 * check that only ever runs against a healthy repository cannot be.
 */

import { describe, expect, it } from 'vitest'

import {
  MAX_FILE_BYTES,
  TOTAL_BUDGET_BYTES,
  WARN_AT,
  committedEntries,
  formatBytes,
  judge,
} from './assets-budget.ts'

const KB = 1024
const MB = 1024 * KB

describe('the per-file limit', () => {
  it('passes a file at the limit and fails one over it', () => {
    expect(judge([{ path: 'a.ktx2', bytes: MAX_FILE_BYTES }]).oversized).toEqual([])
    const over = judge([{ path: 'a.png', bytes: MAX_FILE_BYTES + 1 }])
    expect(over.oversized.map((entry) => entry.path)).toEqual(['a.png'])
  })

  it('reports the offenders largest first', () => {
    const verdict = judge([
      { path: 'small.png', bytes: 6 * MB },
      { path: 'huge.png', bytes: 40 * MB },
      { path: 'fine.ktx2', bytes: 100 * KB },
    ])
    expect(verdict.oversized.map((entry) => entry.path)).toEqual(['huge.png', 'small.png'])
  })
})

describe('the total budget', () => {
  it('catches the failure a per-file limit cannot see', () => {
    // Fifty files, every one of them individually reasonable.
    const many = Array.from({ length: 50 }, (_, index) => ({
      path: `t${index}.ktx2`,
      bytes: 900 * KB,
    }))
    const verdict = judge(many)
    expect(verdict.oversized).toEqual([])
    expect(verdict.overBudget).toBe(true)
  })

  it('warns before it fails', () => {
    const warned = judge([{ path: 'a', bytes: Math.ceil(TOTAL_BUDGET_BYTES * WARN_AT) + 1 }])
    expect(warned.nearBudget).toBe(true)
    expect(warned.overBudget).toBe(false)
  })
})

describe('this repository', () => {
  it('is inside both limits', () => {
    // The acceptance check, run against the real index rather than a fixture.
    const verdict = judge(committedEntries())
    expect(verdict.oversized).toEqual([])
    expect(verdict.overBudget).toBe(false)
  })
})

describe('formatting', () => {
  it('reads like a size', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2 * KB)).toBe('2.0 KB')
    expect(formatBytes(3 * MB)).toBe('3.00 MB')
  })
})
