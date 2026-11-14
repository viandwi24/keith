import { describe, expect, test } from 'bun:test'
import { looksLikeSecret } from '../../hippocampus/index.ts'
import { REDACTED, REDACTED_SECRET, redact } from './redact.ts'

// Fake credentials are built at runtime: gitleaks flags key-shaped literals.
const OPENAI_LIKE = `${['s', 'k'].join('')}-${['A1b', '2C3d', '4E5f', '6G7h', '8I9j', '0K1l'].join('')}`
const RANDOM_RUN = [
  'aB3',
  'kQ9',
  'zT1',
  'mW5',
  'pL7',
  'xR2',
  'vN8',
  'hD4',
  'cF6',
  'gJ0',
  'yE2',
  'bS4',
].join('')
const BEARER = `Bearer ${RANDOM_RUN}`
const PASSWORD = ['hunter2', 'long', 'pass'].join('-')

describe('redact', () => {
  test('fake fixtures are secret-shaped for the guard', () => {
    expect(looksLikeSecret(OPENAI_LIKE)).toBe(true)
    expect(looksLikeSecret(RANDOM_RUN)).toBe(true)
  })

  test('an authorization header never survives; other headers stay', () => {
    const body = { headers: { authorization: BEARER, 'content-type': 'application/json' } }
    const out = redact(body)
    expect(JSON.stringify(out)).not.toContain(RANDOM_RUN)
    expect(out).toEqual({
      headers: { authorization: REDACTED, 'content-type': 'application/json' },
    })
  })

  test('a secret under a matching key at any depth is redacted; other keys stay', () => {
    const body = {
      provider: {
        model: 'gpt-x',
        options: {
          apiKey: OPENAI_LIKE,
          'x-api-key': RANDOM_RUN,
          nested: [{ password: PASSWORD }],
        },
      },
    }
    const out = JSON.stringify(redact(body))
    expect(out).not.toContain(OPENAI_LIKE)
    expect(out).not.toContain(RANDOM_RUN)
    expect(out).not.toContain('hunter2')
    expect(out).toContain('gpt-x')
  })

  test('numbers under a token key stay (usage counters are figures)', () => {
    const body = { usage: { input_tokens: 12, max_tokens: 4096 } }
    expect(redact(body)).toEqual(body)
  })

  test('a secret inside free text is replaced word by word, the rest stays', () => {
    const out = redact({ text: `use this key ${RANDOM_RUN} please` })
    expect(out).toEqual({ text: `use this key ${REDACTED_SECRET} please` })
  })

  test('a bearer value in free text is replaced', () => {
    const out = redact({ text: `curl -H "Authorization: ${BEARER}"` }) as { text: string }
    expect(out.text).not.toContain(RANDOM_RUN)
  })

  test('an array of tool results is walked', () => {
    const results = [
      { toolName: 'shell', output: { stdout: 'ok', env: { OPENAI_API_KEY: OPENAI_LIKE } } },
      { toolName: 'fetch', output: `got ${OPENAI_LIKE} back` },
    ]
    const out = JSON.stringify(redact(results))
    expect(out).not.toContain(OPENAI_LIKE)
    expect(out).toContain('"stdout":"ok"')
    expect(out).toContain(REDACTED_SECRET)
  })

  test('the input is not changed', () => {
    const body = { headers: { authorization: BEARER } }
    redact(body)
    expect(body.headers.authorization).toBe(BEARER)
  })

  test('a cycle does not throw and becomes a marker', () => {
    const node: Record<string, unknown> = { name: 'loop' }
    node.self = node
    const shared = { ok: true }
    const out = redact({ node, a: shared, b: shared }) as {
      node: Record<string, unknown>
      b: unknown
    }
    expect(out.node.self).toBe('[circular]')
    expect(out.b).toEqual({ ok: true })
  })
})
