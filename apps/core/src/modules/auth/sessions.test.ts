import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { AuthPolicySchema } from '@keith/contracts'
import { cleanup, harness, LOOP, member, PASS, PIN, post } from '../../testing/auth-harness.ts'
import { createCredential, parseCredential } from './credentials.ts'
import { PASSWORD_ABSOLUTE_MS, PASSWORD_IDLE_MS } from './policy.ts'

afterEach(cleanup)

const DAY = 86_400_000
const bearer = (token: string) =>
  new Request('http://localhost/rpc', { headers: { authorization: `Bearer ${token}` } })
const who = (h: ReturnType<typeof harness>, token: string) => h.resolver.resolve(bearer(token))

async function signedIn(h: ReturnType<typeof harness>, username = 'ana') {
  const res = await h.routes.login(post({ username, password: PASS(username) }), LOOP)
  expect(res.status).toBe(200)
  return ((await res.json()) as { credential: string }).credential
}

/** A kept device (`remember: true`) through the flow: the rule's lifetimes, not the transient cap. */
async function signedInRemembered(
  h: ReturnType<typeof harness>,
  username = 'ana',
  remember = true,
) {
  const id = (await (await h.routes.identify(post({ identifier: username }), LOOP)).json()) as {
    flowId: string
  }
  const res = await h.routes.flow(
    post({ method: 'password', answer: { password: PASS(username) }, remember }),
    LOOP,
    id.flowId,
  )
  expect(res.status).toBe(200)
  return ((await res.json()) as { credential: string }).credential
}

describe('session lifetimes (fake clock)', () => {
  test('a password session ends when idle for 30 days, and use slides the window', async () => {
    const h = harness()
    await member(h, 'ana')
    const token = await signedInRemembered(h)
    expect((await who(h, token))?.credential?.assurance).toBe(2)
    h.clock.t += 20 * DAY
    expect(await who(h, token)).toBeDefined() // touched: the window restarts
    h.clock.t += 25 * DAY // 45 days after sign-in, 25 after the last use
    expect(await who(h, token)).toBeDefined()
    h.clock.t += PASSWORD_IDLE_MS + 1
    expect(await who(h, token)).toBeUndefined()
  })

  test('a sign-in that is not remembered is capped at 12 h idle and 7 days whatever the rule says', async () => {
    const h = harness()
    await member(h, 'ana')
    const plain = await signedIn(h)
    const row = h.credentials.list((await h.people.get('ana')).id)[0]
    expect((row?.idleExpiresAt ?? 0) - h.clock.t).toBe(12 * 3_600_000)
    expect((row?.absoluteExpiresAt ?? 0) - h.clock.t).toBe(7 * DAY)
    h.clock.t += 13 * 3_600_000
    expect(await who(h, plain)).toBeUndefined()
    const kept = await signedInRemembered(h)
    const kept2 = h.credentials.list((await h.people.get('ana')).id).find((c) => c.id !== row?.id)
    expect((kept2?.idleExpiresAt ?? 0) - h.clock.t).toBe(30 * DAY)
    expect(await who(h, kept)).toBeDefined()
  })

  test('two password rules for one zone: each role gets the lifetime of the rule that admits it, in either order', async () => {
    const rules = (order: 'owner-first' | 'member-first') => {
      const owner = {
        method: 'password',
        zones: ['loopback'],
        roles: ['owner'],
        idleMs: 3_600_000,
        absoluteMs: 1 * DAY,
      }
      const mem = {
        method: 'password',
        zones: ['loopback'],
        roles: ['member'],
        idleMs: 2 * 3_600_000,
        absoluteMs: 3 * DAY,
      }
      return AuthPolicySchema.parse({
        rules: order === 'owner-first' ? [owner, mem] : [mem, owner],
      })
    }
    for (const order of ['owner-first', 'member-first'] as const) {
      const h = harness({ policy: () => rules(order) })
      await member(h, 'ana')
      await signedInRemembered(h, 'ana', false)
      const row = h.credentials.list((await h.people.get('ana')).id)[0]
      expect((row?.idleExpiresAt ?? 0) - h.clock.t).toBe(2 * 3_600_000)
      expect((row?.absoluteExpiresAt ?? 0) - h.clock.t).toBe(3 * DAY)
    }
  })

  test('the absolute end holds however busy the session is', async () => {
    const h = harness()
    await member(h, 'ana')
    const token = await signedInRemembered(h)
    for (let day = 0; day < PASSWORD_ABSOLUTE_MS; day += 10 * DAY) {
      h.clock.t += 10 * DAY
      if (h.clock.t - 1_800_000_000_000 >= PASSWORD_ABSOLUTE_MS) break
      expect(await who(h, token)).toBeDefined()
    }
    h.clock.t = 1_800_000_000_000 + PASSWORD_ABSOLUTE_MS + 1
    expect(await who(h, token)).toBeUndefined()
  })

  test('credentials without limits (device code, token, older rows) never end by time', async () => {
    const h = harness()
    await member(h, 'ana')
    const device = await createCredential(h.credentials, {
      personId: 'owner',
      kind: 'device',
      label: 'approved',
    })
    const old = await createCredential(h.credentials, {
      personId: 'owner',
      kind: 'token',
      label: 't',
    })
    h.sqlite.query('UPDATE credentials SET methods = NULL WHERE id = ?').run(old.id)
    h.clock.t += 5 * 365 * DAY
    expect(await who(h, device.token)).toBeDefined()
    const read = await who(h, old.token)
    expect(read?.credential?.methods).toEqual(['legacy'])
    expect(h.credentials.find(device.id)?.idleExpiresAt).toBeNull()
  })

  test('only the hash is stored, and the user agent is kept for the list', async () => {
    const h = harness()
    await member(h, 'ana')
    const res = await h.routes.login(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'keith-test/1.0' },
        body: JSON.stringify({ username: 'ana', password: PASS('ana') }),
      }),
      LOOP,
    )
    const token = ((await res.json()) as { credential: string }).credential
    const { id, secret } = parseCredential(token) as { id: string; secret: string }
    const row = h.credentials.find(id)
    expect(row?.secretHash).toBe(createHash('sha256').update(secret).digest('hex'))
    expect(JSON.stringify(row)).not.toContain(secret)
    expect(row?.userAgent).toBe('keith-test/1.0')
    expect(row?.methods).toEqual(['password'])
  })
})

describe('rotation on step-up', () => {
  async function viaRoute(h: ReturnType<typeof harness>, token: string, body: object) {
    const request = post(body, { authorization: `Bearer ${token}` })
    const principal = await h.resolver.resolve(request)
    return h.routes.stepUp(request, LOOP, principal)
  }
  test('without the flag nothing changes: no new credential, same row elevated', async () => {
    const h = harness()
    await member(h, 'ana')
    await h.secrets.setPin('ana', PIN, { actor: 'owner', via: 'local' })
    const token = await signedIn(h)
    const res = await viaRoute(h, token, { pin: PIN })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { elevatedUntil: number; credential?: string }
    expect(body.credential).toBeUndefined()
    expect((await who(h, token))?.elevated).toBe(true)
  })

  test('with rotate the answer carries a new credential; the old one ends after the grace', async () => {
    const h = harness()
    await member(h, 'ana')
    await h.secrets.setPin('ana', PIN, { actor: 'owner', via: 'local' })
    const old = await signedIn(h)
    const res = await viaRoute(h, old, { pin: PIN, rotate: true })
    const body = (await res.json()) as { elevatedUntil: number; credential: string }
    expect(body.credential.startsWith('keith_s_')).toBe(true)
    expect(body.credential).not.toBe(old)
    const fresh = await who(h, body.credential)
    expect(fresh).toMatchObject({
      elevated: true,
      credential: { assurance: 2, methods: ['password'] },
    })
    expect(await who(h, old)).toBeDefined() // inside the grace
    h.clock.t += 61_000
    expect(await who(h, old)).toBeUndefined()
    expect(await who(h, body.credential)).toBeDefined()
    // only the new one is a live session
    const ids = h.credentials.sessions(
      (await who(h, body.credential))?.personId as string,
      h.clock.t,
    )
    expect(ids).toHaveLength(1)
  })

  test('a password step-up raises the assurance of a possession session', async () => {
    const h = harness()
    await member(h, 'ana')
    const person = (await h.people.get('ana')).id
    const made = await createCredential(h.credentials, {
      personId: person,
      kind: 'device',
      label: 'code',
    })
    const res = await viaRoute(h, made.token, { password: PASS('ana'), rotate: true })
    const body = (await res.json()) as { credential: string }
    expect((await who(h, body.credential))?.credential).toMatchObject({
      assurance: 2,
      methods: ['device', 'password'],
    })
    expect(h.events('auth.step_up.ok')[0]?.detail).toMatchObject({ rotatedTo: expect.any(String) })
  })
})

describe('the cap per person', () => {
  test('beyond 20 password sessions the longest idle ones end; device-code and token credentials never do', async () => {
    const h = harness()
    await member(h, 'ana')
    const person = (await h.people.get('ana')).id
    const approved = await createCredential(h.credentials, {
      personId: person,
      kind: 'device',
      label: 'code',
    })
    const tokens: string[] = []
    for (let i = 0; i < 22; i += 1) {
      h.clock.t += 1000
      tokens.push(await signedIn(h))
    }
    const live = h.credentials.sessions(person, h.clock.t)
    const password = live.filter((s) => s.methods.includes('password'))
    expect(password).toHaveLength(20)
    expect(await who(h, tokens[0] as string)).toBeUndefined()
    expect(await who(h, tokens[21] as string)).toBeDefined()
    expect(await who(h, approved.token)).toBeDefined()
    expect(h.events('credential.revoked').some((e) => e.detail.by === 'evicted')).toBe(true)
    expect(h.credentials.list(person).find((c) => c.revokedReason === 'evicted')).toBeDefined()
  })
})
