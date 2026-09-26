import { afterAll, describe, expect, test } from 'bun:test'
import { startFakeCore } from '../test/fake-core.ts'
import { login, normalizeBaseUrl, wsUrl } from './api.ts'
import { TuiError } from './errors.ts'

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('urls', () => {
  test('normalizes the base url', () => {
    expect(normalizeBaseUrl('http://127.0.0.1:4824/')).toBe('http://127.0.0.1:4824')
    expect(normalizeBaseUrl('https://keith.example')).toBe('https://keith.example')
  })

  test('rejects non-http urls', () => {
    expect(() => normalizeBaseUrl('ftp://x')).toThrow(TuiError)
    expect(() => normalizeBaseUrl('nope')).toThrow(TuiError)
  })

  test('builds the ws url with the token', () => {
    expect(wsUrl('http://127.0.0.1:4824', 'a b')).toBe('ws://127.0.0.1:4824/v1/ws?token=a+b')
    expect(wsUrl('https://keith.example', 't')).toBe('wss://keith.example/v1/ws?token=t')
  })
})

describe('login', () => {
  const core = startFakeCore()
  afterAll(() => core.stop())

  test('returns the token and person', async () => {
    const res = await login(core.url, { username: 'tony', password: 'jarvis' })
    expect(res.person).toEqual(core.person)
    expect(res.token.length).toBeGreaterThan(0)
  })

  test('wrong password → LOGIN_FAILED', async () => {
    const error = await rejection(login(core.url, { username: 'tony', password: 'nope' }))
    expect(error).toBeInstanceOf(TuiError)
    expect((error as TuiError).code).toBe('LOGIN_FAILED')
    expect((error as TuiError).message).toBe('wrong username or password')
  })

  test('unreachable server → NETWORK', async () => {
    const error = await rejection(login('http://127.0.0.1:1', { username: 'a', password: 'b' }))
    expect((error as TuiError).code).toBe('NETWORK')
  })

  test('an invalid response body → INVALID_RESPONSE', async () => {
    const fetch = async () => Response.json({ token: '' })
    const error = await rejection(login('http://x', { username: 'a', password: 'b' }, { fetch }))
    expect((error as TuiError).code).toBe('INVALID_RESPONSE')
  })

  test('honors the abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await rejection(
      login(core.url, { username: 'tony', password: 'jarvis' }, { signal: controller.signal }),
    )
    expect((error as TuiError).code).toBe('ABORTED')
  })
})
