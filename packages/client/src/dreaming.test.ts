import { afterAll, expect, test } from 'bun:test'
import { createKeithClient } from './client.ts'
import { dreamingApiOf, dreamRefusalOf } from './dreaming.ts'

// The dreaming wrapper: each method calls the `rpc.dream.*` procedure of the same name with its input, over the typed client.
const requests: Array<{ path: string; input: unknown }> = []
let refusal: string | undefined
const run = {
  id: 'run-1',
  trigger: 'manual',
  mode: 'propose',
  status: 'staged',
  reason: null,
  startedAt: 1,
  finishedAt: 2,
  counts: { candidates: 3, promoted: 1, merged: 0, superseded: 1, dropped: 1 },
  applied: false,
  staged: true,
}
const status = {
  mode: 'propose',
  lastRun: run,
  nextRunAt: null,
  canApply: true,
  canUndo: false,
}
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/rpc/dream/')) return new Response('not found', { status: 404 })
    const body = (await request.json()) as { json?: unknown }
    requests.push({ path: url.pathname, input: body.json })
    if (refusal !== undefined)
      return Response.json(
        {
          json: {
            defined: false,
            code: 'CONFLICT',
            status: 409,
            message: 'refused',
            data: { reason: refusal },
          },
        },
        { status: 409 },
      )
    if (url.pathname.endsWith('/status') || url.pathname.endsWith('/mode'))
      return Response.json({ json: status })
    if (url.pathname.endsWith('/now') || url.pathname.endsWith('/apply'))
      return Response.json({ json: run })
    if (url.pathname.endsWith('/undo'))
      return Response.json({ json: { runId: 'run-1', restored: 2 } })
    return Response.json({ json: { date: '2026-11-10', text: '# Dreams\n' } })
  },
})
afterAll(() => server.stop(true))

test('dreamingApiOf calls each dream procedure with its input', async () => {
  requests.length = 0
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  expect((await client.dreaming.status()).mode).toBe('propose')
  await client.dreaming.setMode({ mode: 'auto' })
  await client.dreaming.runNow()
  await client.dreaming.apply({ runId: 'run-1' })
  await client.dreaming.undo()
  await client.dreaming.undo({ runId: 'run-1' })
  await client.dreaming.diary({ date: '2026-11-10' })
  await client.dreaming.diary()
  expect(requests.map((r) => r.path)).toEqual([
    '/rpc/dream/status',
    '/rpc/dream/mode',
    '/rpc/dream/now',
    '/rpc/dream/apply',
    '/rpc/dream/undo',
    '/rpc/dream/undo',
    '/rpc/dream/diary',
    '/rpc/dream/diary',
  ])
  expect(requests[1]?.input).toEqual({ mode: 'auto' })
  expect(requests[3]?.input).toEqual({ runId: 'run-1' })
  expect(requests[4]?.input).toEqual({})
  expect(requests[5]?.input).toEqual({ runId: 'run-1' })
  expect(requests[6]?.input).toEqual({ date: '2026-11-10' })
  expect(requests[7]?.input).toEqual({})
})

test('dreamRefusalOf reads the reason of a CONFLICT and nothing else', async () => {
  const api = dreamingApiOf(createKeithClient({ baseUrl: server.url.href, token: 'keith_t' }))
  refusal = 'too-soon'
  try {
    await api.runNow()
    throw new Error('expected a refusal')
  } catch (error) {
    expect(dreamRefusalOf(error)).toBe('too-soon')
  } finally {
    refusal = undefined
  }
  expect(dreamRefusalOf(new Error('boom'))).toBeUndefined()
  expect(dreamRefusalOf({ code: 'CONFLICT', data: { reason: 'no-such-reason' } })).toBeUndefined()
  expect(dreamRefusalOf({ code: 'NOT_FOUND', data: { reason: 'off' } })).toBeUndefined()
  expect(dreamRefusalOf({ code: 'CONFLICT', data: { reason: 'judge' } })).toBeUndefined()
  expect(dreamRefusalOf(undefined)).toBeUndefined()
})
