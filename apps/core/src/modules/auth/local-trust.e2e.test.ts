import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createKeithClient, type LocalLockError, lockLocal, openLocalSession } from '@keith/client'
import { type BootedCore, bootCore, FAST_HASH } from '../../testing/boot-core.ts'

/** `local trust` over a real listener and the real socket (docs/specs/auth.md, "The local socket"). */
let b: BootedCore
const PIN = '482915'
const socketFetch = ((i: Parameters<typeof fetch>[0], init?: RequestInit) =>
  fetch(i, { ...init, unix: b.socketPath } as RequestInit)) as typeof fetch
const withToken = (token: string) =>
  createKeithClient({ baseUrl: 'http://localhost', fetch: socketFetch, token })
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; status?: number }) => e.code ?? String(e.status),
  )

beforeAll(async () => {
  b = await bootCore({}, { hasher: FAST_HASH, localTrust: 'idle-lock' })
})
afterAll(async () => {
  await b.stop()
})

describe('local trust', () => {
  test('none is refused while the owner has no way to sign in on the socket; full needs the acknowledgement', async () => {
    const view = await b.local.rpc.admin.auth.local.get({})
    expect(view).toMatchObject({ personId: 'owner', trust: 'idle-lock', hasPin: false })
    expect(await code(b.local.rpc.admin.auth.local.set({ trust: 'none' }))).toBe('BAD_REQUEST')
    expect(await code(b.local.rpc.admin.auth.local.set({ trust: 'full' }))).toBe('BAD_REQUEST')
    expect((await b.local.rpc.admin.auth.local.get({})).trust).toBe('idle-lock')
    const full = await b.local.rpc.admin.auth.local.set({ trust: 'full', acknowledge: true })
    expect(full.trust).toBe('full')
    const events = await b.local.rpc.admin.audit.list({ limit: 20 })
    expect(events.find((e) => e.kind === 'auth.local.set')?.detail).toMatchObject({
      trust: 'full',
      wasTrust: 'idle-lock',
      acknowledged: true,
    })
    await b.local.rpc.admin.auth.local.set({ trust: 'idle-lock' })
  })

  test('none: the socket serves nobody without a credential; the PIN buys an admin session', async () => {
    await b.local.rpc.admin.people.setPin({ person: 'owner', pin: PIN })
    const set = await b.local.rpc.admin.auth.local.set({ trust: 'none' })
    expect(set.trust).toBe('none')
    // the implicit owner is gone
    expect(await code(b.local.rpc.auth.whoami())).toBe('UNAUTHORIZED')
    expect((await socketFetch('http://localhost/sessions/front:owner')).status).toBe(401)
    expect((await socketFetch('http://localhost/health')).status).toBe(200)
    // lock has nothing to lock
    const lockError = await lockLocal({ fetch: socketFetch }).catch((e: unknown) => e)
    expect((lockError as LocalLockError).reason).toBe('unauthorized')
    // a wrong PIN, then the right one
    const wrong = await openLocalSession({ fetch: socketFetch, pin: '000000' }).catch(
      (e: unknown) => e,
    )
    expect((wrong as LocalLockError).reason).toBe('invalid')
    const session = await openLocalSession({ fetch: socketFetch, pin: PIN })
    const admin = withToken(session.credential)
    const me = await admin.rpc.auth.whoami()
    expect(me).toMatchObject({
      role: 'owner',
      via: 'local',
      credentialKind: 'device',
      elevated: true,
    })
    // stepped up: a sensitive call works, and the credential is a listed, revocable session
    expect(await code(admin.rpc.admin.auth.local.get({}))).toBe('ok')
    const sessions = await admin.rpc.auth.sessions.list()
    expect(sessions.some((s) => s.label === 'keith-core (local admin)')).toBe(true)
    // the same sign-in works through the identifier-first flow, zone loopback
    const identify = (await (
      await socketFetch('http://localhost/auth/identify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ identifier: 'owner' }),
      })
    ).json()) as { flowId: string; context: string; methods: { id: string; default?: boolean }[] }
    expect(identify.context).toBe('loopback')
    expect(identify.methods.find((m) => m.default)?.id).toBe('pin')
    // back to the default through the session (a sensitive call, stepped up by the typed PIN)
    const back = await admin.rpc.admin.auth.local.set({ trust: 'idle-lock' })
    expect(back.trust).toBe('idle-lock')
    expect((await b.local.rpc.auth.whoami()).via).toBe('local')
    const events = await b.local.rpc.admin.audit.list({ limit: 100 })
    expect(
      events.find((e) => e.kind === 'auth.login.ok' && e.via === 'local')?.detail,
    ).toMatchObject({ admin: true })
    expect(JSON.stringify(events)).not.toContain(PIN)
    expect(JSON.stringify(events)).not.toContain(session.credential)
  })

  test('with an implicit owner the session route has nothing to sell, and none is not available over TCP', async () => {
    const res = await openLocalSession({ fetch: socketFetch, pin: PIN }).catch((e: unknown) => e)
    expect((res as LocalLockError).reason).toBe('not_applicable')
    expect(
      (await fetch(`${b.url}/auth/local/session`, { method: 'POST', body: '{}' })).status,
    ).toBe(404)
  })

  test('logging out ends an admin session at once', async () => {
    await b.local.rpc.admin.auth.local.set({ trust: 'none' })
    const session = await openLocalSession({ fetch: socketFetch, pin: PIN })
    const admin = withToken(session.credential)
    // revoking the session ends it at once
    const [mine] = (await admin.rpc.auth.sessions.list()).filter((s) => s.current)
    expect(mine).toBeDefined()
    await admin.rpc.auth.logout()
    expect(await code(admin.rpc.auth.whoami())).toBe('UNAUTHORIZED')
    const fresh = withToken((await openLocalSession({ fetch: socketFetch, pin: PIN })).credential)
    await fresh.rpc.admin.auth.local.set({ trust: 'idle-lock' })
  })
})
