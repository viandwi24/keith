import { afterEach, describe, expect, test } from 'bun:test'
import { ClientInfo, type MessageDto, ThreadDto } from '@keith/protocol'
import { KeithError } from '@keith/sdk'
import type { NodeId } from '../shared/types.ts'
import {
  connect,
  eventually,
  login,
  OWNER_PASSWORD,
  personId,
  type ReceivedFrame,
  startTestServer,
  type TestServer,
  threadId,
} from './test-fakes.ts'

let t: TestServer | null = null
afterEach(async () => {
  await t?.stop()
  t = null
})

async function setup(opts: Parameters<typeof startTestServer>[0] = {}) {
  t = await startTestServer(opts)
  return t
}

describe('handshake', () => {
  test('bad token closes with 4003', async () => {
    const s = await setup()
    const client = await connect(s.wsUrl('not-a-token'))
    expect((await client.closed).code).toBe(4003)
  })

  test('missing token closes with 4003', async () => {
    const s = await setup()
    const client = await connect(s.wsUrl(null))
    expect((await client.closed).code).toBe(4003)
  })

  test('expired token closes with 4003', async () => {
    const s = await setup()
    const token = await login(s)
    s.clock.advance(31 * 86_400_000)
    const client = await connect(s.wsUrl(token))
    expect((await client.closed).code).toBe(4003)
    expect(s.repos.data.tokens.size).toBe(0)
  })

  test('no hello closes with 4001', async () => {
    const s = await setup({ timing: { helloTimeoutMs: 50 } })
    const client = await connect(s.wsUrl(await login(s)))
    expect((await client.closed).code).toBe(4001)
  })

  test('hello with another protocol version closes with 4009', async () => {
    const s = await setup()
    const client = await connect(s.wsUrl(await login(s)))
    client.send('hello', { protocol: 2, client: { name: 'x', version: '1' }, capabilities: [] })
    expect((await client.closed).code).toBe(4009)
  })

  test('envelope version other than 1 closes with 4009', async () => {
    const s = await setup()
    const client = await connect(s.wsUrl(await login(s)))
    await client.hello()
    client.send('pong', {}, { v: 2 })
    expect((await client.closed).code).toBe(4009)
  })

  test('welcome carries a new node id, persisted with the token', async () => {
    const s = await setup()
    const token = await login(s)
    const client = await connect(s.wsUrl(token))
    const welcome = await client.hello()
    const nodeId = welcome.data.nodeId as NodeId
    expect(welcome.data.protocol).toBe(1)
    expect(welcome.data.person).toEqual({ id: s.owner.id, name: 'Tony', tier: 'owner' })
    expect(welcome.data.server).toEqual({ name: 'keith', version: '0.1.0' })
    expect(s.repos.data.nodes.get(nodeId)).toMatchObject({
      name: 'keith-test',
      kind: 'attended',
      capabilities: ['chat.text@1'],
    })
    expect([...s.repos.data.tokens.values()][0]?.nodeId).toBe(nodeId)
    expect(s.events.named('node.connected')).toEqual([
      { nodeId, personId: s.owner.id, capabilities: ['chat.text@1'] },
    ])
  })

  test('a node that sends back its persisted node id keeps it', async () => {
    const s = await setup()
    const token = await login(s)
    const first = await connect(s.wsUrl(token))
    const nodeId = (await first.hello()).data.nodeId
    await first.close()
    await eventually(() => s.events.named('node.disconnected').length === 1)
    const second = await connect(s.wsUrl(await login(s)))
    expect((await second.hello({ nodeId })).data.nodeId).toBe(nodeId)
  })

  test('an unknown or already connected node id gets a new one', async () => {
    const s = await setup()
    const token = await login(s)
    const a = await connect(s.wsUrl(token))
    const nodeId = (await a.hello()).data.nodeId
    const b = await connect(s.wsUrl(token))
    expect((await b.hello({ nodeId })).data.nodeId).not.toBe(nodeId)
    const c = await connect(s.wsUrl(token))
    const unknown = 'nod_01J8ZQ3K4M5N6P7Q8R9S0T1V2Y'
    expect((await c.hello({ nodeId: unknown })).data.nodeId).not.toBe(unknown)
  })

  test('frames before hello get an error and the connection stays open', async () => {
    const s = await setup()
    const client = await connect(s.wsUrl(await login(s)))
    const id = client.send('thread.open', {})
    const error = await client.next('error')
    expect(error.re).toBe(id)
    expect(error.data.code).toBe('INVALID_FRAME')
    await client.hello()
  })

  test('the core pings and drops a silent node with 4010', async () => {
    const s = await setup({ timing: { pingIntervalMs: 20, heartbeatTimeoutMs: 150 } })
    const client = await connect(s.wsUrl(await login(s)))
    await client.hello()
    await client.next('ping')
    expect((await client.closed).code).toBe(4010)
  })

  test('pong frames keep the node alive', async () => {
    const s = await setup({ timing: { pingIntervalMs: 20, heartbeatTimeoutMs: 120 } })
    const client = await connect(s.wsUrl(await login(s)))
    await client.hello()
    for (let i = 0; i < 6; i++) {
      await Bun.sleep(40)
      client.send('pong', {})
    }
    expect(client.ws.readyState).toBe(WebSocket.OPEN)
  })
})

describe('frames', () => {
  async function ready(s: TestServer) {
    const client = await connect(s.wsUrl(await login(s)))
    const welcome = await client.hello()
    return { client, nodeId: welcome.data.nodeId as NodeId }
  }

  test('invalid frame gets INVALID_FRAME and the connection stays open', async () => {
    const s = await setup()
    const { client } = await ready(s)
    const id = client.send('input.text', { threadId: 'nope', text: '' })
    const error = await client.next('error')
    expect(error.data.code).toBe('INVALID_FRAME')
    expect(error.re).toBe(id)
    client.sendRaw('{not json')
    expect((await client.next('error')).data.code).toBe('INVALID_FRAME')
    client.send('thread.open', {})
    await client.next('thread.opened')
  })

  test('unknown frame gets UNKNOWN_FRAME', async () => {
    const s = await setup()
    const { client } = await ready(s)
    const id = client.send('weather.subscribe', {})
    const error = await client.next('error')
    expect(error.data.code).toBe('UNKNOWN_FRAME')
    expect(error.re).toBe(id)
  })

  test('valid flow: welcome, then thread.opened built from OpenedThread', async () => {
    const s = await setup()
    const { client, nodeId } = await ready(s)
    const id = client.send('thread.open', {})
    const opened = await client.next('thread.opened')
    expect(opened.re).toBe(id)
    const thread = opened.data.thread as { id: string; participants: unknown[] }
    expect(thread.participants).toEqual([{ id: s.owner.id, name: 'Tony', tier: 'owner' }])
    expect(opened.data.messages).toEqual([])
    expect(s.threads.calls.open).toEqual([
      { personId: s.owner.id, nodeId, threadId: undefined, arrival: { awayMs: null } },
    ])
    expect(s.attachments.attachedTo(thread.id as never)).toEqual([nodeId])
  })

  test('thread.opened is sent exactly once per thread.open', async () => {
    const s = await setup()
    const { client } = await ready(s)
    client.send('thread.open', {})
    client.send('thread.open', {})
    await client.next('thread.opened')
    await client.next('thread.opened')
    client.send('pong', {})
    client.send('thread.open', {})
    await client.next('thread.opened')
    await Bun.sleep(30)
    expect(client.frames.filter((f) => f.type === 'thread.opened')).toHaveLength(3)
    expect(s.threads.calls.open).toHaveLength(3)
  })

  test('historyLimit trims the returned messages to the latest ones', async () => {
    const s = await setup()
    const main = `thr_${s.owner.id.slice(4)}` as ReturnType<typeof threadId>
    const messages: MessageDto[] = [1, 2, 3].map((n) => ({
      id: `msg_${String(n).padStart(26, '0')}` as MessageDto['id'],
      threadId: main,
      role: 'user',
      authorPersonId: s.owner.id,
      modality: 'text',
      content: `m${n}`,
      createdAt: n,
    }))
    s.threads.history.set(main, messages)
    const { client } = await ready(s)
    client.send('thread.open', { historyLimit: 2 })
    const opened = await client.next('thread.opened')
    expect((opened.data.messages as MessageDto[]).map((m) => m.content)).toEqual(['m2', 'm3'])
    client.send('thread.open', { historyLimit: 0 })
    expect((await client.next('thread.opened')).data.messages).toEqual([])
  })

  test('open failures come back as an error frame', async () => {
    const s = await setup()
    const { client } = await ready(s)
    s.threads.failOpen = new KeithError('NOT_FOUND', 'thread not found')
    const id = client.send('thread.open', { threadId: threadId(9) })
    const error = await client.next('error')
    expect(error.data).toEqual({ code: 'NOT_FOUND', message: 'thread not found' })
    expect(error.re).toBe(id)
    s.threads.failOpen = new Error('boom')
    client.send('thread.open', {})
    expect((await client.next('error')).data.code).toBe('INTERNAL')
  })

  test('input.text and input.cancel go to the ThreadManager', async () => {
    const s = await setup()
    const { client, nodeId } = await ready(s)
    client.send('thread.open', {})
    const thread = (await client.next('thread.opened')).data.thread as { id: ReturnType<typeof threadId> }
    client.send('input.text', { threadId: thread.id, text: 'hello' })
    client.send('input.cancel', { threadId: thread.id })
    await eventually(() => s.threads.calls.cancel.length === 1)
    expect(s.threads.calls.input).toEqual([
      { threadId: thread.id, personId: s.owner.id, nodeId, text: 'hello' },
    ])
    expect(s.threads.calls.cancel).toEqual([{ threadId: thread.id, nodeId }])
  })

  test('input for a thread the node has not opened is refused', async () => {
    const s = await setup()
    const { client } = await ready(s)
    const id = client.send('input.text', { threadId: threadId(7), text: 'hi' })
    const error = await client.next('error')
    expect(error.data.code).toBe('FORBIDDEN')
    expect(error.re).toBe(id)
    expect(s.threads.calls.input).toHaveLength(0)
  })

  test('thread.close detaches the node', async () => {
    const s = await setup()
    const { client, nodeId } = await ready(s)
    client.send('thread.open', {})
    const thread = (await client.next('thread.opened')).data.thread as { id: ReturnType<typeof threadId> }
    client.send('thread.close', { threadId: thread.id })
    await eventually(() => s.threads.calls.detach.length === 1)
    expect(s.threads.calls.detach).toEqual([{ nodeId, threadId: thread.id }])
    expect(s.attachments.attachedTo(thread.id)).toEqual([])
    expect(s.presence.isPresent(s.owner.id)).toBe(false)
  })

  test('two nodes of one person on one thread: attachedTo returns both, disconnect updates it', async () => {
    const s = await setup()
    const a = await ready(s)
    const b = await ready(s)
    a.client.send('thread.open', {})
    b.client.send('thread.open', {})
    const thread = (await a.client.next('thread.opened')).data.thread as { id: ReturnType<typeof threadId> }
    await b.client.next('thread.opened')
    expect(s.attachments.attachedTo(thread.id)).toEqual([a.nodeId, b.nodeId])
    await a.client.close()
    await eventually(() => s.attachments.attachedTo(thread.id).length === 1)
    expect(s.attachments.attachedTo(thread.id)).toEqual([b.nodeId])
    expect(s.threads.calls.detach).toContainEqual({ nodeId: a.nodeId })
    expect(s.events.named('node.disconnected')).toEqual([{ nodeId: a.nodeId, personId: s.owner.id }])
    expect(s.presence.isPresent(s.owner.id)).toBe(true)
  })

  test('frames sent through the attachment registry reach the node', async () => {
    const s = await setup()
    const { client, nodeId } = await ready(s)
    s.attachments.send(nodeId, {
      v: 1,
      type: 'notice',
      id: 'x1',
      ts: 1,
      data: { level: 'info', text: 'hi' },
    })
    expect((await client.next('notice')).data).toEqual({ level: 'info', text: 'hi' })
  })

  test('plugin ws frames reach the plugin handler with the node and person', async () => {
    const s = await setup()
    const seen: unknown[] = []
    s.server.ws
      .forPlugin({ pluginId: '@keith/web', namespace: 'web', kind: 'client-app' })
      .handle('web.hello', ClientInfo, (data, c) => {
        seen.push({ data, nodeId: c.nodeId, person: c.person?.id })
      })
    const { client, nodeId } = await ready(s)
    client.send('web.hello', { name: 'a', version: '1' })
    await eventually(() => seen.length === 1)
    expect(seen[0]).toEqual({ data: { name: 'a', version: '1' }, nodeId, person: s.owner.id })
    const id = client.send('web.hello', { name: 3 })
    const error = await client.next('error')
    expect(error.data.code).toBe('INVALID_FRAME')
    expect(error.re).toBe(id)
  })
})

describe('thread list (phase 5)', () => {
  const PASSWORD = 'pepper-potts-2008'

  async function person(s: TestServer, n: number, name: string) {
    await s.repos.persons.create({
      id: personId(n),
      name,
      username: name.toLowerCase(),
      passwordHash: await Bun.password.hash(PASSWORD),
      tier: 'member',
      lastSeenAt: null,
      createdAt: 0,
    })
    return personId(n)
  }

  async function node(s: TestServer, username: string, capabilities: string[]) {
    const token = await login(s, username, username === 'tony' ? OWNER_PASSWORD : PASSWORD)
    const client = await connect(s.wsUrl(token))
    const nodeId = (await client.hello({ capabilities })).data.nodeId as NodeId
    return { client, nodeId }
  }

  const names = (f: ReceivedFrame, key: 'participants' | 'formerParticipants') =>
    ((f.data.thread as ThreadDto)[key] ?? []).map((p) => p.name)

  test('joins and leaves reach every node of every participant; the leaver loses the thread', async () => {
    const s = await setup()
    const pepper = await person(s, 2, 'Pepper')
    const happy = await person(s, 3, 'Happy')
    const group = threadId(10)
    await s.repos.threads.create(
      {
        id: group,
        kind: 'group',
        slug: null,
        title: 'Expo',
        ownerPersonId: s.owner.id,
        summary: null,
        purpose: 'Plan the Expo launch.',
        createdAt: 0,
        updatedAt: 0,
      },
      [s.owner.id, pepper],
    )
    // Tony: one node with only the main thread open, one without chat.text@1 and nothing open.
    const tonyMain = await node(s, 'tony', ['chat.text@1'])
    tonyMain.client.send('thread.open', {})
    await tonyMain.client.next('thread.opened')
    const tonyBare = await node(s, 'tony', [])
    const pepperNode = await node(s, 'pepper', ['chat.text@1'])
    pepperNode.client.send('thread.open', { threadId: group })
    await pepperNode.client.next('thread.opened')
    const happyNode = await node(s, 'happy', ['chat.text@1'])

    await s.repos.threads.addParticipant(group, happy, 1)
    s.events.emit('thread.participant_joined', { threadId: group, personId: happy, invitedBy: s.owner.id })
    for (const n of [tonyMain, tonyBare, pepperNode, happyNode]) {
      const updated = await n.client.next('thread.updated')
      expect(ThreadDto.parse(updated.data.thread).id).toBe(group)
      expect(names(updated, 'participants')).toEqual(['Tony', 'Pepper', 'Happy'])
      expect((updated.data.thread as ThreadDto).purpose).toBe('Plan the Expo launch.')
    }

    await s.repos.threads.removeParticipant(group, pepper, 2)
    s.events.emit('thread.participant_left', { threadId: group, personId: pepper })
    expect((await pepperNode.client.next('thread.removed')).data).toEqual({ threadId: group })
    for (const n of [tonyMain, tonyBare, happyNode]) {
      const updated = await n.client.next('thread.updated')
      expect(names(updated, 'participants')).toEqual(['Tony', 'Happy'])
      expect(names(updated, 'formerParticipants')).toEqual(['Pepper'])
    }
    expect(pepperNode.client.frames.filter((f) => f.type === 'thread.updated')).toHaveLength(1)
    // The leaver's node is detached: the thread's frames no longer reach it.
    expect(s.attachments.attachedTo(group)).not.toContain(pepperNode.nodeId)
    expect(s.threads.calls.detach).toContainEqual({ nodeId: pepperNode.nodeId, threadId: group })
    // It had no other thread open, so Pepper is away now.
    expect(s.presence.isPresent(pepper)).toBe(false)
    happyNode.client.send('thread.open', { threadId: group })
    await happyNode.client.next('thread.opened')
    for (const nodeId of s.attachments.attachedTo(group)) {
      s.attachments.send(nodeId, {
        v: 1,
        type: 'thread.state',
        id: 'x2',
        ts: 1,
        data: { threadId: group, state: 'thinking' },
      })
    }
    await happyNode.client.next('thread.state')
    expect(pepperNode.client.frames.some((f) => f.type === 'thread.state')).toBe(false)
  })

  test('an event for an unknown thread sends nothing', async () => {
    const s = await setup()
    const tony = await node(s, 'tony', ['chat.text@1'])
    s.events.emit('thread.participant_joined', {
      threadId: threadId(99),
      personId: s.owner.id,
      invitedBy: null,
    })
    await s.events.idle()
    expect(tony.client.frames.some((f) => f.type === 'thread.updated')).toBe(false)
    expect(s.log.entries.some((e) => e.msg === 'participant event for an unknown thread')).toBe(true)
  })
})
