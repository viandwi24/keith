import { describe, expect, test } from 'bun:test'
import { looksLikeSecret, SECRET_REFUSAL } from './secret-guard.ts'

// built at runtime: gitleaks flags key-shaped literals
const join = (...p: string[]) => p.join('')

describe('looksLikeSecret', () => {
  test.each([
    join('keith_', 'abcDEF123456'),
    join('Bearer ', 'abc123xyz'),
    join('sk-or-v1-', 'abcdef0123456789'),
    join('sk-', 'abcdefghij0123456789ABCD'),
    join('-----BEGIN ', 'PRIVATE KEY-----'),
    join('eyJhbGciOi', '.eyJzdWIiOiIx', '.sig_abc-123'),
    join('Zm9vYmFyQmF6', 'cXV4MTIzNDU2Nzg5', 'QUJDREVGR0g='),
  ])('refuses %s', (text) => {
    expect(looksLikeSecret(`note: ${text}`)).toBe(true)
  })

  test.each([
    'Owner likes coffee without sugar',
    'Office laptop: laptop-e, works in /home/vian/projects/keith/apps',
    'Anthropic-Claude-Sonnet-slowly-but-surely',
    'https://example.com/a-very-long-readable-slug-for-an-article',
  ])('allows %s', (text) => {
    expect(looksLikeSecret(text)).toBe(false)
  })
})

describe('SECRET_REFUSAL', () => {
  test('is English and does not assume who the person is', () => {
    expect(SECRET_REFUSAL).toBe(
      'Refused: this memory content looks like a secret (token, API key, private key, or a long random string). Keith does not store secrets in memory. Say that it was not saved, and keep the secret out of the chat.',
    )
    expect(SECRET_REFUSAL).not.toMatch(/owner/i)
  })
})
