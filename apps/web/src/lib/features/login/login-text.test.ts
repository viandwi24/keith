import { describe, expect, test } from 'bun:test'
import { expiresText, secondsLeft, spacedCode, throttleText, versionLine } from './login-text.ts'

describe('login text (same words as the TUI)', () => {
  test('countdowns', () => {
    expect(secondsLeft(5_000, 1_000)).toBe(4)
    expect(secondsLeft(1_000, 5_000)).toBe(0)
    expect(throttleText(13_000, 1_000)).toBe('try again in 12 s')
    expect(throttleText(1_000, 1_000)).toBe('you can try again now')
    expect(expiresText(601_000, 1_000)).toBe('expires in 10 minutes')
    expect(expiresText(61_000, 1_000)).toBe('expires in 1 minute')
    expect(expiresText(43_000, 1_000)).toBe('expires in 42 s')
    expect(expiresText(1_000, 1_000)).toBe('expired')
  })
  test('code and version', () => {
    expect(spacedCode('KTPW-4C7M')).toBe('K T P W - 4 C 7 M')
    expect(versionLine('0.4.1')).toBe('Keith 0.4.1')
    expect(versionLine('')).toBe('Keith')
  })
})
