import { afterAll, expect, test } from 'bun:test'
import type { LogsStatus } from '@keith/contracts'
import { logsApiOf } from './activity-logs.ts'
import { createKeithClient } from './client.ts'

// The logs wrapper: each method calls the `rpc.logs.*` procedure of the same name with its input, over the typed oRPC client.
// The server procedures are a stub on the core side, so the fake answers each route with a fixed body of the contract's shape.
const requests: Array<{ path: string; input: unknown }> = []
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/rpc/logs/')) return new Response('not found', { status: 404 })
    const body = (await request.json().catch(() => ({}))) as { json?: unknown }
    requests.push({ path: url.pathname, input: body.json })
    if (url.pathname.endsWith('/status'))
      return Response.json({
        json: { queued: 0, dropped: 0, sessions: 1, calls: 2, bodyBytes: 10 },
      })
    if (url.pathname.endsWith('/settings/get') || url.pathname.endsWith('/settings/set'))
      return Response.json({
        json: {
          captureBodies: true,
          guestBodies: false,
          bodyRetentionDays: 14,
          metaRetentionDays: 365,
          maxBodyBytes: 512 * 1024,
        },
      })
    if (url.pathname.endsWith('/sessions'))
      return Response.json({ json: { sessions: [], nextCursor: null } })
    if (url.pathname.endsWith('/purge'))
      return Response.json({ json: { bodies: 1, calls: 0, sessions: 0 } })
    if (url.pathname.endsWith('/raw'))
      return Response.json({
        json: {
          callId: 'c1',
          bodyState: 'stored',
          request: '{}',
          response: null,
          truncated: false,
        },
      })
    return Response.json({ json: {} })
  },
})
afterAll(() => server.stop(true))

test('logsApiOf calls each logs procedure with its input', async () => {
  requests.length = 0
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  const status: LogsStatus = await client.logs.status()
  expect(status.calls).toBe(2)
  await client.logs.settings.get()
  await client.logs.settings.set({ captureBodies: false, bodyRetentionDays: 7 })
  await client.logs.sessions()
  await client.logs.sessions({ kind: 'chat', limit: 5, q: 'ses' })
  await client.logs.session({ id: 'front:ana' })
  await client.logs.call({ id: 'c1' })
  await client.logs.raw({ callId: 'c1' })
  await client.logs.purge({ mode: 'bodies' })
  expect(requests.map((r) => r.path)).toEqual([
    '/rpc/logs/status',
    '/rpc/logs/settings/get',
    '/rpc/logs/settings/set',
    '/rpc/logs/sessions',
    '/rpc/logs/sessions',
    '/rpc/logs/session',
    '/rpc/logs/call',
    '/rpc/logs/raw',
    '/rpc/logs/purge',
  ])
  expect(requests[2]?.input).toEqual({ captureBodies: false, bodyRetentionDays: 7 })
  expect(requests[3]?.input).toEqual({})
  expect(requests[4]?.input).toEqual({ kind: 'chat', limit: 5, q: 'ses' })
  expect(requests[5]?.input).toEqual({ id: 'front:ana' })
  expect(requests[6]?.input).toEqual({ id: 'c1' })
  expect(requests[7]?.input).toEqual({ callId: 'c1' })
  expect(requests[8]?.input).toEqual({ mode: 'bodies' })
})

test('logsApiOf is the same object shape on any rpc', async () => {
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  const api = logsApiOf({ rpc: client.rpc })
  expect(api.status).toBeFunction()
  expect(api.settings.get).toBeFunction()
  expect(api.settings.set).toBeFunction()
  expect(api.sessions).toBeFunction()
  expect(api.session).toBeFunction()
  expect(api.call).toBeFunction()
  expect(api.raw).toBeFunction()
  expect(api.purge).toBeFunction()
})
