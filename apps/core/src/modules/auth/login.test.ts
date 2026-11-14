import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthPolicySchema } from '@keith/contracts'
import {
  caller,
  cleanup,
  dirs,
  type Harness,
  harness,
  LOOP,
  login,
  member,
  opened,
  PASS,
  post,
} from '../../testing/auth-harness.ts'

afterEach(cleanup)

describe('POST /auth/login', () => {
  test('a right password returns a device credential bound to the person', async () => {
    const h = harness()
    await member(h)
    const res = await login(h, 'ana', PASS('ana'))
    expect(res.status).toBe(200)
    const { credential } = (await res.json()) as { credential: string }
    const principal = await h.resolver.resolve(
      new Request('http://x/', { headers: { authorization: `Bearer ${credential}` } }),
    )
    expect(principal).toMatchObject({
      username: 'ana',
      role: 'member',
      credential: { kind: 'device' },
      elevated: false,
    })
    const ana = await h.people.get('ana')
    expect(h.credentials.list(ana.id)[0]).toMatchObject({ kind: 'device', label: 'password login' })
    const ok = h.events('auth.login.ok')[0]
    expect(ok?.actor).toBe(ana.id)
    expect(JSON.stringify(ok)).not.toContain(PASS('ana'))
    expect(JSON.stringify(ok)).not.toContain(credential)
  })

  test('a label names the device; the username is case-insensitive', async () => {
    const h = harness()
    await member(h)
    const res = await h.routes.login(
      post({ username: ' ANA ', password: PASS('ana'), label: 'laptop' }),
      LOOP,
    )
    expect(res.status).toBe(200)
    const ana = await h.people.get('ana')
    expect(h.credentials.list(ana.id)[0]?.label).toBe('laptop')
  })

  test('unknown user, wrong password, no password, suspended and locked all answer the same', async () => {
    const h = harness()
    await member(h)
    await h.people.add({ username: 'nopass' }, caller)
    await member(h, 'sus')
    await h.people.suspend('sus', caller)
    await member(h, 'lock')
    const lock = await h.people.get('lock')
    h.sqlite
      .query(
        'INSERT INTO auth_attempts (subject, ip, failures, last_failure_at, locked_at) VALUES (?, ?, 0, ?, ?)',
      )
      .run(lock.id, '*', h.clock.t, h.clock.t)

    const answers = [
      await login(h, 'ghost', PASS('x')),
      await login(h, 'ana', PASS('wrong')),
      await login(h, 'nopass', PASS('x')),
      await login(h, 'sus', PASS('sus')),
      await login(h, 'lock', PASS('lock')), // the right password, but locked
    ]
    for (const res of answers) {
      expect(res.status).toBe(401)
      expect(await res.json()).toEqual({ error: 'invalid_credentials' })
    }
    const reasons = h.events('auth.login.failed').map((e) => e.detail.reason)
    expect(reasons.sort()).toEqual(
      ['inactive', 'locked', 'no_password', 'unknown_user', 'wrong_password'].sort(),
    )
    // the unknown user is recorded as a hash, never as the name
    const unknown = h.events('auth.login.failed').find((e) => e.detail.reason === 'unknown_user')
    expect(unknown?.detail.usernameHash).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(unknown)).not.toContain('ghost')
  })

  test('a malformed body is a 400 and an oversized one a 413', async () => {
    const h = harness()
    expect((await h.routes.login(post({ username: 1 }), LOOP)).status).toBe(400)
    expect((await h.routes.login(post({}), LOOP)).status).toBe(400)
    const big = await h.routes.login(post({ username: 'a', password: 'x'.repeat(5000) }), LOOP)
    expect(big.status).toBe(413)
  })

  test('the network rule applies and refusals are audited', async () => {
    const h = harness()
    await member(h)
    const refused = await login(h, 'ana', PASS('ana'), {
      via: 'tcp',
      ip: '203.0.113.5',
      forwarded: false,
    })
    expect(refused.status).toBe(403)
    expect(await refused.json()).toEqual({ error: 'login_not_allowed_here' })
    expect(h.events('auth.login.refused')).toHaveLength(1)
    // a Tailscale peer is fine
    expect(
      (await login(h, 'ana', PASS('ana'), { via: 'tcp', ip: '100.100.1.1', forwarded: false }))
        .status,
    ).toBe(200)
    // loopback with a forwarding header is not, unless tailscale serve is set
    const forwarded = { via: 'tcp' as const, ip: '127.0.0.1', forwarded: true }
    expect((await login(h, 'ana', PASS('ana'), forwarded)).status).toBe(403)
    h.setProxy('tailscale-serve')
    const viaServe = await h.routes.login(
      post(
        { username: 'ana', password: PASS('ana') },
        { 'tailscale-user-login': 'ana@example.com' },
      ),
      forwarded,
    )
    expect(viaServe.status).toBe(200)
    const ok = h.events('auth.login.ok')[0]
    expect(ok?.detail).toMatchObject({ forwarded: true, tailscaleUser: 'ana@example.com' })
    // Funnel never passes
    const funnel = await h.routes.login(
      post({ username: 'ana', password: PASS('ana') }, { 'tailscale-funnel-request': '?1' }),
      forwarded,
    )
    expect(funnel.status).toBe(403)
  })

  test('KEITH_INSECURE_LOGIN lets a public address in', async () => {
    const h = harness({ insecure: true })
    await member(h)
    const res = await login(h, 'ana', PASS('ana'), {
      via: 'tcp',
      ip: '203.0.113.5',
      forwarded: true,
    })
    expect(res.status).toBe(200)
  })
})

describe('role and identifier kind narrow /auth/login like /auth/flow', () => {
  const ownerOnly = () =>
    AuthPolicySchema.parse({
      rules: [{ method: 'password', zones: ['loopback'], roles: ['owner'] }],
    })
  const kindOnly = () =>
    AuthPolicySchema.parse({
      rules: [{ method: 'password', zones: ['loopback'], identifierKinds: ['username'] }],
    })

  test('a member is refused with the uniform 401 on both routes, the owner signs in', async () => {
    const h = harness({ policy: ownerOnly })
    await member(h)
    const viaLogin = await login(h, 'ana', PASS('ana'))
    const ghost = await login(h, 'ghost', PASS('ana'))
    expect(viaLogin.status).toBe(401)
    const loginBody = await viaLogin.text()
    expect(loginBody).toBe(await ghost.text())
    const id = (await (await h.routes.identify(post({ identifier: 'ana' }), LOOP)).json()) as {
      flowId: string
    }
    const viaFlow = await h.routes.flow(
      post({ method: 'password', answer: { password: PASS('ana') } }),
      LOOP,
      id.flowId,
    )
    expect(viaFlow.status).toBe(401)
    expect(await viaFlow.text()).toBe(loginBody)
    // the same refusal reason on both routes (the unknown name is the third row)
    const reasons = h.events('auth.login.failed').map((e) => e.detail.reason)
    expect(reasons.filter((r) => r === 'not_permitted')).toHaveLength(2)
    await h.secrets.setPassword('owner', PASS('owner'), caller)
    expect((await login(h, 'owner', PASS('owner'))).status).toBe(200)
  })

  test('identifier kinds narrow the same way', async () => {
    const h = harness({ policy: kindOnly })
    await member(h)
    const ana = await h.people.get('ana')
    h.identifiers.add({
      personId: ana.id,
      kind: 'email',
      valueNorm: 'ana@example.com',
      createdBy: null,
      at: h.clock.t,
    })
    expect((await login(h, 'ana', PASS('ana'))).status).toBe(200)
    expect((await login(h, 'ana@example.com', PASS('ana'))).status).toBe(401)
  })
})

describe('throttling', () => {
  const fail = (h: Harness, user = 'ana', ip = '127.0.0.1') =>
    login(h, user, PASS('wrong'), { via: 'tcp', ip, forwarded: false })

  test('four free failures, then 1 s doubling to a 5 minute cap, with Retry-After', async () => {
    const h = harness()
    await member(h)
    for (let i = 0; i < 4; i++) expect((await fail(h)).status).toBe(401)
    expect((await fail(h)).status).toBe(401) // the 5th failure itself still answers 401
    // now it waits 1 s
    const blocked = await fail(h)
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('1')
    expect(await blocked.json()).toEqual({ error: 'throttled', retryAfter: 1 })
    // the right password is also held back while the delay runs
    expect((await login(h, 'ana', PASS('ana'))).status).toBe(429)
    h.clock.t += 1000
    expect((await fail(h)).status).toBe(401) // 6th: next delay 2 s
    h.clock.t += 1999
    expect((await fail(h)).status).toBe(429)
    h.clock.t += 1
    expect((await fail(h)).status).toBe(401) // 7th: 4 s
    const wait = await fail(h)
    expect(wait.headers.get('retry-after')).toBe('4')
    // the delay is capped at five minutes
    for (let i = 0; i < 12; i++) {
      h.clock.t += 400_000
      await fail(h)
    }
    h.clock.t += 1000
    const capped = await fail(h)
    expect(capped.status).toBe(429)
    expect(Number(capped.headers.get('retry-after'))).toBeLessThanOrEqual(300)
  })

  test('an unknown username is throttled the same way', async () => {
    const h = harness()
    for (let i = 0; i < 5; i++) await fail(h, 'ghost')
    const blocked = await fail(h, 'ghost')
    expect(blocked.status).toBe(429)
    expect(blocked.headers.get('retry-after')).toBe('1')
  })

  test('another address has its own counter; a success resets', async () => {
    const h = harness()
    await member(h)
    for (let i = 0; i < 5; i++) await fail(h)
    expect((await fail(h)).status).toBe(429)
    // a different address is not delayed
    expect((await fail(h, 'ana', '100.64.0.9')).status).toBe(401)
    h.clock.t += 1000
    const ok = await login(h, 'ana', PASS('ana'))
    expect(ok.status).toBe(200)
    // everything was reset: failures start from zero again
    for (let i = 0; i < 5; i++) expect((await fail(h)).status).toBe(401)
  })

  test('counters survive closing and reopening the database', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'keith-throttle-'))
    dirs.push(dir)
    const file = join(dir, 'k.db')
    const first = harness({ file })
    await member(first)
    for (let i = 0; i < 5; i++) await fail(first)
    expect((await fail(first)).status).toBe(429)
    const t = first.clock.t
    first.sqlite.close()
    opened.splice(opened.indexOf(first.sqlite), 1)
    const second = harness({ file })
    second.clock.t = t // same moment: the delay is still running
    expect((await fail(second)).status).toBe(429)
    second.clock.t = t + 1000
    expect((await fail(second)).status).toBe(401)
  })

  test('the owner is never locked, only delayed', async () => {
    const h = harness()
    await h.secrets.setPassword('owner', PASS('owner'), caller)
    for (let i = 0; i < 30; i++) {
      h.clock.t += 400_000
      expect((await fail(h, 'owner', `127.0.0.${i + 1}`)).status).toBe(401)
    }
    expect((await login(h, 'owner', PASS('owner'))).status).toBe(200)
  })

  test('a member locks after 20 failures (any address) until unlock', async () => {
    const h = harness()
    await member(h)
    for (let i = 0; i < 20; i++) {
      h.clock.t += 400_000
      await fail(h, 'ana', `127.0.0.${(i % 200) + 1}`)
    }
    h.clock.t += 400_000
    const locked = await login(h, 'ana', PASS('ana'))
    expect(locked.status).toBe(401) // uniform: not 423, not a different body
    expect(await locked.json()).toEqual({ error: 'invalid_credentials' })
    expect(h.events('auth.login.failed').some((e) => e.detail.lockedNow === true)).toBe(true)
    expect(await h.secrets.unlock('ana', caller)).toBe(true)
    expect(h.events('person.secret.unlock')).toHaveLength(1)
    expect((await login(h, 'ana', PASS('ana'))).status).toBe(200)
    expect(await h.secrets.unlock('ana', caller)).toBe(false)
  })
})
