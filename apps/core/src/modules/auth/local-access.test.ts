import { afterEach, describe, expect, test } from 'bun:test'
import { DEFAULT_IDLE_MINUTES } from '@keith/contracts'
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
import { createHasher } from './hasher.ts'
import { createLocalAccess, type LocalAccess } from './local-access.ts'

afterEach(cleanup)

const MIN = 60_000
const REQ = ['POST', '/sessions/front:owner/messages'] as const
const POLL = ['POST', '/rpc/tasks/list'] as const

function setup(): { h: Harness; local: LocalAccess; settings: ReturnType<typeof settingsRepo> } {
  const h = harness()
  const settings = settingsRepo(h.sqlite)
  const local = createLocalAccess({
    settings,
    tokens: tokensRepo(h.sqlite),
    secrets: secretsRepo(h.sqlite),
    credentials: h.credentials,
    hasher: createHasher(FAST),
    audit: createAudit(auditRepo(h.sqlite)),
    now: () => h.clock.t,
    defaultTrust: 'idle-lock',
  })
  return { h, local, settings }
}
const ready = async (withPin = true) => {
  const s = setup()
  if (withPin) await s.h.secrets.setPin('owner', PIN, caller)
  return s
}
const unlock = (local: LocalAccess, body: unknown) => local.unlock(post(body))

describe('the idle-lock of the local socket (fake clock)', () => {
  test('an owner without a PIN is never locked, however idle, and cannot lock', async () => {
    const { h, local } = await ready(false)
    h.clock.t += 5 * 60 * MIN
    expect(local.mode()).toBe('open')
    const res = local.lock()
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: string }).error).toBe('no_pin')
    expect(local.view()).toMatchObject({ hasPin: false, locked: false })
    expect(h.events('auth.lock')).toHaveLength(0)
  })

  test('with a PIN it locks after the default 15 idle minutes, on the request that finds it idle', async () => {
    const { h, local } = await ready()
    expect(DEFAULT_IDLE_MINUTES).toBe(15)
    h.clock.t += 14 * MIN
    expect(local.mode()).toBe('open')
    h.clock.t += 1 * MIN
    expect(local.mode()).toBe('locked')
    const rows = h.events('auth.lock')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'owner', via: 'local' })
    expect(rows[0]?.detail).toMatchObject({ reason: 'idle', idleMinutes: 15 })
    expect(JSON.stringify(rows[0])).not.toContain(PIN)
  })

  test('only user actions keep it open: polling and the feed do not, a chat send does', async () => {
    const { h, local } = await ready()
    for (let i = 0; i < 7; i++) {
      h.clock.t += 2 * MIN
      expect(local.mode()).toBe('open')
      local.touch(...POLL)
      local.touch('GET', '/activity/stream')
      local.touch('GET', '/attention')
    }
    // 14 minutes of polling and nothing else, then one more poll interval: locked
    h.clock.t += 2 * MIN
    expect(local.mode()).toBe('locked')
    expect(await unlock(local, { pin: PIN }).then((r) => r.status)).toBe(200)
    for (let i = 0; i < 6; i++) {
      h.clock.t += 10 * MIN
      expect(local.mode()).toBe('open')
      local.touch(...REQ)
    }
    h.clock.t += 16 * MIN
    expect(local.mode()).toBe('locked')
  })

  test('0 minutes means never; the setting is read at once and sliding the lock window resets it', async () => {
    const { h, local, settings } = await ready()
    local.setIdleMinutes(0)
    expect(local.view().idleMinutes).toBe(0)
    h.clock.t += 1000 * MIN
    expect(local.mode()).toBe('open')
    local.setIdleMinutes(30)
    expect(settings.get('auth.local')).toEqual({ idleMinutes: 30 })
    h.clock.t += 29 * MIN
    expect(local.mode()).toBe('open')
    h.clock.t += 2 * MIN
    expect(local.mode()).toBe('locked')
  })

  test('keith lock locks now, and only with a PIN; clearing the PIN opens a locked socket', async () => {
    const { h, local } = await ready()
    expect((await local.lock().json()) as unknown).toEqual({ locked: true })
    expect(local.mode()).toBe('locked')
    expect(h.events('auth.lock')[0]?.detail).toMatchObject({ reason: 'manual' })
    await h.secrets.clear('owner', 'pin', caller)
    expect(local.mode()).toBe('open')
    expect(local.view().locked).toBe(false)
  })
})

describe('unlocking', () => {
  test('the PIN opens it and is audited without the secret; a wrong one is refused and audited', async () => {
    const { h, local } = await ready()
    local.lock()
    const wrong = await unlock(local, { pin: '000000' })
    expect(wrong.status).toBe(401)
    expect(local.mode()).toBe('locked')
    expect(h.events('auth.unlock.failed')).toHaveLength(1)
    const ok = await unlock(local, { pin: PIN })
    expect(ok.status).toBe(200)
    expect(local.mode()).toBe('open')
    const rows = h.events('auth.unlock')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ actor: 'owner', via: 'local' })
    expect(rows[0]?.detail).toMatchObject({ method: 'pin' })
    expect(JSON.stringify(h.events())).not.toContain(PIN)
  })

  test('the owner password opens it too', async () => {
    const { h, local } = await ready()
    await h.secrets.setPassword('owner', 'purple tractors orbit mars slowly 7', caller)
    local.lock()
    const res = await unlock(local, { password: 'purple tractors orbit mars slowly 7' })
    expect(res.status).toBe(200)
    expect(h.events('auth.unlock')[0]?.detail).toMatchObject({ method: 'password' })
  })

  test('failures share the throttle: the fifth wrong PIN starts a delay, never a lock-out', async () => {
    const { h, local } = await ready()
    local.lock()
    for (let i = 0; i < 5; i++) expect((await unlock(local, { pin: '000000' })).status).toBe(401)
    const wait = await unlock(local, { pin: PIN })
    expect(wait.status).toBe(429)
    expect(Number(wait.headers.get('retry-after'))).toBeGreaterThan(0)
    h.clock.t += 5_000
    expect((await unlock(local, { pin: PIN })).status).toBe(200)
  })

  test('a malformed body is a 400 and an unlock of an open socket is a harmless 200', async () => {
    const { local } = await ready()
    expect((await unlock(local, { nope: 1 })).status).toBe(400)
    expect((await unlock(local, { pin: PIN })).status).toBe(200)
  })
})
