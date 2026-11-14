import { describe, expect, test } from 'bun:test'
import { KEITH_STEP_UP_REQUIRED, passwordLogin, stepUp } from './index.ts'

const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    })) as unknown as typeof fetch
const login = (fetch: typeof globalThis.fetch) =>
  passwordLogin({ core: 'http://core/', username: 'ana', password: 'x'.repeat(16), fetch })
const reason = async (run: Promise<unknown>) => {
  try {
    await run
  } catch (e) {
    return e as { reason: string; retryAfter?: number; hint?: string }
  }
  throw new Error('did not fail')
}

describe('passwordLogin', () => {
  test('posts the credentials and returns the credential', async () => {
    let seen: { url: string; body: unknown } | undefined
    const fetch = (async (url: string, init: RequestInit) => {
      seen = { url, body: JSON.parse(String(init.body)) }
      return Response.json({ credential: 'keith_s_x' })
    }) as unknown as typeof globalThis.fetch
    const credential = await passwordLogin({
      core: 'http://core/',
      username: 'ana',
      password: 'p'.repeat(16),
      label: 'laptop',
      fetch,
    })
    expect(credential).toBe('keith_s_x')
    expect(seen?.url).toBe('http://core/auth/login')
    expect(seen?.body).toEqual({ username: 'ana', password: 'p'.repeat(16), label: 'laptop' })
  })

  test('maps each failure to a reason', async () => {
    expect((await reason(login(reply(401, { error: 'invalid_credentials' })))).reason).toBe(
      'invalid',
    )
    const throttled = await reason(
      login(reply(429, { error: 'throttled', retryAfter: 8 }, { 'retry-after': '8' })),
    )
    expect(throttled).toMatchObject({ reason: 'throttled', retryAfter: 8 })
    expect((await reason(login(reply(403, { error: 'login_not_allowed_here' })))).reason).toBe(
      'not_allowed_here',
    )
    expect((await reason(login(reply(503, { error: 'unavailable' })))).reason).toBe('unavailable')
    const down = (async () => {
      throw new Error('ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    expect((await reason(login(down))).reason).toBe('unreachable')
  })
})

const method = {
  id: 'password',
  label: 'Password',
  available: true,
  assurance: 2,
  interaction: 'form',
  firstStep: { id: 'password', fields: [] },
}

/** A core that offers the flow route: identify, then the password answer. */
function flowCore(options: { identify?: () => Response; answer?: () => Response } = {}) {
  const seen: Array<{ url: string; body: unknown }> = []
  const fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, body: JSON.parse(String(init.body)) })
    if (url.endsWith('/auth/identify'))
      return (
        options.identify?.() ??
        Response.json({ flowId: 'f1', context: 'loopback', methods: [method] })
      )
    return options.answer?.() ?? Response.json({ credential: 'keith_s_remembered' })
  }) as unknown as typeof globalThis.fetch
  return { fetch, seen }
}

describe('passwordLogin with remember', () => {
  const remembered = (fetch: typeof globalThis.fetch) =>
    passwordLogin({
      core: 'http://core/',
      username: 'ana',
      password: 'p'.repeat(16),
      remember: true,
      fetch,
    })

  test('identifies, then answers the password with remember: true', async () => {
    const core = flowCore()
    expect(await remembered(core.fetch)).toBe('keith_s_remembered')
    expect(core.seen.map((r) => r.url)).toEqual([
      'http://core/auth/identify',
      'http://core/auth/flow/f1',
    ])
    expect(core.seen[0]?.body).toEqual({ identifier: 'ana' })
    expect(core.seen[1]?.body).toEqual({
      method: 'password',
      answer: { password: 'p'.repeat(16) },
      remember: true,
    })
  })

  test('a core without the flow route (an older core) cannot remember the login', async () => {
    const core = flowCore({ identify: () => new Response('nope', { status: 404 }) })
    expect((await reason(remembered(core.fetch))).reason).toBe('remember_unavailable')
    expect(core.seen).toHaveLength(1)
  })

  test('a core that does not offer the password method cannot remember the login', async () => {
    const core = flowCore({
      identify: () =>
        Response.json({
          flowId: 'f1',
          context: 'loopback',
          methods: [{ ...method, available: false, reason: 'off' }],
        }),
    })
    expect((await reason(remembered(core.fetch))).reason).toBe('remember_unavailable')
  })

  test('a wrong password on the flow route is the same invalid reason', async () => {
    const core = flowCore({ answer: () => new Response('no', { status: 401 }) })
    expect((await reason(remembered(core.fetch))).reason).toBe('invalid')
  })
})

describe('stepUp', () => {
  const run = (
    fetch: typeof globalThis.fetch,
    secret: { pin: string } | { password: string } = { pin: '123456' },
  ) => stepUp({ core: 'http://core', token: 'keith_s_t', fetch, ...secret })

  test('sends the bearer and the PIN, returns elevatedUntil', async () => {
    let seen: { auth: string | null; body: unknown } | undefined
    const fetch = (async (_url: string, init: RequestInit) => {
      seen = {
        auth: new Headers(init.headers).get('authorization'),
        body: JSON.parse(String(init.body)),
      }
      return Response.json({ elevatedUntil: 42 })
    }) as unknown as typeof globalThis.fetch
    expect(await run(fetch)).toEqual({ elevatedUntil: 42 })
    expect(seen).toEqual({ auth: 'Bearer keith_s_t', body: { pin: '123456' } })
    await run(fetch, { password: 'a long enough password' })
    expect(seen?.body).toEqual({ password: 'a long enough password' })
  })

  test('maps failures, with the hint when there is no method', async () => {
    expect((await reason(run(reply(401, { error: 'invalid_credentials' })))).reason).toBe('invalid')
    expect((await reason(run(reply(401, { error: 'unauthorized' })))).reason).toBe('unauthorized')
    const none = await reason(
      run(reply(403, { error: 'no_step_up_method', hint: 'keith-core people pin ana' })),
    )
    expect(none).toMatchObject({ reason: 'no_method', hint: 'keith-core people pin ana' })
    expect(
      (await reason(run(reply(429, { error: 'throttled' }, { 'retry-after': '2' })))).retryAfter,
    ).toBe(2)
    expect((await reason(run(reply(409, { error: 'legacy_credential' })))).reason).toBe(
      'legacy_credential',
    )
    expect((await reason(run(reply(403, { error: 'login_not_allowed_here' })))).reason).toBe(
      'not_allowed_here',
    )
  })

  test('exports the error code step 3 raises', () => {
    expect(KEITH_STEP_UP_REQUIRED).toBe('KEITH_STEP_UP_REQUIRED')
  })
})

describe('client.stepUp', () => {
  test('uses the client token and base url; rejects without a token', async () => {
    const { createKeithClient } = await import('./index.ts')
    let seen: { url: string; auth: string | null } | undefined
    const fetch = (async (url: string, init: RequestInit) => {
      seen = { url, auth: new Headers(init.headers).get('authorization') }
      return Response.json({ elevatedUntil: 123 })
    }) as unknown as typeof globalThis.fetch
    const client = createKeithClient({ baseUrl: 'http://core/', token: 'keith_s_t', fetch })
    expect(await client.stepUp({ pin: '1234' })).toEqual({ elevatedUntil: 123 })
    expect(seen).toEqual({ url: 'http://core/auth/step-up', auth: 'Bearer keith_s_t' })
    const bare = createKeithClient({ baseUrl: 'http://core/', fetch })
    expect((await reason(bare.stepUp({ pin: '1234' }))).reason).toBe('unauthorized')
  })
})
