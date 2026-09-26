import { afterAll, describe, expect, test } from 'bun:test'
import { startFakeCore } from '../test/fake-core.ts'
import { ClientError } from './errors.ts'
import { getMe, listMessages, listThreads, login, logout, normalizeBaseUrl, wsUrl } from './http.ts'

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
    expect(() => normalizeBaseUrl('ftp://x')).toThrow(ClientError)
    expect(() => normalizeBaseUrl('nope')).toThrow(ClientError)
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
    expect(error).toBeInstanceOf(ClientError)
    expect((error as ClientError).code).toBe('LOGIN_FAILED')
    expect((error as ClientError).message).toBe('wrong username or password')
  })

  test('unreachable server → NETWORK', async () => {
    const error = await rejection(login('http://127.0.0.1:1', { username: 'a', password: 'b' }))
    expect((error as ClientError).code).toBe('NETWORK')
  })

  test('an invalid response body → INVALID_RESPONSE', async () => {
    const fetch = async () => Response.json({ token: '' })
    const error = await rejection(login('http://x', { username: 'a', password: 'b' }, { fetch }))
    expect((error as ClientError).code).toBe('INVALID_RESPONSE')
  })

  test('honors the abort signal', async () => {
    const controller = new AbortController()
    controller.abort()
    const error = await rejection(
      login(core.url, { username: 'tony', password: 'jarvis' }, { signal: controller.signal }),
    )
    expect((error as ClientError).code).toBe('ABORTED')
  })
})

describe('bearer endpoints', () => {
  const core = startFakeCore({ history: 7 })
  afterAll(() => core.stop())
  const signIn = async () => (await login(core.url, { username: 'tony', password: 'jarvis' })).token

  test('me and threads', async () => {
    const token = await signIn()
    expect(await getMe(core.url, token)).toEqual(core.person)
    expect(await listThreads(core.url, token)).toEqual([core.thread])
  })

  test('messages pages backwards, oldest first, with hasMore', async () => {
    const token = await signIn()
    const latest = await listMessages(core.url, token, core.thread.id, { limit: 3 })
    expect(latest.messages.map((m) => m.content)).toEqual(['history 5', 'history 6', 'history 7'])
    expect(latest.hasMore).toBe(true)
    const before = latest.messages[0]?.id
    const older = await listMessages(core.url, token, core.thread.id, { before, limit: 10 })
    expect(older.messages.map((m) => m.content)).toEqual(['history 1', 'history 2', 'history 3', 'history 4'])
    expect(older.hasMore).toBe(false)
  })

  test('logout revokes the token; later calls are UNAUTHORIZED', async () => {
    const token = await signIn()
    await logout(core.url, token)
    const error = await rejection(getMe(core.url, token))
    expect(error).toBeInstanceOf(ClientError)
    expect((error as ClientError).code).toBe('UNAUTHORIZED')
  })

  test('an unknown thread is NOT_FOUND', async () => {
    const token = await signIn()
    const error = await rejection(listMessages(core.url, token, 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V99'))
    expect((error as ClientError).code).toBe('NOT_FOUND')
  })

  test('uses the injected fetch', async () => {
    const calls: string[] = []
    const fetch = async (input: string, init: RequestInit) => {
      calls.push(`${init.method} ${input} ${new Headers(init.headers).get('authorization')}`)
      return Response.json({ person: core.person })
    }
    await getMe('http://core.test', 'tok', { fetch })
    expect(calls).toEqual(['GET http://core.test/v1/me Bearer tok'])
  })
})
