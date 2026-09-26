import { afterEach, describe, expect, test } from 'bun:test'
import type { NodeId } from '@keith/protocol'
import { type FakeCoreOptions, startFakeCore } from '../test/fake-core.ts'
import { waitUntil } from '../test/helpers.ts'
import { login } from './api.ts'
import { backoffDelay, type ChatClient, createChatClient } from './client.ts'
import type { ChatState, MessageEntry } from './state.ts'
import { entryText } from './view.ts'

const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function setup(opts: FakeCoreOptions & { nodeId?: NodeId } = {}) {
  const core = startFakeCore(opts)
  cleanups.push(() => core.stop())
  const { token } = await login(core.url, { username: 'tony', password: 'jarvis' })
  const states: ChatState[] = []
  const nodeIds: string[] = []
  const client = createChatClient({
    baseUrl: core.url,
    token,
    nodeId: opts.nodeId,
    client: { name: 'keith-tui', version: '0.0.0' },
    onState: (s) => states.push(s),
    onNodeId: (id) => nodeIds.push(id),
    backoff: { initialMs: 10, maxMs: 50, factor: 2 },
  })
  cleanups.push(() => client.close())
  client.start()
  await waitUntil(() => client.state.thread !== null, 3000, 'thread.opened')
  return { core, client, states, nodeIds, token }
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
    await waitUntil(() => messages(client).some((m) => m.role === 'assistant' && !m.streaming), 3000, 'reply')

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
    const tool = client.state.entries.find((e) => e.kind === 'tool')
    expect(tool && entryText(tool)).toBe('  ⚙ web.search ✓ 3 results')
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

  test('Esc cancel sends input.cancel only while a turn runs', async () => {
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

describe('backoff', () => {
  test('grows exponentially up to the maximum', () => {
    const backoff = { initialMs: 500, maxMs: 15_000, factor: 2 }
    expect([1, 2, 3, 4, 5, 6, 7].map((a) => backoffDelay(backoff, a))).toEqual([
      500, 1000, 2000, 4000, 8000, 15_000, 15_000,
    ])
  })
})
