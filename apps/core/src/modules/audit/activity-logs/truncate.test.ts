import { describe, expect, test } from 'bun:test'
import { truncateBody } from './truncate.ts'

const CAP = 512 * 1024
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

describe('truncateBody', () => {
  test('a normal body is returned equal and not flagged', () => {
    const body = { model: 'x', messages: [{ role: 'user', content: 'hello' }], n: 3 }
    expect(truncateBody(body, { maxBodyBytes: CAP })).toEqual({ value: body, truncated: false })
  })

  test('a string over 64 KB is cut with the byte count marker', () => {
    const { value, truncated } = truncateBody({ text: 'a'.repeat(70_000) }, { maxBodyBytes: CAP })
    const text = (value as { text: string }).text
    expect(truncated).toBe(true)
    expect(text.startsWith('a'.repeat(65_536))).toBe(true)
    expect(text.endsWith('[truncated 4464 bytes]')).toBe(true)
  })

  test('a 2 MB body is cut to the cap and flagged', () => {
    const body = { output: 'y'.repeat(2 * 1024 * 1024) }
    const { value, truncated } = truncateBody(body, { maxBodyBytes: CAP })
    expect(truncated).toBe(true)
    expect(bytes(value)).toBeLessThanOrEqual(CAP)
  })

  test('many strings under the string cap are cut to the body cap, longest first', () => {
    const chunks = Array.from({ length: 32 }, (_, i) => `${i}`.padEnd(64 * 1024 + 10, 'x'))
    const small = 'short'
    const { value, truncated } = truncateBody({ chunks, small }, { maxBodyBytes: CAP })
    expect(truncated).toBe(true)
    expect(bytes(value)).toBeLessThanOrEqual(CAP)
    expect((value as { small: string }).small).toBe(small)
  })

  test('a cut never splits a multi-byte character', () => {
    const { value } = truncateBody({ text: '€'.repeat(30_000) }, { maxBodyBytes: CAP })
    const text = (value as { text: string }).text
    expect(text.includes('�')).toBe(false)
    expect(text.includes('[truncated')).toBe(true)
  })

  test('the input is not changed', () => {
    const body = { text: 'z'.repeat(70_000) }
    truncateBody(body, { maxBodyBytes: CAP })
    expect(body.text.length).toBe(70_000)
  })
})
