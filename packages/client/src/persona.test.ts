import { afterAll, expect, test } from 'bun:test'
import { createKeithClient } from './client.ts'
import { type PersonaFeed, watchPersona } from './persona.ts'

// The persona wrapper: each method calls the `rpc.persona.*` procedure of the same name with its input, over the typed client.
const requests: Array<{ path: string; input: unknown }> = []
const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (!url.pathname.startsWith('/rpc/persona/')) return new Response('not found', { status: 404 })
    const body = (await request.json()) as { json?: unknown }
    requests.push({ path: url.pathname, input: body.json })
    if (url.pathname.endsWith('/style/get') || url.pathname.endsWith('/style/set'))
      return Response.json({
        json: {
          address: null,
          language: 'auto',
          brevity: 'short',
          formality: 'neutral',
          gentleTopics: [],
        },
      })
    if (url.pathname.endsWith('/history')) return Response.json({ json: [] })
    return Response.json({
      json: {
        version: 1,
        templateId: 'professional',
        updatedAt: 1,
        body: {
          tone: 'Plain.',
          attitude: '',
          humour: 'none',
          addressing: '',
          caresAbout: '',
          lines: { answerFailed: 'No.', guestUnavailable: 'No.' },
        },
      },
    })
  },
})
afterAll(() => server.stop(true))

test('personaApiOf calls each persona procedure with its input', async () => {
  const client = createKeithClient({ baseUrl: server.url.href, token: 'keith_t' })
  await client.persona.get()
  await client.persona.history()
  await client.persona.setTemplate({ templateId: 'friend' })
  await client.persona.edit({ patch: { tone: 'Plain.' } })
  await client.persona.restore({ version: 1 })
  await client.persona.style.get()
  await client.persona.style.set({ patch: { brevity: 'short' } })
  await client.persona.style.read({ personId: 'ana' })
  expect(requests.map((r) => r.path)).toEqual([
    '/rpc/persona/get',
    '/rpc/persona/history',
    '/rpc/persona/setTemplate',
    '/rpc/persona/edit',
    '/rpc/persona/restore',
    '/rpc/persona/style/get',
    '/rpc/persona/style/set',
    '/rpc/persona/style/read',
  ])
  expect(requests[2]?.input).toEqual({ templateId: 'friend' })
  expect(requests[3]?.input).toEqual({ patch: { tone: 'Plain.' } })
  expect(requests[4]?.input).toEqual({ version: 1 })
  expect(requests[6]?.input).toEqual({ patch: { brevity: 'short' } })
  expect(requests[7]?.input).toEqual({ personId: 'ana' })
})

/** A feed double: the test emits records and resyncs by hand, and counts the listeners it holds. */
function fakeFeed() {
  const events = new Set<(record: { type: string; payload: unknown }) => void>()
  const resyncs = new Set<(reason: string) => void>()
  const feed: PersonaFeed = {
    subscribeEvents: (fn) => {
      events.add(fn)
      return () => events.delete(fn)
    },
    subscribeResync: (fn) => {
      resyncs.add(fn)
      return () => resyncs.delete(fn)
    },
  }
  return {
    feed,
    emit: (type: string, payload: unknown) => {
      for (const fn of [...events]) fn({ type, payload })
    },
    resync: () => {
      for (const fn of [...resyncs]) fn('resync')
    },
    listeners: () => events.size + resyncs.size,
  }
}

test('watchPersona refetches on persona.changed and on a feed resync, and nothing else', () => {
  const fake = fakeFeed()
  let refetches = 0
  const off = watchPersona({ feed: fake.feed, refetch: () => refetches++ })
  fake.emit('persona.changed', { version: 2, reason: 'template' })
  expect(refetches).toBe(1)
  fake.emit('persona.changed', { version: 3, reason: 'edit' })
  expect(refetches).toBe(2)
  fake.emit('persona.changed', { reason: 'edit' })
  fake.emit('room.event', { seq: 1 })
  expect(refetches).toBe(2)
  fake.resync()
  expect(refetches).toBe(3)
  off()
  expect(fake.listeners()).toBe(0)
  fake.emit('persona.changed', { version: 4, reason: 'restore' })
  fake.resync()
  expect(refetches).toBe(3)
})
