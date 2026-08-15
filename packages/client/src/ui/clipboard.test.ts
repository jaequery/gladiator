import { describe, expect, it } from 'vitest'

import { copyMessage, copyText } from './clipboard.ts'

describe('copying the share link', () => {
  it('uses the asynchronous clipboard where there is one', async () => {
    const written: string[] = []
    const result = await copyText('https://gladiator.example/?room=H7K2Q9', {
      writeText: async (text) => {
        written.push(text)
      },
      execCopy: () => {
        throw new Error('should not have been reached')
      },
    })
    expect(result).toBe('clipboard')
    expect(written).toEqual(['https://gladiator.example/?room=H7K2Q9'])
  })

  it('falls back to execCommand on an insecure origin', async () => {
    // No `writeText` at all: that is what a page served over plain HTTP gets.
    const copied: string[] = []
    const result = await copyText('link', {
      execCopy: (text) => {
        copied.push(text)
        return true
      },
    })
    expect(result).toBe('execCommand')
    expect(copied).toEqual(['link'])
  })

  it('falls through when the clipboard rejects, rather than giving up', async () => {
    // A refused permission, or a document that lost focus between the click and
    // the promise. `execCommand` needs neither.
    const result = await copyText('link', {
      writeText: () => Promise.reject(new Error('NotAllowedError')),
      execCopy: () => true,
    })
    expect(result).toBe('execCommand')
  })

  it('says so when nothing worked, instead of resolving as if it had', async () => {
    // The failure this file exists for: a player who believes they have the
    // link and pastes an empty message.
    expect(await copyText('link', {})).toBe('unavailable')
    expect(await copyText('link', { execCopy: () => false })).toBe('unavailable')
    expect(
      await copyText('link', {
        writeText: () => Promise.reject(new Error('no')),
        execCopy: () => {
          throw new Error('deprecated')
        },
      }),
    ).toBe('unavailable')
  })

  it('turns each outcome into something worth reading', () => {
    expect(copyMessage('clipboard')).toBe('copied')
    expect(copyMessage('execCommand')).toBe('copied')
    expect(copyMessage('unavailable')).not.toBe('copied')
  })
})
