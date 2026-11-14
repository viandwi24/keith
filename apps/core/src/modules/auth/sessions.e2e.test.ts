import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type BootedCore, bootCore, FAST_HASH, stepUp } from '../../testing/boot-core.ts'

/** `auth.sessions.*` and `admin.sessions.*` over a real listener. */
let b: BootedCore
const PASS = `sailing ${Bun.hash('sess')} kettles hum softly`

beforeAll(async () => {
  b = await bootCore({}, { hasher: FAST_HASH })
  await b.local.rpc.admin.people.add({ username: 'ana' })
  await b.local.rpc.admin.people.setPassword({ person: 'ana', password: PASS })
  await b.local.rpc.admin.people.add({ username: 'bob' })
  await b.local.rpc.admin.people.setPassword({ person: 'bob', password: `${PASS} two` })
})
afterAll(async () => {
  await b.stop()
})

async function login(username = 'ana', password = PASS) {
  const res = await fetch(`${b.url}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': 'e2e/1' },
    body: JSON.stringify({ username, password }),
  })
  return ((await res.json()) as { credential: string }).credential
}
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  )

describe('auth.sessions', () => {
  test('lists the caller own live sessions, marks the current one, shows no secret', async () => {
    const first = await login()
    const second = await login()
    await login('bob', `${PASS} two`)
    const ana = b.tcp(second)
    const list = await ana.rpc.auth.sessions.list()
    expect(list.length).toBeGreaterThanOrEqual(2)
    expect(list.filter((s) => s.current)).toHaveLength(1)
    expect(list.every((s) => s.methods.includes('password') && s.assurance === 2)).toBe(true)
    expect(list.every((s) => s.idleExpiresAt !== null && s.absoluteExpiresAt !== null)).toBe(true)
    expect(list[0]?.userAgent).toBe('e2e/1')
    expect(JSON.stringify(list)).not.toContain(first.slice(-20))
    const me = await ana.rpc.auth.whoami()
    expect(list.every((s) => s.id.length === 12)).toBe(true)
    expect(me.credentialKind).toBe('device')
  })

  test('ending another session needs a step-up; ending the current one is a logout', async () => {
    const keep = await login()
    const other = await login()
    const ana = b.tcp(keep)
    const target = (await b.tcp(other).rpc.auth.sessions.list()).find((s) => s.current)
    expect(await code(ana.rpc.auth.sessions.revoke({ id: target?.id as string }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
    await stepUp(b, keep, 'ana')
    expect(await code(ana.rpc.auth.sessions.revoke({ id: target?.id as string }))).toBe('ok')
    // the other client falls to a 401 at once
    expect(await code(b.tcp(other).rpc.auth.whoami())).toBeDefined()
    expect(await code(b.tcp(other).rpc.auth.whoami())).not.toBe('ok')
    const mine = (await ana.rpc.auth.sessions.list()).find((s) => s.current)
    expect(await code(ana.rpc.auth.sessions.revoke({ id: mine?.id as string }))).toBe('ok')
    expect(await code(ana.rpc.auth.whoami())).not.toBe('ok')
  })

  test('another person session id and an unknown id are the same NOT_FOUND', async () => {
    const ana = b.tcp(await login())
    await stepUp(b, await login(), 'ana')
    const bob = b.tcp(await login('bob', `${PASS} two`))
    const bobs = (await bob.rpc.auth.sessions.list()).find((s) => s.current)
    expect(await code(ana.rpc.auth.sessions.revoke({ id: bobs?.id as string }))).toBe('NOT_FOUND')
    expect(await code(ana.rpc.auth.sessions.revoke({ id: 'ffffffffffff' }))).toBe('NOT_FOUND')
    expect(await code(bob.rpc.auth.whoami())).toBe('ok')
  })
})

describe('admin.sessions', () => {
  test('the owner lists and revokes the sessions of a member; a member cannot', async () => {
    const token = await login()
    const ana = b.tcp(token)
    const id = (await ana.rpc.auth.sessions.list()).find((s) => s.current)?.id as string
    const listed = await b.local.rpc.admin.sessions.list({ person: 'ana' })
    expect(listed.some((s) => s.id === id)).toBe(true)
    expect(await code(ana.rpc.admin.sessions.list({}))).toBe('FORBIDDEN')
    expect(await code(b.local.rpc.admin.sessions.revoke({ id }))).toBe('ok')
    expect(await code(ana.rpc.auth.whoami())).not.toBe('ok')
    expect(await code(b.local.rpc.admin.sessions.revoke({ id }))).toBe('NOT_FOUND')
    expect(await code(b.local.rpc.admin.sessions.list({ person: 'nobody' }))).toBe('NOT_FOUND')
  })
})

describe('step-up rotation over HTTP', () => {
  test('rotate: true returns a credential that works; the answer never repeats the old one', async () => {
    const old = await login()
    await b.local.rpc.admin.people.setPin({ person: 'ana', pin: '482915' })
    const res = await fetch(`${b.url}/auth/step-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${old}` },
      body: JSON.stringify({ pin: '482915', rotate: true }),
    })
    const body = (await res.json()) as { credential: string; elevatedUntil: number }
    expect(res.status).toBe(200)
    expect(body.credential).not.toBe(old)
    const fresh = b.tcp(body.credential)
    expect((await fresh.rpc.auth.whoami()).elevated).toBe(true)
  })
})
