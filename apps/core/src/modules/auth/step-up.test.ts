import { afterEach, describe, expect, test } from 'bun:test'
import {
  caller,
  cleanup,
  type Harness,
  harness,
  LOOP,
  login,
  member,
  PASS,
  PIN,
  post,
} from '../../testing/auth-harness.ts'
import { createCredential } from './credentials.ts'
import { type Peer, STEP_UP_MS } from './login.ts'

afterEach(cleanup)

describe('step-up', () => {
  async function session(h: Harness, name = 'ana') {
    await member(h, name)
    const res = await login(h, name, PASS(name))
    const { credential } = (await res.json()) as { credential: string }
    const req = () =>
      new Request('http://x/', { headers: { authorization: `Bearer ${credential}` } })
    return { credential, principal: () => h.resolver.resolve(req()) }
  }
  const step = async (
    h: Harness,
    principal: Awaited<ReturnType<Awaited<ReturnType<typeof session>>['principal']>>,
    body: unknown,
    peer: Peer = LOOP,
  ) => h.routes.stepUp(post(body), peer, principal)

  test('a PIN or the password elevates the session for ten minutes', async () => {
    const h = harness()
    const s = await session(h)
    await h.secrets.setPin('ana', PIN, caller)
    expect((await s.principal())?.elevated).toBe(false)
    const res = await step(h, await s.principal(), { pin: PIN })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ elevatedUntil: h.clock.t + STEP_UP_MS })
    expect((await s.principal())?.elevated).toBe(true)
    // the password works as well, on a fresh session
    const t = await session(h, 'bob')
    expect((await step(h, await t.principal(), { password: PASS('bob') })).status).toBe(200)
    expect((await t.principal())?.elevated).toBe(true)
    expect(h.events('auth.step_up.ok')).toHaveLength(2)
  })

  test('the window is fixed: use does not extend it, a new step-up restarts it', async () => {
    const h = harness()
    const s = await session(h)
    await h.secrets.setPin('ana', PIN, caller)
    await step(h, await s.principal(), { pin: PIN })
    h.clock.t += STEP_UP_MS - 1
    expect((await s.principal())?.elevated).toBe(true) // using it did not move the end
    h.clock.t += 1
    expect((await s.principal())?.elevated).toBe(false)
    // a step-up in the middle of a window restarts it at ten minutes
    await step(h, await s.principal(), { pin: PIN })
    h.clock.t += 6 * 60_000
    const again = await step(h, await s.principal(), { pin: PIN })
    expect(await again.json()).toEqual({ elevatedUntil: h.clock.t + STEP_UP_MS })
    h.clock.t += 9 * 60_000
    expect((await s.principal())?.elevated).toBe(true)
    h.clock.t += 60_000
    expect((await s.principal())?.elevated).toBe(false)
  })

  test('a wrong PIN is a uniform 401, throttled like a login; a method that is not set is wrong too', async () => {
    const h = harness()
    const s = await session(h)
    await h.secrets.setPin('ana', PIN, caller)
    for (let i = 0; i < 5; i++) {
      const res = await step(h, await s.principal(), { pin: '000000' })
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'invalid_credentials' })
    }
    const blocked = await step(h, await s.principal(), { pin: PIN })
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('1')
    expect((await s.principal())?.elevated).toBe(false)
    h.clock.t += 1000
    expect((await step(h, await s.principal(), { pin: PIN })).status).toBe(200)
    // a password given when only a PIN is set does not pass
    const t = await session(h, 'cy')
    await h.secrets.setPin('cy', PIN, caller)
    await h.secrets.clear('cy', 'password', caller)
    const fresh = await createCredential(h.credentials, {
      personId: (await h.people.get('cy')).id,
      kind: 'token',
      label: 't',
    })
    const principal = await h.resolver.resolve(
      new Request('http://x/', { headers: { authorization: `Bearer ${fresh.token}` } }),
    )
    expect((await step(h, principal, { password: PASS('cy') })).status).toBe(401)
    void t
  })

  test('a person with neither PIN nor password cannot step up and is told how to fix it', async () => {
    const h = harness()
    const s = await session(h)
    await h.secrets.clear('ana', 'password', caller)
    // clearing the password revoked the session: sign in is impossible, so build one by hand
    const ana = await h.people.get('ana')
    const { token } = await createCredential(h.credentials, {
      personId: ana.id,
      kind: 'token',
      label: 't',
    })
    const principal = await h.resolver.resolve(
      new Request('http://x/', { headers: { authorization: `Bearer ${token}` } }),
    )
    const res = await step(h, principal, { pin: PIN })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error: 'no_step_up_method',
      hint: 'keith-core people pin ana',
    })
    void s
  })

  test('the local socket is always elevated; no bearer is a 401; the network rule applies', async () => {
    const h = harness()
    const local = await h.routes.stepUp(
      post({ pin: PIN }),
      { via: 'local', ip: 'local', forwarded: false },
      await h.resolver.resolve(new Request('http://x/'), 'local'),
    )
    expect(local.status).toBe(200)
    expect((await h.resolver.resolve(new Request('http://x/'), 'local'))?.elevated).toBe(true)
    expect((await step(h, undefined, { pin: PIN })).status).toBe(401)
    const s = await session(h)
    const refused = await step(
      h,
      await s.principal(),
      { pin: PIN },
      { via: 'tcp', ip: '203.0.113.5', forwarded: false },
    )
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'login_not_allowed_here' })
  })

  test('the zone rule follows the method: a LAN phone steps up with its PIN, never with the password', async () => {
    const h = harness()
    h.setLan({ contains: (ip) => ip?.startsWith('192.168.1.') === true })
    const s = await session(h)
    await h.secrets.setPin('ana', PIN, caller)
    const lan: Peer = { via: 'tcp', ip: '192.168.1.20', forwarded: false }
    const pin = await step(h, await s.principal(), { pin: PIN }, lan)
    expect(pin.status).toBe(200)
    const password = await step(h, await s.principal(), { password: PASS('ana') }, lan)
    expect(password.status).toBe(403)
    expect(await password.json()).toEqual({ error: 'login_not_allowed_here' })
    const pub: Peer = { via: 'tcp', ip: '203.0.113.5', forwarded: false }
    expect((await step(h, await s.principal(), { pin: PIN }, pub)).status).toBe(403)
    expect(h.events('auth.step_up.refused')).toHaveLength(2)
  })

  test('a body with both fields or neither is a 400', async () => {
    const h = harness()
    const s = await session(h)
    expect((await step(h, await s.principal(), { pin: PIN, password: 'x' })).status).toBe(400)
    expect((await step(h, await s.principal(), {})).status).toBe(400)
  })
})
