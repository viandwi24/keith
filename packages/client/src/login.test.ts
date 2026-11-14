import { describe, expect, test } from 'bun:test'
import { type DeviceLoginError, deviceLogin } from './login.ts'

/** A fake core: `start` answers once, `poll` answers from the script, one entry per call. */
function fakeCore(polls: Array<{ status: number; body?: unknown } | 'network'>) {
  const calls: string[] = []
  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(input)).pathname
    calls.push(path)
    if (path === '/auth/device/start') {
      return Response.json({
        code: 'ABCD-EFGH',
        requestId: 'r1',
        expiresAt: Date.now() + 600_000,
        pollSecret: 'ps',
      })
    }
    expect(JSON.parse(String(init?.body))).toEqual({ requestId: 'r1', pollSecret: 'ps' })
    const next = polls.shift()
    if (next === undefined || next === 'network') throw new Error('offline')
    return Response.json(next.body ?? {}, { status: next.status })
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

describe('deviceLogin', () => {
  test('reports the code, polls until approved and returns the credential', async () => {
    const core = fakeCore([
      { status: 200, body: { status: 'pending' } },
      'network',
      { status: 200, body: { status: 'pending' } },
      { status: 200, body: { status: 'approved', credential: 'cred-1' } },
    ])
    const codes: string[] = []
    const credential = await deviceLogin({
      core: 'http://core/',
      label: 'laptop',
      onCode: (c) => codes.push(c.code),
      fetch: core.fetch,
      pollMs: 1,
    })
    expect(credential).toBe('cred-1')
    expect(codes).toEqual(['ABCD-EFGH'])
    expect(core.calls.filter((p) => p.endsWith('/poll'))).toHaveLength(4)
  })

  test('denied, expired and a vanished request reject with a reason', async () => {
    const reason = async (poll: { status: number; body?: unknown }) => {
      const core = fakeCore([poll])
      try {
        await deviceLogin({ core: 'http://core', onCode() {}, fetch: core.fetch, pollMs: 1 })
      } catch (error) {
        return (error as DeviceLoginError).reason
      }
    }
    expect(await reason({ status: 200, body: { status: 'denied' } })).toBe('denied')
    expect(await reason({ status: 200, body: { status: 'expired' } })).toBe('expired')
    expect(await reason({ status: 404 })).toBe('expired')
  })

  test('aborting stops the wait', async () => {
    const core = fakeCore(
      Array.from({ length: 50 }, () => ({ status: 200, body: { status: 'pending' } })),
    )
    const controller = new AbortController()
    const waiting = deviceLogin({
      core: 'http://core',
      onCode: () => setTimeout(() => controller.abort(), 5),
      signal: controller.signal,
      fetch: core.fetch,
      pollMs: 2,
    })
    await expect(waiting).rejects.toMatchObject({ reason: 'aborted' })
  })

  test('a refused start is a rejection, an unreachable core says so', async () => {
    const refuse = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch
    await expect(
      deviceLogin({ core: 'http://core', onCode() {}, fetch: refuse }),
    ).rejects.toMatchObject({
      reason: 'rejected',
    })
    const down = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof fetch
    await expect(
      deviceLogin({ core: 'http://core', onCode() {}, fetch: down }),
    ).rejects.toMatchObject({
      reason: 'unreachable',
    })
  })
})
