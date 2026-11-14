import { afterAll, expect, test } from 'bun:test'
import {
  ChatContextDeadlineError,
  type ChatContextFeed,
  chatContextApiOf,
  chatContextRefusalOf,
  watchChatContext,
  watchChatContextPending,
} from './chat-context.ts'
import { createKeithClient } from './client.ts'

// The context wrapper: each method calls the `rpc.chat.*` procedure of the same name with its input, over the typed client.
const requests: Array<{ path: string; input: unknown }> = []
let refusal: string | undefined
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/rpc/chat/')) return new Response('not found', { status: 404 })
    const body = (await request.json()) as { json?: unknown }
    requests.push({ path: url.pathname, input: body.json })
    if (refusal !== undefined && !url.pathname.endsWith('/generations'))
      return Response.json(
        {
          json: {
            defined: false,
            code: 'CONFLICT',
            status: 409,
            message: 'a turn is still running',
            data: { reason: refusal },
          },
        },
        { status: 409 },
      )
    if (url.pathname.endsWith('/generations'))
      return Response.json({ json: [{ generation: 0, startedAt: 1, messages: 2 }] })
    if (url.pathname.endsWith('/history')) return Response.json({ json: [] })
    if (url.pathname.endsWith('/newContext'))
      return Response.json({ json: { generation: 1, flushed: true } })
    return Response.json({ json: { generation: 0, flushed: false } })
  },
})
afterAll(() => server.stop(true))

test('chatContextApiOf calls each chat procedure with its input', async () => {
  requests.length = 0
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  await client.chatContext.newContext()
  await client.chatContext.newContext({ flush: false })
  await client.chatContext.compact({ keepLast: 4 })
  await client.chatContext.generations()
  await client.chatContext.history({ generation: 0, limit: 10 })
  expect(requests.map((r) => r.path)).toEqual([
    '/rpc/chat/newContext',
    '/rpc/chat/newContext',
    '/rpc/chat/compact',
    '/rpc/chat/generations',
    '/rpc/chat/history',
  ])
  expect(requests[0]?.input).toEqual({})
  expect(requests[1]?.input).toEqual({ flush: false })
  expect(requests[2]?.input).toEqual({ keepLast: 4 })
  expect(requests[4]?.input).toEqual({ generation: 0, limit: 10 })
})

test('chatContextRefusalOf reads the reason of a CONFLICT and nothing else', async () => {
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  refusal = 'task-running'
  try {
    await client.chatContext.newContext()
    throw new Error('expected a refusal')
  } catch (error) {
    expect(chatContextRefusalOf(error)).toBe('task-running')
  } finally {
    refusal = undefined
  }
  expect(chatContextRefusalOf(new Error('boom'))).toBeUndefined()
  expect(
    chatContextRefusalOf({ code: 'CONFLICT', data: { reason: 'no-such-reason' } }),
  ).toBeUndefined()
  expect(
    chatContextRefusalOf({ code: 'NOT_FOUND', data: { reason: 'flush-failed' } }),
  ).toBeUndefined()
  expect(chatContextRefusalOf(undefined)).toBeUndefined()
})

test('watchChatContext refetches once per chat.context.changed and on each resync', () => {
  let onEvent: ((record: { type: string; payload: unknown }) => void) | undefined
  let onResync: ((reason: string) => void) | undefined
  const feed: ChatContextFeed = {
    subscribeEvents(fn) {
      onEvent = fn
      return () => {
        onEvent = undefined
      }
    },
    subscribeResync(fn) {
      onResync = fn
      return () => {
        onResync = undefined
      }
    },
  }
  let calls = 0
  const off = watchChatContext({ feed, refetch: () => calls++ })
  onEvent?.({ type: 'chat.context.changed', payload: { generation: 1, personId: 'ana' } })
  expect(calls).toBe(1)
  onEvent?.({ type: 'chat.context.changed', payload: { generation: 'x' } })
  onEvent?.({ type: 'persona.changed', payload: { generation: 2 } })
  expect(calls).toBe(1)
  onResync?.('reconnect')
  expect(calls).toBe(2)
  off()
  expect(onEvent).toBeUndefined()
  expect(onResync).toBeUndefined()
})

test('watchChatContextPending hands each well-formed pending record to onRecord and forgets on resync', async () => {
  const events: Array<(record: { type: string; payload: unknown }) => void> = []
  const resyncs: Array<(reason: string) => void> = []
  const feed: ChatContextFeed = {
    subscribeEvents: (fn) => {
      events.push(fn)
      return () => events.splice(events.indexOf(fn), 1)
    },
    subscribeResync: (fn) => {
      resyncs.push(fn)
      return () => resyncs.splice(resyncs.indexOf(fn), 1)
    },
  }
  const seen: string[] = []
  let forgotten = 0
  const off = watchChatContextPending({
    feed,
    onRecord: (r) => seen.push(`${r.kind}:${r.state}:${r.ok ?? '-'}`),
    onResync: () => {
      forgotten++
    },
  })
  const emit = (type: string, payload: unknown) => {
    for (const fn of events) fn({ type, payload })
  }
  emit('chat.context.pending', { kind: 'compact', state: 'start' })
  emit('chat.context.pending', { kind: 'compact', state: 'end', ok: true })
  emit('chat.context.pending', { kind: 'sideways', state: 'start' })
  emit('chat.context.changed', { generation: 1 })
  for (const fn of resyncs) fn('reconnected')
  expect(seen).toEqual(['compact:start:-', 'compact:end:true'])
  expect(forgotten).toBe(1)
  off()
  expect(events).toHaveLength(0)
  expect(resyncs).toHaveLength(0)
})

test('a reset or a compaction the core never answers is refused at the deadline, and its call is aborted', async () => {
  const signals: AbortSignal[] = []
  const stalled = {
    chat: {
      newContext: (_input: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal)
        return new Promise(() => undefined)
      },
      compact: (_input: unknown, options: { signal: AbortSignal }) => {
        signals.push(options.signal)
        return new Promise(() => undefined)
      },
    },
  }
  const api = chatContextApiOf({ rpc: stalled } as never, { deadlineMs: 10 })
  const reset = await api.newContext().catch((error: unknown) => error)
  const compaction = await api.compact().catch((error: unknown) => error)
  expect(reset).toBeInstanceOf(ChatContextDeadlineError)
  expect(compaction).toBeInstanceOf(ChatContextDeadlineError)
  expect(signals.map((signal) => signal.aborted)).toEqual([true, true])
})

test('a reset the core answers in time is not refused by the deadline', async () => {
  const quick = {
    chat: {
      newContext: async () => ({ generation: 1, flushed: true }),
      compact: async () => ({ generation: 1, flushed: true }),
    },
  }
  const api = chatContextApiOf({ rpc: quick } as never, { deadlineMs: 1_000 })
  expect(await api.newContext()).toEqual({ generation: 1, flushed: true })
  expect(await api.compact()).toEqual({ generation: 1, flushed: true })
})
