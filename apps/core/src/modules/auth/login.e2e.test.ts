import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type BootedCore, bootCore, FAST_HASH } from '../../testing/boot-core.ts'

/** The password routes over a real listener: the peer is loopback, so headers and the setting decide. */
let booted: BootedCore
let insecure: BootedCore
const PASS = `harbor ${Bun.hash('e2e')} windmills turn slowly`

beforeAll(async () => {
  booted = await bootCore({}, { hasher: FAST_HASH })
  insecure = await bootCore({ KEITH_INSECURE_LOGIN: 'true' }, { hasher: FAST_HASH })
  for (const b of [booted, insecure]) {
    await b.local.rpc.admin.people.add({ username: 'ana' })
    await b.local.rpc.admin.people.setPassword({ person: 'ana', password: PASS })
  }
})
afterAll(async () => {
  await booted.stop()
  await insecure.stop()
})

const login = (b: BootedCore, headers: Record<string, string> = {}, password = PASS) =>
  fetch(`${b.url}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ username: 'ana', password }),
  })
/** A request that arrives from a given TCP peer (a stand-in server answers `requestIP`). */
const from = (b: BootedCore, address: string, headers: Record<string, string> = {}) =>
  b.core.fetch(
    new Request(`http://localhost:${b.port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ username: 'ana', password: PASS }),
    }),
    {
      port: b.port,
      requestIP: () => ({ address, family: 'IPv4', port: 1 }),
      timeout: () => {},
    } as never,
  )

describe('network rule over HTTP', () => {
  test('loopback without forwarding headers logs in, and every failure is the same 401', async () => {
    const ok = await login(booted)
    expect(ok.status).toBe(200)
    const wrong = await login(booted, {}, 'definitely not the right words')
    expect(wrong.status).toBe(401)
    expect(await wrong.json()).toEqual({ error: 'invalid_credentials' })
    const unknown = await fetch(`${booted.url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'nobody', password: PASS }),
    })
    expect(unknown.status).toBe(401)
    expect(await unknown.json()).toEqual({ error: 'invalid_credentials' })
  })

  test('loopback with X-Forwarded-For is refused until tailscale serve is configured', async () => {
    const refused = await login(booted, { 'x-forwarded-for': '203.0.113.9' })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'login_not_allowed_here' })
    await booted.local.rpc.admin.access.set({ mode: 'local', proxy: 'tailscale-serve' })
    const viaServe = await login(booted, {
      'x-forwarded-for': '100.101.1.1',
      'tailscale-user-login': 'ana@example.com',
    })
    expect(viaServe.status).toBe(200)
    const events = await booted.local.rpc.admin.audit.list({ limit: 50 })
    expect(events.find((e) => e.kind === 'auth.login.ok')?.detail).toMatchObject({
      forwarded: true,
      tailscaleUser: 'ana@example.com',
    })
    // Funnel stays out even with the setting
    const funnel = await login(booted, {
      'tailscale-funnel-request': '?1',
      'x-forwarded-for': '203.0.113.9',
    })
    expect(funnel.status).toBe(403)
    await booted.local.rpc.admin.access.set({ mode: 'local', proxy: 'none' })
  })

  test('a Tailscale peer is allowed, a LAN peer is not', async () => {
    expect((await from(booted, '100.64.1.2'))?.status).toBe(200)
    expect((await from(booted, 'fd7a:115c:a1e0::9'))?.status).toBe(200)
    expect((await from(booted, '192.168.1.40'))?.status).toBe(403)
    expect((await from(booted, '203.0.113.7'))?.status).toBe(403)
  })

  test('the step-up route follows the same rule', async () => {
    const res = await booted.core.fetch(
      new Request(`http://localhost:${booted.port}/auth/step-up`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer keith_nope' },
        body: JSON.stringify({ pin: '123456' }),
      }),
      {
        port: booted.port,
        requestIP: () => ({ address: '203.0.113.7', family: 'IPv4', port: 1 }),
        timeout: () => {},
      } as never,
    )
    // a bearer that fails to resolve is 401 from the middleware only after the rule: 403 first
    expect(res?.status).toBe(403)
  })

  test('KEITH_INSECURE_LOGIN lets Funnel and public peers in', async () => {
    expect((await login(insecure, { 'tailscale-funnel-request': '?1' })).status).toBe(200)
    expect((await from(insecure, '203.0.113.7', { 'x-forwarded-for': '1.2.3.4' }))?.status).toBe(
      200,
    )
  })

  test('a body over 4 KB is refused', async () => {
    const big = await fetch(`${booted.url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ana', password: 'x'.repeat(5000) }),
    })
    expect(big.status).toBe(413)
  })

  test('behind tailscale serve every caller shares the loopback peer, so one caller delays the others (REQ-246)', async () => {
    await booted.local.rpc.admin.access.set({ mode: 'local', proxy: 'tailscale-serve' })
    try {
      // the throttle key is (account, peer address): both callers reach core from 127.0.0.1
      const noisy = {
        'x-forwarded-for': '100.101.1.1',
        'tailscale-user-login': 'noisy@example.com',
      }
      const statuses: number[] = []
      for (let i = 0; i < 10 && !statuses.includes(429); i++) {
        statuses.push((await login(booted, noisy, 'definitely not the right words')).status)
      }
      expect(statuses).toContain(429)
      const other = {
        'x-forwarded-for': '100.101.2.2',
        'tailscale-user-login': 'other@example.com',
      }
      const delayed = await login(booted, other)
      expect(delayed.status).toBe(429)
      expect(await delayed.json()).toMatchObject({ error: 'throttled' })
    } finally {
      await booted.local.rpc.admin.access.set({ mode: 'local', proxy: 'none' })
    }
  })
})
