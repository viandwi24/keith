import { describe, expect, test } from 'bun:test'
import { defineTool } from '@keith/sdk'
import { createFakeClock } from '@keith/sdk/testing'
import { z } from 'zod'
import type { MessageRecord } from '../storage/types.ts'
import { createContextBuilder } from './context-builder.ts'
import { lowestTier, toLlmMessages, toMessageDto } from './messages.ts'
import {
  createFakeCommitments,
  createFakeMemory,
  createFakeRepos,
  createFakeSkills,
  createFakeToolRegistry,
  testConfig,
} from './testing/fakes.ts'
import { PEPPER, TONY } from './testing/harness.ts'

const THREAD = 'thr_00000000000000000000000001' as const

function tool(name: string, minTier: 'owner' | 'member' | 'guest', requires?: string[]) {
  return defineTool({
    name,
    description: name,
    input: z.object({}),
    minTier,
    ...(requires ? { requires } : {}),
    run: async () => ({ content: 'ok' }),
  })
}

let seq = 0
function msg(role: 'user' | 'assistant', content: string, over: Partial<MessageRecord> = {}): MessageRecord {
  seq++
  const base = {
    id: `msg_${String(seq).padStart(26, '0')}` as const,
    threadId: THREAD,
    authorPersonId: role === 'user' ? TONY : null,
    nodeId: null,
    modality: 'text' as const,
    content,
    meta: null,
    createdAt: seq,
  }
  return role === 'user'
    ? { ...base, role: 'user' }
    : ({ ...base, role: 'assistant', toolCalls: null, ui: null, ...over } as MessageRecord)
}

function toolRow(toolCallId: string, content: string): MessageRecord {
  seq++
  return {
    id: `msg_${String(seq).padStart(26, '0')}`,
    threadId: THREAD,
    role: 'tool',
    authorPersonId: null,
    nodeId: null,
    modality: 'text',
    content,
    meta: null,
    createdAt: seq,
    toolCallId,
    toolName: 'test.echo',
    isError: false,
  }
}

async function setup(recentMessages = 40) {
  const repos = createFakeRepos()
  for (const [id, name, tier] of [
    [TONY, 'Tony', 'owner'],
    [PEPPER, 'Pepper', 'member'],
  ] as const) {
    await repos.persons.create({
      id,
      name,
      username: null,
      passwordHash: null,
      tier,
      lastSeenAt: null,
      createdAt: 0,
    })
  }
  await repos.relationships.upsert({ personId: TONY, tone: 'dry wit', notes: '', blockedRelayFrom: [] })
  const memory = createFakeMemory()
  memory.coreMemories = [
    {
      id: 'mem_00000000000000000000000001',
      content: 'Tony builds suits.',
      subjectPersonId: TONY,
      visibility: 'subject',
      threadId: null,
      source: 'stated',
      authorPersonId: TONY,
      pinned: true,
      createdAt: 0,
      updatedAt: 0,
      lastRecalledAt: null,
    },
  ]
  memory.indexEntries = ['Expo']
  memory.digestText = 'Running one background task.'
  const tools = createFakeToolRegistry([
    tool('skill.load', 'guest'),
    tool('lab.deploy', 'owner'),
    tool('lab.status', 'member'),
    tool('fs.read', 'guest', ['fs@1']),
  ])
  const builder = createContextBuilder({
    config: testConfig({ context: { recentMessages } }),
    persona: async () => 'You are Keith.',
    clock: createFakeClock(0),
    repos,
    memory,
    commitments: createFakeCommitments([
      {
        id: 'cmt_00000000000000000000000001',
        threadId: THREAD,
        personId: TONY,
        taskId: 'tsk_00000000000000000000000001',
        promise: 'Report the shortlist',
        status: 'open',
        createdAt: 0,
        resolvedAt: null,
        expiresAt: 1,
      },
    ]),
    skills: createFakeSkills([{ name: 'expo', description: 'Plan an expo', instructions: 'long text' }]),
    tools,
  })
  return { repos, builder }
}

describe('context builder', () => {
  test('assembles the nine sections in core.md order', async () => {
    const { builder } = await setup()
    const built = await builder.build({
      threadId: THREAD,
      viewer: { participants: [TONY] },
      kind: 'delivery',
      focusCapabilities: ['chat.text@1'],
      deliveries: [
        {
          id: 'dlv_00000000000000000000000001',
          threadId: THREAD,
          personId: TONY,
          kind: 'task_result',
          authorPersonId: null,
          source: 'core',
          urgency: 'normal',
          content: 'Shortlist ready',
          ui: null,
          status: 'pending',
          createdAt: 0,
          deliveredAt: null,
        },
      ],
    })
    const markers = [
      'You are Keith.',
      '# Now',
      '# Who you are talking to',
      '# What you know',
      '# Memory index',
      '# Meanwhile',
      '# Open promises',
      '# Things to tell them',
      '# Skills',
    ]
    const positions = markers.map((m) => built.system.indexOf(m))
    expect(positions.every((p) => p >= 0)).toBe(true)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  test('filters tools by the lowest participant tier and the focus node capabilities', async () => {
    const { builder } = await setup()
    const base = { threadId: THREAD, kind: 'user' as const, deliveries: [] }
    const owner = await builder.build({ ...base, viewer: { participants: [TONY] }, focusCapabilities: [] })
    expect(owner.tools.sort()).toEqual(['lab.deploy', 'lab.status', 'skill.load'])
    const mixed = await builder.build({
      ...base,
      viewer: { participants: [TONY, PEPPER] },
      focusCapabilities: ['fs@1'],
    })
    expect(mixed.tools.sort()).toEqual(['fs.read', 'lab.status', 'skill.load'])
  })

  test('keeps only the last recentMessages messages', async () => {
    const { repos, builder } = await setup(2)
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
    for (const m of [msg('user', 'one'), msg('assistant', 'two'), msg('user', 'three')])
      await repos.messages.append(m)
    const built = await builder.build({
      threadId: THREAD,
      viewer: { participants: [TONY] },
      kind: 'user',
      focusCapabilities: [],
      deliveries: [],
    })
    expect(built.messages).toEqual([
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ])
  })
})

describe('message conversions', () => {
  test('drops orphan tool rows and incomplete tool calls from the LLM replay', () => {
    const records = [
      toolRow('lost', 'cut off by the window'),
      msg('user', 'go'),
      msg('assistant', '', {
        toolCalls: [{ id: 'c1', name: 'test.echo', args: {} }],
      } as Partial<MessageRecord>),
      toolRow('c1', 'result'),
      msg('assistant', 'done'),
      msg('assistant', 'Let me check', {
        toolCalls: [{ id: 'c2', name: 'test.echo', args: {} }],
      } as Partial<MessageRecord>),
    ]
    expect(toLlmMessages(records)).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'test.echo', args: {} }] },
      { role: 'tool', toolCallId: 'c1', content: 'result' },
      { role: 'assistant', content: 'done' },
      { role: 'assistant', content: 'Let me check' },
    ])
  })

  test('DTOs hide tool rows and tool-call steps, and carry ui and meta', () => {
    expect(toMessageDto(toolRow('c1', 'x'))).toBeNull()
    expect(
      toMessageDto(
        msg('assistant', '', { toolCalls: [{ id: 'c', name: 'a.b', args: {} }] } as Partial<MessageRecord>),
      ),
    ).toBeNull()
    const dto = toMessageDto(
      msg('assistant', 'hi', {
        meta: { proactive: true, cancelled: undefined },
        ui: [{ block: { type: 'markdown', id: 'b1', text: 'x' }, toolCallId: 'c', toolName: 'a.b' }],
      } as Partial<MessageRecord>),
    )
    expect(dto).toMatchObject({ meta: { proactive: true }, ui: [{ type: 'markdown', id: 'b1', text: 'x' }] })
    expect(dto?.meta && 'cancelled' in dto.meta).toBe(false)
  })

  test('lowestTier', () => {
    expect(lowestTier(['owner', 'member'])).toBe('member')
    expect(lowestTier(['owner', 'guest', 'member'])).toBe('guest')
    expect(lowestTier(['owner'])).toBe('owner')
    expect(lowestTier([])).toBe('guest')
  })
})
