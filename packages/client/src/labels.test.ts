import { describe, expect, test } from 'bun:test'
import { connectionLabel, turnLabel } from './labels.ts'

describe('labels', () => {
  test('turn state labels', () => {
    expect(turnLabel('thinking')).toBe('thinking…')
    expect(turnLabel('speaking')).toBe('speaking')
    expect(turnLabel('idle')).toBe('')
  })

  test('connection labels', () => {
    expect(connectionLabel({ kind: 'online' })).toBe('online')
    expect(connectionLabel({ kind: 'reconnecting', attempt: 2, inMs: 1000 })).toBe(
      'offline, reconnecting in 1s (attempt 2)',
    )
    expect(connectionLabel({ kind: 'auth-required' })).toBe('signed out: the token was rejected')
    expect(connectionLabel({ kind: 'closed', reason: 'bye' })).toBe('closed: bye')
  })
})
