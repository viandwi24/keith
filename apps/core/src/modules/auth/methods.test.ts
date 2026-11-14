import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { AuthMethodsSchema } from '@keith/contracts'
import { caller, cleanup, harness, member } from '../../testing/auth-harness.ts'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import type { Peer } from './login.ts'

afterEach(cleanup)
const booted: BootedCore[] = []
afterAll(async () => {
  for (const b of booted) await b.stop().catch(() => undefined)
})

const get = (headers: Record<string, string> = {}) =>
  new Request('http://localhost/auth/methods', { headers })
const peer = (ip: string, forwarded = false): Peer => ({ via: 'tcp', ip, forwarded })
const passwordOf = async (res: Response) => {
  const body = AuthMethodsSchema.parse(await res.json())
  return body.methods.find((m) => m.id === 'password')
}

describe('GET /auth/methods', () => {
  test('a loopback caller may use all three methods', async () => {
    const h = harness()
    const res = h.routes.methods(get(), peer('127.0.0.1'))
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    const body = AuthMethodsSchema.parse(await res.json())
    expect(body.methods).toEqual([
      { id: 'device', available: true },
      { id: 'password', available: true },
      { id: 'token', available: true },
    ])
  })

  test('the local socket and a Tailscale peer may use the password', async () => {
    const h = harness()
    const local = h.routes.methods(get(), { via: 'local', ip: 'unknown', forwarded: false })
    expect((await passwordOf(local))?.available).toBe(true)
    expect((await passwordOf(h.routes.methods(get(), peer('100.101.102.103'))))?.available).toBe(
      true,
    )
  })

  test('a public peer cannot use the password, with a generic reason', async () => {
    const h = harness()
    const res = h.routes.methods(get(), peer('203.0.113.9'))
    const body = AuthMethodsSchema.parse(await res.json())
    expect(body.methods.map((m) => [m.id, m.available])).toEqual([
      ['device', true],
      ['password', false],
      ['token', true],
    ])
    const reason = body.methods[1]?.reason ?? ''
    expect(reason).toContain('device code')
    expect(reason).not.toContain('203.0.113.9')
    expect(reason).not.toContain('KEITH_')
  })

  test('proxy headers make a local proxy look remote', async () => {
    const h = harness()
    const forwarded = get({ 'x-forwarded-for': '203.0.113.9' })
    expect(
      (await passwordOf(h.routes.methods(forwarded, peer('127.0.0.1', true))))?.available,
    ).toBe(false)
    const funnel = get({ 'tailscale-funnel-request': '?1' })
    expect((await passwordOf(h.routes.methods(funnel, peer('127.0.0.1'))))?.available).toBe(false)
    // tailscale serve, when the setting says so
    h.setProxy('tailscale-serve')
    expect(
      (await passwordOf(h.routes.methods(forwarded, peer('127.0.0.1', true))))?.available,
    ).toBe(true)
  })

  test('KEITH_INSECURE_LOGIN lifts the rule', async () => {
    const h = harness({ insecure: true })
    expect((await passwordOf(h.routes.methods(get(), peer('203.0.113.9'))))?.available).toBe(true)
  })

  test('nothing about accounts, no audit row', async () => {
    const h = harness()
    await member(h, 'ana')
    await h.people.add({ username: 'nopass' }, caller)
    const before = h.events().length
    const text = await h.routes.methods(get(), peer('127.0.0.1')).text()
    const other = await harness().routes.methods(get(), peer('127.0.0.1')).text()
    expect(text).toBe(other)
    expect(text).not.toContain('ana')
    expect(text).not.toContain('nopass')
    expect(text.length).toBeLessThan(300)
    h.routes.methods(get(), peer('203.0.113.9'))
    expect(h.events().length).toBe(before)
  })
})

describe('GET /auth/methods on a running core', () => {
  test('open without a credential, and the Host guard still applies', async () => {
    const b = await bootCore()
    booted.push(b)
    const res = await fetch(`${b.url}/auth/methods`)
    expect(res.status).toBe(200)
    expect((await passwordOf(res))?.available).toBe(true)
    expect(
      (await fetch(`${b.url}/auth/methods`, { headers: { host: 'evil.example' } })).status,
    ).toBe(421)
    const proxied = await fetch(`${b.url}/auth/methods`, {
      headers: { 'x-forwarded-for': '203.0.113.9' },
    })
    expect((await passwordOf(proxied))?.available).toBe(false)
  })
})
