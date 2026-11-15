import { describe, expect, test } from 'bun:test'
import {
  adoptToken,
  createCookieSignIn,
  createKeithClient,
  detectBrowserEnvironment,
  localStorageClientIdStore,
  localStorageIdentifierMemory,
  logout,
  StepUpError,
  ViewMenuError,
  WEB_CAPABILITIES,
} from './browser.ts'
import { deviceLoginResult } from './login.ts'
import {
  atFlow,
  CORE,
  fakeCore,
  health,
  identifyReply,
  TOKEN,
  unauthorized,
  WHOAMI,
  whoamiOk,
} from './sign-in-fake.ts'
import type { ViewSocket } from './view/open-view.ts'

/** A fetch that records each request (headers, credentials, body) and answers by path. */
function recorder(answers: Record<string, () => Response>) {
  const calls: Array<{ path: string; headers: Headers; credentials?: string; body: string }> = []
  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined
    const path = new URL(request?.url ?? String(input)).pathname
    calls.push({
      path,
      headers: new Headers(request?.headers ?? init?.headers),
      ...(init?.credentials === undefined ? {} : { credentials: init.credentials }),
      body: String(init?.body ?? ''),
    })
    return (answers[path] ?? (() => new Response('{}', { status: 404 })))()
  }
  return { fetch: impl as unknown as typeof fetch, calls }
}

const client = (r: ReturnType<typeof recorder>) =>
  createKeithClient({ baseUrl: CORE, auth: 'cookie', fetch: r.fetch })

describe('cookie mode client', () => {
  test('no Authorization header, same-origin credentials, on rpc and harness calls', async () => {
    const r = recorder({ '/rpc/auth/whoami': whoamiOk, '/sessions': () => Response.json({}) })
    const c = client(r)
    expect(await c.rpc.auth.whoami()).toMatchObject({ username: 'ana' })
    await c.harness.sessions.get('s1').catch(() => undefined)
    expect(r.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of r.calls) {
      expect(call.headers.get('authorization')).toBeNull()
      expect(call.credentials).toBe('same-origin')
    }
  })

  test('stepUp sends deliver cookie with rotate and accepts {cookie:true}', async () => {
    const r = recorder({
      '/auth/step-up': () => Response.json({ elevatedUntil: 123, cookie: true }),
    })
    const pin = ['1', '2', '3', '4'].join('')
    expect(await client(r).stepUp({ pin })).toMatchObject({ elevatedUntil: 123 })
    const call = r.calls[0]
    expect(call?.headers.get('authorization')).toBeNull()
    expect(call?.credentials).toBe('same-origin')
    expect(JSON.parse(call?.body ?? '{}')).toEqual({ pin, rotate: true, deliver: 'cookie' })
  })

  test('stepUp maps a 401 to unauthorized, not a missing-token rejection', async () => {
    const r = recorder({
      '/auth/step-up': () => Response.json({ error: 'unauthorized' }, { status: 401 }),
    })
    const error = await client(r)
      .stepUp({ password: 'x' })
      .catch((e) => e)
    expect(error).toBeInstanceOf(StepUpError)
    expect(r.calls).toHaveLength(1) // it reached the core
  })

  test('viewMenu and openView go without a token', async () => {
    const r = recorder({ '/plugins/tui/menu': () => new Response('x', { status: 500 }) })
    const c = client(r)
    const error = await c.viewMenu().catch((e) => e)
    expect(error).toBeInstanceOf(ViewMenuError)
    expect((error as ViewMenuError).reason).toBe('unavailable')
    expect(r.calls[0]?.headers.get('authorization')).toBeNull()

    const seen: Array<{ url: string; headers: Record<string, string> }> = []
    const socket: ViewSocket = {
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    }
    const view = c.openView({
      viewId: 'a.b',
      cols: 80,
      rows: 24,
      onFrame() {},
      onEnd() {},
      connect: (url, headers) => {
        seen.push({ url, headers })
        return socket
      },
    })
    expect(seen).toEqual([{ url: 'ws://core.test/plugins/views/ws', headers: {} }])
    view.close()
  })

  test('openView uses the platform WebSocket with no headers when none is given', () => {
    const urls: unknown[][] = []
    const original = globalThis.WebSocket
    class Fake {
      onopen = null
      onmessage = null
      onclose = null
      onerror = null
      constructor(...args: unknown[]) {
        urls.push(args)
      }
      send() {}
      close() {}
    }
    globalThis.WebSocket = Fake as never
    try {
      const view = client(recorder({})).openView({
        viewId: 'a.b',
        cols: 80,
        rows: 24,
        onFrame() {},
        onEnd() {},
      })
      view.close()
    } finally {
      globalThis.WebSocket = original
    }
    expect(urls).toEqual([['ws://core.test/plugins/views/ws']])
  })
})

describe('cookie sign-in', () => {
  test('the flow answer asks for the cookie and {cookie:true} is signed in', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('lan'),
      '/auth/flow/:id': () => Response.json({ cookie: true }),
      '/rpc/auth/whoami': whoamiOk,
    })
    const signIn = createCookieSignIn({ fetch: core.fetch, address: CORE })
    await atFlow(signIn)
    await signIn.submitStep({ pin: ['1', '2', '3', '4'].join('') })
    expect(signIn.get()).toMatchObject({ step: 'done', person: { username: WHOAMI.username } })
    const flow = core.calls.find((c) => c.path.startsWith('/auth/flow/'))
    expect(JSON.parse(flow?.body ?? '{}')).toMatchObject({ method: 'pin', deliver: 'cookie' })
    expect(core.calls.every((c) => c.auth === null)).toBe(true)
  })

  test('a credential in a cookie-mode answer is not accepted', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('lan'),
      '/auth/flow/:id': () => Response.json({ credential: TOKEN }),
    })
    const signIn = createCookieSignIn({ fetch: core.fetch, address: CORE })
    await atFlow(signIn)
    await signIn.submitStep({ pin: ['1', '2', '3', '4'].join('') })
    expect(signIn.get().step).toBe('flow')
  })

  test('a pasted token is checked, then adopted into the cookie', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('lan'),
      '/rpc/auth/whoami': whoamiOk,
      '/auth/web/adopt': () => Response.json({ cookie: true }),
    })
    const signIn = createCookieSignIn({ fetch: core.fetch, address: CORE })
    await atFlow(signIn)
    signIn.chooseMethod('token')
    signIn.setRememberDevice(true)
    await signIn.submitStep({ token: TOKEN })
    expect(signIn.get().step).toBe('done')
    const adopt = core.calls.find((c) => c.path === '/auth/web/adopt')
    expect(JSON.parse(adopt?.body ?? '{}')).toEqual({ credential: TOKEN, remember: true })
    expect(adopt?.auth).toBeNull()
  })

  test('a refused pasted token stays on the flow', async () => {
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('lan'),
      '/rpc/auth/whoami': unauthorized,
    })
    const signIn = createCookieSignIn({ fetch: core.fetch, address: CORE })
    await atFlow(signIn)
    signIn.chooseMethod('token')
    await signIn.submitStep({ token: TOKEN })
    expect(signIn.get()).toMatchObject({ step: 'flow', problem: { reason: 'invalid' } })
  })

  test('device login in cookie mode sends deliver cookie and takes {cookie:true}', async () => {
    const core = fakeCore({
      '/auth/device/start': () =>
        Response.json({
          requestId: 'r1',
          pollSecret: 's1',
          code: 'ABCD-EFGH',
          expiresAt: Date.now() + 60_000,
        }),
      '/auth/device/poll': () => Response.json({ status: 'approved', cookie: true }),
    })
    const result = await deviceLoginResult({
      core: CORE,
      fetch: core.fetch,
      pollMs: 1,
      deliver: 'cookie',
      onCode() {},
    })
    expect(result).toEqual({ cookie: true })
    const poll = core.calls.find((c) => c.path === '/auth/device/poll')
    expect(JSON.parse(poll?.body ?? '{}')).toMatchObject({ deliver: 'cookie' })
  })

  test('body mode: an approved poll with no credential is an error', async () => {
    const core = fakeCore({
      '/auth/device/start': () =>
        Response.json({
          requestId: 'r1',
          pollSecret: 's1',
          code: 'ABCD-EFGH',
          expiresAt: Date.now() + 60_000,
        }),
      '/auth/device/poll': () => Response.json({ status: 'approved', cookie: true }),
    })
    const error = await deviceLoginResult({
      core: CORE,
      fetch: core.fetch,
      pollMs: 1,
      onCode() {},
    }).catch((e) => e)
    expect(error).toMatchObject({ name: 'DeviceLoginError', reason: 'rejected' })
  })

  test('body mode: a {cookie:true} flow answer is not a sign-in', async () => {
    const { createSignIn } = await import('./sign-in.ts')
    const core = fakeCore({
      '/health': health,
      '/auth/identify': identifyReply('lan'),
      '/auth/flow/:id': () => Response.json({ cookie: true }),
    })
    const signIn = createSignIn({ fetch: core.fetch })
    await atFlow(signIn)
    await signIn.submitStep({ pin: ['1', '2', '3', '4'].join('') })
    expect(signIn.get().step).toBe('flow')
  })
})

describe('adopt and logout', () => {
  test('adoptToken posts the credential once, same origin, no Authorization', async () => {
    const r = recorder({ '/auth/web/adopt': () => Response.json({ cookie: true }) })
    await adoptToken(TOKEN, true, { baseUrl: CORE, fetch: r.fetch })
    expect(r.calls).toHaveLength(1)
    expect(r.calls[0]?.credentials).toBe('same-origin')
    expect(r.calls[0]?.headers.get('authorization')).toBeNull()
    expect(JSON.parse(r.calls[0]?.body ?? '{}')).toEqual({ credential: TOKEN, remember: true })
  })

  test('adoptToken without remember leaves the flag out; a 401 is invalid', async () => {
    const r = recorder({ '/auth/web/adopt': () => Response.json({}, { status: 401 }) })
    const error = await adoptToken(TOKEN, false, { baseUrl: CORE, fetch: r.fetch }).catch((e) => e)
    expect(error).toMatchObject({ name: 'WebSessionError', reason: 'invalid' })
    expect(JSON.parse(r.calls[0]?.body ?? '{}')).toEqual({ credential: TOKEN })
  })

  test('logout posts to the logout route', async () => {
    const r = recorder({ '/auth/web/logout': () => Response.json({ ok: true }) })
    await logout({ baseUrl: CORE, fetch: r.fetch })
    expect(r.calls[0]).toMatchObject({ path: '/auth/web/logout', credentials: 'same-origin' })
  })
})

describe('browser storage', () => {
  const UUID = '0f1e2d3c-4b5a-4968-8776-655443322110'

  test('the client id is kept in the storage', () => {
    const data = new Map<string, string>()
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
    }
    const store = localStorageClientIdStore(storage)
    expect(store.read()).toBeUndefined()
    store.write(UUID)
    expect(localStorageClientIdStore(storage).read()).toBe(UUID)
  })

  test('a storage that throws falls back to memory', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const store = localStorageClientIdStore(broken)
    expect(store.read()).toBeUndefined()
    store.write(UUID)
    expect(store.read()).toBe(UUID)
    expect(localStorageClientIdStore(undefined).read()).toBeUndefined()
    const memory = localStorageIdentifierMemory(broken)
    memory.write(`${CORE}/`, 'ana')
    expect(memory.read(CORE)).toBe('ana')
  })
})

describe('browser environment', () => {
  test('macOS Chrome with client hints', async () => {
    const env = await detectBrowserEnvironment({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/126.0 Safari/537.36',
      language: 'id-ID',
      userAgentData: {
        platform: 'macOS',
        mobile: false,
        brands: [
          { brand: 'Not/A)Brand', version: '8' },
          { brand: 'Chromium', version: '126' },
          { brand: 'Google Chrome', version: '126' },
        ],
      },
    })
    expect(env).toMatchObject({
      host: 'Google Chrome browser',
      os: 'macos',
      device: 'unknown',
      locale: 'id-ID',
    })
    expect(typeof env?.timezone).toBe('string')
    expect(Object.keys(env ?? {}).sort()).toEqual(['device', 'host', 'locale', 'os', 'timezone'])
  })

  test('Firefox on Linux from the user agent alone', async () => {
    const env = await detectBrowserEnvironment({
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
    })
    expect(env).toMatchObject({ host: 'Firefox browser', os: 'linux', device: 'unknown' })
  })

  test('an iPhone is a phone and not macOS', async () => {
    const env = await detectBrowserEnvironment({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
    })
    expect(env).toMatchObject({ host: 'Safari browser', os: 'other', device: 'phone' })
  })

  test('no navigator at all still gives a valid answer', async () => {
    const env = await detectBrowserEnvironment({})
    expect(env).toMatchObject({ host: 'web browser', os: 'other', device: 'unknown' })
  })

  test('the web capabilities are the terminal four', () => {
    expect([...WEB_CAPABILITIES]).toEqual(['chat', 'notify', 'open.view', 'render.markdown'])
  })
})
