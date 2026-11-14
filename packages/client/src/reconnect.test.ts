import { afterAll, beforeEach, expect, setDefaultTimeout, test } from 'bun:test'
import type { ChatBridge } from 'eharness/client'
import { CHAT_CLIP, createKeithClient } from './client.ts'

// every wait below is bounded by `until` (15 s, 20 s for the health ping): the test limit is above
setDefaultTimeout(30_000)

const enc = new TextEncoder()
const urls: string[] = []
const feeds = new Set<ReadableStreamDefaultController<Uint8Array>>()
let running = false
let health = 0
let down = false
let client0: ReturnType<typeof createKeithClient>

const server = Bun.serve({
  port: 0,
  idleTimeout: 0,
  fetch(request) {
    const url = new URL(request.url)
    urls.push(url.pathname + url.search)
    if (url.pathname === '/activity/stream') {
      return new Response(
        new ReadableStream({
          start(c) {
            feeds.add(c)
            c.enqueue(enc.encode('retry: 100\n\nevent: boot\ndata: {"boot":"b1"}\n\n'))
          },
          cancel() {
            feeds.clear()
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    }
    if (url.pathname === '/health') {
      health++
      return Response.json({ status: 'ok', boot: 'b1' })
    }
    if (url.pathname === '/sessions/s1/messages') return Response.json({ messages: [] })
    if (url.pathname === '/sessions/s1' && down) return new Response('down', { status: 503 })
    if (url.pathname === '/sessions/s1') {
      return Response.json({
        id: 's1',
        running,
        busy: null,
        activeTurn: null,
        pending: null,
        usage: null,
      })
    }
    return new Response('not found', { status: 404 })
  },
})
afterAll(() => server.stop(true))
beforeEach(() => {
  running = false
  down = false
  health = 0
  urls.length = 0
})

const count = (prefix: string): number => urls.filter((u) => u.startsWith(prefix)).length
const exact = (): number => urls.filter((u) => u === '/sessions/s1').length
const until = async (check: () => boolean, what: string, ms = 15_000): Promise<void> => {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`)
    await Bun.sleep(15)
  }
}

function bridge(status: ChatBridge['status'] = 'ready') {
  const state = { resumed: 0, status }
  const chat: ChatBridge = {
    messages: [],
    get status() {
      return state.status
    },
    sendMessage: async () => undefined,
    regenerate: async () => undefined,
    resumeStream: async () => {
      state.resumed++
    },
    stop: async () => undefined,
    clearError: () => undefined,
  }
  return { chat, state }
}

async function ready() {
  const client = createKeithClient({ baseUrl: server.url.href, token: 't' })
  const session = client.chat('s1')
  const b = bridge()
  session.bind(b.chat)
  await session.init()
  const feed = client.feed()
  feed.start()
  await until(() => feed.get().boot === 'b1', 'the first boot id')
  // the feed's first `connect` resync makes the idle chat recover (messages, then the snapshot):
  // let it finish, or its late requests land inside the window a test counts
  await until(() => count('/sessions/s1/messages') >= 2 && exact() >= 2, 'the connect recovery')
  client0 = client
  return { client, session, feed, ...b }
}

const reboot = (id: string): void => {
  for (const c of feeds) c.enqueue(enc.encode(`event: boot\ndata: {"boot":"${id}"}\n\n`))
}

test('chat() reads history with the clip', async () => {
  const { feed } = await ready()
  feed.stop()
  expect(CHAT_CLIP).toBe(2000)
  expect(urls.some((u) => u.startsWith('/sessions/s1/messages') && u.includes('clip=2000'))).toBe(
    true,
  )
})

test('a core restart refetches the history and does not follow an idle session', async () => {
  const { feed, state } = await ready()
  const before = count('/sessions/s1/messages')
  reboot('b2')
  await until(() => count('/sessions/s1/messages') > before, 'the refetch after the restart')
  feed.stop()
  expect(state.resumed).toBe(0)
})

test('a core restart follows the turn when the snapshot says it still runs', async () => {
  const { feed, state } = await ready()
  running = true
  reboot('b2')
  await until(() => state.resumed > 0, 'follow() after the restart')
  feed.stop()
})

test('a busy chat is left alone by a restart (its own reader and checkStalled handle it)', async () => {
  const { feed, session, state } = await ready()
  state.status = 'streaming'
  session.refreshBusy()
  const before = count('/sessions/s1/messages')
  reboot('b2')
  await until(() => feed.get().boot === 'b2', 'the new boot id')
  await Bun.sleep(300)
  feed.stop()
  expect(count('/sessions/s1/messages')).toBe(before)
  expect(state.resumed).toBe(0)
})

test('the feed pings /health while a chat is busy', async () => {
  const { feed, session, state } = await ready()
  state.status = 'streaming'
  session.refreshBusy()
  await until(() => health > 0, 'a health ping while busy', 20_000)
  feed.stop()
})

test('an error notice on an idle attached session asks the core and follows the running turn', async () => {
  const { feed, session, state } = await ready()
  running = true
  const before = count('/sessions/s1/messages')
  client0.reportChatNotice(session, 'info')
  await Bun.sleep(150)
  expect(state.resumed).toBe(0)
  client0.reportChatNotice(session, 'error')
  await until(() => state.resumed > 0, 'follow() after the failed send')
  // follow() refetches the stored messages (the stored user message replaces the optimistic one)
  await until(() => count('/sessions/s1/messages') > before, 'the refetch')
  feed.stop()
})

test('a failed send while the core is unreachable is retried when it answers again', async () => {
  const { feed, session, state } = await ready()
  running = true
  down = true
  client0.reportChatNotice(session, 'error')
  await Bun.sleep(300)
  expect(state.resumed).toBe(0)
  down = false
  await until(() => state.resumed > 0, 'follow() once the core is back', 10_000)
  feed.stop()
})

test('a notice for a session that is not attached does nothing', async () => {
  const { feed, client } = await ready()
  const other = client.chat('s1')
  const b = bridge()
  other.bind(b.chat)
  client.reportChatNotice({ ...other, sessionId: 'x' } as typeof other, 'error')
  await Bun.sleep(100)
  expect(b.state.resumed).toBe(0)
  feed.stop()
})
