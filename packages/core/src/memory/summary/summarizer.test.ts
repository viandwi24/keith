import { describe, expect, test } from 'bun:test'
import { ProviderError } from '@keith/sdk'
import {
  createFakeClock,
  createFakeLlm,
  createMemoryLogger,
  type FakeLlmTurn,
  fakeText,
} from '@keith/sdk/testing'
import { createEventBus } from '../../events/index.ts'
import { createRunLoop } from '../../mind/index.ts'
import {
  createFakeIds,
  createFakeProviders,
  createFakeRepos,
  createFakeToolRegistry,
  testConfig,
} from '../../mind/testing/fakes.ts'
import type { MessageRecord } from '../../storage/types.ts'
import { createThreadSummaries } from './index.ts'
import { cutAtSentence } from './prompts.ts'

const THREAD = 'thr_00000000000000000000000001' as const
const TONY = 'per_00000000000000000000000001' as const

let n = 0
function row(role: MessageRecord['role'], content: string, over: Partial<MessageRecord> = {}): MessageRecord {
  n++
  const base = {
    id: `msg_${String(n).padStart(26, '0')}` as const,
    threadId: THREAD,
    authorPersonId: role === 'user' ? TONY : null,
    nodeId: null,
    modality: 'text' as const,
    content,
    meta: null,
    createdAt: n,
  }
  if (role === 'user') return { ...base, role }
  if (role === 'tool')
    return {
      ...base,
      role,
      toolCallId: 'c1',
      toolName: 'lab.status',
      isError: false,
      ...over,
    } as MessageRecord
  return { ...base, role, toolCalls: null, ui: null, ...over } as MessageRecord
}

async function setup(opts: { recent: number; min: number; maxChars?: number; script?: FakeLlmTurn[] }) {
  const clock = createFakeClock(0)
  const log = createMemoryLogger()
  const repos = createFakeRepos()
  await repos.persons.create({
    id: TONY,
    name: 'Tony',
    username: null,
    passwordHash: null,
    tier: 'owner',
    lastSeenAt: null,
    createdAt: 0,
  })
  await repos.threads.create(
    {
      id: THREAD,
      kind: 'direct',
      slug: 'main',
      title: 'Main',
      ownerPersonId: TONY,
      summary: null,
      createdAt: 0,
      updatedAt: 0,
    },
    [TONY],
  )
  const events = createEventBus({ log, clock })
  const summarized: unknown[] = []
  events.on('thread.summarized', (e) => {
    summarized.push(e.data)
  })
  const llm = createFakeLlm(opts.script ?? [])
  const ids = createFakeIds()
  const runLoop = createRunLoop({
    providers: createFakeProviders(llm),
    tools: createFakeToolRegistry(),
    repos,
    events,
    ids,
    clock,
    log,
    stallMs: 10_000,
    retries: 0,
  })
  const config = testConfig(
    { context: { recentMessages: opts.recent } },
    { summary: { minMessages: opts.min, ...(opts.maxChars ? { maxChars: opts.maxChars } : {}) } },
  )
  const { summarizer } = createThreadSummaries({
    config,
    repos,
    runLoop,
    scheduler: { run: (_lane, job, signal) => job(signal ?? new AbortController().signal) },
    events,
    clock,
    ids,
    log,
  })
  const update = () => summarizer.update({ threadId: THREAD, signal: new AbortController().signal })
  return { repos, llm, events, summarized, update }
}

describe('thread summarizer', () => {
  test('below minMessages there is no model call and the result is false', async () => {
    const s = await setup({ recent: 3, min: 4 })
    // 6 rows: 3 left the window, 1 short of minMessages.
    for (let i = 0; i < 6; i++)
      await s.repos.messages.append(row(i % 2 === 0 ? 'user' : 'assistant', `m${i}`))
    expect(await s.update()).toBe(false)
    expect(s.llm.calls).toBe(0)
    expect((await s.repos.threads.get(THREAD))?.summaryThroughSeq ?? null).toBeNull()
  })

  test('at the threshold, folds the pending rows into the previous summary', async () => {
    const s = await setup({ recent: 3, min: 4, script: [fakeText('Tony picked Rome. You booked the hall.')] })
    await s.repos.threads.setSummary(THREAD, { summary: 'Tony runs an expo.', throughSeq: 0 })
    const pending = [
      row('user', 'Plan the expo in Rome.'),
      row('assistant', '', {
        toolCalls: [{ id: 'c1', name: 'lab.status', args: {} }],
      } as Partial<MessageRecord>),
      row('tool', 'SECRET TOOL OUTPUT'),
      row('assistant', 'Booked the hall.'),
    ]
    const recent = [row('user', 'recent one'), row('assistant', 'recent two'), row('user', 'recent three')]
    for (const r of [...pending, ...recent]) await s.repos.messages.append(r)

    expect(await s.update()).toBe(true)
    expect(s.llm.calls).toBe(1)
    const req = s.llm.requests[0]
    const prompt = req?.messages.map((m) => m.content).join('\n') ?? ''
    expect(prompt).toContain('Tony runs an expo.')
    expect(prompt).toContain('Tony: Plan the expo in Rome.')
    expect(prompt).toContain('Keith (you): Booked the hall.')
    expect(prompt).not.toContain('SECRET TOOL OUTPUT')
    expect(prompt).not.toContain('recent one')
    expect(req?.tools ?? []).toEqual([])
    expect(req?.system).toContain('2000 characters')

    const thread = await s.repos.threads.get(THREAD)
    expect(thread?.summary).toBe('Tony picked Rome. You booked the hall.')
    expect(thread?.summaryThroughSeq).toBe(4)
    await s.events.idle()
    expect(s.summarized).toEqual([{ threadId: THREAD, throughSeq: 4 }])
  })

  test('output over maxChars is cut at a sentence boundary', async () => {
    const s = await setup({
      recent: 1,
      min: 2,
      maxChars: 40,
      script: [fakeText('Tony picked Rome for the expo. Pepper will handle the budget next week.')],
    })
    for (let i = 0; i < 3; i++)
      await s.repos.messages.append(row(i % 2 === 0 ? 'user' : 'assistant', `m${i}`))
    expect(await s.update()).toBe(true)
    expect((await s.repos.threads.get(THREAD))?.summary).toBe('Tony picked Rome for the expo.')
  })

  test('a provider error leaves the summary unchanged', async () => {
    const s = await setup({
      recent: 1,
      min: 2,
      script: [
        () => {
          throw new ProviderError('bad_request', '400')
        },
      ],
    })
    await s.repos.threads.setSummary(THREAD, { summary: 'Before.', throughSeq: 0 })
    for (let i = 0; i < 3; i++)
      await s.repos.messages.append(row(i % 2 === 0 ? 'user' : 'assistant', `m${i}`))
    expect(await s.update()).toBe(false)
    expect(s.llm.calls).toBe(1)
    const thread = await s.repos.threads.get(THREAD)
    expect(thread?.summary).toBe('Before.')
    expect(thread?.summaryThroughSeq).toBe(0)
    await s.events.idle()
    expect(s.summarized).toEqual([])
  })

  test('an empty reply leaves the summary unchanged', async () => {
    const s = await setup({ recent: 1, min: 2, script: [fakeText('   ')] })
    for (let i = 0; i < 3; i++)
      await s.repos.messages.append(row(i % 2 === 0 ? 'user' : 'assistant', `m${i}`))
    expect(await s.update()).toBe(false)
    expect((await s.repos.threads.get(THREAD))?.summaryThroughSeq ?? null).toBeNull()
  })
})

describe('cutAtSentence', () => {
  test('keeps short text, cuts at a sentence end, else at a space', () => {
    expect(cutAtSentence(' Short. ', 100)).toBe('Short.')
    expect(cutAtSentence('One two. Three four five.', 15)).toBe('One two.')
    expect(cutAtSentence('no sentence end here at all', 12)).toBe('no sentence')
    expect(cutAtSentence('abcdefghij', 4)).toBe('abcd')
  })
})
