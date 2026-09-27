import { describe, expect, test } from 'bun:test'
import { ID_PREFIXES, isPrefixedId, MessageId, prefixedId, ThreadId, Ulid } from './ids.ts'

const body = '01J8ZQ3K4M5N6P7Q8R9S0T1V31'

describe('prefixed ids', () => {
  test('every prefix is three lowercase letters and unique', () => {
    const prefixes = Object.values(ID_PREFIXES)
    expect(new Set(prefixes).size).toBe(prefixes.length)
    for (const p of prefixes) expect(p).toMatch(/^[a-z]{3}$/)
  })

  test('accepts the right prefix with a ULID body', () => {
    expect(ThreadId.safeParse(`thr_${body}`).success).toBe(true)
  })

  test.each([
    ['wrong prefix', `msg_${body}`],
    ['no prefix', body],
    ['short body', `thr_${body.slice(1)}`],
    ['long body', `thr_${body}0`],
    ['lowercase body', `thr_${body.toLowerCase()}`],
    ['excluded letter U', `thr_${body.slice(0, -1)}U`],
    ['excluded letter I', `thr_${body.slice(0, -1)}I`],
    ['first char above 7 (timestamp overflow)', `thr_8${body.slice(1)}`],
    ['not a string', 42],
  ])('rejects %s', (_name, value) => {
    expect(ThreadId.safeParse(value).success).toBe(false)
  })

  test('prefixedId builds a schema for any prefix', () => {
    expect(prefixedId('win').safeParse(`win_${body}`).success).toBe(true)
  })

  test('isPrefixedId narrows', () => {
    expect(isPrefixedId('msg', `msg_${body}`)).toBe(true)
    expect(isPrefixedId('msg', `thr_${body}`)).toBe(false)
    expect(isPrefixedId('msg', null)).toBe(false)
    expect(MessageId.safeParse(`msg_${body}`).success).toBe(true)
  })

  test('Ulid accepts a bare ULID', () => {
    expect(Ulid.safeParse(body).success).toBe(true)
  })
})
