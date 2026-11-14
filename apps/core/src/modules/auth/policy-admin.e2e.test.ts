import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { AuthPolicySchema } from '@keith/contracts'
import { type BootedCore, bootCore, FAST_HASH, stepUp } from '../../testing/boot-core.ts'
import { DEFAULT_POLICY } from './policy.ts'

/** `admin.auth.policy.*` over a real listener: owner only, step-up, audit, guard, and the effect on sign-in. */
let b: BootedCore
const PASS = `quarry ${Bun.hash('policy')} bells ring faintly`
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string; message?: string }) => e.code,
  )

beforeAll(async () => {
  b = await bootCore({}, { hasher: FAST_HASH })
  await b.local.rpc.admin.people.add({ username: 'ana' })
  await b.local.rpc.admin.people.setPassword({ person: 'ana', password: PASS })
})
afterAll(async () => {
  await b.stop()
})

const identify = async () =>
  (await (
    await fetch(`${b.url}/auth/identify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'owner' }),
    })
  ).json()) as { methods: { id: string; available: boolean }[] }

describe('admin.auth.policy', () => {
  test('starts as the default; a stored policy takes effect on the next request and is audited', async () => {
    const first = await b.local.rpc.admin.auth.policy.get()
    expect(first.isDefault).toBe(true)
    expect(first.policy).toEqual(DEFAULT_POLICY)
    expect((await identify()).methods.find((m) => m.id === 'device')?.available).toBe(true)

    const custom = AuthPolicySchema.parse({
      rules: [
        { method: 'pin', zones: ['loopback'], idleMs: 60_000, absoluteMs: 120_000 },
        { method: 'password', zones: ['loopback', 'tailscale'] },
        { method: 'token', zones: ['loopback'] },
      ],
    })
    const done = await b.local.rpc.admin.auth.policy.set(custom)
    expect(done.isDefault).toBe(false)
    expect((await b.local.rpc.admin.auth.policy.get()).policy).toEqual(custom)
    const listed = await identify()
    expect(listed.methods.find((m) => m.id === 'device')?.available).toBe(false)
    expect(listed.methods.find((m) => m.id === 'pin')?.available).toBe(true)
    // the legacy list follows the stored policy too
    const legacy = (await (await fetch(`${b.url}/auth/methods`)).json()) as {
      methods: { id: string; available: boolean }[]
    }
    expect(legacy.methods.find((m) => m.id === 'device')?.available).toBe(false)

    const events = await b.local.rpc.admin.audit.list({ limit: 50 })
    const set = events.find((e) => e.kind === 'auth.policy.set')
    expect(set?.detail).toMatchObject({ rules: 3, wasDefault: true, lanCidrs: 0 })
    expect(JSON.stringify(set)).not.toContain('idleMs')
  })

  test('refuses a policy that would leave the owner no way in, and keeps the stored one', async () => {
    const before = await b.local.rpc.admin.auth.policy.get()
    const locked = AuthPolicySchema.parse({ rules: [{ method: 'token', zones: ['loopback'] }] })
    expect(await code(b.local.rpc.admin.auth.policy.set(locked))).toBe('BAD_REQUEST')
    expect((await b.local.rpc.admin.auth.policy.get()).policy).toEqual(before.policy)
    const bad = AuthPolicySchema.parse({
      rules: [{ method: 'password', zones: ['loopback'], cidrs: ['10.0.0.0/40'] }],
    })
    expect(await code(b.local.rpc.admin.auth.policy.set(bad))).toBe('BAD_REQUEST')
  })

  test('a rule that still carries a removed field is a 400 and stores nothing', async () => {
    const before = await b.local.rpc.admin.auth.policy.get()
    for (const extra of [{ rateLimit: { free: 4, capSeconds: 300 } }, { requireAssurance: 1 }]) {
      const rule = { method: 'password', zones: ['loopback'], ...extra }
      const sent = b.local.rpc.admin.auth.policy.set({ rules: [rule], lanCidrs: [] } as never)
      expect(await code(sent)).toBe('BAD_REQUEST')
    }
    expect((await b.local.rpc.admin.auth.policy.get()).policy).toEqual(before.policy)
  })

  test('a member is refused even with settings.manage; the step-up comes first over TCP', async () => {
    await b.local.rpc.admin.people.grant({ person: 'ana', capability: 'settings.manage' })
    const login = await fetch(`${b.url}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'ana', password: PASS }),
    })
    const credential = ((await login.json()) as { credential: string }).credential
    const ana = b.tcp(credential)
    expect(await code(ana.rpc.admin.auth.policy.get())).toBe('FORBIDDEN')
    expect(await code(ana.rpc.admin.auth.policy.set(DEFAULT_POLICY))).toBe('KEITH_STEP_UP_REQUIRED')
    await stepUp(b, credential, 'ana')
    expect(await code(ana.rpc.admin.auth.policy.set(DEFAULT_POLICY))).toBe('FORBIDDEN')
    expect((await b.local.rpc.admin.auth.policy.get()).isDefault).toBe(false)
  })
})
