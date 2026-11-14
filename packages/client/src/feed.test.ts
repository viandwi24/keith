import { afterAll, expect, test } from 'bun:test'
import { brainEventOf, createKeithClient } from './client.ts'

const urls: string[] = []
const auth: Array<string | null> = []
const enc = new TextEncoder()
const record = (seq: number, type: string, payload: unknown): string =>
  `id: ${seq}\nevent: activity\ndata: ${JSON.stringify({ seq, type, sessionId: null, agentId: null, payload, createdAt: 1 })}\n\n`
const routed = { region: 'thalamus', sessionId: 'front:owner', preview: 'hi' }
const task = {
  id: 't1',
  parentSessionId: 'front:owner',
  agent: 'cortex.research',
  description: 'd',
  status: 'running',
  steps: 1,
  summary: null,
  error: null,
  createdAt: 1,
  updatedAt: 2,
  finishedAt: null,
}

const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch(request) {
    const url = new URL(request.url)
    urls.push(url.pathname + url.search)
    auth.push(request.headers.get('authorization'))
    if (url.pathname === '/activity/stream') {
      const body =
        'event: boot\ndata: {"boot":"b1"}\n\n' +
        record(1, 'brain.thalamus.routed', routed) +
        record(1, 'brain.thalamus.routed', routed) +
        record(2, 'something.else', {})
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(enc.encode(body))
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    if (url.pathname === '/rpc/tasks/list') return Response.json({ json: [task] })
    return Response.json({ status: 'ok', version: '0.0.0', sha: 'x', boot: 'b1' })
  },
})
// force: a feed left open must not hold the hook (stop() waits for open connections)
afterAll(() => server.stop(true))

test('the feed streams typed brain events with the token, deduped, and reads boot', async () => {
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  expect(client.feed()).toBe(client.feed())
  const feed = client.feed()
  const seen: Array<{ seq: number; type: string; brain: string | undefined }> = []
  const stop = feed.subscribeEvents((r) =>
    seen.push({ seq: r.seq, type: r.type, brain: brainEventOf(r)?.type }),
  )
  feed.start()
  const deadline = Date.now() + 3000
  while (seen.length < 2 && Date.now() < deadline) await Bun.sleep(20)
  stop()
  feed.stop()
  expect(seen.slice(0, 2)).toEqual([
    { seq: 1, type: 'brain.thalamus.routed', brain: 'brain.thalamus.routed' },
    { seq: 2, type: 'something.else', brain: undefined },
  ])
  expect(seen.filter((r) => r.seq === 1)).toHaveLength(1)
  expect(feed.get().boot).toBe('b1')
  expect(urls.some((u) => u.startsWith('/activity/stream'))).toBe(true)
  expect(auth.every((a) => a === 'Bearer keith_t')).toBe(true)
})

test('rpc.tasks.list round-trips', async () => {
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  const tasks = await client.rpc.tasks.list({ active: true })
  expect(tasks[0]?.id).toBe('t1')
  expect(urls).toContain('/rpc/tasks/list')
})
