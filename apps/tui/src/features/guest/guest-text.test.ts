import { describe, expect, test } from 'bun:test'
import { endsText, GUEST_COMMANDS, leftText } from './guest-text.ts'

describe('guest text', () => {
  test('messages left, with and without the limit', () => {
    expect(leftText(undefined, 20)).toBe('')
    expect(leftText(19, 20)).toBe('19 of 20 messages left')
    expect(leftText(3, undefined)).toBe('3 messages left')
  })
  test('when the chat ends', () => {
    const now = 1_000_000
    expect(endsText(now - 1, now)).toBe('ended')
    expect(endsText(now + 30_000, now)).toBe('ends in under a minute')
    expect(endsText(now + 12 * 60_000, now)).toBe('ends in 12 min')
    expect(endsText(now + 120 * 60_000, now)).toBe('ends in 2 h')
    expect(endsText(now + 118 * 60_000, now)).toBe('ends in 1 h 58 min')
  })
  test('a visitor has two commands, none that needs an account', () => {
    expect(GUEST_COMMANDS).toEqual(['/help', '/quit'])
  })
})
