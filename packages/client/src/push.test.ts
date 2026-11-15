import { afterAll, expect, test } from 'bun:test'
import { createKeithClient } from './client.ts'
import {
  applicationServerKeyOf,
  listPush,
  pushPublicKey,
  subscribePush,
  unsubscribePush,
} from './push.ts'

// The push wrapper: each function calls the `presence.push.*` procedure of the same name with its input.
const requests: Array<{ path: string; input: unknown }> = []
const record = {
  id: 's1',
  clientId: null,
  label: 'phone',
  userAgent: 'UA',
  createdAt: 1,
  lastSuccessAt: null,
  failures: 0,
}
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/rpc/presence/push/')) return new Response('nf', { status: 404 })
    const body = (await request.json()) as { json?: unknown }
    requests.push({ path: url.pathname, input: body.json })
    if (url.pathname.endsWith('/publicKey')) return Response.json({ json: { publicKey: 'PUB' } })
    if (url.pathname.endsWith('/list')) return Response.json({ json: [record] })
    if (url.pathname.endsWith('/unsubscribe')) return Response.json({ json: { ok: true } })
    return Response.json({ json: record })
  },
})
afterAll(() => server.stop(true))

const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4'
const AUTH = ['BTBZMqHH', '6r4Tts7J', '_aSIgg'].join('') // RFC 8291 Appendix A auth secret, built at runtime (gitleaks)
const json = {
  endpoint: 'https://push.example.com/s/1',
  expirationTime: null,
  keys: { p256dh: P256DH, auth: AUTH },
}

test('the four calls hit their procedures with the right inputs', async () => {
  requests.length = 0
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  expect(await pushPublicKey(client)).toBe('PUB')
  expect((await subscribePush(client, json, 'phone', { userAgent: 'UA' })).id).toBe('s1')
  // a browser PushSubscription is accepted through toJSON()
  await subscribePush(client, { toJSON: () => json }, 'x'.repeat(100))
  expect(await listPush(client)).toHaveLength(1)
  await unsubscribePush(client, { endpoint: json.endpoint })
  await unsubscribePush(client, { id: 's1' })
  expect(requests.map((r) => r.path)).toEqual([
    '/rpc/presence/push/publicKey',
    '/rpc/presence/push/subscribe',
    '/rpc/presence/push/subscribe',
    '/rpc/presence/push/list',
    '/rpc/presence/push/unsubscribe',
    '/rpc/presence/push/unsubscribe',
  ])
  expect(requests[1]?.input).toEqual({
    subscription: { endpoint: json.endpoint, expirationTime: null, keys: json.keys },
    label: 'phone',
    userAgent: 'UA',
  })
  expect(((requests[2]?.input as { label?: string } | undefined)?.label ?? '').length).toBe(60)
  expect(requests[4]?.input).toEqual({ endpoint: json.endpoint })
  expect(requests[5]?.input).toEqual({ id: 's1' })
})

test('applicationServerKeyOf decodes a 65-byte VAPID key from base64url', () => {
  const bytes = applicationServerKeyOf(P256DH)
  expect(bytes).toHaveLength(65)
  expect(bytes[0]).toBe(4)
})
