import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type BootedCore, bootCore, FAST_HASH } from '../../testing/boot-core.ts'

/** Browser sessions over a real listener: the `keith_s` cookie, CSRF, adopt, logout (docs/specs/auth.md). */
let b: BootedCore
let origin: string
const PASS = `harbor ${Bun.hash('web')} lanterns hum softly`
const PIN = '482915'

beforeAll(async () => {
  b = await bootCore({}, { hasher: FAST_HASH })
  origin = b.url
  await b.local.rpc.admin.people.add({ username: 'ana' })
  await b.local.rpc.admin.people.setPassword({ person: 'ana', password: PASS })
  await b.local.rpc.admin.people.setPin({ person: 'ana', pin: PIN })
  await b.local.rpc.admin.people.setPin({ person: 'owner', pin: PIN })
})
afterAll(async () => {
  await b.stop()
})

const POST = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${b.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
const cookieOf = (res: Response): string => {
  const header = res.headers.get('set-cookie') ?? ''
  return header.split(';')[0] ?? ''
}
const same = (): Record<string, string> => ({ origin })
// biome-ignore lint/suspicious/noExplicitAny: untyped JSON answers
const whoami = async (headers: Record<string, string>): Promise<{ status: number; body: any }> => {
  const res = await POST('/rpc/auth/whoami', { json: null }, headers)
  return {
    status: res.status,
    body: res.status === 200 ? ((await res.json()) as { json: unknown }).json : undefined,
  }
}
async function signIn(deliver: 'cookie' | 'body' | undefined, remember?: boolean) {
  const id = (await (await POST('/auth/identify', { identifier: 'ana' })).json()) as {
    flowId: string
  }
  return POST(`/auth/flow/${id.flowId}`, {
    method: 'password',
    answer: { password: PASS },
    ...(deliver === undefined ? {} : { deliver }),
    ...(remember === undefined ? {} : { remember }),
  })
}

/** A device session of the owner (no per-identifier limit, unlike the identifier flow). */
async function device(deliver?: 'cookie', headers: Record<string, string> = {}): Promise<Response> {
  const start = (await (await POST('/auth/device/start', { label: 'browser' })).json()) as {
    code: string
    requestId: string
    pollSecret: string
  }
  await b.local.rpc.admin.devices.approve({ code: start.code })
  return POST(
    '/auth/device/poll',
    {
      requestId: start.requestId,
      pollSecret: start.pollSecret,
      ...(deliver === undefined ? {} : { deliver }),
    },
    headers,
  )
}
const deviceCookie = async (): Promise<string> => cookieOf(await device('cookie'))
const deviceCredential = async (): Promise<string> =>
  ((await (await device()).json()) as { credential: string }).credential

describe('cookie sign-in', () => {
  test('deliver cookie sets an HttpOnly SameSite=Strict cookie and keeps the credential out of the body', async () => {
    const res = await signIn('cookie')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cookie: true })
    const header = res.headers.get('set-cookie') ?? ''
    expect(header).toStartWith('keith_s=keith_s_')
    expect(header).toContain('HttpOnly')
    expect(header).toContain('SameSite=Strict')
    expect(header).toContain('Path=/')
    expect(header).not.toContain('Max-Age')
    expect(header).not.toContain('Secure')
    expect((await whoami({ cookie: cookieOf(res), ...same() })).body.username).toBe('ana')
  })

  test('remember makes a persistent cookie; HTTPS behind a proxy adds Secure', async () => {
    const res = await signIn('cookie', true)
    const header = res.headers.get('set-cookie') ?? ''
    const age = Number(/Max-Age=(\d+)/.exec(header)?.[1])
    expect(age).toBeGreaterThan(170 * 86_400)
    expect(age).toBeLessThanOrEqual(180 * 86_400)
    const secure = await device('cookie', { 'x-forwarded-proto': 'https' })
    expect(secure.headers.get('set-cookie')).toContain('Secure')
  })

  test("deliver body or absent keeps today's answer and sets no cookie", async () => {
    for (const deliver of [undefined, 'body' as const]) {
      const res = await signIn(deliver)
      const body = (await res.json()) as { credential?: string }
      expect(body.credential).toStartWith('keith_s_')
      expect(res.headers.get('set-cookie')).toBeNull()
    }
  })

  test('a bearer always wins over the cookie', async () => {
    const cookie = cookieOf(await signIn('cookie'))
    const bad = await whoami({ cookie, authorization: 'Bearer keith_s_000000000000_nope' })
    expect(bad.status).toBe(401)
    const body = (await (await signIn(undefined)).json()) as { credential: string }
    const ok = await whoami({
      cookie: 'keith_s=garbage',
      authorization: `Bearer ${body.credential}`,
    })
    expect(ok.status).toBe(200)
  })
})

describe('CSRF', () => {
  test('a cookie write needs a same-origin Origin or Sec-Fetch-Site', async () => {
    const cookie = await deviceCookie()
    expect((await whoami({ cookie })).status).toBe(403)
    expect((await whoami({ cookie, origin: 'http://evil.example' })).status).toBe(403)
    expect((await whoami({ cookie, 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await whoami({ cookie, ...same() })).status).toBe(200)
    expect((await whoami({ cookie, 'sec-fetch-site': 'same-origin' })).status).toBe(200)
    // a read is not a write
    const read = await fetch(`${b.url}/health`, { headers: { cookie } })
    expect(read.status).toBe(200)
  })

  test('a bearer write needs no Origin', async () => {
    expect((await whoami({ authorization: `Bearer ${await deviceCredential()}` })).status).toBe(200)
  })

  test('the rejected cookie is cleared; a wrong step-up answer is not', async () => {
    const dead = await whoami({ cookie: 'keith_s=keith_s_000000000000_nope', ...same() })
    expect(dead.status).toBe(401)
    const res = await POST('/rpc/auth/whoami', { json: null }, { cookie: 'keith_s=bad', ...same() })
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0')
    const cookie = await deviceCookie()
    const wrong = await POST(
      '/auth/step-up',
      { password: 'not the password at all' },
      { cookie, ...same() },
    )
    expect(wrong.status).toBe(401)
    expect(wrong.headers.get('set-cookie')).toBeNull()
  })
})

describe('step-up, device, adopt, logout', () => {
  test('whoami reports elevatedUntil; step-up with rotate and deliver cookie replaces the cookie', async () => {
    const cookie = await deviceCookie()
    const before = await whoami({ cookie, ...same() })
    expect(before.body.elevated).toBe(false)
    expect(before.body.elevatedUntil).toBeNull()
    const up = await POST(
      '/auth/step-up',
      { pin: PIN, rotate: true, deliver: 'cookie' },
      { cookie, ...same() },
    )
    expect(up.status).toBe(200)
    const answer = (await up.json()) as {
      elevatedUntil: number
      cookie?: boolean
      credential?: string
    }
    expect(answer.cookie).toBe(true)
    expect(answer.credential).toBeUndefined()
    const next = cookieOf(up)
    expect(next).toStartWith('keith_s=keith_s_')
    expect(next).not.toBe(cookie)
    const after = await whoami({ cookie: next, ...same() })
    expect(after.body.elevated).toBe(true)
    expect(after.body.elevatedUntil).toBe(answer.elevatedUntil)
  })

  test('the socket reports no elevatedUntil', async () => {
    const me = await b.local.rpc.auth.whoami()
    expect(me.elevatedUntil ?? null).toBeNull()
  })

  test('device poll with deliver cookie sets the cookie and no credential', async () => {
    const res = await device('cookie')
    expect(await res.json()).toEqual({ status: 'approved', cookie: true })
    expect(res.headers.get('set-cookie') ?? '').toContain('HttpOnly')
    expect((await whoami({ cookie: cookieOf(res), ...same() })).status).toBe(200)
  })

  test('adopt turns a credential into the cookie; an unknown one is refused', async () => {
    const res = await POST('/auth/web/adopt', {
      credential: await deviceCredential(),
      remember: true,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ cookie: true })
    expect(res.headers.get('set-cookie')).toContain('Max-Age=')
    expect((await whoami({ cookie: cookieOf(res), ...same() })).status).toBe(200)
    const refused = await POST('/auth/web/adopt', { credential: 'keith_s_000000000000_nope' })
    expect(refused.status).toBe(401)
    expect(refused.headers.get('set-cookie')).toBeNull()
    expect((await POST('/auth/web/adopt', { nope: 1 })).status).toBe(400)
  })

  test('logout revokes the session and clears the cookie', async () => {
    const cookie = await deviceCookie()
    expect((await POST('/auth/web/logout', {}, { cookie })).status).toBe(403)
    const out = await POST('/auth/web/logout', {}, { cookie, ...same() })
    expect(out.status).toBe(200)
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0')
    expect((await whoami({ cookie, ...same() })).status).toBe(401)
  })
})

describe('view socket', () => {
  const open = (headers: Record<string, string>): Promise<'open' | 'refused'> =>
    new Promise((resolve) => {
      const ws = new WebSocket(`${b.url.replace('http', 'ws')}/plugins/views/ws`, { headers })
      ws.onopen = () => {
        ws.close()
        resolve('open')
      }
      ws.onerror = () => resolve('refused')
    })

  test('the cookie authenticates an upgrade only from the same origin', async () => {
    const cookie = await deviceCookie()
    expect(await open({ cookie })).toBe('refused')
    expect(await open({ cookie, origin: 'http://localhost:1' })).toBe('refused')
    expect(await open({ cookie, ...same() })).toBe('open')
    expect(await open({ cookie: 'keith_s=garbage', ...same() })).toBe('refused')
  })

  test('a bearer needs no Origin', async () => {
    expect(await open({ authorization: `Bearer ${await deviceCredential()}` })).toBe('open')
  })
})
