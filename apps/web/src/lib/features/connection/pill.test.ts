import { describe, expect, test } from 'bun:test'
import { isOffline, offlineText, pillOf, retryText } from './pill.ts'

describe('pillOf', () => {
  test('maps every link kind to a glyph, a word and a tone', () => {
    expect(pillOf({ kind: 'connecting', attempts: 0 })).toEqual({
      glyph: '◐',
      label: 'connecting',
      tone: 'muted',
    })
    expect(pillOf({ kind: 'live', attempts: 0 })).toEqual({
      glyph: '●',
      label: 'live',
      tone: 'success',
    })
    expect(pillOf({ kind: 'reconnecting', attempts: 1 }).tone).toBe('warning')
    expect(pillOf({ kind: 'disconnected', attempts: 1 })).toMatchObject({
      label: 'offline',
      tone: 'danger',
    })
    expect(pillOf({ kind: 'logged-out', attempts: 0 })).toMatchObject({
      label: 'logged out',
      tone: 'danger',
    })
  })
})

describe('offline banner text', () => {
  test('shows after a drop, not while connecting, live or logged out', () => {
    expect(isOffline({ kind: 'disconnected', attempts: 1 })).toBe(true)
    expect(isOffline({ kind: 'reconnecting', attempts: 1 })).toBe(true)
    for (const kind of ['connecting', 'live', 'logged-out'] as const)
      expect(isOffline({ kind, attempts: 0 })).toBe(false)
  })
  test('names the reason when known', () => {
    expect(offlineText({ reason: 'connection refused' })).toBe(
      'cannot reach the core (connection refused)',
    )
    expect(offlineText({})).toBe('cannot reach the core')
  })
  test('counts down to the next attempt', () => {
    const link = { kind: 'disconnected', attempts: 1, retryAt: 20_000 } as const
    expect(retryText(link, 8_000)).toBe('retrying in 12 s')
    expect(retryText(link, 20_000)).toBe('retrying now')
    expect(retryText({ kind: 'reconnecting', attempts: 1 }, 0)).toBe('retrying now')
    expect(retryText({ kind: 'live', attempts: 0 }, 0)).toBe('')
  })
})
