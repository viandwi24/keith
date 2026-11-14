/**
 * The guest listener's routes in a booted core (docs/specs/guests.md, "Guest HTTP"): the isolation matrix (a guest
 * bearer is nothing on the owner API, the owner's bearer is nothing on `/guest/*`, no credential is 401, an ended
 * session is 410), zones, the Host guard of that listener, the per-IP window and what a visitor can see.
 * The listener's `fetch` is called in process with a fake `server` that names the peer address.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  GUEST_BANNER,
  GUEST_BEARER_PREFIX,
  GuestPublicStatusSchema,
  GuestStartResponseSchema,
} from '@keith/contracts'
import { scriptedProvider } from 'eharness/testing'
import { loadConfig } from './platform/config.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'
import { issueOwnerToken } from './testing/owner-token.ts'

const PORT = 7421
const LOOPBACK = '127.0.0.1'
const LAN = '192.168.77.9'
const TAILNET = '100.64.3.4'
const FAR = '203.0.113.9'

const answer = `rp${crypto.randomUUID().replaceAll('-', '')}`
const fast = { text: answer, usage: { inputTokens: 80, outputTokens: 40 } }

let booted: BootedCore
let ownerToken = ''
beforeAll(async () => {
  booted = await bootCore(
    {},
    {
      definitions: [
        scriptedProvider({
          id: 'pricey',
          models: {
            // a short delay on every turn, so a second message can arrive while one runs
            cheap: Array.from({ length: 80 }, () => ({ ...fast, delayMs: 150 })),
          },
          info: { cheap: { pricing: { input: 1, output: 4 }, contextWindow: 100_000 } },
        }),
      ],
    },
  )
  const owner = booted.local.rpc
  await owner.providers.put({ providerId: 'pricey' })
  await owner.models.roles.set({ role: 'guest', ref: 'pricey:cheap' })
  await owner.admin.auth.policy.set({
    rules: [
      { method: 'pin', zones: ['loopback'], idleMs: 60_000, absoluteMs: 120_000 },
      { method: 'password', zones: ['loopback'] },
      { method: 'token', zones: ['loopback'] },
    ],
    lanCidrs: ['192.168.77.0/24'],
  })
  await owner.admin.guests.set({
    enabled: true,
    zones: ['loopback', 'lan', 'tailscale'],
    maxConcurrent: 20,
    sessionsPerIpPerWindow: 100,
  })
  ownerToken = await issueOwnerToken(
    loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }),
  )
})
afterAll(async () => {
  await booted.stop()
})

const peer = (address: string) => ({
  requestIP: () => ({ address }),
  timeout: () => undefined,
  port: PORT,
})
interface Call {
  ip?: string
  method?: string
  headers?: Record<string, string>
  host?: string
  token?: string
  body?: unknown
}
const call = (path: string, c: Call = {}): Promise<Response> =>
  booted.core.guestHttp.fetch(
    new Request(`http://${c.host ?? `127.0.0.1:${PORT}`}${path}`, {
      method: c.method ?? (c.body === undefined ? 'GET' : 'POST'),
      headers: {
        host: c.host ?? `127.0.0.1:${PORT}`,
        ...(c.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(c.token === undefined ? {} : { authorization: `Bearer ${c.token}` }),
        ...c.headers,
      },
      ...(c.body === undefined ? {} : { body: JSON.stringify(c.body) }),
    }),
    peer(c.ip ?? LOOPBACK) as never,
  )
const json = async <T = Record<string, unknown>>(res: Response): Promise<T> =>
  (await res.json()) as T

async function start(ip = LOOPBACK, headers: Record<string, string> = {}) {
  const res = await call('/guest/session', { ip, body: {}, headers })
  if (res.status !== 201) throw new Error(`start refused: ${res.status} ${await res.text()}`)
  return GuestStartResponseSchema.parse(await res.json())
}
const chatBody = (sessionId: string, text: string) => ({
  id: sessionId,
  trigger: 'submit-message',
  messages: [{ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text }] }],
})
const chat = (s: { sessionId: string; token: string }, text: string, ip = LOOPBACK) =>
  call(`/guest/sessions/${encodeURIComponent(s.sessionId)}/chat`, {
    ip,
    token: s.token,
    body: chatBody(s.sessionId, text),
  })

describe('status and the visitor view', () => {
  test('status says what a visitor may know and nothing about the owner', async () => {
    const res = await call('/guest/status')
    expect(res.status).toBe(200)
    const status = GuestPublicStatusSchema.parse(await res.json())
    expect(status).toMatchObject({ enabled: true, available: true, banner: GUEST_BANNER })
    expect(status.limits).toMatchObject({ maxTurns: 20, maxInputChars: 2048 })
    const raw = JSON.stringify(status)
    for (const secret of ['pricey', 'cheap', 'scripted', 'USD', 'owner-floor', 'budget'])
      expect(raw).not.toContain(secret)
  })

  test('from a network the owner did not allow, status says disabled and no limits', async () => {
    const status = GuestPublicStatusSchema.parse(
      await (await call('/guest/status', { ip: FAR })).json(),
    )
    expect(status).toEqual({ enabled: false, available: false, banner: GUEST_BANNER, limits: null })
  })

  test('only /health and /guest/* exist on the guest listener', async () => {
    expect((await call('/health')).status).toBe(200)
    for (const path of [
      '/rpc/health/get',
      '/sessions/front:owner',
      '/activity',
      '/attention',
      '/auth/login',
      '/nodes/join',
      '/plugins/openapi.json',
      '/guest',
      '/guest/unknown',
    ]) {
      const res = await call(path, { token: ownerToken })
      expect(res.status, path).toBe(404)
    }
    expect((await call('/rpc/health/get', { body: {} })).status).toBe(404)
  })

  test('the main listener serves no /guest route', async () => {
    for (const path of ['/guest/status', '/guest/session', '/guest/sessions/guest:x/chat']) {
      for (const method of ['GET', 'POST']) {
        const res = await fetch(`${booted.url}${path}`, { method })
        expect(res.status, `${method} ${path}`).toBe(404)
      }
    }
  })
})

describe('Host guard of the guest listener', () => {
  test('a literal LAN address is served, a name only when it is the machine or listed', async () => {
    expect((await call('/guest/status', { host: `192.168.1.5:${PORT}` })).status).toBe(200)
    expect((await call('/guest/status', { host: `[fd00::2]:${PORT}` })).status).toBe(200)
    expect((await call('/guest/status', { host: `192.168.1.5:${PORT + 1}` })).status).toBe(421)
    expect((await call('/guest/status', { host: `rebind.evil.example:${PORT}` })).status).toBe(421)
    await booted.local.rpc.admin.guests.set({ hosts: ['kiosk.example'] })
    expect((await call('/guest/status', { host: `kiosk.example:${PORT}` })).status).toBe(200)
    await booted.local.rpc.admin.guests.set({ hosts: [] })
    expect((await call('/guest/status', { host: `kiosk.example:${PORT}` })).status).toBe(421)
  })

  test('the main listener still refuses the LAN address as a Host', async () => {
    const res = await fetch(`${booted.url}/health`, { headers: { host: '192.168.1.5:80' } })
    expect(res.status).toBe(421)
  })
})

describe('entry: zone and rate', () => {
  test('a far peer is refused; a loopback peer behind a proxy or Funnel counts as public', async () => {
    const refused = await call('/guest/session', { ip: FAR, body: {} })
    expect(refused.status).toBe(403)
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe('GUEST_ZONE')
    for (const headers of [
      { 'x-forwarded-for': '9.9.9.9' },
      { forwarded: 'for=9.9.9.9' },
      { 'tailscale-funnel-request': '?1' },
    ]) {
      const res = await call('/guest/session', { ip: LOOPBACK, body: {}, headers })
      expect(res.status, JSON.stringify(headers)).toBe(403)
    }
  })

  test('loopback, lan and tailscale peers may start, each with its zone in the owner list', async () => {
    const made = [await start(LOOPBACK), await start(LAN), await start(TAILNET)]
    const zones = (await booted.local.rpc.admin.guests.list()).map((s) => s.zone).sort()
    expect(zones).toEqual(expect.arrayContaining(['lan', 'loopback', 'tailscale']))
    for (const s of made)
      await call(`/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
        method: 'DELETE',
        token: s.token,
        ip:
          s.sessionId === made[1]?.sessionId
            ? LAN
            : s.sessionId === made[2]?.sessionId
              ? TAILNET
              : LOOPBACK,
      })
  })

  test('the per-IP window answers 429 with Retry-After; another address is unaffected', async () => {
    await booted.local.rpc.admin.guests.set({ sessionsPerIpPerWindow: 2 })
    const ip = '192.168.77.50'
    const a = await start(ip)
    const b = await start(ip)
    const third = await call('/guest/session', { ip, body: {} })
    expect(third.status).toBe(429)
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await json<{ error: { code: string } }>(third)).error.code).toBe('GUEST_RATE_LIMITED')
    const other = await start('192.168.77.51')
    for (const [s, at] of [
      [a, ip],
      [b, ip],
      [other, '192.168.77.51'],
    ] as const)
      await call(`/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
        method: 'DELETE',
        token: s.token,
        ip: at,
      })
    await booted.local.rpc.admin.guests.set({ sessionsPerIpPerWindow: 100 })
  })

  test('a bad start body is 400 and a start answers the banner and the limits', async () => {
    expect((await call('/guest/session', { body: { clientKind: 'robot' } })).status).toBe(400)
    const s = await start()
    expect(s.token.startsWith(GUEST_BEARER_PREFIX)).toBe(true)
    expect(s.sessionId.startsWith('guest:')).toBe(true)
    expect(s.notice).toBe(GUEST_BANNER)
    expect(s.limits.maxTurns).toBe(20)
    await call(`/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
      method: 'DELETE',
      token: s.token,
    })
  })
})

describe('isolation of the bearers', () => {
  test('a guest chats over HTTP; the stream names no provider, model or price', async () => {
    const s = await start()
    const res = await chat(s, 'hello there')
    expect(res.status).toBe(200)
    expect(res.headers.get('x-keith-guest-notice')).toContain('not stored')
    const text = await res.text()
    expect(text).toContain(answer)
    for (const secret of ['pricey', 'cheap', 'scripted', 'costUsd', 'pricing'])
      expect(text, secret).not.toContain(secret)
    await call(`/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
      method: 'DELETE',
      token: s.token,
    })
  })

  test('no credential, a wrong one, the owner bearer, another address and another session are 401 or 404', async () => {
    const s = await start()
    const a = await start()
    const path = `/guest/sessions/${encodeURIComponent(s.sessionId)}/chat`
    const body = chatBody(s.sessionId, 'x')
    const code = async (res: Response) => (await json<{ error: { code: string } }>(res)).error.code
    expect((await call(path, { body })).status).toBe(401)
    expect(
      (await call(path, { body, token: `${GUEST_BEARER_PREFIX}${'A'.repeat(43)}` })).status,
    ).toBe(401)
    expect((await call(path, { body, token: 'nonsense' })).status).toBe(401)
    const owner = await call(path, { body, token: ownerToken })
    expect(owner.status).toBe(401)
    expect(await code(owner)).toBe('GUEST_UNAUTHORIZED')
    // right bearer, other address: the bearer is bound to the address that started the session
    expect((await call(path, { body, token: s.token, ip: '127.0.0.2' })).status).toBe(401)
    // a bearer of session A on session B's path
    expect((await call(path, { body, token: a.token })).status).toBe(401)
    expect((await chat(s, 'still fine')).status).toBe(200)
    for (const x of [s, a])
      await call(`/guest/sessions/${encodeURIComponent(x.sessionId)}`, {
        method: 'DELETE',
        token: x.token,
      })
  })

  test('a guest bearer is 401 on every owner route of the main listener', async () => {
    const s = await start()
    const headers = { authorization: `Bearer ${s.token}` }
    const cases: Array<[string, string]> = [
      ['POST', '/rpc/health/get'],
      ['POST', '/rpc/admin/guests/get'],
      ['GET', '/sessions/front:owner'],
      ['POST', '/sessions/front:owner/chat'],
      ['GET', '/activity'],
      ['GET', '/activity/stream'],
      ['GET', '/attention'],
      ['POST', '/attention/x/answer'],
      ['GET', '/nodes/ws'],
      ['POST', '/plugins/notes/list'],
      ['POST', '/auth/step-up'],
    ]
    for (const [method, path] of cases) {
      const res = await fetch(`${booted.url}${path}`, {
        method,
        headers: {
          ...headers,
          ...(method === 'POST' ? { 'content-type': 'application/json' } : {}),
        },
        ...(method === 'POST' ? { body: '{}' } : {}),
      })
      expect(res.status, `${method} ${path}`).toBe(401)
    }
    await call(`/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
      method: 'DELETE',
      token: s.token,
    })
  })

  test('a guest cannot reach the routes it does not need: list, regenerate, edit, files, long text', async () => {
    const s = await start()
    const base = `/guest/sessions/${encodeURIComponent(s.sessionId)}`
    expect((await call('/guest/sessions', { token: s.token })).status).toBe(404)
    const regenerate = await call(`${base}/chat`, {
      token: s.token,
      body: { id: s.sessionId, trigger: 'regenerate-message', messageId: 'x' },
    })
    expect(regenerate.status).toBeGreaterThanOrEqual(400)
    // reading the stored session would show the model id, usage and cost: not offered
    for (const path of [base, `${base}/messages`, `${base}/messages/x`])
      expect((await call(path, { token: s.token })).status, path).toBe(404)
    const file = {
      id: s.sessionId,
      messages: [
        {
          id: 'm1',
          role: 'user',
          parts: [{ type: 'file', url: 'data:text/plain;base64,aGk=', mediaType: 'text/plain' }],
        },
      ],
    }
    expect((await call(`${base}/chat`, { token: s.token, body: file })).status).toBe(400)
    const long = await chat(s, 'x'.repeat(2049))
    expect(long.status).toBe(413)
    await call(base, { method: 'DELETE', token: s.token })
  })

  test('a second message while one runs is 409 (ifBusy reject works without a lock)', async () => {
    const s = await start('192.168.77.60')
    const first = chat(s, 'slow one', '192.168.77.60')
    await new Promise((r) => setTimeout(r, 60))
    const second = await chat(s, 'second', '192.168.77.60')
    expect(second.status).toBe(409)
    expect((await first).status).toBe(200)
    await call(`/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
      method: 'DELETE',
      token: s.token,
      ip: '192.168.77.60',
    })
  })
})

describe('ending', () => {
  test('an ended session is 410 with its reason to the right bearer and 401 to anyone else', async () => {
    const s = await start()
    const id = s.sessionId.slice('guest:'.length)
    expect(await booted.core.guests.end(id, 'idle')).toBe(true)
    const res = await chat(s, 'hello?')
    expect(res.status).toBe(410)
    const err = await json<{ error: { code: string; details: { reason: string } } }>(res)
    expect(err.error).toMatchObject({ code: 'GUEST_SESSION_ENDED', details: { reason: 'idle' } })
    expect(
      (
        await call(`/guest/sessions/${encodeURIComponent(s.sessionId)}/chat`, {
          body: chatBody(s.sessionId, 'x'),
        })
      ).status,
    ).toBe(401)
    expect((await chat(s, 'hi', '127.0.0.2')).status).toBe(401)
  })

  test('the visitor can end the chat; a second end is 410', async () => {
    const s = await start()
    const before = booted.core.guests.size
    const del = (ip = LOOPBACK) =>
      call(`/guest/sessions/${encodeURIComponent(s.sessionId)}`, {
        method: 'DELETE',
        token: s.token,
        ip,
      })
    expect((await del()).status).toBe(200)
    expect(booted.core.guests.size).toBe(before - 1)
    expect((await del()).status).toBe(410)
  })

  test('the kill switch ends the session (410 killed) and refuses new ones; enabling lifts it', async () => {
    const s = await start()
    await booted.local.rpc.admin.guests.killswitch({ on: true })
    const res = await chat(s, 'hi')
    expect(res.status).toBe(410)
    expect((await json<{ error: { details: { reason: string } } }>(res)).error.details.reason).toBe(
      'killed',
    )
    const refused = await call('/guest/session', { body: {} })
    expect(refused.status).toBe(403)
    expect((await json<{ error: { code: string } }>(refused)).error.code).toBe('GUEST_DISABLED')
    expect(GuestPublicStatusSchema.parse(await (await call('/guest/status')).json()).enabled).toBe(
      false,
    )
    await booted.local.rpc.admin.guests.set({ enabled: true })
    await start()
    await booted.core.guests.endAll('closed')
  })

  test('the guest listener plan follows the settings: closed when off, loopback bind when only loopback', async () => {
    const owner = booted.local.rpc
    expect(booted.core.guestHttp.plan()).toEqual({ enabled: true, port: PORT, hostname: '0.0.0.0' })
    await owner.admin.guests.set({ zones: ['loopback'] })
    expect(booted.core.guestHttp.plan().hostname).toBe('127.0.0.1')
    await owner.admin.guests.set({ enabled: false })
    expect(booted.core.guestHttp.plan().enabled).toBe(false)
    await owner.admin.guests.set({ enabled: true, zones: ['loopback', 'lan', 'tailscale'] })
  })
})
