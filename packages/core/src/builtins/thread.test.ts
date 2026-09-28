// The `thread.*` group built-ins: names, input schemas, `minTier` (ADR-0017) and registration
// (P5-K1), and the behavior against a fake GroupThreads (P5-C1).

import { describe, expect, test } from 'bun:test'
import { KeithError, type Tool, type ToolResult, type ToolRunContext } from '@keith/sdk'
import { createMemoryLogger } from '@keith/sdk/testing'
import { z } from 'zod'
import { createFakeRepos, testConfig } from '../mind/testing/fakes.ts'
import type { GroupRefusalReason, GroupThreads } from '../mind/types.ts'
import type { PersonDto, PersonId, ThreadId } from '../shared/types.ts'
import type { ThreadRecord } from '../storage/types.ts'
import { type BuiltinDeps, registerBuiltins } from './index.ts'
import { createThreadTools, THREAD_MESSAGES, THREAD_TOOL_NAMES, type ThreadToolsDeps } from './thread.ts'

const service: GroupThreads = {
  start: async () => {
    throw new Error('unused')
  },
  invite: async () => ({ invited: [], joined: [], skipped: [] }),
  join: async () => false,
  leave: async () => false,
}

const groupDeps: ThreadToolsDeps = {
  service,
  persons: { findByName: async () => null },
  threads: { get: async () => null, participants: async () => [] },
  config: { mind: testConfig().mind },
}

const threadId = 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V31'

function byName(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]))
}

function builtinDeps(extra: Partial<BuiltinDeps> = {}): { deps: BuiltinDeps; registered: string[] } {
  const registered: string[] = []
  const deps: BuiltinDeps = {
    tasks: {} as BuiltinDeps['tasks'],
    memory: {} as BuiltinDeps['memory'],
    persons: { list: async () => [] },
    skills: { get: () => undefined, list: () => [], registerDefault: () => {} },
    tools: { registerBuiltin: (tool) => registered.push(tool.name) },
    ...extra,
  }
  return { deps, registered }
}

describe('thread.* specs (ADR-0017)', () => {
  const tools = byName(createThreadTools(groupDeps))

  test('four tools with the fixed names; members start and invite, anyone joins and leaves', () => {
    expect([...tools.keys()]).toEqual([...THREAD_TOOL_NAMES])
    expect(tools.get('thread.start_group')?.minTier).toBe('member')
    expect(tools.get('thread.invite')?.minTier).toBe('member')
    expect(tools.get('thread.join')?.minTier).toBe('guest')
    expect(tools.get('thread.leave')?.minTier).toBe('guest')
  })

  test('thread.start_group takes 1..7 names, a title (1..80) and an optional purpose (..500)', () => {
    const input = tools.get('thread.start_group')?.input
    if (!input) throw new Error('missing thread.start_group')
    expect(input.parse({ participants: [' Pepper ', 'Rhodey'], title: ' Mission ' })).toEqual({
      participants: ['Pepper', 'Rhodey'],
      title: 'Mission',
    })
    expect(input.safeParse({ participants: ['Pepper'], title: 'M', purpose: 'x'.repeat(500) }).success).toBe(
      true,
    )
    expect(input.safeParse({ participants: ['Pepper'], title: 'M', purpose: 'x'.repeat(501) }).success).toBe(
      false,
    )
    expect(input.safeParse({ participants: [], title: 'Mission' }).success).toBe(false)
    expect(input.safeParse({ participants: Array(8).fill('Pepper'), title: 'Mission' }).success).toBe(false)
    expect(input.safeParse({ participants: Array(7).fill('Pepper'), title: 'Mission' }).success).toBe(true)
    expect(input.safeParse({ participants: ['Pepper'], title: '' }).success).toBe(false)
    expect(input.safeParse({ participants: ['Pepper'], title: 'x'.repeat(81) }).success).toBe(false)
    expect(input.safeParse({ participants: [''], title: 'Mission' }).success).toBe(false)
  })

  test('thread.invite takes 1..7 names', () => {
    const input = tools.get('thread.invite')?.input
    if (!input) throw new Error('missing thread.invite')
    expect(input.safeParse({ participants: ['Happy'] }).success).toBe(true)
    expect(input.safeParse({ participants: [] }).success).toBe(false)
    expect(input.safeParse({ participants: Array(8).fill('Happy') }).success).toBe(false)
  })

  test('thread.join needs a thread id; thread.leave takes an optional one', () => {
    const join = tools.get('thread.join')?.input
    const leave = tools.get('thread.leave')?.input
    if (!join || !leave) throw new Error('missing thread.join or thread.leave')
    expect(join.safeParse({ threadId }).success).toBe(true)
    expect(join.safeParse({}).success).toBe(false)
    expect(join.safeParse({ threadId: 'msg_01J8ZQ3K4M5N6P7Q8R9S0T1V31' }).success).toBe(false)
    expect(leave.safeParse({}).success).toBe(true)
    expect(leave.safeParse({ threadId }).success).toBe(true)
    expect(leave.safeParse({ threadId: 'thr_x' }).success).toBe(false)
  })

  test('every input schema converts to JSON Schema for the model', () => {
    for (const tool of tools.values()) expect(() => z.toJSONSchema(tool.input)).not.toThrow()
  })

  test('there is a refusal answer for every GroupRefusalReason', () => {
    expect(Object.keys(THREAD_MESSAGES.refused).sort()).toEqual(
      ['limit', 'no_invitees', 'not_group', 'not_participant', 'self', 'tier', 'unknown_person'].sort(),
    )
    expect(THREAD_MESSAGES.refused.limit(8)).toContain('8')
    expect(THREAD_MESSAGES.unknown('Bob')).toBe("I don't know anyone called Bob.")
  })
})

describe('registerBuiltins and groups', () => {
  test('without groups, no thread.* tool is registered', () => {
    const { deps, registered } = builtinDeps()
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('thread.'))).toEqual([])
  })

  test('with groups, the four tools are registered', () => {
    const { deps, registered } = builtinDeps({ groups: groupDeps })
    registerBuiltins(deps)
    expect(registered.filter((n) => n.startsWith('thread.'))).toEqual([...THREAD_TOOL_NAMES])
  })
})

// Behavior (P5-C1)

const TONY = 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V01' as PersonId
const PEPPER = 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V02' as PersonId
const RHODEY = 'per_01J8ZQ3K4M5N6P7Q8R9S0T1V03' as PersonId
const MAIN = 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V10' as ThreadId
const GROUP = 'thr_01J8ZQ3K4M5N6P7Q8R9S0T1V11' as ThreadId

function refused(reason: GroupRefusalReason): KeithError {
  return new KeithError('FORBIDDEN', reason, { details: { reason } })
}

type Calls = { start: unknown[]; invite: unknown[]; join: unknown[]; leave: unknown[] }

/** Tony (owner), Pepper and Rhodey (members), Tony's main thread and the "Mission" group (Tony, Pepper). */
async function behaviorWorld(service: Partial<GroupThreads> = {}) {
  const repos = createFakeRepos()
  for (const [id, name] of [
    [TONY, 'Tony'],
    [PEPPER, 'Pepper'],
    [RHODEY, 'Rhodey'],
  ] as const) {
    await repos.persons.create({
      id,
      name,
      username: `${name.toLowerCase()}_s`,
      passwordHash: null,
      tier: id === TONY ? 'owner' : 'member',
      lastSeenAt: null,
      createdAt: 0,
    })
  }
  const base = { summary: null, createdAt: 0, updatedAt: 0 }
  await repos.threads.create(
    { ...base, id: MAIN, kind: 'direct', slug: 'main', title: 'Main', ownerPersonId: TONY },
    [TONY],
  )
  const group: ThreadRecord = {
    ...base,
    id: GROUP,
    kind: 'group',
    slug: null,
    title: 'Mission',
    ownerPersonId: TONY,
    purpose: null,
  }
  await repos.threads.create(group, [TONY, PEPPER])

  const calls: Calls = { start: [], invite: [], join: [], leave: [] }
  const fake: GroupThreads = {
    async start(a) {
      calls.start.push(a)
      if (service.start) return service.start(a)
      return { thread: group, invited: a.inviteeIds, joined: [] }
    },
    async invite(a) {
      calls.invite.push(a)
      if (service.invite) return service.invite(a)
      return { invited: a.inviteeIds, joined: [], skipped: [] }
    },
    async join(a) {
      calls.join.push(a)
      return service.join ? service.join(a) : true
    },
    async leave(a) {
      calls.leave.push(a)
      return service.leave ? service.leave(a) : true
    },
  }
  const tools = byName(
    createThreadTools({
      service: fake,
      persons: repos.persons,
      threads: repos.threads,
      config: {
        mind: testConfig({ group: { maxParticipants: 5, autoJoin: false, addressing: 'rules' } }).mind,
      },
    }),
  )
  return { tools, calls }
}

const TONY_DTO: PersonDto = { id: TONY, name: 'Tony', tier: 'owner' }
const RHODEY_DTO: PersonDto = { id: RHODEY, name: 'Rhodey', tier: 'member' }

function ctx(threadId: ThreadId | null, person: PersonDto = TONY_DTO): ToolRunContext {
  return {
    person,
    participants: [person],
    threadId,
    taskId: null,
    signal: new AbortController().signal,
    log: createMemoryLogger(),
    services: {
      get: () => {
        throw new Error('no services in this test')
      },
      find: () => undefined,
    },
  }
}

/** Parses input with the tool's schema (as the registry does), then runs it. */
async function call(
  tools: Map<string, Tool>,
  name: string,
  raw: unknown,
  t: ToolRunContext,
): Promise<ToolResult> {
  const tool = tools.get(name)
  if (!tool) throw new Error(`missing ${name}`)
  return tool.run(tool.input.parse(raw), t)
}

describe('thread.start_group', () => {
  test('resolves names case-insensitively (name or username) and answers the thread id and title', async () => {
    const w = await behaviorWorld()
    const r = await call(
      w.tools,
      'thread.start_group',
      { participants: ['pepper', 'RHODEY_S'], title: 'Mission', purpose: 'Plan it' },
      ctx(MAIN),
    )
    expect(w.calls.start).toEqual([
      { creatorId: TONY, inviteeIds: [PEPPER, RHODEY], title: 'Mission', purpose: 'Plan it' },
    ])
    expect(r).toEqual({
      content: THREAD_MESSAGES.started({
        title: 'Mission',
        threadId: GROUP,
        invited: ['Pepper', 'Rhodey'],
        joined: [],
      }),
    })
    expect(r.content).toContain(GROUP)
  })

  test('an unknown name is a tool error, and the service is not called', async () => {
    const w = await behaviorWorld()
    const r = await call(
      w.tools,
      'thread.start_group',
      { participants: ['Pepper', 'Bob'], title: 'M' },
      ctx(MAIN),
    )
    expect(r).toEqual({ content: THREAD_MESSAGES.unknown('Bob'), error: true })
    expect(w.calls.start).toEqual([])
  })

  test('refusals become tool errors with the fixed wording; limit names maxParticipants', async () => {
    for (const reason of ['tier', 'self', 'limit'] as const) {
      const w = await behaviorWorld({
        start: async () => {
          throw refused(reason)
        },
      })
      const r = await call(w.tools, 'thread.start_group', { participants: ['Pepper'], title: 'M' }, ctx(MAIN))
      const answer = THREAD_MESSAGES.refused[reason]
      expect(r).toEqual({ content: typeof answer === 'function' ? answer(5) : answer, error: true })
    }
  })

  test('an unexpected error is thrown, not hidden', async () => {
    const w = await behaviorWorld({
      start: async () => {
        throw new KeithError('INTERNAL', 'boom')
      },
    })
    await expect(
      call(w.tools, 'thread.start_group', { participants: ['Pepper'], title: 'M' }, ctx(MAIN)),
    ).rejects.toMatchObject({ code: 'INTERNAL' })
  })
})

describe('thread.invite', () => {
  test('invites in the current thread and names invited and skipped people', async () => {
    const w = await behaviorWorld({
      invite: async () => ({ invited: [RHODEY], joined: [], skipped: [PEPPER] }),
    })
    const r = await call(w.tools, 'thread.invite', { participants: ['Rhodey', 'pepper'] }, ctx(GROUP))
    expect(w.calls.invite).toEqual([{ threadId: GROUP, inviterId: TONY, inviteeIds: [RHODEY, PEPPER] }])
    expect(r).toEqual({
      content: THREAD_MESSAGES.invited({ invited: ['Rhodey'], joined: [], skipped: ['Pepper'] }),
    })
  })

  test('outside a group it answers not_group', async () => {
    const w = await behaviorWorld({
      invite: async () => {
        throw refused('not_group')
      },
    })
    const notGroup = { content: THREAD_MESSAGES.refused.not_group, error: true }
    expect(await call(w.tools, 'thread.invite', { participants: ['Rhodey'] }, ctx(MAIN))).toEqual(notGroup)
    expect(await call(w.tools, 'thread.invite', { participants: ['Rhodey'] }, ctx(null))).toEqual(notGroup)
  })
})

describe('thread.join', () => {
  test('answers the title', async () => {
    const w = await behaviorWorld()
    expect(await call(w.tools, 'thread.join', { threadId: GROUP }, ctx(MAIN, RHODEY_DTO))).toEqual({
      content: THREAD_MESSAGES.joined('Mission'),
    })
    expect(w.calls.join).toEqual([{ threadId: GROUP, personId: RHODEY }])
  })

  test('no invitation and an unknown thread are tool errors', async () => {
    const none = await behaviorWorld({ join: async () => false })
    expect(await call(none.tools, 'thread.join', { threadId: GROUP }, ctx(MAIN, RHODEY_DTO))).toEqual({
      content: THREAD_MESSAGES.noInvitation,
      error: true,
    })
    const missing = await behaviorWorld({
      join: async () => {
        throw new KeithError('NOT_FOUND', 'no thread')
      },
    })
    expect(await call(missing.tools, 'thread.join', { threadId: GROUP }, ctx(MAIN, RHODEY_DTO))).toEqual({
      content: THREAD_MESSAGES.noSuchThread,
      error: true,
    })
  })
})

describe('thread.leave', () => {
  test('defaults to the current thread; a participant left, an invitee declined', async () => {
    const w = await behaviorWorld()
    expect(await call(w.tools, 'thread.leave', {}, ctx(GROUP))).toEqual({
      content: THREAD_MESSAGES.left('Mission'),
    })
    expect(w.calls.leave).toEqual([{ threadId: GROUP, personId: TONY }])
    expect(await call(w.tools, 'thread.leave', { threadId: GROUP }, ctx(MAIN, RHODEY_DTO))).toEqual({
      content: THREAD_MESSAGES.declined('Mission'),
    })
  })

  test('in a direct thread it is refused with the fixed wording', async () => {
    const w = await behaviorWorld({
      leave: async () => {
        throw refused('not_group')
      },
    })
    expect(await call(w.tools, 'thread.leave', {}, ctx(MAIN))).toEqual({
      content: THREAD_MESSAGES.refused.not_group,
      error: true,
    })
  })

  test('neither in nor invited, an unknown thread and no thread at all are tool errors', async () => {
    const w = await behaviorWorld({ leave: async () => false })
    expect(await call(w.tools, 'thread.leave', { threadId: GROUP }, ctx(MAIN))).toEqual({
      content: THREAD_MESSAGES.notInThread,
      error: true,
    })
    const noSuch = { content: THREAD_MESSAGES.noSuchThread, error: true }
    expect(
      await call(w.tools, 'thread.leave', { threadId: 'thr_09999999999999999999999999' }, ctx(MAIN)),
    ).toEqual(noSuch)
    expect(await call(w.tools, 'thread.leave', {}, ctx(null))).toEqual(noSuch)
  })
})
