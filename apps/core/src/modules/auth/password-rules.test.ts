import { describe, expect, test } from 'bun:test'
import { checkPassword, checkPin } from './password-rules.ts'

describe('password rules', () => {
  test('length: 15 to 256 characters, no composition rules, spaces allowed', () => {
    expect(checkPassword('a'.repeat(0))).toContain('15')
    expect(checkPassword('short pass 14ch')).toBeUndefined() // exactly 15
    expect(checkPassword('short pass 14c')).toContain('at least 15')
    expect(checkPassword('only lowercase words here and there')).toBeUndefined()
    expect(checkPassword(`${'ab1 '.repeat(63)}z9`)).toBeUndefined() // 254
    expect(checkPassword(`${'x7 q'.repeat(65)}`)).toContain('at most 256') // 260
  })

  test('the blocklist refuses common passwords and phrases, however they are dressed', () => {
    expect(checkPassword('correct horse battery staple')).toContain('common')
    expect(checkPassword('Password-Password')).toContain('common')
    expect(checkPassword('password1234567890')).toContain('common')
    expect(checkPassword('qwertyuiopasdfghjkl')).toContain('common')
  })

  test('one character, a repeated short unit and runs are refused', () => {
    expect(checkPassword('a'.repeat(20))).toContain('repeats')
    expect(checkPassword('abcd'.repeat(5))).toContain('repeats')
    expect(checkPassword('defghijklmnopqrstu')).toContain('run')
    expect(checkPassword('9876543210987654321')).toContain('run')
  })

  test('it may not contain the username or the display name', () => {
    expect(checkPassword('my-vian-secret-phrase-2026', { username: 'vian' })).toContain('username')
    expect(checkPassword('viandwi24 is my favourite', { username: 'viandwi24' })).toContain(
      'username',
    )
    expect(checkPassword('Ana Beatrice was here again', { name: 'Ana Beatrice' })).toContain('name')
    // a two-letter username is too short to forbid
    expect(checkPassword('bobby plays the tuba loudly', { username: 'bo' })).toBeUndefined()
    expect(
      checkPassword('purple tractors orbit mars', { username: 'vian', name: 'Vian' }),
    ).toBeUndefined()
  })

  test('a PIN is 6 to 12 digits', () => {
    expect(checkPin('123456')).toBeUndefined()
    expect(checkPin('123456789012')).toBeUndefined()
    expect(checkPin('12345')).toBeDefined()
    expect(checkPin('1234567890123')).toBeDefined()
    expect(checkPin('12345a')).toBeDefined()
    expect(checkPin('')).toBeDefined()
  })

  test('a stray leading or trailing space is named when it is part of the problem', () => {
    expect(checkPassword('short pass ')).toContain('starts or ends with a space')
    expect(checkPassword('a long enough pass phrase ')).toBeUndefined()
    expect(checkPin(' 123456')).toContain('remove the space')
    expect(checkPin('12345 ')).toBe('a PIN is 6 to 12 digits')
  })
})
