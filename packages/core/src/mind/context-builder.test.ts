import { describe, expect, test } from 'bun:test'
import { defineTool } from '@keith/sdk'
import { createFakeClock } from '@keith/sdk/testing'
import { z } from 'zod'
import type { Delivery, PersonId } from '../shared/types.ts'
import type { MessageRecord, ThreadRecord } from '../storage/types.ts'
import { createContextBuilder } from './context-builder.ts'
import { GROUP_ADDRESS_RULE, GROUP_TONE_RULE } from './context-sections.ts'
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
const RHODEY: PersonId = 'per_000000000000000000000RH0DE'
/** A person who was deleted (ADR-0018) or never existed: `persons.get` answers null. */
const GONE: PersonId = 'per_0000000000000000000000G0NE'

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
    ? ({ ...base, role: 'user', ...over } as MessageRecord)
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

async function setup(recentMessages = 40, minMessages = 20) {
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
    config: testConfig({ context: { recentMessages } }, { summary: { minMessages } }),
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

describe('context builder: thread summary', () => {
  async function thread(repos: Awaited<ReturnType<typeof setup>>['repos'], count: number) {
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
    for (let i = 1; i <= count; i++)
      await repos.messages.append(msg(i % 2 === 1 ? 'user' : 'assistant', `m${i}`))
  }

  const turn = { threadId: THREAD, viewer: { participants: [TONY] }, focusCapabilities: [] }

  test('the summary is its own section, between open promises and deliveries', async () => {
    const { repos, builder } = await setup()
    await thread(repos, 2)
    await repos.threads.setSummary(THREAD, { summary: 'Tony picked Rome for the expo.', throughSeq: 0 })
    const built = await builder.build({ ...turn, kind: 'briefing', deliveries: [] })
    const promises = built.system.indexOf('# Open promises')
    const summary = built.system.indexOf('# Earlier in this thread\nTony picked Rome for the expo.')
    const deliveries = built.system.indexOf('# Things to tell them')
    expect(promises).toBeGreaterThanOrEqual(0)
    expect(summary).toBeGreaterThan(promises)
    expect(deliveries).toBeGreaterThan(summary)
  })

  test('no summary, no section', async () => {
    const { repos, builder } = await setup()
    await thread(repos, 2)
    const built = await builder.build({ ...turn, kind: 'user', deliveries: [] })
    expect(built.system).not.toContain('# Earlier in this thread')
  })

  test('the window starts right after the cursor, within [recent, recent + minMessages]', async () => {
    // recentMessages 3, minMessages 2: the window holds 3 to 5 rows.
    const { repos, builder } = await setup(3, 2)
    await thread(repos, 10)
    const windowAfter = async (throughSeq: number) => {
      await repos.threads.setSummary(THREAD, { summary: 'Earlier.', throughSeq })
      const built = await builder.build({ ...turn, kind: 'user', deliveries: [] })
      return built.messages.map((m) => m.content)
    }
    // 4 rows after the cursor: exactly those.
    expect(await windowAfter(6)).toEqual(['m7', 'm8', 'm9', 'm10'])
    // 5 rows after the cursor: the upper bound, still exactly those.
    expect(await windowAfter(5)).toEqual(['m6', 'm7', 'm8', 'm9', 'm10'])
    // 2 rows after the cursor: at least recentMessages.
    expect(await windowAfter(8)).toEqual(['m8', 'm9', 'm10'])
    // 8 rows after the cursor (the job fell behind): at most recentMessages + minMessages.
    expect(await windowAfter(2)).toEqual(['m6', 'm7', 'm8', 'm9', 'm10'])
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

function delivery(over: Partial<Delivery>): Delivery {
  return {
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
    ...over,
  }
}

function threadRecord(kind: 'direct' | 'group', over: Partial<ThreadRecord> = {}): ThreadRecord {
  return {
    id: THREAD,
    kind,
    slug: kind === 'direct' ? 'main' : null,
    title: kind === 'direct' ? 'Main' : 'Mission',
    ownerPersonId: TONY,
    summary: null,
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

describe('context builder: direct threads are unchanged (phase 5)', () => {
  test('a direct build is byte-for-byte what it was before group support', async () => {
    const { repos, builder } = await setup()
    await repos.threads.create(threadRecord('direct'), [TONY])
    for (const m of [
      msg('user', 'hello'),
      msg('assistant', 'Good morning, sir.'),
      msg('user', 'what did I miss?'),
    ])
      await repos.messages.append(m)
    const built = await builder.build({
      threadId: THREAD,
      viewer: { participants: [TONY] },
      kind: 'user',
      focusCapabilities: ['chat.text@1'],
      deliveries: [
        delivery({}),
        delivery({
          id: 'dlv_00000000000000000000000002',
          kind: 'plugin',
          authorPersonId: PEPPER,
          source: '@keith/tool-lab',
          urgency: 'high',
          content: 'Reactor warm',
        }),
      ],
    })
    // Captured from the phase-4 builder with the same fixture.
    expect(built).toEqual({
      system:
        "You are Keith.\n\n# Now\nIt is Thursday, January 1, 1970 at 12:00 AM (UTC).\nThe person's current device supports: chat.text@1.\nIt cannot show visual UI; answer in plain text.\n\n# Who you are talking to\n- Tony (tier: owner)\n  Tone: dry wit\n\n# What you know\n- Tony builds suits.\n\n# Memory index\nYou also have memories about these subjects. Use memory.recall when one is relevant:\nExpo\n\n# Meanwhile\nRunning one background task.\n\n# Open promises in this conversation\n- Report the shortlist (task tsk_00000000000000000000000001)\n\n# Things to tell them\nThey just arrived. If their message is a greeting or asks what they missed, lead with these items. Otherwise answer first, then mention them briefly.\n- [normal] (task_result) Shortlist ready\n- [high] (plugin from @keith/tool-lab) Reactor warm\n\n# Skills\nCall skill.load with a name to read its full instructions before using it:\n- expo: Plan an expo",
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'Good morning, sir.' },
        { role: 'user', content: 'what did I miss?' },
      ],
      tools: ['skill.load', 'lab.deploy', 'lab.status'],
    })
  })

  test('a relay in a direct delivery turn is labelled with its sender', async () => {
    const { repos, builder } = await setup()
    await repos.threads.create(threadRecord('direct'), [TONY])
    const built = await builder.build({
      threadId: THREAD,
      viewer: { participants: [TONY] },
      kind: 'delivery',
      focusCapabilities: [],
      deliveries: [
        delivery({ kind: 'relay', authorPersonId: PEPPER, content: 'The kids are asleep.' }),
        delivery({
          id: 'dlv_00000000000000000000000002',
          kind: 'relay',
          authorPersonId: GONE,
          content: 'Old news.',
        }),
      ],
    })
    expect(built.system).toContain('- [normal] (relay from Pepper) The kids are asleep.')
    expect(built.system).toContain('- [normal] (relay from Someone) Old news.')
    expect(built.system).toContain('say who it is from')
  })
})

describe('context builder: group threads (phase 5)', () => {
  async function group(purpose: string | null = 'Get the suit to Rome') {
    const s = await setup()
    await s.repos.persons.create({
      id: RHODEY,
      name: 'Rhodey',
      username: null,
      passwordHash: null,
      tier: 'guest',
      lastSeenAt: null,
      createdAt: 0,
    })
    await s.repos.relationships.upsert({
      personId: RHODEY,
      tone: 'formal',
      notes: 'colonel',
      blockedRelayFrom: [],
    })
    await s.repos.threads.create(threadRecord('group', { purpose }), [TONY, PEPPER, RHODEY])
    return s
  }

  const turn = {
    threadId: THREAD,
    viewer: { participants: [TONY, PEPPER, RHODEY] },
    focusCapabilities: [],
    deliveries: [],
  }

  test('user messages carry their author names, and the Mind stays unnamed', async () => {
    const { repos, builder } = await group()
    for (const m of [
      msg('user', 'Keith, status?'),
      msg('assistant', 'All green, sir.'),
      msg('user', 'Keith, and the jet?', { authorPersonId: PEPPER }),
      msg('user', 'I left the group.', { authorPersonId: GONE }),
      msg('user', 'Keith, what about me?', { authorPersonId: RHODEY }),
    ])
      await repos.messages.append(m)
    const built = await builder.build({ ...turn, kind: 'user' })
    expect(built.messages).toEqual([
      { role: 'user', name: 'Tony', content: 'Tony: Keith, status?' },
      { role: 'assistant', content: 'All green, sir.' },
      { role: 'user', name: 'Pepper', content: 'Pepper: Keith, and the jet?' },
      { role: 'user', name: 'Someone', content: 'Someone: I left the group.' },
      { role: 'user', name: 'Rhodey', content: 'Rhodey: Keith, what about me?' },
    ])
  })

  test('a former participant who still exists keeps their name', async () => {
    const { repos, builder } = await group()
    await repos.messages.append(msg('user', 'Keith, hi.', { authorPersonId: PEPPER }))
    const built = await builder.build({ ...turn, viewer: { participants: [TONY, RHODEY] }, kind: 'user' })
    expect(built.messages).toEqual([{ role: 'user', name: 'Pepper', content: 'Pepper: Keith, hi.' }])
    expect(built.system).not.toContain('- Pepper (tier')
  })

  test('section 3 shows every card, the title, the purpose, whose message it answers and the rules', async () => {
    const { repos, builder } = await group()
    await repos.messages.append(msg('user', 'Keith, and the jet?', { authorPersonId: PEPPER }))
    const built = await builder.build({ ...turn, kind: 'user' })
    expect(built.system).toContain(
      [
        '# Participants',
        'This is the group thread "Mission".',
        'Its purpose: Get the suit to Rome',
        '- Tony (tier: owner)',
        '  Tone: dry wit',
        '- Pepper (tier: member)',
        '- Rhodey (tier: guest)',
        '  Tone: formal',
        '  Notes: colonel',
        "You are answering Pepper's message.",
        GROUP_TONE_RULE,
        GROUP_ADDRESS_RULE,
      ].join('\n'),
    )
    // A guest in the group limits everyone's tools.
    expect(built.tools).toEqual(['skill.load'])
  })

  test('a delivery turn in a group answers nobody', async () => {
    const { builder } = await group(null)
    const built = await builder.build({ ...turn, kind: 'delivery', deliveries: [delivery({})] })
    expect(built.system).toContain('This is the group thread "Mission".')
    expect(built.system).not.toContain('Its purpose')
    expect(built.system).not.toContain('You are answering')
  })
})
