import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createKeithClient } from '@keith/client'
import { type BootedCore, bootCore, FAST_HASH } from '../../testing/boot-core.ts'

/**
 * The default `local trust` is `none` and a fresh owner has no credential: the first-owner flow over
 * the real socket (docs/specs/auth.md, "The local socket"), then it is closed for good.
 */
let b: BootedCore
const PIN = '482915'
const socketFetch = ((i: Parameters<typeof fetch>[0], init?: RequestInit) =>
  fetch(i, { ...init, unix: b.socketPath } as RequestInit)) as typeof fetch
const send = (path: string, body: unknown) =>
  socketFetch(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

beforeAll(async () => {
  b = await bootCore({}, { hasher: FAST_HASH, localTrust: 'default' })
})
afterAll(async () => {
  await b.stop()
})

describe('default local trust none and the first-owner flow', () => {
  test('a visitor at the socket is nobody: no implicit owner, everything but sign-in answers 401', async () => {
    expect((await socketFetch('http://localhost/sessions/front:owner')).status).toBe(401)
    expect((await send('/rpc/auth/whoami', {})).status).toBe(401)
    expect((await socketFetch('http://localhost/health')).status).toBe(200)
    const status = await (await socketFetch('http://localhost/auth/local/status')).json()
    expect(status).toEqual({ needsFirstOwner: true })
  })

  test('the routes do not exist over TCP', async () => {
    expect((await fetch(`${b.url}/auth/local/status`)).status).toBe(404)
    expect(
      (await fetch(`${b.url}/auth/local/first-owner`, { method: 'POST', body: `{"pin":"${PIN}"}` }))
        .status,
    ).toBe(404)
  })

  test('the first PIN is set once over the socket, signs in, and the flow is closed for good', async () => {
    expect((await send('/auth/local/first-owner', { pin: '12' })).status).toBe(400)
    const res = await send('/auth/local/first-owner', { pin: PIN })
    expect(res.status).toBe(200)
    const { credential } = (await res.json()) as { credential: string }
    const me = createKeithClient({
      baseUrl: 'http://localhost',
      fetch: socketFetch,
      token: credential,
    })
    expect(await me.rpc.auth.whoami()).toMatchObject({ role: 'owner', via: 'local' })
    // closed forever: another request (a visitor) cannot replace the PIN
    expect((await send('/auth/local/first-owner', { pin: '999111' })).status).toBe(409)
    expect(await (await socketFetch('http://localhost/auth/local/status')).json()).toEqual({
      needsFirstOwner: false,
    })
    // still no implicit owner afterwards
    expect((await send('/rpc/auth/whoami', {})).status).toBe(401)
    const audit = await me.rpc.admin.audit.list({ limit: 50 })
    expect(audit.filter((e) => e.kind === 'auth.first_owner')).toHaveLength(1)
    expect(JSON.stringify(audit)).not.toContain(PIN)
  })

  test('the stored PIN is the one that signs in (identifier then PIN through the socket)', async () => {
    const identify = (await (await send('/auth/identify', { identifier: 'owner' })).json()) as {
      flowId: string
    }
    const wrong = await send(`/auth/flow/${identify.flowId}`, {
      method: 'pin',
      answer: { pin: '000000' },
    })
    expect(wrong.status).not.toBe(200)
    const fresh = (await (await send('/auth/identify', { identifier: 'owner' })).json()) as {
      flowId: string
    }
    const ok = await send(`/auth/flow/${fresh.flowId}`, { method: 'pin', answer: { pin: PIN } })
    expect(ok.status).toBe(200)
  })
})
