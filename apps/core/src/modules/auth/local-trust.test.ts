import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_LOCAL_TRUST, type LocalTrust } from '@keith/contracts'
import { auditRepo, secretsRepo, settingsRepo, tokensRepo } from '@keith/db'
import {
  caller,
  cleanup,
  FAST,
  type Harness,
  harness,
  PIN,
  post,
} from '../../testing/auth-harness.ts'
import { createAudit } from '../audit/index.ts'
import { createCredential } from './credentials.ts'
import { createHasher } from './hasher.ts'
import {
  createLocalAccess,
  LOCAL_SETTING,
  type LocalAccess,
  type LocalMode,
} from './local-access.ts'
import { createPrincipalResolver } from './principal.ts'

afterEach(cleanup)

const MIN = 60_000
const PASSWORD = `purple ${Bun.hash('owner')} tractors orbit mars slowly`

async function setup(options: { pin: boolean; password?: boolean; defaultTrust?: LocalTrust }) {
  const h = harness()
  const local = createLocalAccess({
    settings: settingsRepo(h.sqlite),
    tokens: tokensRepo(h.sqlite),
    secrets: secretsRepo(h.sqlite),
    credentials: h.credentials,
    hasher: createHasher(FAST),
    audit: createAudit(auditRepo(h.sqlite)),
    now: () => h.clock.t,
    ...(options.defaultTrust === undefined ? {} : { defaultTrust: options.defaultTrust }),
  })
  if (options.pin) await h.secrets.setPin('owner', PIN, caller)
  if (options.password === true) await h.secrets.setPassword('owner', PASSWORD, caller)
  return { h, local }
}

/** What the socket does after `idle` minutes of nothing, optionally after an explicit lock. */
function observe(
  { h, local }: { h: Harness; local: LocalAccess },
  trust: LocalTrust,
  explicitLock: boolean,
): { mode: LocalMode; implicit: boolean; lock: number } {
  local.setTrust('owner', trust)
  const lock = explicitLock ? local.lock().status : 0
  h.clock.t += 60 * MIN
  return { mode: local.mode(), implicit: local.implicit(), lock }
}

describe('local trust x PIN x locked (policy table)', () => {
  // trust, PIN set, locked by `keith lock` first -> what the socket is after an hour idle
  const table: Array<
    [LocalTrust, boolean, boolean, { mode: LocalMode; implicit: boolean; lock: number }]
  > = [
    ['none', true, false, { mode: 'session', implicit: false, lock: 0 }],
    ['none', true, true, { mode: 'session', implicit: false, lock: 409 }],
    ['none', false, false, { mode: 'session', implicit: false, lock: 0 }],
    ['none', false, true, { mode: 'session', implicit: false, lock: 409 }],
    ['idle-lock', true, false, { mode: 'locked', implicit: true, lock: 0 }],
    ['idle-lock', true, true, { mode: 'locked', implicit: true, lock: 200 }],
    ['idle-lock', false, false, { mode: 'open', implicit: true, lock: 0 }],
    ['idle-lock', false, true, { mode: 'open', implicit: true, lock: 409 }],
    ['full', true, false, { mode: 'open', implicit: true, lock: 0 }],
    ['full', true, true, { mode: 'locked', implicit: true, lock: 200 }],
    ['full', false, false, { mode: 'open', implicit: true, lock: 0 }],
    ['full', false, true, { mode: 'open', implicit: true, lock: 409 }],
  ]
  for (const [trust, pin, explicit, want] of table) {
    test(`${trust}, PIN ${pin ? 'set' : 'unset'}, ${explicit ? 'keith lock first' : 'idle for an hour'}`, async () => {
      const s = await setup({ pin })
      expect(observe(s, trust, explicit)).toEqual(want)
    })
  }

  test('the default is none for everyone (also with nothing stored), and the level is kept per person', async () => {
    const { local } = await setup({ pin: true })
    expect(DEFAULT_LOCAL_TRUST).toBe('none')
    expect(local.trustOf('owner')).toBe('none')
    expect(local.implicit()).toBe(false)
    expect(local.mode()).toBe('session')
    local.setTrust('owner', 'full')
    expect(local.trustOf('owner')).toBe('full')
    expect(local.trustOf('ana')).toBe('none')
    expect(local.view('ana').trust).toBe('none')
  })

  test('migration: settings stored before the new default (idle minutes only) mean none; an explicit level is respected', async () => {
    const { h, local } = await setup({ pin: true })
    const settings = settingsRepo(h.sqlite)
    settings.set(LOCAL_SETTING, { idleMinutes: 30 })
    expect(local.trustOf('owner')).toBe('none')
    expect(local.view('owner').idleMinutes).toBe(30)
    settings.set(LOCAL_SETTING, { idleMinutes: 30, trust: { owner: 'idle-lock' } })
    expect(local.trustOf('owner')).toBe('idle-lock')
    settings.set(LOCAL_SETTING, { trust: { owner: 'full' } })
    expect(local.trustOf('owner')).toBe('full')
  })
})

/** The socket's resolver: the implicit owner only while the trust level allows it. */
const socketResolver = (h: Harness, local: LocalAccess) =>
  createPrincipalResolver(tokensRepo(h.sqlite), h.credentials, {
    now: () => h.clock.t,
    localImplicit: () => local.implicit(),
  })

const buy = (local: LocalAccess, body: unknown) => local.session(post(body))

describe('the admin session of a socket that needs one (trust none)', () => {
  test('the PIN buys a 5-minute session, stepped up for as long, audited without the secret', async () => {
    const { h, local } = await setup({ pin: true })
    local.setTrust('owner', 'none')
    const resolver = socketResolver(h, local)
    // no credential: no principal on a socket that needs a session
    expect(await resolver.resolve(new Request('http://localhost/rpc'), 'local')).toBeUndefined()
    const res = await buy(local, { pin: PIN })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { credential: string; elevatedUntil: number }
    expect(body.elevatedUntil).toBe(h.clock.t + 5 * MIN)
    const request = new Request('http://localhost/rpc', {
      headers: { authorization: `Bearer ${body.credential}` },
    })
    const principal = await resolver.resolve(request, 'local')
    expect(principal).toMatchObject({ personId: 'owner', role: 'owner', elevated: true })
    expect(principal?.credential?.assurance).toBe(1)
    expect(principal?.credential?.methods).toEqual(['pin', 'local-admin'])
    // idle for 6 minutes: the session is over
    h.clock.t += 6 * MIN
    expect(
      await resolver.resolve(
        new Request('http://localhost/rpc', { headers: request.headers }),
        'local',
      ),
    ).toBeUndefined()
    const rows = h.events('auth.login.ok')
    expect(rows.at(-1)?.detail).toMatchObject({ method: 'pin', admin: true })
    expect(JSON.stringify(h.events())).not.toContain(PIN)
    expect(JSON.stringify(h.events())).not.toContain(body.credential)
  })

  test('the password gives assurance 2; a wrong secret is a 401 and an audit row', async () => {
    const { h, local } = await setup({ pin: true, password: true })
    local.setTrust('owner', 'none')
    const resolver = socketResolver(h, local)
    expect((await buy(local, { pin: '000000' })).status).toBe(401)
    expect(h.events('auth.login.failed')).toHaveLength(1)
    const body = (await (await buy(local, { password: PASSWORD })).json()) as { credential: string }
    const principal = await resolver.resolve(
      new Request('http://localhost/rpc', {
        headers: { authorization: `Bearer ${body.credential}` },
      }),
      'local',
    )
    expect(principal?.credential?.assurance).toBe(2)
  })

  test('with an implicit owner there is nothing to buy', async () => {
    const { local } = await setup({ pin: true })
    local.setTrust('owner', 'idle-lock')
    expect((await buy(local, { pin: PIN })).status).toBe(409)
  })
})

describe('the first-owner flow (the owner has no PIN and no password)', () => {
  const first = (local: LocalAccess, body: unknown) => local.firstOwner(post(body))

  test('open only while the owner has no credential: it sets the PIN once, audited without the secret, then closes for good', async () => {
    const { h, local } = await setup({ pin: false })
    expect(local.status()).toEqual({ needsFirstOwner: true })
    const resolver = socketResolver(h, local)
    expect((await first(local, { pin: '12' })).status).toBe(400)
    const res = await first(local, { pin: PIN })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { credential: string }
    const principal = await resolver.resolve(
      new Request('http://localhost/rpc', {
        headers: { authorization: `Bearer ${body.credential}` },
      }),
      'local',
    )
    expect(principal).toMatchObject({ personId: 'owner', role: 'owner' })
    expect(h.events('auth.first_owner')).toHaveLength(1)
    expect(JSON.stringify(h.events())).not.toContain(PIN)
    // closed for good: a second attempt (even with another secret) is refused and changes nothing
    expect(local.status()).toEqual({ needsFirstOwner: false })
    expect((await first(local, { pin: '999111' })).status).toBe(409)
    expect((await buy(local, { pin: PIN })).status).toBe(200)
    expect(h.events('auth.first_owner')).toHaveLength(1)
  })

  test('a password works too and follows the password rules; a PIN already set keeps it closed', async () => {
    const { local } = await setup({ pin: false })
    expect((await first(local, { password: 'short' })).status).toBe(400)
    expect((await first(local, { password: PASSWORD })).status).toBe(200)
    expect((await first(local, { pin: PIN })).status).toBe(409)
    const withPin = await setup({ pin: true })
    expect(withPin.local.status()).toEqual({ needsFirstOwner: false })
    expect((await first(withPin.local, { pin: PIN })).status).toBe(409)
  })

  test('an older session of the owner stops working; the new one survives', async () => {
    const { h, local } = await setup({ pin: false })
    const resolver = socketResolver(h, local)
    const old = await createCredential(h.credentials, {
      personId: 'owner',
      kind: 'device',
      label: 'old',
    })
    const bearer = (token: string) =>
      new Request('http://localhost/rpc', { headers: { authorization: `Bearer ${token}` } })
    expect(await resolver.resolve(bearer(old.token), 'local')).toBeDefined()
    const res = await first(local, { pin: PIN })
    const body = (await res.json()) as { credential: string }
    expect(await resolver.resolve(bearer(old.token), 'local')).toBeUndefined()
    expect(await resolver.resolve(bearer(body.credential), 'local')).toBeDefined()
    expect(h.events('person.sessions.revoked')[0]?.detail).toMatchObject({
      personId: 'owner',
      reason: 'first-owner',
      count: 1,
    })
  })

  test('two simultaneous requests: one wins', async () => {
    const { local } = await setup({ pin: false })
    const results = await Promise.all([first(local, { pin: PIN }), first(local, { pin: '654321' })])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
  })
})
