import { afterAll, describe, expect, test } from 'bun:test'
import { deviceLogin } from '@keith/client'
import {
  auditRepo,
  credentialsRepo,
  deviceRequestsRepo,
  migrateDatabase,
  openDatabase,
  tokensRepo,
} from '@keith/db'
import { type BootedCore, bootCore } from '../../testing/boot-core.ts'
import { issueOwnerToken } from '../../testing/owner-token.ts'
import { createAudit } from '../audit/index.ts'
import { createDeviceLogin } from './device.ts'
import { ensureOwner } from './tokens.ts'

const booted: BootedCore[] = []
afterAll(async () => {
  for (const b of booted) await b.stop().catch(() => undefined)
})
async function boot(env: Record<string, string> = {}) {
  const b = await bootCore(env)
  booted.push(b)
  return b
}

// biome-ignore lint/suspicious/noExplicitAny: test helper over untyped JSON answers
const j = (r: Response): Promise<any> => r.json()

const post = (url: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

describe('device login end to end', () => {
  test('start, approve over the socket, poll returns the credential once, it works on /rpc', async () => {
    const b = await boot()
    const start = await j(await post(b.url, '/auth/device/start', { label: 'laptop' }))
    expect(start.code).toMatch(
      /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/,
    )
    expect(start.expiresAt).toBeGreaterThan(Date.now())
    const poll = () =>
      post(b.url, '/auth/device/poll', { requestId: start.requestId, pollSecret: start.pollSecret })
    expect(await j(await poll())).toEqual({ status: 'pending' })

    // it shows up as waiting, with its label and address (never the code)
    const listed = await b.local.rpc.admin.devices.list()
    expect(listed.pending).toHaveLength(1)
    expect(listed.pending[0]).toMatchObject({ label: 'laptop', id: start.requestId })
    expect(JSON.stringify(listed)).not.toContain(start.code)

    // typed lower case with a space, as a person would
    const approved = await b.local.rpc.admin.devices.approve({
      code: start.code.toLowerCase().replace('-', ' '),
      label: 'my laptop',
    })
    expect(approved.label).toBe('my laptop')

    const done = await j(await poll())
    expect(done.status).toBe('approved')
    expect(done.credential).toMatch(/^keith_s_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/)
    expect(done.credential).toContain(approved.credentialId)

    // the credential authorizes
    const client = b.tcp(done.credential)
    expect((await client.rpc.health.get()).status).toBe('ok')
    expect((await client.rpc.admin.devices.list()).devices.map((d) => d.label)).toEqual([
      'my laptop',
    ])

    // single use: the request is consumed
    const again = await poll()
    expect(again.status).toBe(404)
    expect((await b.local.rpc.admin.devices.list()).pending).toEqual([])

    // revoke over the socket cuts it off
    await b.local.rpc.admin.devices.revoke({ id: approved.credentialId })
    await expect(client.rpc.health.get()).rejects.toMatchObject({ status: 401 })
  })

  test('the client helper logs in against a real core and revokeSelf logs out', async () => {
    const b = await boot()
    const credential = await deviceLogin({
      core: b.url,
      label: 'helper',
      pollMs: 20,
      onCode: ({ code }) => void b.local.rpc.admin.devices.approve({ code }),
    })
    const client = b.tcp(credential)
    expect((await client.rpc.health.get()).status).toBe('ok')
    await client.revokeSelf()
    await expect(client.rpc.health.get()).rejects.toMatchObject({ status: 401 })
  })

  test('deny answers denied once', async () => {
    const b = await boot()
    const start = await j(await post(b.url, '/auth/device/start', {}))
    await b.local.rpc.admin.devices.deny({ code: start.code })
    const body = { requestId: start.requestId, pollSecret: start.pollSecret }
    expect(await j(await post(b.url, '/auth/device/poll', body))).toEqual({
      status: 'denied',
    })
    expect((await post(b.url, '/auth/device/poll', body)).status).toBe(404)
    await expect(b.local.rpc.admin.devices.approve({ code: start.code })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  test('unknown ids, wrong secrets and consumed requests all answer the same 404', async () => {
    const b = await boot()
    const start = await j(await post(b.url, '/auth/device/start', {}))
    const unknown = await post(b.url, '/auth/device/poll', { requestId: 'nope', pollSecret: 'x' })
    const wrong = await post(b.url, '/auth/device/poll', {
      requestId: start.requestId,
      pollSecret: 'x',
    })
    expect(unknown.status).toBe(404)
    expect(wrong.status).toBe(404)
    expect(await unknown.text()).toBe(await wrong.text())
    await expect(b.local.rpc.admin.devices.approve({ code: 'AAAA-AAAA' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  test('bodies over 4 KB and non-JSON are refused before anything is stored', async () => {
    const b = await boot()
    expect((await post(b.url, '/auth/device/start', { label: 'x'.repeat(5000) })).status).toBe(413)
    expect((await post(b.url, '/auth/device/start', 'not json')).status).toBe(400)
    expect((await post(b.url, '/auth/device/start', { label: 'x'.repeat(200) })).status).toBe(400)
    expect((await b.local.rpc.admin.devices.list()).pending).toEqual([])
  })

  test('the client address is the socket peer, never X-Forwarded-For', async () => {
    const b = await boot()
    await post(
      b.url,
      '/auth/device/start',
      {},
      { 'x-forwarded-for': '9.9.9.9', forwarded: 'for=8.8.8.8' },
    )
    const [pending] = (await b.local.rpc.admin.devices.list()).pending
    expect(pending?.ip).toMatch(/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/)
    const audit = await b.local.rpc.admin.audit.list({ limit: 10 })
    expect(JSON.stringify(audit)).not.toContain('9.9.9.9')
  })

  test('whoami names the person, the listener and the credential kind', async () => {
    const b = await boot()
    const token = await issueOwnerToken({ dataDir: b.dir, dbFile: `${b.dir}/keith.db` } as never)
    expect(await b.local.rpc.auth.whoami()).toMatchObject({
      personId: 'owner',
      role: 'owner',
      via: 'local',
      credentialKind: null,
    })
    expect(await b.tcp(token).rpc.auth.whoami()).toMatchObject({
      via: 'tcp',
      credentialKind: 'token',
    })
  })

  test('logout revokes the calling credential; on the socket it is a no-op', async () => {
    const b = await boot()
    const token = await issueOwnerToken({ dataDir: b.dir, dbFile: `${b.dir}/keith.db` } as never)
    const client = b.tcp(token)
    await client.rpc.auth.logout()
    await expect(client.rpc.health.get()).rejects.toMatchObject({ status: 401 })
    await b.local.rpc.auth.logout() // owner on the socket stays signed in
    expect((await b.local.rpc.health.get()).status).toBe('ok')
    const kinds = (await b.local.rpc.admin.audit.list({ limit: 10 })).map((e) => e.kind)
    expect(kinds).toContain('credential.revoked')
  })
})

describe('device login service', () => {
  function service(options: { maxStarts?: number; maxPollFailures?: number } = {}) {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    ensureOwner(tokensRepo(sqlite))
    let t = 1_000_000
    const audit = auditRepo(sqlite, { now: () => t })
    const login = createDeviceLogin({
      devices: deviceRequestsRepo(sqlite, { now: () => t }),
      credentials: credentialsRepo(sqlite, { now: () => t }),
      audit: createAudit(audit),
      now: () => t,
      ...options,
    })
    const call = (path: string, body: unknown, ip = '1.1.1.1') =>
      (path === 'start' ? login.start : login.poll)(
        new Request(`http://x/${path}`, { method: 'POST', body: JSON.stringify(body) }),
        ip,
        'tcp',
      )
    return { login, call, audit, advance: (ms: number) => (t += ms) }
  }

  test('a request expires after ten minutes: the poll says expired, the approval is refused', async () => {
    const { login, call, audit, advance } = service()
    const start = await j(await call('start', {}))
    advance(10 * 60_000 + 1)
    await expect(
      login.approve({ code: start.code, personId: 'owner', via: 'local' }),
    ).rejects.toThrow()
    const poll = await call('poll', { requestId: start.requestId, pollSecret: start.pollSecret })
    expect(await j(poll)).toEqual({ status: 'expired' })
    expect(audit.list(10).map((e) => e.kind)).toEqual(['device.expired', 'device.requested'])
    expect(
      (await call('poll', { requestId: start.requestId, pollSecret: start.pollSecret })).status,
    ).toBe(404)
  })

  test('purging an expired approved request revokes its uncollected credential', async () => {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    ensureOwner(tokensRepo(sqlite))
    let t = 1_000_000
    const credentials = credentialsRepo(sqlite, { now: () => t })
    const audit = auditRepo(sqlite, { now: () => t })
    const login = createDeviceLogin({
      devices: deviceRequestsRepo(sqlite, { now: () => t }),
      credentials,
      audit: createAudit(audit),
      now: () => t,
    })
    const start = await j(
      await login.start(
        new Request('http://x/s', { method: 'POST', body: '{}' }),
        '1.1.1.1',
        'tcp',
      ),
    )
    const approved = await login.approve({ code: start.code, personId: 'owner', via: 'local' })
    expect(credentials.find(approved.credentialId)?.revokedAt).toBeNull()
    // never polled: the credential waits for a device that never comes
    t += 10 * 60_000 + 3_600_000 + 1
    login.purge()
    expect(credentials.find(approved.credentialId)?.revokedAt).not.toBeNull()
    const revoked = audit.list(10).find((e) => e.kind === 'credential.revoked')
    expect(revoked?.detail).toMatchObject({ credentialId: approved.credentialId, by: 'expiry' })
    expect(sqlite.query('SELECT COUNT(*) AS n FROM device_requests').get()).toEqual({ n: 0 })
  })

  test('at most 5 pending per address; the sixth is 429, another address is fine', async () => {
    const { call } = service()
    for (let i = 0; i < 5; i++) expect((await call('start', {})).status).toBe(200)
    expect((await call('start', {})).status).toBe(429)
    expect((await call('start', {}, '2.2.2.2')).status).toBe(200)
  })

  test('starts are rate limited per address inside the window', async () => {
    const { call } = service({ maxStarts: 2 })
    expect((await call('start', {})).status).toBe(200)
    expect((await call('start', {})).status).toBe(200)
    expect((await call('start', {})).status).toBe(429)
    expect((await call('start', {}, '2.2.2.2')).status).toBe(200)
  })

  test('repeated failed polls lock the address out', async () => {
    const { call } = service({ maxPollFailures: 3 })
    for (let i = 0; i < 3; i++) {
      expect((await call('poll', { requestId: 'nope', pollSecret: 'x' })).status).toBe(404)
    }
    expect((await call('poll', { requestId: 'nope', pollSecret: 'x' })).status).toBe(429)
    expect((await call('poll', { requestId: 'nope', pollSecret: 'x' }, '3.3.3.3')).status).toBe(404)
  })

  test('only hashes are stored', async () => {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    const login = createDeviceLogin({
      devices: deviceRequestsRepo(sqlite),
      credentials: credentialsRepo(sqlite),
      audit: createAudit(auditRepo(sqlite)),
    })
    const start = await j(
      await login.start(new Request('http://x/', { method: 'POST', body: '{}' }), 'ip', 'tcp'),
    )
    const row = JSON.stringify(sqlite.query('SELECT * FROM device_requests').all())
    expect(row).not.toContain(start.pollSecret)
    expect(row).not.toContain(start.code.replace('-', ''))
  })
})

describe('device login label rules', () => {
  test('an escape or a forged-row label answers 400 and a clean one is stored trimmed', async () => {
    const b = await boot()
    for (const label of ['a\u001b[2Jb', 'x\nroot  owner'])
      expect((await post(b.url, '/auth/device/start', { label })).status).toBe(400)
    const ok = await post(b.url, '/auth/device/start', { label: '  laptop ' })
    expect(ok.status).toBe(200)
    expect((await b.local.rpc.admin.devices.list()).pending[0]?.label).toBe('laptop')
  })
})
