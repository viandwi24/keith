import { describe, expect, test } from 'bun:test'
import { makeFrame } from '@keith/protocol'
import { createMemoryLogger } from '@keith/sdk/testing'
import type { NodeId } from '../shared/types.ts'
import { createAttachmentRegistry } from './attachments.ts'
import { threadId } from './test-fakes.ts'

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
    reg.connect(node(1), { sendText: (t) => sent.push(t) })
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

  test('an invalid outgoing frame is dropped and logged', () => {
    const log = createMemoryLogger()
    const reg = createAttachmentRegistry({ log })
    const sent: string[] = []
    reg.connect(node(1), { sendText: (t) => sent.push(t) })
    const bad = makeFrame('thread.state', { threadId: threadId(1), state: 'idle' }, { id: '', ts: 1 })
    reg.send(node(1), bad)
    expect(sent).toEqual([])
    expect(log.entries.some((e) => e.level === 'error')).toBe(true)
  })
})
