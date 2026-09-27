import { afterEach, describe, expect, test } from 'bun:test'
import { KeithError } from '@keith/sdk'
import type { NodeId } from '../shared/types.ts'
import {
  connect,
  eventually,
  login,
  startTestServer,
  type TestClient,
  type TestServer,
  threadId,
} from './test-fakes.ts'

let t: TestServer | null = null
afterEach(async () => {
  await t?.stop()
  t = null
})

const MESSAGE = 'msg_00000000000000000000000042'

async function openThread(): Promise<{ s: TestServer; client: TestClient; nodeId: NodeId; thread: string }> {
  const s = await startTestServer()
  t = s
  const client = await connect(s.wsUrl(await login(s)))
  const welcome = await client.hello()
  client.send('thread.open', {})
  const opened = await client.next('thread.opened')
  const thread = (opened.data.thread as { id: string }).id
  return { s, client, nodeId: welcome.data.nodeId as NodeId, thread }
}

describe('ui.action', () => {
  test('goes to ThreadManager.action with the node and person', async () => {
    const { s, client, nodeId, thread } = await openThread()
    client.send('ui.action', { threadId: thread, messageId: MESSAGE, blockId: 'confirm', actionId: 'book' })
    client.send('ui.action', {
      threadId: thread,
      messageId: MESSAGE,
      blockId: 'confirm',
      actionId: 'more',
      value: { page: 2 },
    })
    await eventually(() => s.threads.calls.action.length === 2)
    expect(s.threads.calls.action).toEqual([
      {
        threadId: thread,
        personId: s.owner.id,
        nodeId,
        messageId: MESSAGE,
        blockId: 'confirm',
        actionId: 'book',
      },
      {
        threadId: thread,
        personId: s.owner.id,
        nodeId,
        messageId: MESSAGE,
        blockId: 'confirm',
        actionId: 'more',
        value: { page: 2 },
      },
    ] as never)
    // No UNKNOWN_FRAME any more.
    await Bun.sleep(20)
    expect(client.frames.filter((f) => f.type === 'error')).toHaveLength(0)
  })

  test('KeithError codes come back as error frames with re; others as INTERNAL', async () => {
    const { s, client, thread } = await openThread()
    s.threads.failAction = new KeithError('NOT_FOUND', 'block or action not found')
    const id = client.send('ui.action', { threadId: thread, messageId: MESSAGE, blockId: 'x', actionId: 'y' })
    const error = await client.next('error')
    expect(error.data).toEqual({ code: 'NOT_FOUND', message: 'block or action not found' })
    expect(error.re).toBe(id)

    s.threads.failAction = new KeithError('FORBIDDEN', "this action needs tier 'owner'")
    const id2 = client.send('ui.action', {
      threadId: thread,
      messageId: MESSAGE,
      blockId: 'x',
      actionId: 'y',
    })
    const forbidden = await client.next('error')
    expect(forbidden.data.code).toBe('FORBIDDEN')
    expect(forbidden.re).toBe(id2)

    s.threads.failAction = new Error('onAction exploded')
    client.send('ui.action', { threadId: thread, messageId: MESSAGE, blockId: 'x', actionId: 'y' })
    expect((await client.next('error')).data).toEqual({ code: 'INTERNAL', message: 'internal error' })
  })

  test('a thread the node has not opened is refused', async () => {
    const { s, client } = await openThread()
    const id = client.send('ui.action', {
      threadId: threadId(7),
      messageId: MESSAGE,
      blockId: 'confirm',
      actionId: 'book',
    })
    const error = await client.next('error')
    expect(error.data.code).toBe('FORBIDDEN')
    expect(error.re).toBe(id)
    expect(s.threads.calls.action).toHaveLength(0)
  })

  test('an invalid block id gets INVALID_FRAME', async () => {
    const { s, client, thread } = await openThread()
    const id = client.send('ui.action', {
      threadId: thread,
      messageId: MESSAGE,
      blockId: 'Bad Id',
      actionId: 'a',
    })
    const error = await client.next('error')
    expect(error.data.code).toBe('INVALID_FRAME')
    expect(error.re).toBe(id)
    expect(s.threads.calls.action).toHaveLength(0)
  })
})
