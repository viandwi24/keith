// P3-H2: welcome failure closes the socket (B7), chat.text@1 enforcement (C3), notices (C1),
// RATE_LIMITED pass-through (C2) and historyLimit pass-through (B5).

import { afterEach, describe, expect, test } from 'bun:test'
import type { MessageDto } from '@keith/protocol'
import { KeithError, type KeithErrorCode } from '@keith/sdk'
import type { PluginStatus } from '../plugins/types.ts'
import type { NodeId } from '../shared/types.ts'
import type { PersonRecord } from '../storage/types.ts'
import {
  connect,
  eventually,
  login,
  personId,
  startTestServer,
  type TestServer,
  type TestServerOptions,
} from './test-fakes.ts'

let t: TestServer | null = null
afterEach(async () => {
  await t?.stop()
  t = null
})

async function setup(opts: TestServerOptions = {}) {
  t = await startTestServer(opts)
  return t
}

const FAILED: PluginStatus = {
  id: '@keith/tool-weather',
  namespace: 'weather',
  version: '0.1.0',
  kind: 'tool',
  state: 'failed',
  error: { stage: 'setup', message: 'missing apiKey' },
}
const STARTED: PluginStatus = {
  ...FAILED,
  id: '@keith/web',
  namespace: 'web',
  state: 'started',
  error: undefined,
}

describe('welcome failure (B7)', () => {
  test('an invalid welcome closes the socket with 1011 and no node.connected', async () => {
    const s = await setup()
    const token = await login(s)
    const owner = s.repos.data.persons.get(s.owner.id) as PersonRecord
    // A tier the protocol doesn't know makes the welcome's PersonDto invalid.
    s.repos.data.persons.set(owner.id, { ...owner, tier: 'superuser' as PersonRecord['tier'] })
    const client = await connect(s.wsUrl(token))
    client.send('hello', { protocol: 1, client: { name: 'x', version: '1' }, capabilities: ['chat.text@1'] })
    expect((await client.closed).code).toBe(1011)
    expect(client.frames.filter((f) => f.type === 'welcome')).toEqual([])
    expect(s.events.named('node.connected')).toEqual([])
    expect(s.events.named('node.disconnected')).toEqual([])
  })
})

describe('chat.text@1 (C3)', () => {
  test('input.text from a node without chat.text@1 gets FORBIDDEN', async () => {
    const s = await setup()
    const client = await connect(s.wsUrl(await login(s)))
    await client.hello({ capabilities: ['audio.in@1'] })
    client.send('thread.open', {})
    const thread = (await client.next('thread.opened')).data.thread as { id: string }
    const id = client.send('input.text', { threadId: thread.id, text: 'hi' })
    const error = await client.next('error')
    expect(error.data.code).toBe('FORBIDDEN')
    expect(error.re).toBe(id)
    expect(s.threads.calls.input).toEqual([])
  })

  test('message.* frames reach only nodes with chat.text@1; chat.text@1 nodes see no change', async () => {
    const s = await setup()
    const chat = await connect(s.wsUrl(await login(s)))
    const chatNode = (await chat.hello()).data.nodeId as NodeId
    const voice = await connect(s.wsUrl(await login(s)))
    const voiceNode = (await voice.hello({ capabilities: ['audio.in@1', 'audio.out@1'] })).data
      .nodeId as NodeId
    chat.send('thread.open', {})
    voice.send('thread.open', {})
    const thread = (await chat.next('thread.opened')).data.thread as { id: MessageDto['threadId'] }
    await voice.next('thread.opened')
    const messageId = 'msg_00000000000000000000000001' as MessageDto['id']
    for (const node of s.attachments.attachedTo(thread.id)) {
      s.attachments.send(node, {
        v: 1,
        type: 'message.started',
        id: `s-${node}`,
        ts: 1,
        data: { threadId: thread.id, messageId, proactive: false },
      })
      s.attachments.send(node, {
        v: 1,
        type: 'thread.state',
        id: `t-${node}`,
        ts: 1,
        data: { threadId: thread.id, state: 'thinking' },
      })
    }
    expect(s.attachments.attachedTo(thread.id)).toEqual([chatNode, voiceNode])
    await chat.next('message.started')
    await chat.next('thread.state')
    await voice.next('thread.state')
    await Bun.sleep(20)
    expect(voice.frames.some((f) => f.type === 'message.started')).toBe(false)
  })
})

describe('notices (C1)', () => {
  test('an owner node gets one warn per failed plugin, then voice-off info for audio.in@1', async () => {
    const s = await setup({ pluginStatus: () => [STARTED, FAILED] })
    const client = await connect(s.wsUrl(await login(s)))
    await client.hello({ capabilities: ['chat.text@1', 'audio.in@1'] })
    await client.next('notice')
    await client.next('notice')
    const types = client.frames.map((f) => f.type)
    expect(types.slice(0, 3)).toEqual(['welcome', 'notice', 'notice'])
    const notices = client.frames.filter((f) => f.type === 'notice').map((f) => f.data)
    expect(notices).toEqual([
      { level: 'warn', text: 'plugin @keith/tool-weather failed: missing apiKey' },
      { level: 'info', text: 'voice is not configured on this Keith' },
    ])
  })

  test('no voice notice when voice is configured or audio.in@1 is not declared', async () => {
    const s = await setup({ voiceConfigured: true })
    const a = await connect(s.wsUrl(await login(s)))
    await a.hello({ capabilities: ['chat.text@1', 'audio.in@1'] })
    const b = await connect(s.wsUrl(await login(s)))
    await b.hello()
    a.send('thread.open', {})
    b.send('thread.open', {})
    await a.next('thread.opened')
    await b.next('thread.opened')
    expect([...a.frames, ...b.frames].filter((f) => f.type === 'notice')).toEqual([])
  })

  test('a non-owner node gets no plugin notices', async () => {
    const s = await setup({ pluginStatus: () => [FAILED] })
    await s.repos.persons.create({
      id: personId(2),
      name: 'Pepper',
      username: 'pepper',
      passwordHash: await Bun.password.hash('pepper password'),
      tier: 'member',
      lastSeenAt: null,
      createdAt: 0,
    })
    const client = await connect(s.wsUrl(await login(s, 'pepper', 'pepper password')))
    await client.hello()
    client.send('thread.open', {})
    await client.next('thread.opened')
    expect(client.frames.filter((f) => f.type === 'notice')).toEqual([])
  })
})

describe('error pass-through (C2)', () => {
  test('RATE_LIMITED passes through like PROVIDER_ERROR', async () => {
    const s = await setup()
    const client = await connect(s.wsUrl(await login(s)))
    await client.hello()
    client.send('thread.open', {})
    const thread = (await client.next('thread.opened')).data.thread as { id: string }
    const action = {
      threadId: thread.id,
      messageId: 'msg_00000000000000000000000042',
      blockId: 'b',
      actionId: 'a',
    }
    // RATE_LIMITED is a protocol code; the mind raises it as a KeithError (P3-H1).
    s.threads.failAction = new KeithError('RATE_LIMITED' as KeithErrorCode, 'rate limited')
    const id = client.send('ui.action', action)
    const error = await client.next('error')
    expect(error.data).toEqual({ code: 'RATE_LIMITED', message: 'rate limited' })
    expect(error.re).toBe(id)
    s.threads.failAction = new KeithError('PROVIDER_ERROR', 'the model provider failed')
    client.send('ui.action', action)
    expect((await client.next('error')).data.code).toBe('PROVIDER_ERROR')
  })
})

describe('historyLimit (B5)', () => {
  test('thread.open passes historyLimit to ThreadManager.open', async () => {
    const s = await setup()
    const client = await connect(s.wsUrl(await login(s)))
    await client.hello()
    client.send('thread.open', { historyLimit: 120 })
    client.send('thread.open', {})
    await client.next('thread.opened')
    await client.next('thread.opened')
    await eventually(() => s.threads.calls.open.length === 2)
    expect(s.threads.calls.open.map((c) => c.historyLimit)).toEqual([120, undefined])
  })
})
