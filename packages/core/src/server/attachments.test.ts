import { describe, expect, test } from 'bun:test'
import { makeFrame } from '@keith/protocol'
import { createMemoryLogger } from '@keith/sdk/testing'
import type { NodeId } from '../shared/types.ts'
import { createAttachmentRegistry } from './attachments.ts'
import { personId, threadId } from './test-fakes.ts'

const node = (n: number) => `nod_${String(n).padStart(26, '0')}` as NodeId

describe('attachment registry', () => {
  test('tracks which nodes have a thread open, in attach order', () => {
    const reg = createAttachmentRegistry({ log: createMemoryLogger() })
    reg.attach(node(1), threadId(1))
    reg.attach(node(2), threadId(1))
    reg.attach(node(1), threadId(2))
    expect(reg.attachedTo(threadId(1))).toEqual([node(1), node(2)])
    reg.attach(node(1), threadId(1))
    expect(reg.attachedTo(threadId(1))).toEqual([node(2), node(1)])
    expect(reg.threadsOf(node(1))).toEqual([threadId(1), threadId(2)])
    reg.detach(node(1), threadId(1))
    expect(reg.attachedTo(threadId(1))).toEqual([node(2)])
    reg.detach(node(1))
    expect(reg.attachedTo(threadId(2))).toEqual([])
  })

  test('send goes to the connected node only, and is a no-op for a gone node', () => {
    const log = createMemoryLogger()
    const reg = createAttachmentRegistry({ log })
    const sent: string[] = []
    reg.connect(
      node(1),
      { sendText: (t) => sent.push(t), sendBinary: () => {} },
      ['chat.text@1'],
      personId(1),
    )
    const frame = makeFrame('notice', { level: 'info', text: 'hi' }, { id: 'a', ts: 1 })
    reg.send(node(1), frame)
    reg.send(node(2), frame)
    expect(sent.map((s) => JSON.parse(s))).toEqual([frame])
    reg.attach(node(1), threadId(1))
    reg.disconnect(node(1))
    expect(reg.isConnected(node(1))).toBe(false)
    expect(reg.attachedTo(threadId(1))).toEqual([])
    reg.send(node(1), frame)
    expect(sent).toHaveLength(1)
  })

  test('sendBinary goes to the connected node only, and is a no-op for a gone node', () => {
    const reg = createAttachmentRegistry({ log: createMemoryLogger() })
    const sent: Uint8Array[] = []
    reg.connect(
      node(1),
      { sendText: () => {}, sendBinary: (b) => sent.push(b) },
      ['chat.text@1'],
      personId(1),
    )
    const bytes = new Uint8Array([2, 1, 2, 3])
    reg.sendBinary(node(1), bytes)
    reg.sendBinary(node(2), bytes)
    expect(sent).toEqual([bytes])
    reg.disconnect(node(1))
    reg.sendBinary(node(1), bytes)
    expect(sent).toHaveLength(1)
  })

  test('an invalid outgoing frame is dropped and logged', () => {
    const log = createMemoryLogger()
    const reg = createAttachmentRegistry({ log })
    const sent: string[] = []
    reg.connect(
      node(1),
      { sendText: (t) => sent.push(t), sendBinary: () => {} },
      ['chat.text@1'],
      personId(1),
    )
    const bad = makeFrame('thread.state', { threadId: threadId(1), state: 'idle' }, { id: '', ts: 1 })
    reg.send(node(1), bad)
    expect(sent).toEqual([])
    expect(log.entries.some((e) => e.level === 'error')).toBe(true)
  })

  test('a node without chat.text@1 gets no message.* or tool.activity frames', () => {
    const reg = createAttachmentRegistry({ log: createMemoryLogger() })
    const sent: string[] = []
    reg.connect(node(1), { sendText: (t) => sent.push(t), sendBinary: () => {} }, ['audio.in@1'], personId(1))
    const at = { ts: 1 }
    const thread = threadId(1)
    const messageId = 'msg_00000000000000000000000001' as const
    const message = {
      id: messageId,
      threadId: thread,
      role: 'assistant' as const,
      authorPersonId: null,
      modality: 'text' as const,
      content: 'hi',
      createdAt: 1,
    }
    const hidden = [
      makeFrame('message.user', { message: { ...message, role: 'user' } }, { id: 'a1', ...at }),
      makeFrame('message.started', { threadId: thread, messageId, proactive: false }, { id: 'a2', ...at }),
      makeFrame('message.delta', { threadId: thread, messageId, text: 'h' }, { id: 'a3', ...at }),
      makeFrame('message.completed', { message }, { id: 'a4', ...at }),
      makeFrame(
        'tool.activity',
        { threadId: thread, messageId, toolCallId: 'c1', name: 'time', status: 'started' },
        { id: 'a5', ...at },
      ),
    ]
    const shown = [
      makeFrame('thread.state', { threadId: thread, state: 'thinking' }, { id: 'b1', ...at }),
      makeFrame('notice', { level: 'info', text: 'hi' }, { id: 'b2', ...at }),
      makeFrame('error', { code: 'INTERNAL', message: 'x' }, { id: 'b3', ...at }),
    ]
    for (const f of [...hidden, ...shown]) reg.send(node(1), f)
    expect(sent.map((s) => JSON.parse(s).type)).toEqual(['thread.state', 'notice', 'error'])

    const chat: string[] = []
    reg.connect(
      node(2),
      { sendText: (t) => chat.push(t), sendBinary: () => {} },
      ['chat.text@1'],
      personId(1),
    )
    for (const f of hidden) reg.send(node(2), f)
    expect(chat).toHaveLength(hidden.length)
  })

  test('phase 5: nodesOfPerson lists the ready nodes of a person, in connect order', () => {
    const reg = createAttachmentRegistry({ log: createMemoryLogger() })
    const outlet = { sendText: () => {}, sendBinary: () => {} }
    reg.connect(node(1), outlet, ['chat.text@1'], personId(1))
    reg.connect(node(2), outlet, [], personId(2))
    reg.connect(node(3), outlet, [], personId(1))
    // Not before `welcome`.
    expect(reg.nodesOfPerson(personId(1))).toEqual([])
    for (const n of [1, 2, 3]) reg.markReady(node(n))
    reg.markReady(node(9))
    // Whether or not a thread is open.
    reg.attach(node(3), threadId(1))
    expect(reg.nodesOfPerson(personId(1))).toEqual([node(1), node(3)])
    expect(reg.nodesOfPerson(personId(2))).toEqual([node(2)])
    reg.disconnect(node(1))
    expect(reg.nodesOfPerson(personId(1))).toEqual([node(3)])
    expect(reg.nodesOfPerson(personId(5))).toEqual([])
  })
})
