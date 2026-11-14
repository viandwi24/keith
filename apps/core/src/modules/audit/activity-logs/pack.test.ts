import { describe, expect, test } from 'bun:test'
import { pack, unpack } from './pack.ts'
import { REDACTED, redact } from './redact.ts'

describe('pack and unpack', () => {
  test('a normal body round trips equal', () => {
    const body = {
      model: 'x',
      messages: [{ role: 'user', content: 'hello ünïcode €' }],
      n: 3,
      ok: null,
    }
    expect(unpack(pack(body))).toEqual(body)
  })

  test('a redacted body round trips byte-equal', () => {
    const body = {
      headers: { authorization: 'Bearer abc' },
      text: 'plain words only',
      list: [1, 2, 3],
    }
    const redacted = redact(body)
    expect(JSON.stringify(unpack(pack(redacted)))).toBe(JSON.stringify(redacted))
    expect((redacted as { headers: { authorization: string } }).headers.authorization).toBe(
      REDACTED,
    )
  })

  test('the output is gzip and smaller than the JSON for repetitive text', () => {
    const body = { text: 'repeat me '.repeat(1000) }
    const bytes = pack(body)
    expect(bytes[0]).toBe(0x1f)
    expect(bytes[1]).toBe(0x8b)
    expect(bytes.byteLength).toBeLessThan(JSON.stringify(body).length / 10)
  })
})
