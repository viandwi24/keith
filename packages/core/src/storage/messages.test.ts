import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { isKeithError, type LlmMessage } from '@keith/sdk'
import type { MessageId } from '../shared/types.ts'
import { person, seed, testId, thread } from './fixtures.ts'
import { createTestDb, type TestDb } from './testing.ts'
import type { AssistantMessageRecord, MessageRecord, ToolMessageRecord, UserMessageRecord } from './types.ts'

let db: TestDb
beforeEach(async () => {
  db = createTestDb()
  await seed(db.repos, 1)
})
afterEach(() => db.close())

const threadId = testId('thr', 1)
const personId = testId('per', 1)

function userMessage(n: number, createdAt: number, content = `m${n}`): UserMessageRecord {
  return {
    id: testId('msg', n),
    threadId,
    role: 'user',
    authorPersonId: personId,
    nodeId: testId('nod', 1),
    modality: 'text',
    content,
    meta: null,
    createdAt,
  }
}

const assistant: AssistantMessageRecord = {
  id: testId('msg', 2),
  threadId,
  role: 'assistant',
  authorPersonId: null,
  nodeId: null,
  modality: 'text',
  content: 'Let me check.',
  meta: { proactive: true },
  toolCalls: [{ id: 'call_abc', name: 'weather.current', args: { city: 'Lyon' } }],
  ui: [
    {
      block: { type: 'markdown', id: 'b1', text: '**sunny**' },
      toolCallId: 'call_abc',
      toolName: 'weather.current',
    },
  ],
  createdAt: 20,
}

const tool: ToolMessageRecord = {
  id: testId('msg', 3),
  threadId,
  role: 'tool',
  authorPersonId: null,
  nodeId: null,
  modality: 'text',
  content: '{"temp":21}',
  meta: null,
  toolCallId: 'call_abc',
  toolName: 'weather.current',
  isError: false,
  createdAt: 21,
}

/** The replay mapping the context builder does; proves the stored shape is enough for it. */
function toLlmMessage(m: MessageRecord): LlmMessage {
  switch (m.role) {
    case 'user':
      return { role: 'user', content: m.content }
    case 'assistant':
      return m.toolCalls
        ? { role: 'assistant', content: m.content, toolCalls: m.toolCalls }
        : { role: 'assistant', content: m.content }
    case 'tool':
      return { role: 'tool', toolCallId: m.toolCallId, content: m.content }
  }
}

describe('messages', () => {
  test('round-trips user, assistant and tool messages', async () => {
    const user = userMessage(1, 10)
    for (const m of [user, assistant, tool]) await db.repos.messages.append(m)
    expect(await db.repos.messages.get(user.id)).toEqual({ ...user, seq: 1 })
    expect(await db.repos.messages.get(assistant.id)).toEqual({ ...assistant, seq: 2 })
    expect(await db.repos.messages.get(tool.id)).toEqual({ ...tool, seq: 3 })
    expect(await db.repos.messages.get(testId('msg', 99))).toBeNull()
  })

  test('round-trips meta.spokenChars of a reply cut by barge-in', async () => {
    const spoken: AssistantMessageRecord = {
      ...assistant,
      id: testId('msg', 4),
      modality: 'audio',
      content: 'Hello.',
      meta: { cancelled: true, spokenChars: 6 },
      toolCalls: null,
      ui: null,
    }
    await db.repos.messages.append(spoken)
    expect(await db.repos.messages.get(spoken.id)).toEqual({ ...spoken, seq: 1 })
    const page = await db.repos.messages.page({ threadId, limit: 10 })
    expect(page.messages[0]?.meta).toEqual({ cancelled: true, spokenChars: 6 })
  })

  test('I-13: round-trips meta.relayFrom of a delivery turn that carried relays (phase 5)', async () => {
    const relayFrom = [
      { personId: testId('per', 7), name: 'Tony' },
      { personId: testId('per', 8), name: 'Happy' },
    ]
    const relayed: AssistantMessageRecord = {
      ...assistant,
      id: testId('msg', 5),
      content: 'Tony says he will be late.',
      meta: { proactive: true, relayFrom },
      toolCalls: null,
      ui: null,
    }
    await db.repos.messages.append(relayed)
    expect((await db.repos.messages.get(relayed.id))?.meta).toEqual({ proactive: true, relayFrom })
  })

  test('assistant tool calls and tool results replay into LlmMessage shapes', async () => {
    for (const m of [userMessage(1, 10), assistant, { ...tool, isError: true }])
      await db.repos.messages.append(m)
    const page = await db.repos.messages.page({ threadId, limit: 10 })
    expect(page.messages.map(toLlmMessage)).toEqual([
      { role: 'user', content: 'm1' },
      {
        role: 'assistant',
        content: 'Let me check.',
        toolCalls: [{ id: 'call_abc', name: 'weather.current', args: { city: 'Lyon' } }],
      },
      { role: 'tool', toolCallId: 'call_abc', content: '{"temp":21}' },
    ])
    expect((page.messages[2] as ToolMessageRecord).isError).toBe(true)
  })

  test('append bumps the thread updated_at', async () => {
    await db.repos.messages.append(userMessage(1, 50_000))
    expect((await db.repos.threads.get(threadId))?.updatedAt).toBe(50_000)
  })

  test('seq is per thread, gap-free, and ignores a value passed in', async () => {
    const other = testId('thr', 2)
    await db.repos.threads.create(thread(2, personId, { slug: 'other' }), [personId])
    await db.repos.messages.append({ ...userMessage(1, 10), seq: 42 })
    await db.repos.messages.append({ ...userMessage(2, 20), threadId: other, authorPersonId: null })
    await db.repos.messages.append(userMessage(3, 30))
    const seqs = async (t: typeof threadId) =>
      (await db.repos.messages.page({ threadId: t, limit: 10 })).messages.map((m) => [m.id, m.seq])
    expect(await seqs(threadId)).toEqual([
      [testId('msg', 1), 1],
      [testId('msg', 3), 2],
    ])
    expect(await seqs(other)).toEqual([[testId('msg', 2), 1]])
  })

  test('messages with the same created_at keep insert order, whatever their ids', async () => {
    // Inserted 9, 5, 7 at the same millisecond: order is insert order, not id order.
    for (const n of [9, 5, 7]) await db.repos.messages.append(userMessage(n, 1_000))
    const page = await db.repos.messages.page({ threadId, limit: 10 })
    expect(page.messages.map((m) => m.id)).toEqual([9, 5, 7].map((n) => testId('msg', n)))
    expect(page.messages.map((m) => m.seq)).toEqual([1, 2, 3])
    const before = await db.repos.messages.page({ threadId, before: testId('msg', 7), limit: 10 })
    expect(before.messages.map((m) => m.id)).toEqual([9, 5].map((n) => testId('msg', n)))
  })

  test('order follows seq even when created_at goes backwards', async () => {
    await db.repos.messages.append(userMessage(1, 500))
    await db.repos.messages.append(userMessage(2, 100))
    const page = await db.repos.messages.page({ threadId, limit: 10 })
    expect(page.messages.map((m) => m.id)).toEqual([1, 2].map((n) => testId('msg', n)))
  })

  test('pages by before + limit, oldest first, stable on equal timestamps', async () => {
    // Messages 1..7; 3, 4 and 5 share a timestamp, so insert order (seq) breaks the tie.
    const times = [10, 20, 30, 30, 30, 40, 50]
    for (const [i, t] of times.entries()) await db.repos.messages.append(userMessage(i + 1, t))
    const ids = (ms: MessageRecord[]) => ms.map((m) => m.id)
    const msg = (n: number): MessageId => testId('msg', n)

    const latest = await db.repos.messages.page({ threadId, limit: 3 })
    expect(ids(latest.messages)).toEqual([msg(5), msg(6), msg(7)])
    expect(latest.hasMore).toBe(true)

    const middle = await db.repos.messages.page({ threadId, before: msg(5), limit: 3 })
    expect(ids(middle.messages)).toEqual([msg(2), msg(3), msg(4)])
    expect(middle.hasMore).toBe(true)

    const first = await db.repos.messages.page({ threadId, before: msg(2), limit: 3 })
    expect(ids(first.messages)).toEqual([msg(1)])
    expect(first.hasMore).toBe(false)

    const all = await db.repos.messages.page({ threadId, limit: 7 })
    expect(ids(all.messages)).toEqual([1, 2, 3, 4, 5, 6, 7].map(msg))
    expect(all.hasMore).toBe(false)

    expect(await db.repos.messages.page({ threadId, before: testId('msg', 99), limit: 3 })).toEqual({
      messages: [],
      hasMore: false,
    })
  })

  test('filters pages by role', async () => {
    for (const m of [userMessage(1, 10), assistant, tool, userMessage(4, 30)])
      await db.repos.messages.append(m)
    const page = await db.repos.messages.page({ threadId, limit: 10, roles: ['user', 'assistant'] })
    expect(page.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
  })

  test('a malformed JSON column throws STORAGE_CORRUPT', async () => {
    await db.repos.messages.append(assistant)
    const raw = new Database(db.path)
    raw.run('update messages set tool_calls = \'[{"id":1}]\' where id = ?', [assistant.id])
    raw.close()
    let error: unknown
    try {
      await db.repos.messages.get(assistant.id)
    } catch (e) {
      error = e
    }
    expect(isKeithError(error, 'STORAGE_CORRUPT')).toBe(true)
  })
})

describe('messages.range and lastSeq (phase 4)', () => {
  test('lastSeq is 0 for an empty thread, then the highest seq of any role', async () => {
    expect(await db.repos.messages.lastSeq(threadId)).toBe(0)
    expect(await db.repos.messages.lastSeq(testId('thr', 99))).toBe(0)
    for (const m of [userMessage(1, 10), assistant, tool]) await db.repos.messages.append(m)
    expect(await db.repos.messages.lastSeq(threadId)).toBe(3)
  })

  test('range returns rows after afterSeq in seq order, capped by limit, built like page', async () => {
    for (const [i, t] of [50, 40, 30, 20, 10].entries()) await db.repos.messages.append(userMessage(i + 1, t))
    const range = await db.repos.messages.range({ threadId, afterSeq: 1, limit: 3 })
    expect(range.map((m) => [m.id, m.seq])).toEqual([
      [testId('msg', 2), 2],
      [testId('msg', 3), 3],
      [testId('msg', 4), 4],
    ])
    const page = await db.repos.messages.page({ threadId, limit: 5 })
    expect(range).toEqual(page.messages.slice(1, 4))
    expect(await db.repos.messages.range({ threadId, afterSeq: 5, limit: 3 })).toEqual([])
    expect(await db.repos.messages.range({ threadId, afterSeq: 0, limit: 0 })).toEqual([])
  })

  test('range filters by roles before the limit applies', async () => {
    for (const m of [userMessage(1, 10), assistant, tool, userMessage(4, 30), userMessage(5, 40)])
      await db.repos.messages.append(m)
    const range = await db.repos.messages.range({
      threadId,
      afterSeq: 1,
      limit: 2,
      roles: ['user', 'assistant'],
    })
    expect(range.map((m) => [m.role, m.seq])).toEqual([
      ['assistant', 2],
      ['user', 4],
    ])
    expect(range[0]).toEqual({ ...assistant, seq: 2 })
    expect(await db.repos.messages.range({ threadId, afterSeq: 0, limit: 5, roles: [] })).toEqual([])
  })

  test('range stays inside its thread', async () => {
    await db.repos.persons.create(person(2))
    await db.repos.threads.create(thread(2, testId('per', 2)), [testId('per', 2)])
    await db.repos.messages.append(userMessage(1, 10))
    await db.repos.messages.append({ ...userMessage(2, 10), threadId: testId('thr', 2) })
    expect((await db.repos.messages.range({ threadId, afterSeq: 0, limit: 10 })).map((m) => m.id)).toEqual([
      testId('msg', 1),
    ])
  })
})
