import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { type BootedCore, bootCore, FAST_HASH } from '../../testing/boot-core.ts'

/** The PIN over a real listener: identifier-first sign-in from loopback, self-service PIN, step-up rules. */
let b: BootedCore
const PASS = `harbor ${Bun.hash('pine')} violins glow gently`
const POST = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${b.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'ok',
    (e: { code?: string }) => e.code,
  )

beforeAll(async () => {
  b = await bootCore({}, { hasher: FAST_HASH })
  await b.local.rpc.admin.people.add({ username: 'ana' })
  await b.local.rpc.admin.people.setPassword({ person: 'ana', password: PASS })
})
afterAll(async () => {
  await b.stop()
})

async function viaFlow(identifier: string, method: string, answer: Record<string, string>) {
  const id = (await (await POST('/auth/identify', { identifier })).json()) as {
    flowId: string
    context: string
    methods: { id: string; available: boolean; default?: boolean }[]
  }
  const res = await POST(`/auth/flow/${id.flowId}`, { method, answer })
  return { id, res }
}

describe('PIN over HTTP', () => {
  test('identify names the PIN as default on loopback and the flow answers a session', async () => {
    const pass = (
      (await (await POST('/auth/login', { username: 'ana', password: PASS })).json()) as {
        credential: string
      }
    ).credential
    // step up ana with her password: the PIN is not set yet, a step-up is needed to set one
    expect(await code(b.tcp(pass).rpc.auth.pin.set({ pin: '482915' }))).toBe(
      'KEITH_STEP_UP_REQUIRED',
    )
    const up = await POST('/auth/step-up', { password: PASS }, { authorization: `Bearer ${pass}` })
    expect(up.status).toBe(200)
    const ana = b.tcp(pass)
    expect(await code(ana.rpc.auth.pin.set({ pin: '1234' }))).toBe('BAD_REQUEST')
    expect(await code(ana.rpc.auth.pin.set({ pin: '482915' }))).toBe('ok')

    const { id, res } = await viaFlow('ana', 'pin', { pin: '482915' })
    expect(id.context).toBe('loopback')
    expect(id.methods.find((m) => m.default)?.id).toBe('pin')
    expect(res.status).toBe(200)
    const pinCredential = ((await res.json()) as { credential: string }).credential
    const session = b.tcp(pinCredential)
    expect((await session.rpc.auth.sessions.list()).find((s) => s.current)).toMatchObject({
      assurance: 1,
      methods: ['pin'],
    })
    // a PIN session cannot be elevated by the PIN, and so cannot set a PIN
    const refused = await POST(
      '/auth/step-up',
      { pin: '482915' },
      { authorization: `Bearer ${pinCredential}` },
    )
    expect(refused.status).toBe(403)
    expect(await code(session.rpc.auth.pin.set({ pin: '739104' }))).toBe('KEITH_STEP_UP_REQUIRED')
    // the owner at the machine may set it for anyone, and that ends the PIN sessions
    await b.local.rpc.admin.people.setPin({ person: 'ana', pin: '739104' })
    expect(await code(session.rpc.auth.whoami())).not.toBe('ok')
  })

  test('a wrong PIN and an unknown identifier answer alike over the wire', async () => {
    const wrong = await viaFlow('ana', 'pin', { pin: '000000' })
    const ghost = await viaFlow('ghost', 'pin', { pin: '000000' })
    expect(wrong.res.status).toBe(401)
    expect(ghost.res.status).toBe(401)
    expect(await wrong.res.text()).toBe(await ghost.res.text())
  })
})

describe('remember this device', () => {
  const DAY = 86_400_000
  async function pinSession(remember?: boolean): Promise<{ idle: number; absolute: number }> {
    const id = (await (await POST('/auth/identify', { identifier: 'remy' })).json()) as {
      flowId: string
    }
    const res = await POST(`/auth/flow/${id.flowId}`, {
      method: 'pin',
      answer: { pin: '615284' },
      ...(remember === undefined ? {} : { remember }),
    })
    expect(res.status).toBe(200)
    const credential = ((await res.json()) as { credential: string }).credential
    const row = (await b.tcp(credential).rpc.auth.sessions.list()).find((s) => s.current)
    return {
      idle: (row?.idleExpiresAt ?? 0) - Date.now(),
      absolute: (row?.absoluteExpiresAt ?? 0) - Date.now(),
    }
  }

  test('a ticked box makes a 30 days idle session, 180 in all; without it the PIN keeps its 12 hours', async () => {
    await b.local.rpc.admin.people.add({ username: 'remy' })
    await b.local.rpc.admin.people.setPin({ person: 'remy', pin: '615284' })
    const plain = await pinSession()
    expect(plain.idle).toBeLessThan(DAY)
    expect(plain.absolute).toBeLessThan(8 * DAY)
    const unticked = await pinSession(false)
    expect(unticked.idle).toBeLessThan(DAY)
    const kept = await pinSession(true)
    expect(kept.idle).toBeGreaterThan(29 * DAY)
    expect(kept.idle).toBeLessThanOrEqual(30 * DAY)
    expect(kept.absolute).toBeGreaterThan(179 * DAY)
    expect(kept.absolute).toBeLessThanOrEqual(180 * DAY)
  })
})
