import { afterEach, expect, test } from 'bun:test'
import { createKeithClient } from './client.ts'

const enc = new TextEncoder()
const item = (id: string, node = 'laptop-e') => ({
  id,
  kind: 'approval',
  sessionId: 'task-1',
  parentSessionId: 'front:owner',
  rootSessionId: 'front:owner',
  toolCallId: `call-${id}`,
  toolName: 'motor_remote',
  input: { node, capability: 'shell.exec', input: { command: 'df -h' } },
  risk: 'external',
  messageId: 'm',
  createdAt: 1,
  answeredWaiting: 0,
})

interface Fake {
  url: string
  items: Array<ReturnType<typeof item>>
  answers: Array<{ path: string; auth: string | null; body: unknown }>
  lists: () => number
  /** Status of the next answers (default 200). */
  answerStatus: number
  emit(type: string): void
  stop(): void
}

function fake(): Fake {
  let lists = 0
  let seq = 0
  const streams = new Set<ReadableStreamDefaultController<Uint8Array>>()
  const state: Fake = {
    url: '',
    items: [item('a1'), item('a2', 'desktop-b')],
    answers: [],
    lists: () => lists,
    answerStatus: 200,
    emit(type) {
      seq++
      const record = { seq, type, sessionId: 'task-1', agentId: null, payload: {}, createdAt: 1 }
      for (const c of streams)
        c.enqueue(enc.encode(`id:${seq}\nevent:${type}\ndata:${JSON.stringify(record)}\n\n`))
    },
    stop: () => server.stop(true),
  }
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/activity/stream') {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              streams.add(c)
              c.enqueue(enc.encode('retry: 1000\n\nevent: boot\ndata: {"boot":"b"}\n\n'))
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } },
        )
      }
      if (url.pathname === '/attention') {
        lists++
        return Response.json({ items: state.items })
      }
      const match = /^\/attention\/([^/]+)\/answer$/.exec(url.pathname)
      if (match !== null && request.method === 'POST') {
        state.answers.push({
          path: url.pathname,
          auth: request.headers.get('authorization'),
          body: await request.json(),
        })
        if (state.answerStatus !== 200) {
          const code = state.answerStatus === 409 ? 'EH_HTTP_ALREADY_ANSWERED' : 'EH_HTTP_ERROR'
          return Response.json({ error: { code, message: 'no' } }, { status: state.answerStatus })
        }
        state.items = state.items.filter((i) => i.id !== match[1])
        return Response.json({ status: 'resumed', id: match[1], sessionId: 'task-1' })
      }
      return new Response('not found', { status: 404 })
    },
  })
  state.url = server.url.href
  return state
}

async function until(check: () => boolean, what: string): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > 10_000) throw new Error(`timeout waiting for ${what}`)
    await Bun.sleep(10)
  }
}

let core: Fake | undefined
afterEach(() => core?.stop())

function setup() {
  core = fake()
  const client = createKeithClient({ baseUrl: core.url, token: 'keith_t' })
  return { client, core, attention: client.attention() }
}

test('attention() is one lazy list per client and reads GET /attention with the token', async () => {
  const { client, attention } = setup()
  expect(client.attention()).toBe(attention)
  expect(attention.get().loaded).toBe(false)
  await attention.refresh()
  expect(attention.get().items.map((i) => i.id)).toEqual(['a1', 'a2'])
  expect(attention.get().loaded).toBe(true)
})

test('approve, deny and approveForSession post the approval answers with the session id', async () => {
  const { core, attention } = setup()
  core.items = [item('a1'), item('a2'), item('a3')]
  await attention.refresh()
  const [a1, a2, a3] = attention.get().items
  await attention.approve(a1 as never)
  await attention.deny(a2 as never)
  await attention.approveForSession(a3 as never)
  expect(core.answers.map((a) => a.path)).toEqual([
    '/attention/a1/answer',
    '/attention/a2/answer',
    '/attention/a3/answer',
  ])
  expect(core.answers.every((a) => a.auth === 'Bearer keith_t')).toBe(true)
  expect(core.answers.map((a) => a.body)).toEqual([
    { sessionId: 'task-1', answer: { kind: 'approval', approved: true } },
    { sessionId: 'task-1', answer: { kind: 'approval', approved: false } },
    { sessionId: 'task-1', answer: { kind: 'approval', approved: true, remember: 'session' } },
  ])
})

test('deny carries the reason', async () => {
  const { core, attention } = setup()
  await attention.refresh()
  await attention.deny(attention.get().items[0] as never, 'not now')
  expect(core.answers[0]?.body).toEqual({
    sessionId: 'task-1',
    answer: { kind: 'approval', approved: false, reason: 'not now' },
  })
})

test('the optimistic answer removes the item before the server replies', async () => {
  const { attention } = setup()
  await attention.refresh()
  const [first] = attention.get().items
  const pending = attention.approve(first as never)
  expect(attention.get().items.map((i) => i.id)).toEqual(['a2'])
  await pending
})

test('a 409 keeps the item gone and rejects; another failure puts it back', async () => {
  const { core, attention } = setup()
  await attention.refresh()
  core.answerStatus = 409
  const [first, second] = attention.get().items
  await expect(attention.approve(first as never)).rejects.toThrow()
  expect(attention.get().items.map((i) => i.id)).toEqual(['a2'])
  core.answerStatus = 500
  await expect(attention.approve(second as never)).rejects.toThrow()
  expect(attention.get().items.map((i) => i.id)).toContain('a2')
})

test('feed events refetch the list: pending-changed, brain.amygdala.wait; others do not', async () => {
  const { client, core, attention } = setup()
  const feed = client.feed()
  feed.start()
  try {
    await until(() => feed.get().boot !== undefined, 'the feed boot')
    await attention.refresh()
    const base = core.lists()
    core.items = [item('a1'), item('a2', 'desktop-b'), item('a9')]
    core.emit('pending-changed')
    await until(() => attention.get().items.length === 3, 'the refetch after pending-changed')
    core.items = [item('a1')]
    core.emit('brain.amygdala.wait')
    await until(() => attention.get().items.length === 1, 'the refetch after brain.amygdala.wait')
    const seen = core.lists()
    expect(seen).toBeGreaterThan(base)
    core.emit('something.else')
    await Bun.sleep(500)
    expect(core.lists()).toBe(seen)
  } finally {
    feed.stop()
  }
})
