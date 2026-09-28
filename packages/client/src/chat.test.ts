import { afterEach, describe, expect, test } from 'bun:test'
import type { NodeId, ThreadDto } from '@keith/protocol'
import { type FakeCore, type FakeCoreOptions, startFakeCore } from '../test/fake-core.ts'
import { waitUntil } from '../test/wait.ts'
import { backoffDelay, type ChatClient, createChatClient } from './chat.ts'
import { login } from './http.ts'
import { authorName, type ChatState, type MessageEntry, relayFrom, type ToolEntry } from './state.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

type SetupOptions = FakeCoreOptions & {
  nodeId?: NodeId
  capabilities?: string[]
  historyLimit?: number
  historyPageSize?: number
  /** Runs on the fake core before the client connects (e.g. `addGroup`). */
  prepare?: (core: FakeCore) => void
}

async function setup(opts: SetupOptions = {}) {
  const core = startFakeCore(opts)
  cleanups.push(() => core.stop())
  opts.prepare?.(core)
  const { token } = await login(core.url, { username: 'tony', password: 'jarvis' })
  const states: ChatState[] = []
  const nodeIds: string[] = []
  const threadLists: ThreadDto[][] = []
  const client = createChatClient({
    baseUrl: core.url,
    token,
    nodeId: opts.nodeId,
    client: { name: 'keith-tui', version: '0.0.0' },
    onState: (s) => states.push(s),
    onNodeId: (id) => nodeIds.push(id),
    onThreads: (threads) => threadLists.push(threads),
    backoff: { initialMs: 10, maxMs: 50, factor: 2 },
    capabilities: opts.capabilities,
    historyLimit: opts.historyLimit,
    historyPageSize: opts.historyPageSize,
  })
  cleanups.push(() => client.close())
  client.start()
  await waitUntil(() => client.state.thread !== null, 3000, 'thread.opened')
  return { core, client, states, nodeIds, token, threadLists }
}

function messages(client: ChatClient): MessageEntry[] {
  return client.state.entries.filter((e): e is MessageEntry => e.kind === 'message')
}

describe('chat client against the fake core', () => {
  test('logs in, opens the main thread, sends, streams and shows the final message', async () => {
    const { core, client, states } = await setup()
    expect(core.received[0]).toMatchObject({
      type: 'hello',
      data: { protocol: 1, client: { name: 'keith-tui' }, capabilities: ['chat.text@1'] },
    })
    expect(core.received[1]).toMatchObject({ type: 'thread.open', data: {} })
    expect(client.state.thread?.id).toBe(core.thread.id)
    expect(client.state.person).toEqual(core.person)

    expect(client.send('  Research venue options.  ')).toEqual({ ok: true })
    expect(core.received.length).toBeGreaterThanOrEqual(2)
    // `thread.state idle` follows `message.completed` in a separate frame: wait for both, so the
    // final turnState check below never races the last frame.
    await waitUntil(
      () =>
        messages(client).some((m) => m.role === 'assistant' && !m.streaming) &&
        client.state.turnState === 'idle',
      3000,
      'reply',
    )

    expect(core.received.find((f) => f.type === 'input.text')).toMatchObject({
      data: { threadId: core.thread.id, text: 'Research venue options.' },
    })
    expect(messages(client).map((m) => [m.role, m.text])).toEqual([
      ['user', 'Research venue options.'],
      ['assistant', 'You said: Research venue options.'],
    ])
    // The turn went through thinking and speaking, streamed partial text, and ended idle.
    const turnStates = new Set(states.map((s) => s.turnState))
    expect(turnStates.has('thinking')).toBe(true)
    expect(turnStates.has('speaking')).toBe(true)
    const partial = states.some((s) =>
      s.entries.some(
        (e) =>
          e.kind === 'message' &&
          e.streaming &&
          e.text.length > 0 &&
          e.text !== 'You said: Research venue options.',
      ),
    )
    expect(partial).toBe(true)
    expect(client.state.turnState).toBe('idle')
  })

  test('tool activity lines appear during the turn', async () => {
    const { client } = await setup({ toolActivity: true })
    client.send('search something')
    await waitUntil(() => client.state.turnState === 'idle' && messages(client).length === 2, 3000, 'reply')
    const tool = client.state.entries.find((e): e is ToolEntry => e.kind === 'tool')
    expect(tool).toMatchObject({ name: 'web.search', status: 'completed', summary: '3 results' })
  })

  test('S-2: an unsolicited proactive message arrives without any input', async () => {
    const { core, client } = await setup()
    await core.pushProactive('Sir, the venue shortlist is ready.')
    await waitUntil(() => messages(client).some((m) => !m.streaming && m.proactive), 3000, 'proactive')
    expect(messages(client)).toMatchObject([
      { role: 'assistant', proactive: true, text: 'Sir, the venue shortlist is ready.' },
    ])
  })

  test('persists the node id from welcome and sends it back in hello', async () => {
    const first = await setup()
    expect(first.nodeIds).toEqual([first.core.nodeId])
    const second = await setup({ nodeId: first.core.nodeId })
    expect(second.core.received[0]).toMatchObject({ type: 'hello', data: { nodeId: first.core.nodeId } })
    expect(second.nodeIds).toEqual([])
  })

  test('answers ping with pong', async () => {
    const { core } = await setup()
    const [id] = core.ping()
    await waitUntil(() => core.received.some((f) => f.type === 'pong'), 3000, 'pong')
    expect(core.received.find((f) => f.type === 'pong')).toMatchObject({ re: id, data: {} })
  })

  test('reconnects with backoff after the core restarts and restores the thread', async () => {
    const { core, client, states } = await setup()
    client.send('before restart')
    await waitUntil(() => messages(client).length === 2 && client.state.turnState === 'idle', 3000, 'reply')

    await core.stop()
    await waitUntil(() => client.state.connection.kind === 'reconnecting', 3000, 'reconnecting')
    await core.restart()
    await waitUntil(() => core.hellos === 2 && client.state.connection.kind === 'online', 5000, 'reconnected')
    // `online` is set on welcome; the reopen's thread.open follows it, so wait for the core to receive it.
    const threadOpens = () => core.received.filter((f) => f.type === 'thread.open').length
    await waitUntil(() => threadOpens() === 2, 3000, 'thread reopened')
    await waitUntil(() => messages(client).length === 2, 3000, 'history')

    const reopen = core.received.filter((f) => f.type === 'thread.open').at(-1)
    expect(reopen).toMatchObject({ data: { threadId: core.thread.id } })
    expect(messages(client).map((m) => m.text)).toEqual(['before restart', 'You said: before restart'])
    expect(states.some((s) => s.connection.kind === 'reconnecting')).toBe(true)

    // Still usable after the reconnect.
    expect(client.send('after restart')).toEqual({ ok: true })
    await waitUntil(() => messages(client).length === 4, 3000, 'second reply')
  })

  test('4003 stops reconnecting and asks for a new login', async () => {
    const { core, client } = await setup()
    core.revokeTokens()
    core.dropConnections(1001)
    await waitUntil(() => client.state.connection.kind === 'auth-required', 3000, 'auth-required')
    const hellos = core.hellos
    await Bun.sleep(80)
    expect(core.hellos).toBe(hellos)
  })

  test('cancel sends input.cancel only while a turn runs', async () => {
    const { core, client } = await setup({ reply: () => 'one two three four five six seven eight nine ten' })
    expect(client.cancel()).toBe(false)
    client.send('go')
    await waitUntil(() => client.state.turnState !== 'idle', 3000, 'turn start')
    expect(client.cancel()).toBe(true)
    await waitUntil(() => core.received.some((f) => f.type === 'input.cancel'), 3000, 'input.cancel')
    expect(core.received.find((f) => f.type === 'input.cancel')).toMatchObject({
      data: { threadId: core.thread.id },
    })
  })

  test('refuses empty, too long and offline sends', async () => {
    const { core, client } = await setup()
    expect(client.send('   ')).toEqual({ ok: false, reason: 'empty' })
    expect(client.send('x'.repeat(16_001))).toEqual({ ok: false, reason: 'too-long' })
    await core.stop()
    await waitUntil(() => client.state.connection.kind !== 'online', 3000, 'offline')
    expect(client.send('hello')).toEqual({ ok: false, reason: 'offline' })
  })

  test('close stops the client for good', async () => {
    const { core, client } = await setup()
    client.close()
    expect(client.state.connection).toEqual({ kind: 'closed', reason: 'closed by user' })
    await Bun.sleep(50)
    expect(core.hellos).toBe(1)
  })
})

describe('phase-2 client features', () => {
  test('S-2: a proactive message arriving during a streamed reply stays separate', async () => {
    const { core, client } = await setup({ tickMs: 20, reply: () => 'one two three four five six' })
    client.send('go')
    await waitUntil(() => client.state.turnState === 'speaking', 3000, 'speaking')
    await core.pushProactive('Sir, a reminder.')
    await waitUntil(
      () => client.state.turnState === 'idle' && messages(client).every((m) => !m.streaming),
      3000,
      'both done',
    )
    const assistant = messages(client).filter((m) => m.role === 'assistant')
    expect(assistant.map((m) => [m.text, m.proactive]).sort()).toEqual([
      ['Sir, a reminder.', true],
      ['one two three four five six', false],
    ])
  })

  test('4003 → sign in again → reconnect restores the thread with the new token', async () => {
    const { core, client } = await setup()
    client.send('before')
    await waitUntil(() => messages(client).length === 2 && client.state.turnState === 'idle', 3000, 'reply')
    core.revokeTokens()
    core.dropConnections(1001)
    await waitUntil(() => client.state.connection.kind === 'auth-required', 3000, 'auth-required')

    const { token } = await login(core.url, { username: 'tony', password: 'jarvis' })
    client.reconnect(token)
    await waitUntil(() => core.hellos === 2 && client.state.connection.kind === 'online', 3000, 'online')
    const threadOpens = () => core.received.filter((f) => f.type === 'thread.open')
    await waitUntil(() => threadOpens().length === 2, 3000, 'thread reopened')
    expect(threadOpens().at(-1)).toMatchObject({ data: { threadId: core.thread.id } })
    await waitUntil(() => messages(client).length === 2, 3000, 'history')
    expect(client.send('after')).toEqual({ ok: true })
    await waitUntil(() => messages(client).length === 4, 3000, 'second reply')
  })

  test('reconnect after close() does nothing', async () => {
    const { core, client } = await setup()
    client.close()
    client.reconnect()
    await Bun.sleep(50)
    expect(core.hellos).toBe(1)
    expect(client.state.connection.kind).toBe('closed')
  })

  test('ui.render blocks attach to the streamed message for a ui.render@1 node', async () => {
    const block = { type: 'card', id: 'weather', title: 'Paris', body: '22°C' } as const
    const { core, client, states } = await setup({
      capabilities: ['chat.text@1', 'ui.render@1'],
      replyUi: () => block,
    })
    expect(core.received[0]).toMatchObject({ data: { capabilities: ['chat.text@1', 'ui.render@1'] } })
    client.send('weather?')
    // The block arrives while the message is still streaming.
    await waitUntil(() => client.state.turnState === 'idle' && messages(client).length === 2, 3000, 'done')
    const streamedWithUi = states.some((st) =>
      st.entries.some((e) => e.kind === 'message' && e.streaming && e.ui.length === 1),
    )
    expect(streamedWithUi).toBe(true)
    const reply = messages(client)[1]
    expect(reply?.ui).toEqual([{ block, fallbackText: 'Paris\n22°C' }])

    core.pushUi({ type: 'markdown', id: 'note', text: 'floating' })
    await waitUntil(() => client.state.entries.some((e) => e.kind === 'ui'), 3000, 'floating block')
    expect(client.state.entries.at(-1)).toMatchObject({ kind: 'ui', fallbackText: 'floating' })
  })

  test('a node without ui.render@1 gets no ui.render frames', async () => {
    const { client, states } = await setup({ replyUi: () => ({ type: 'markdown', id: 'n', text: 'x' }) })
    client.send('hi')
    await waitUntil(() => client.state.turnState === 'idle' && messages(client).length === 2, 3000, 'done')
    // The final message still carries the block from the DTO; the node may show its fallback text.
    expect(messages(client)[1]?.ui).toEqual([
      { block: { type: 'markdown', id: 'n', text: 'x' }, fallbackText: 'x' },
    ])
    expect(client.state.entries.some((e) => e.kind === 'ui')).toBe(false)
    // No block ever showed up while the message was streaming, i.e. no ui.render frame came in.
    const streamedWithUi = states.some((st) =>
      st.entries.some((e) => e.kind === 'message' && e.streaming && e.ui.length > 0),
    )
    expect(streamedWithUi).toBe(false)
  })

  test('sendUiAction sends ui.action for the open thread', async () => {
    const { core, client } = await setup({ capabilities: ['chat.text@1', 'ui.render@1'] })
    const messageId = 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V33'
    expect(client.sendUiAction({ messageId, blockId: 'confirm', actionId: 'book', value: { n: 1 } })).toEqual(
      {
        ok: true,
      },
    )
    expect(client.sendUiAction({ messageId, blockId: 'confirm', actionId: 'more' })).toEqual({ ok: true })
    await waitUntil(() => core.received.filter((f) => f.type === 'ui.action').length === 2, 3000, 'ui.action')
    const actions = core.received.filter((f) => f.type === 'ui.action')
    expect(actions[0]).toMatchObject({
      data: { threadId: core.thread.id, messageId, blockId: 'confirm', actionId: 'book', value: { n: 1 } },
    })
    expect(actions[1]?.data).not.toHaveProperty('value')

    expect(client.sendUiAction({ messageId: 'local:1', blockId: 'confirm', actionId: 'book' })).toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(client.sendUiAction({ messageId, blockId: 'Bad Id', actionId: 'book' })).toMatchObject({
      ok: false,
    })
    await core.stop()
    await waitUntil(() => client.state.connection.kind !== 'online', 3000, 'offline')
    expect(client.sendUiAction({ messageId, blockId: 'confirm', actionId: 'book' })).toEqual({
      ok: false,
      reason: 'offline',
    })
  })

  test('loadOlder pages back through history until there is no more', async () => {
    const { client } = await setup({ history: 7, historyLimit: 3, historyPageSize: 2 })
    const texts = () => messages(client).map((m) => m.text)
    expect(texts()).toEqual(['history 5', 'history 6', 'history 7'])
    expect(client.state.history).toEqual({ hasMore: true, loading: false })

    const first = client.loadOlder()
    expect(client.state.history.loading).toBe(true)
    expect(await client.loadOlder()).toEqual({ ok: false, reason: 'busy' })
    expect(await first).toEqual({ ok: true, added: 2 })
    expect(texts()).toEqual(['history 3', 'history 4', 'history 5', 'history 6', 'history 7'])
    expect(await client.loadOlder()).toEqual({ ok: true, added: 2 })
    expect(client.state.history.hasMore).toBe(false)
    expect(texts()[0]).toBe('history 1')
    expect(await client.loadOlder()).toEqual({ ok: false, reason: 'no-more' })
  })

  test('a short first page means there is no older history', async () => {
    const { client } = await setup({ history: 2, historyLimit: 5 })
    expect(client.state.history.hasMore).toBe(false)
  })

  test('loadOlder reports a failure as a notice', async () => {
    const { core, client } = await setup({ history: 4, historyLimit: 2 })
    core.revokeTokens()
    const result = await client.loadOlder()
    expect(result).toMatchObject({ ok: false, reason: 'failed' })
    expect(client.state.history).toEqual({ hasMore: true, loading: false })
    expect(client.state.entries.at(-1)).toMatchObject({ kind: 'notice', level: 'error' })
  })
})

describe('phase 5: thread list and switching threads', () => {
  const pepper = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V40', name: 'Pepper', tier: 'member' } as const
  const rhodey = { id: 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V41', name: 'Rhodey', tier: 'guest' } as const
  let mission: ThreadDto

  const withGroup = (opts: SetupOptions = {}) =>
    setup({
      ...opts,
      prepare: (core) => {
        mission = core.addGroup({
          title: 'Mission',
          purpose: 'Plan the Expo launch.',
          others: [pepper],
          messages: [
            { content: 'Venue ideas?', authorPersonId: pepper.id },
            { content: 'Three options.', authorPersonId: null },
          ],
        })
      },
    })

  const threadIds = (client: ChatClient) => client.state.threads.map((t) => t.id)
  const sentTypes = (core: FakeCore, from: number) =>
    core.received.slice(from).flatMap((f) => (f.type === 'pong' ? [] : [f.type]))

  test('loads the thread list on connect, most recent first, and reports it through onThreads', async () => {
    const { core, client, threadLists } = await withGroup()
    await waitUntil(() => client.state.threads.length === 2, 3000, 'thread list')
    expect(threadIds(client)).toEqual([mission.id, core.thread.id])
    expect(threadLists.at(-1)).toBe(client.state.threads)
  })

  test('thread.updated and thread.removed keep the list current', async () => {
    const { core, client } = await setup()
    await waitUntil(() => client.state.threads.length === 1, 3000, 'thread list')
    const group = core.addGroup({ title: 'Party', others: [pepper] })
    await waitUntil(() => client.state.threads.length === 2, 3000, 'thread.updated')
    expect(client.state.threads[0]).toEqual(group)
    const joined = { ...group, participants: [...group.participants, rhodey], updatedAt: group.updatedAt + 1 }
    core.pushThreadUpdated(joined)
    await waitUntil(() => client.state.threads[0]?.participants.length === 3, 3000, 'joined')
    core.pushThreadRemoved(group.id)
    await waitUntil(() => client.state.threads.length === 1, 3000, 'thread.removed')
    expect(threadIds(client)).toEqual([core.thread.id])
    // The open thread did not change.
    expect(client.state.thread?.id).toBe(core.thread.id)
  })

  test('openThread sends thread.close then thread.open, and shows the group with its authors', async () => {
    const { core, client } = await withGroup()
    const from = core.received.length
    expect(client.openThread(mission.id)).toEqual({ ok: true })
    // The old conversation is gone at once; nothing can be sent until the new one is open.
    expect(client.state.thread).toBeNull()
    expect(client.send('too early')).toEqual({ ok: false, reason: 'offline' })
    await waitUntil(() => client.state.thread?.id === mission.id, 3000, 'group opened')
    expect(core.received.slice(from).filter((f) => f.type.startsWith('thread.'))).toMatchObject([
      { type: 'thread.close', data: { threadId: core.thread.id } },
      { type: 'thread.open', data: { threadId: mission.id } },
    ])
    expect(core.openThreads()).toEqual([mission.id])
    expect(messages(client).map((m) => [authorName(client.state, m), m.text])).toEqual([
      ['Pepper', 'Venue ideas?'],
      [null, 'Three options.'],
    ])

    // Input goes to the group.
    client.send('Book the second one.')
    await waitUntil(
      () =>
        messages(client).length === 4 && !messages(client)[3]?.streaming && client.state.turnState === 'idle',
      3000,
      'group reply',
    )
    expect(core.received.find((f) => f.type === 'input.text')).toMatchObject({
      data: { threadId: mission.id },
    })
    expect(core.messagesOf(mission.id)).toHaveLength(4)
    expect(authorName(client.state, messages(client)[2] as MessageEntry)).toBe('Tony')

    // Opening the open thread again sends nothing; a bad id is refused.
    const count = core.received.length
    expect(client.openThread(mission.id)).toEqual({ ok: true })
    expect(client.openThread('nope' as ThreadDto['id'])).toEqual({ ok: false, reason: 'invalid' })
    expect(sentTypes(core, count)).toEqual([])

    // And back to main.
    expect(client.openThread(core.thread.id)).toEqual({ ok: true })
    await waitUntil(() => client.state.thread?.id === core.thread.id, 3000, 'main again')
    expect(sentTypes(core, count)).toEqual(['thread.close', 'thread.open'])
  })

  test('openThread is refused while offline', async () => {
    const { core, client } = await withGroup()
    await core.stop()
    await waitUntil(() => client.state.connection.kind === 'reconnecting', 3000, 'reconnecting')
    expect(client.openThread(mission.id)).toEqual({ ok: false, reason: 'offline' })
  })

  test('a reconnect reopens the thread opened last', async () => {
    const { core, client } = await withGroup()
    client.openThread(mission.id)
    await waitUntil(() => client.state.thread?.id === mission.id, 3000, 'group opened')
    await core.stop()
    await waitUntil(() => client.state.connection.kind === 'reconnecting', 3000, 'reconnecting')
    await core.restart()
    await waitUntil(() => core.hellos === 2 && client.state.thread?.id === mission.id, 5000, 'reopened')
    const reopen = core.received.filter((f) => f.type === 'thread.open').at(-1)
    expect(reopen).toMatchObject({ data: { threadId: mission.id } })
    expect(messages(client).map((m) => m.text)).toEqual(['Venue ideas?', 'Three options.'])
  })

  test('thread.removed of the open thread switches to main with a notice', async () => {
    const { core, client } = await withGroup()
    client.openThread(mission.id)
    await waitUntil(() => client.state.thread?.id === mission.id, 3000, 'group opened')
    const from = core.received.length
    core.pushThreadRemoved(mission.id)
    await waitUntil(() => client.state.thread?.id === core.thread.id, 3000, 'back to main')
    expect(core.received.slice(from).filter((f) => f.type.startsWith('thread.'))).toMatchObject([
      { type: 'thread.open', data: {} },
    ])
    expect(core.received.at(-1)?.data).not.toHaveProperty('threadId')
    expect(threadIds(client)).toEqual([core.thread.id])
    await waitUntil(() => client.state.entries.some((e) => e.kind === 'notice'), 3000, 'notice')
    expect(client.state.entries.filter((e) => e.kind === 'notice')).toMatchObject([
      { level: 'info', text: 'You are no longer in Mission.' },
    ])
  })

  test('a thread the core refuses to open (left while offline) falls back to main', async () => {
    const { core, client } = await withGroup()
    client.openThread(mission.id)
    await waitUntil(() => client.state.thread?.id === mission.id, 3000, 'group opened')
    await core.stop()
    await waitUntil(() => client.state.connection.kind === 'reconnecting', 3000, 'reconnecting')
    // Left while offline: no thread.removed reached this node.
    core.threads.splice(core.threads.indexOf(mission), 1)
    await core.restart()
    await waitUntil(() => core.hellos === 2 && client.state.thread?.id === core.thread.id, 5000, 'main')
    expect(core.received.filter((f) => f.type === 'thread.open').slice(-2)).toMatchObject([
      { data: { threadId: mission.id } },
      { data: {} },
    ])
    await waitUntil(() => client.state.threads.length === 1, 3000, 'list reloaded')
  })

  test('a relayed message carries its senders', async () => {
    const { core, client } = await setup()
    await core.pushProactive('Pepper says the kids are asleep.', {
      relayFrom: [{ personId: pepper.id, name: 'Pepper' }],
    })
    await waitUntil(() => messages(client).some((m) => !m.streaming), 3000, 'relay')
    const [entry] = messages(client)
    expect(entry && relayFrom(entry)).toEqual(['Pepper'])
    expect(entry && authorName(client.state, entry)).toBeNull()
  })
})

describe('backoff', () => {
  test('grows exponentially up to the maximum', () => {
    const backoff = { initialMs: 500, maxMs: 15_000, factor: 2 }
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => backoffDelay(backoff, a))).toEqual([
      500, 1000, 2000, 4000, 8000, 15_000, 15_000,
    ])
  })
})
