import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { isLockedError, LocalLockError, lockLocal, unlockLocal } from '@keith/client'
import { type BootedCore, bootCore, FAST_HASH } from '../../testing/boot-core.ts'

/** The idle-lock over a real listener and the real socket (docs/specs/auth.md, "The local socket"). */
let b: BootedCore
const clock = { t: 1_800_000_000_000 }
const MIN = 60_000
const PIN = '482915'
const onSocket = (path: string, init?: RequestInit) =>
  fetch(`http://localhost${path}`, { ...init, unix: b.socketPath } as RequestInit)
const socketFetch = ((i: Parameters<typeof fetch>[0], init?: RequestInit) =>
  fetch(i, { ...init, unix: b.socketPath } as RequestInit)) as typeof fetch

beforeAll(async () => {
  b = await bootCore({}, { hasher: FAST_HASH, localClock: () => clock.t, localTrust: 'idle-lock' })
})
afterAll(async () => {
  await b.stop()
})

describe('the socket lock', () => {
  test('with no PIN the socket never locks and keith lock says why', async () => {
    clock.t += 600 * MIN
    expect((await b.local.rpc.auth.whoami()).via).toBe('local')
    const failure = await lockLocal({ fetch: socketFetch }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(LocalLockError)
    expect((failure as LocalLockError).reason).toBe('no_pin')
    expect((await b.local.rpc.admin.auth.local.get({})).hasPin).toBe(false)
  })

  test('with a PIN it locks after the idle minutes: 423 for everything but /health and unlock', async () => {
    await b.local.rpc.admin.people.setPin({ person: 'owner', pin: PIN })
    await b.local.rpc.auth.whoami() // a touch of the clock
    clock.t += 16 * MIN
    const error = await b.local.rpc.auth.whoami().catch((e: unknown) => e)
    expect(isLockedError(error)).toBe(true)
    expect((await onSocket('/health')).status).toBe(200)
    expect((await onSocket('/activity/stream')).status).toBe(423)
    expect((await onSocket('/auth/identify', { method: 'POST', body: '{}' })).status).toBe(423)
    expect((await onSocket('/sessions/front:owner')).status).toBe(423)
    const events = await unlockThenAudit()
    expect(events.map((e) => e.kind)).toContain('auth.lock')
  })
})

async function unlockThenAudit() {
  const wrong = await unlockLocal({ fetch: socketFetch, pin: '000000' }).catch((e: unknown) => e)
  expect((wrong as LocalLockError).reason).toBe('invalid')
  expect((await onSocket('/rpc/auth/whoami', { method: 'POST' })).status).toBe(423)
  await unlockLocal({ fetch: socketFetch, pin: PIN })
  expect((await b.local.rpc.auth.whoami()).via).toBe('local')
  return b.local.rpc.admin.audit.list({ limit: 50 })
}

describe('keith lock and the setting', () => {
  test('lock now, then unlock; the idle minutes are set by the owner and audited', async () => {
    await lockLocal({ fetch: socketFetch })
    expect(isLockedError(await b.local.rpc.auth.whoami().catch((e: unknown) => e))).toBe(true)
    await unlockLocal({ fetch: socketFetch, pin: PIN })
    const view = await b.local.rpc.admin.auth.local.set({ idleMinutes: 5 })
    expect(view).toMatchObject({ idleMinutes: 5, hasPin: true, locked: false })
    clock.t += 6 * MIN
    expect(isLockedError(await b.local.rpc.auth.whoami().catch((e: unknown) => e))).toBe(true)
    await unlockLocal({ fetch: socketFetch, pin: PIN })
    const events = await b.local.rpc.admin.audit.list({ limit: 100 })
    expect(events.find((e) => e.kind === 'auth.local.set')?.detail).toMatchObject({
      idleMinutes: 5,
    })
    expect(events.filter((e) => e.kind === 'auth.unlock').length).toBeGreaterThanOrEqual(3)
    expect(JSON.stringify(events)).not.toContain(PIN)
  })

  test('the lock routes do not exist over TCP', async () => {
    expect(
      (await fetch(`${b.url}/auth/local/unlock`, { method: 'POST', body: '{"pin":"1"}' })).status,
    ).toBe(404)
    expect((await fetch(`${b.url}/auth/local/lock`, { method: 'POST' })).status).toBe(404)
  })
})
