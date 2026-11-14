import { describe, expect, test } from 'bun:test'
import { DeviceStartRequestSchema } from './admin.ts'

describe('device label', () => {
  test('is trimmed', () => {
    expect(DeviceStartRequestSchema.parse({ label: '  laptop  ' }).label).toBe('laptop')
  })
  test('refuses control characters, escapes, bidi marks and forged rows', () => {
    for (const label of [
      'a\u001b[2Jb',
      'a\u001b]52;c;aGk=\u0007',
      'a\u009bb',
      'a\rb',
      'a‮b',
      'x\nroot  owner',
      '   ',
    ])
      expect(DeviceStartRequestSchema.safeParse({ label }).success).toBe(false)
  })
})
