// The phase-5 visibility audit (task P5-E1, S-4, S-6): on a real migrated database, every read
// path that feeds a context or a tool answer admits exactly what I-4 admits, for direct threads,
// groups, a group with a guest, and a group someone left.
//
// The expected rows come from a table written by hand (EXPECTED), which is itself checked against
// `isVisible` over facts written by hand (not loaded from storage). The read paths use the real
// storage filter, so `left_at` counts.

import { afterEach, describe, expect, test } from 'bun:test'
import type { Tool, ToolRunContext } from '@keith/sdk'
import { createFakeClock, createMemoryLogger } from '@keith/sdk/testing'
import { createMemoryTools } from '../builtins/memory.ts'
import { createTaskTools } from '../builtins/task.ts'
import { createTaskService, type TaskManager } from '../scheduler/tasks.ts'
import type {
  Ids,
  Memory,
  MemoryId,
  PersonDto,
  PersonId,
  Task,
  TaskId,
  ThreadId,
  Tier,
  Viewer,
  Visibility,
} from '../shared/types.ts'
import { createTestDb, type TestDb } from '../storage/testing.ts'
import { MemoryStore } from './service.ts'
import { FakeEventBus, fixedId } from './testing/fakes.ts'
import { isVisible, taskTarget, type VisibilityFacts } from './visibility.ts'

// People

const TONY = fixedId('per', 1)
const PEPPER = fixedId('per', 2)
const RHODEY = fixedId('per', 3)
const HAPPY = fixedId('per', 4)

const PEOPLE: PersonDto[] = [
  { id: TONY, name: 'Tony', tier: 'owner' },
  { id: PEPPER, name: 'Pepper', tier: 'member' },
  { id: RHODEY, name: 'Rhodey', tier: 'member' },
  { id: HAPPY, name: 'Happy', tier: 'guest' },
]
const person = (id: PersonId): PersonDto => PEOPLE.find((p) => p.id === id) as PersonDto
const nameOf = (id: PersonId): string => person(id).name

// Threads

const TONY_MAIN = fixedId('thr', 1)
const PEPPER_MAIN = fixedId('thr', 2)
const RHODEY_MAIN = fixedId('thr', 3)
const HAPPY_MAIN = fixedId('thr', 4)
/** Tony, Pepper and Rhodey. */
const MISSION = fixedId('thr', 5)
/** Tony, Pepper and Happy (a guest). */
const PARTY = fixedId('thr', 6)
/** Tony, Pepper and Rhodey; Rhodey left. */
const WORKSHOP = fixedId('thr', 7)

type ThreadSpec = { id: ThreadId; title: string; kind: 'direct' | 'group'; members: PersonId[] }

const THREADS: ThreadSpec[] = [
  { id: TONY_MAIN, title: 'Tony', kind: 'direct', members: [TONY] },
  { id: PEPPER_MAIN, title: 'Pepper', kind: 'direct', members: [PEPPER] },
  { id: RHODEY_MAIN, title: 'Rhodey', kind: 'direct', members: [RHODEY] },
  { id: HAPPY_MAIN, title: 'Happy', kind: 'direct', members: [HAPPY] },
  { id: MISSION, title: 'Mission', kind: 'group', members: [TONY, PEPPER, RHODEY] },
  { id: PARTY, title: 'Party', kind: 'group', members: [TONY, PEPPER, HAPPY] },
  { id: WORKSHOP, title: 'Workshop', kind: 'group', members: [TONY, PEPPER, RHODEY] },
]
const titleOf = (id: ThreadId): string => THREADS.find((t) => t.id === id)?.title ?? '?'

/** Written by hand from the fixture: tiers and the threads each person is a *current* participant of. */
const HAND_FACTS: VisibilityFacts = new Map<PersonId, { tier: Tier; threadIds: Set<ThreadId> }>([
  [TONY, { tier: 'owner', threadIds: new Set([TONY_MAIN, MISSION, PARTY, WORKSHOP]) }],
  [PEPPER, { tier: 'member', threadIds: new Set([PEPPER_MAIN, MISSION, PARTY, WORKSHOP]) }],
  [RHODEY, { tier: 'member', threadIds: new Set([RHODEY_MAIN, MISSION]) }],
  [HAPPY, { tier: 'guest', threadIds: new Set([HAPPY_MAIN, PARTY]) }],
])

// Memories: one of every visibility. Each content has a unique topic word (its key) and the
// shared word "zebra", so one recall query finds them all and `index` shows which ones it saw.

type MemorySpec = {
  key: string
  visibility: Visibility
  subject: PersonId | null
  thread: ThreadId | null
}

const MEMORIES: MemorySpec[] = [
  { key: 'subjecttony', visibility: 'subject', subject: TONY, thread: TONY_MAIN },
  { key: 'subjectpepper', visibility: 'subject', subject: PEPPER, thread: PEPPER_MAIN },
  { key: 'subjectrhodey', visibility: 'subject', subject: RHODEY, thread: RHODEY_MAIN },
  { key: 'subjecthappy', visibility: 'subject', subject: HAPPY, thread: HAPPY_MAIN },
  { key: 'threadtonymain', visibility: 'thread', subject: null, thread: TONY_MAIN },
  { key: 'threadpeppermain', visibility: 'thread', subject: null, thread: PEPPER_MAIN },
  { key: 'threadrhodeymain', visibility: 'thread', subject: null, thread: RHODEY_MAIN },
  { key: 'threadhappymain', visibility: 'thread', subject: null, thread: HAPPY_MAIN },
  { key: 'threadmission', visibility: 'thread', subject: null, thread: MISSION },
  { key: 'threadparty', visibility: 'thread', subject: null, thread: PARTY },
  { key: 'threadworkshop', visibility: 'thread', subject: null, thread: WORKSHOP },
  { key: 'householdfact', visibility: 'household', subject: null, thread: null },
  { key: 'ownerfact', visibility: 'owner', subject: null, thread: null },
]
const memoryId = (key: string): MemoryId => fixedId('mem', MEMORIES.findIndex((m) => m.key === key) + 1)
const keyOfMemory = (id: MemoryId): string => MEMORIES[Number(id.slice(4)) - 1]?.key ?? '?'

// Tasks: every visibility a task can have (subject in a direct thread, thread in a group).

type TaskSpec = { key: string; person: PersonId; thread: ThreadId; visibility: 'subject' | 'thread' }

const TASKS: TaskSpec[] = [
  { key: 'tasktony', person: TONY, thread: TONY_MAIN, visibility: 'subject' },
  { key: 'taskpepper', person: PEPPER, thread: PEPPER_MAIN, visibility: 'subject' },
  { key: 'taskrhodey', person: RHODEY, thread: RHODEY_MAIN, visibility: 'subject' },
  { key: 'taskhappy', person: HAPPY, thread: HAPPY_MAIN, visibility: 'subject' },
  { key: 'taskmission', person: RHODEY, thread: MISSION, visibility: 'thread' },
  { key: 'taskparty', person: PEPPER, thread: PARTY, visibility: 'thread' },
  { key: 'taskworkshop', person: TONY, thread: WORKSHOP, visibility: 'thread' },
]
const taskId = (key: string): TaskId => fixedId('tsk', TASKS.findIndex((t) => t.key === key) + 1)
const goalOf = (key: string): string => `Goal ${key}`

// Viewers: every direct thread and every group, with who speaks there (the tool caller).

type ViewerSpec = { name: string; participants: PersonId[]; thread: ThreadId; speaker: PersonId }

const VIEWERS: ViewerSpec[] = [
  { name: "Tony's direct thread", participants: [TONY], thread: TONY_MAIN, speaker: TONY },
  { name: "Pepper's direct thread", participants: [PEPPER], thread: PEPPER_MAIN, speaker: PEPPER },
  { name: "Rhodey's direct thread", participants: [RHODEY], thread: RHODEY_MAIN, speaker: RHODEY },
  { name: "Happy's direct thread", participants: [HAPPY], thread: HAPPY_MAIN, speaker: HAPPY },
  { name: 'the Mission group', participants: [TONY, PEPPER, RHODEY], thread: MISSION, speaker: TONY },
  {
    name: 'the Party group (with a guest)',
    participants: [TONY, PEPPER, HAPPY],
    thread: PARTY,
    speaker: PEPPER,
  },
  { name: 'the Workshop group (Rhodey left)', participants: [TONY, PEPPER], thread: WORKSHOP, speaker: TONY },
]
const viewerOf = (v: ViewerSpec): Viewer => ({ participants: v.participants })

/** The audit table, by hand: which memory keys each viewer may see. */
const EXPECTED: Record<string, string[]> = {
  "Tony's direct thread": [
    'subjecttony',
    'threadtonymain',
    'threadmission',
    'threadparty',
    'threadworkshop',
    'householdfact',
    'ownerfact',
  ],
  "Pepper's direct thread": [
    'subjectpepper',
    'threadpeppermain',
    'threadmission',
    'threadparty',
    'threadworkshop',
    'householdfact',
  ],
  "Rhodey's direct thread": ['subjectrhodey', 'threadrhodeymain', 'threadmission', 'householdfact'],
  "Happy's direct thread": ['subjecthappy', 'threadhappymain', 'threadparty'],
  'the Mission group': ['threadmission', 'householdfact'],
  'the Party group (with a guest)': ['threadparty'],
  'the Workshop group (Rhodey left)': ['threadmission', 'threadparty', 'threadworkshop', 'householdfact'],
}

/** The same rule for tasks, by hand. */
const EXPECTED_TASKS: Record<string, string[]> = {
  "Tony's direct thread": ['tasktony', 'taskmission', 'taskparty', 'taskworkshop'],
  "Pepper's direct thread": ['taskpepper', 'taskmission', 'taskparty', 'taskworkshop'],
  "Rhodey's direct thread": ['taskrhodey', 'taskmission'],
  "Happy's direct thread": ['taskhappy', 'taskparty'],
  'the Mission group': ['taskmission'],
  'the Party group (with a guest)': ['taskparty'],
  'the Workshop group (Rhodey left)': ['taskmission', 'taskparty', 'taskworkshop'],
}

const memoryTarget = (m: MemorySpec) => ({
  visibility: m.visibility,
  subjectPersonId: m.subject,
  threadId: m.thread,
})
const taskSpecTarget = (t: TaskSpec) =>
  taskTarget({ visibility: t.visibility, personId: t.person, threadId: t.thread })

const hasGuest = (v: ViewerSpec) => v.participants.some((id) => person(id).tier === 'guest')

// The world

type World = {
  db: TestDb
  memory: MemoryStore
  events: FakeEventBus
  tasks: TaskManager
  memoryTools: Record<'remember' | 'recall' | 'forget', Tool>
  taskTools: Record<'status' | 'cancel', Tool>
}

const worlds: World[] = []

afterEach(() => {
  for (const w of worlds.splice(0)) {
    w.memory.stop()
    w.db.close()
  }
})

async function createWorld(opts: { taskStatus?: Task['status'] } = {}): Promise<World> {
  const db = createTestDb()
  const { repos } = db
  for (const p of PEOPLE) {
    await repos.persons.create({
      id: p.id,
      name: p.name,
      username: p.name.toLowerCase(),
      passwordHash: null,
      tier: p.tier,
      lastSeenAt: null,
      createdAt: 0,
    })
  }
  for (const t of THREADS) {
    await repos.threads.create(
      {
        id: t.id,
        kind: t.kind,
        slug: t.kind === 'direct' ? 'main' : null,
        title: t.title,
        ownerPersonId: t.members[0] ?? null,
        summary: null,
        createdAt: 0,
        updatedAt: 0,
      },
      t.members,
    )
  }
  expect(await repos.threads.removeParticipant(WORKSHOP, RHODEY, 10)).toBe(true)

  for (const [i, m] of MEMORIES.entries()) {
    const row: Memory = {
      id: memoryId(m.key),
      content: `zebra ${m.key}`,
      subjectPersonId: m.subject,
      visibility: m.visibility,
      threadId: m.thread,
      source: 'stated',
      authorPersonId: null,
      pinned: false,
      createdAt: i,
      updatedAt: i,
      lastRecalledAt: null,
    }
    await repos.memories.create(row)
  }
  for (const [i, t] of TASKS.entries()) {
    await repos.tasks.create({
      id: taskId(t.key),
      personId: t.person,
      threadId: t.thread,
      agentId: 'general',
      goal: goalOf(t.key),
      status: opts.taskStatus ?? 'running',
      attempt: 1,
      visibility: t.visibility,
      summary: null,
      detail: null,
      ui: null,
      createdAt: i,
      startedAt: i,
      finishedAt: null,
    })
  }

  const events = new FakeEventBus()
  const clock = createFakeClock(1_000_000)
  const log = createMemoryLogger()
  // New rows (memory.remember) start past the fixture's ids.
  let n = 1_000
  const ids: Ids = { next: (prefix) => fixedId(prefix, ++n) }
  const memory = new MemoryStore({
    repos,
    events,
    config: {
      memory: {
        coreMaxChars: 1_500,
        reflect: { enabled: false, idleMinutes: 20, maxMessages: 200, cardMaxChars: 1_000 },
        summary: { enabled: false, minMessages: 20, maxChars: 2_000 },
      },
    },
    clock,
    ids,
    log,
  })
  const unused = () => {
    throw new Error('not used by the audit')
  }
  const tasks = createTaskService({
    config: { mind: { name: 'Keith', task: { maxSteps: 1, maxPerPerson: 3, timeoutMs: 1_000 } } },
    repos,
    scheduler: { run: unused },
    runLoop: unused,
    agents: { get: () => undefined },
    commitments: { create: unused, openFor: unused, resolveForTask: async () => null },
    deliveries: { enqueue: unused, pendingFor: unused, markDelivered: unused },
    events,
    ids,
    clock,
    log,
  })
  const [remember, recall, forget] = createMemoryTools({ memory, persons: repos.persons })
  const [, status, cancel] = createTaskTools({ tasks })
  if (!remember || !recall || !forget || !status || !cancel) throw new Error('missing tools')
  const world: World = {
    db,
    memory,
    events,
    tasks,
    memoryTools: { remember, recall, forget },
    taskTools: { status, cancel },
  }
  worlds.push(world)
  return world
}

function ctx(v: ViewerSpec): ToolRunContext {
  return {
    person: person(v.speaker),
    participants: v.participants.map(person),
    threadId: v.thread,
    taskId: null,
    signal: new AbortController().signal,
    log: createMemoryLogger(),
    services: {
      get: () => {
        throw new Error('no services in the audit')
      },
      find: () => undefined,
    },
  }
}

async function call(tool: Tool, raw: unknown, t: ToolRunContext) {
  return tool.run(tool.input.parse(raw), t)
}

const sorted = (xs: Iterable<string>) => [...xs].sort()
const keysOf = (memories: Memory[]) => sorted(memories.map((m) => keyOfMemory(m.id)))
const hiddenMemories = (v: ViewerSpec) => MEMORIES.filter((m) => !EXPECTED[v.name]?.includes(m.key))
const hiddenTasks = (v: ViewerSpec) => TASKS.filter((t) => !EXPECTED_TASKS[v.name]?.includes(t.key))

// The table itself

describe('audit table', () => {
  for (const v of VIEWERS) {
    test(`I-4: the hand-written table for ${v.name} is what isVisible admits`, () => {
      const memories = MEMORIES.filter((m) => isVisible(memoryTarget(m), viewerOf(v), HAND_FACTS))
      expect(sorted(memories.map((m) => m.key))).toEqual(sorted(EXPECTED[v.name] ?? []))
      const tasks = TASKS.filter((t) => isVisible(taskSpecTarget(t), viewerOf(v), HAND_FACTS))
      expect(sorted(tasks.map((t) => t.key))).toEqual(sorted(EXPECTED_TASKS[v.name] ?? []))
    })
  }
})

// MemoryService read paths

describe('audit: MemoryService read paths', () => {
  for (const v of VIEWERS) {
    test(`I-4: recall in ${v.name} returns exactly the admitted memories`, async () => {
      const w = await createWorld()
      const found = await w.memory.recall({ text: 'zebra', viewer: viewerOf(v), limit: 50 })
      expect(keysOf(found)).toEqual(sorted(EXPECTED[v.name] ?? []))
    })

    test(`I-4: core in ${v.name} holds exactly the admitted pinned memories`, async () => {
      const w = await createWorld()
      for (const m of MEMORIES) await w.db.repos.memories.update(memoryId(m.key), { pinned: true })
      expect(keysOf(await w.memory.core(viewerOf(v)))).toEqual(sorted(EXPECTED[v.name] ?? []))
    })

    test(`I-4: index in ${v.name} names no hidden subject or topic`, async () => {
      const w = await createWorld()
      const index = await w.memory.index(viewerOf(v))
      const visible = MEMORIES.filter((m) => EXPECTED[v.name]?.includes(m.key))
      const names = [...new Set(visible.flatMap((m) => (m.subject ? [nameOf(m.subject)] : [])))]
      expect(sorted(index)).toEqual(sorted([...names, 'zebra', ...visible.map((m) => m.key)]))
      for (const m of hiddenMemories(v)) {
        expect(index).not.toContain(m.key)
        if (m.subject && !names.includes(nameOf(m.subject))) expect(index).not.toContain(nameOf(m.subject))
      }
    })
  }

  test("I-4: Tony's subject memory is hidden in the Mission group", async () => {
    const w = await createWorld()
    const mission = { participants: [TONY, PEPPER, RHODEY] }
    const found = await w.memory.recall({ text: 'subjecttony', viewer: mission })
    expect(found).toEqual([])
    expect(await w.memory.recall({ text: 'subjecttony', viewer: { participants: [TONY] } })).toHaveLength(1)
  })

  test('I-4: the owner-only memory is hidden in every group Tony shares', async () => {
    const w = await createWorld()
    for (const participants of [
      [TONY, PEPPER, RHODEY],
      [TONY, PEPPER, HAPPY],
      [TONY, PEPPER],
    ]) {
      expect(await w.memory.recall({ text: 'ownerfact', viewer: { participants } })).toEqual([])
    }
  })

  test('I-4: a guest in the Party group hides household memories from everyone in it', async () => {
    const w = await createWorld()
    const party = { participants: [TONY, PEPPER, HAPPY] }
    expect(await w.memory.recall({ text: 'householdfact', viewer: party })).toEqual([])
    expect(
      await w.memory.recall({ text: 'householdfact', viewer: { participants: [TONY, PEPPER] } }),
    ).toHaveLength(1)
  })
})

// Leaving (S-6)

describe('audit: leaving a group (S-6)', () => {
  test("I-4: after Rhodey leaves Mission, his viewers no longer admit Mission's thread memories", async () => {
    const w = await createWorld()
    const rhodey = { participants: [RHODEY] }
    const staleMission = { participants: [TONY, PEPPER, RHODEY] }
    expect(await w.memory.recall({ text: 'threadmission', viewer: rhodey })).toHaveLength(1)

    expect(await w.db.repos.threads.removeParticipant(MISSION, RHODEY, 20)).toBe(true)

    expect(await w.memory.recall({ text: 'threadmission', viewer: rhodey })).toEqual([])
    expect(await w.memory.recall({ text: 'threadmission', viewer: staleMission })).toEqual([])
    for (const m of [...MEMORIES].filter((x) => x.thread === MISSION && x.visibility === 'thread')) {
      await w.db.repos.memories.update(memoryId(m.key), { pinned: true })
    }
    expect(await w.memory.core(rhodey)).toEqual([])
    expect(await w.memory.index(rhodey)).not.toContain('threadmission')
    // Rhodey's Mission task is no longer his to see from his direct thread either.
    expect(keysOfTasks(await w.tasks.visibleTo(await w.tasks.active(), rhodey))).toEqual(['taskrhodey'])
  })

  test('I-4: the remaining Mission participants still admit its thread memories after Rhodey left', async () => {
    const w = await createWorld()
    expect(await w.db.repos.threads.removeParticipant(MISSION, RHODEY, 20)).toBe(true)
    for (const participants of [[TONY], [PEPPER], [TONY, PEPPER]]) {
      expect(await w.memory.recall({ text: 'threadmission', viewer: { participants } })).toHaveLength(1)
    }
  })

  test('I-4: Rhodey, who left Workshop, sees none of its thread memories or tasks', async () => {
    const w = await createWorld()
    const rhodey = { participants: [RHODEY] }
    expect(await w.memory.recall({ text: 'threadworkshop', viewer: rhodey })).toEqual([])
    expect(
      await w.memory.recall({ text: 'threadworkshop', viewer: { participants: [TONY, PEPPER, RHODEY] } }),
    ).toEqual([])
    const visible = await w.tasks.visibleTo(await w.tasks.active(), rhodey)
    expect(visible.map((t) => t.id)).not.toContain(taskId('taskworkshop'))
  })
})

function keysOfTasks(tasks: Task[]): string[] {
  return sorted(tasks.map((t) => TASKS[Number(t.id.slice(4)) - 1]?.key ?? '?'))
}

// Tools

describe('audit: memory tools', () => {
  for (const v of VIEWERS) {
    test(`I-4: memory.recall in ${v.name} lists exactly the admitted memories`, async () => {
      const w = await createWorld()
      const r = await call(w.memoryTools.recall, { query: 'zebra' }, ctx(v))
      const ids = [...r.content.matchAll(/mem_[0-9A-Za-z]+/g)].map((m) => keyOfMemory(m[0] as MemoryId))
      expect(sorted(ids)).toEqual(sorted(EXPECTED[v.name] ?? []))
    })

    test(`I-4: memory.forget in ${v.name} reads a hidden memory as not found, even for the owner`, async () => {
      const w = await createWorld()
      for (const m of hiddenMemories(v)) {
        const r = await call(w.memoryTools.forget, { id: memoryId(m.key) }, ctx(v))
        expect(r).toEqual({ content: `No memory ${memoryId(m.key)} is visible here.`, error: true })
        expect(await w.db.repos.memories.get(memoryId(m.key))).not.toBeNull()
      }
      for (const key of EXPECTED[v.name] ?? []) {
        const m = MEMORIES.find((x) => x.key === key) as MemorySpec
        const allowed = person(v.speaker).tier === 'owner' || m.subject === v.speaker
        const r = await call(w.memoryTools.forget, { id: memoryId(key) }, ctx(v))
        expect(r.error === true).toBe(!allowed)
        expect((await w.db.repos.memories.get(memoryId(key))) === null).toBe(allowed)
      }
    })
  }
})

describe('audit: task tools', () => {
  for (const v of VIEWERS) {
    test(`I-4: task.status in ${v.name} lists and shows exactly the admitted tasks`, async () => {
      const w = await createWorld()
      const list = await call(w.taskTools.status, {}, ctx(v))
      const expected = EXPECTED_TASKS[v.name] ?? []
      for (const t of TASKS) expect(list.content.includes(goalOf(t.key))).toBe(expected.includes(t.key))
      for (const t of TASKS) {
        const one = await call(w.taskTools.status, { id: taskId(t.key) }, ctx(v))
        if (expected.includes(t.key)) expect(one.content).toContain(goalOf(t.key))
        else expect(one).toEqual({ content: `No task ${taskId(t.key)} found.`, error: true })
      }
    })

    test(`I-4: task.cancel in ${v.name} reads a hidden task as not found`, async () => {
      const w = await createWorld()
      for (const t of hiddenTasks(v)) {
        const r = await call(w.taskTools.cancel, { id: taskId(t.key) }, ctx(v))
        expect(r).toEqual({ content: `No task ${taskId(t.key)} found.`, error: true })
        expect((await w.db.repos.tasks.get(taskId(t.key)))?.status).toBe('running')
      }
      for (const key of EXPECTED_TASKS[v.name] ?? []) {
        const r = await call(w.taskTools.cancel, { id: taskId(key) }, ctx(v))
        expect(r.content).toBe(`Cancelled task ${taskId(key)}.`)
      }
    })
  }

  test("I-4: Tony's private task is hidden from task.status in the Mission group", async () => {
    const w = await createWorld()
    const mission = VIEWERS.find((v) => v.thread === MISSION) as ViewerSpec
    const r = await call(w.taskTools.status, { id: taskId('tasktony') }, ctx(mission))
    expect(r.error).toBe(true)
  })
})

// Awareness digest

describe('audit: awareness digest', () => {
  test('I-4: a task is described in detail only where every viewer participant may see it; counts only with a guest', async () => {
    const w = await createWorld({ taskStatus: 'completed' })
    for (const t of TASKS) {
      await w.db.repos.tasks.update(taskId(t.key), { status: 'running' })
      for (const v of VIEWERS) {
        const d = await w.memory.digest({ threadId: v.thread, viewer: viewerOf(v) })
        const detailed = EXPECTED_TASKS[v.name]?.includes(t.key) === true && !hasGuest(v)
        const label = `${t.key} in ${v.name}`
        expect({ label, detailed: d.includes(goalOf(t.key)) }).toEqual({ label, detailed })
        if (hasGuest(v)) {
          expect(d).toBe('- Also busy with 0 other conversations and 1 background task.')
        } else if (!detailed) {
          expect(d).toBe('- Busy with 1 private background task for someone else.')
        }
      }
      await w.db.repos.tasks.update(taskId(t.key), { status: 'completed' })
    }
  })

  test('I-4: a busy thread is described in detail only where every viewer participant is in it; counts only with a guest', async () => {
    const w = await createWorld({ taskStatus: 'completed' })
    for (const busy of THREADS) {
      w.events.emit('thread.state_changed', { threadId: busy.id, from: 'idle', to: 'thinking' })
      await w.events.idle()
      for (const v of VIEWERS) {
        if (v.thread === busy.id) continue
        const d = await w.memory.digest({ threadId: v.thread, viewer: viewerOf(v) })
        const admitted = isVisible(
          { visibility: 'thread', subjectPersonId: null, threadId: busy.id },
          viewerOf(v),
          HAND_FACTS,
        )
        const label = `${busy.title} busy, seen from ${v.name}`
        if (hasGuest(v)) {
          expect({ label, d }).toEqual({
            label,
            d: '- Also busy with 1 other conversation and 0 background tasks.',
          })
        } else if (admitted) {
          expect({ label, d }).toEqual({ label, d: `- Replying in your other thread "${titleOf(busy.id)}".` })
        } else {
          expect({ label, d }).toEqual({ label, d: '- In 1 conversation with someone else.' })
        }
      }
      w.events.emit('thread.state_changed', { threadId: busy.id, from: 'thinking', to: 'idle' })
      await w.events.idle()
    }
  })

  test("S-4: Tony's direct thread describes the busy Mission group in detail", async () => {
    const w = await createWorld({ taskStatus: 'completed' })
    w.events.emit('thread.state_changed', { threadId: MISSION, from: 'idle', to: 'thinking' })
    await w.events.idle()
    const d = await w.memory.digest({ threadId: TONY_MAIN, viewer: { participants: [TONY] } })
    expect(d).toBe('- Replying in your other thread "Mission".')
  })

  test("S-4: Pepper's direct thread describes Tony's private task only as a count", async () => {
    const w = await createWorld({ taskStatus: 'completed' })
    await w.db.repos.tasks.update(taskId('tasktony'), { status: 'running' })
    const d = await w.memory.digest({ threadId: PEPPER_MAIN, viewer: { participants: [PEPPER] } })
    expect(d).toBe('- Busy with 1 private background task for someone else.')
    expect(d).not.toContain('Tony')
  })

  test('S-4: a group with a guest gets counts only, even for its own group task', async () => {
    const w = await createWorld()
    w.events.emit('thread.state_changed', { threadId: MISSION, from: 'idle', to: 'thinking' })
    await w.events.idle()
    const d = await w.memory.digest({ threadId: PARTY, viewer: { participants: [TONY, PEPPER, HAPPY] } })
    expect(d).toBe(`- Also busy with 1 other conversation and ${TASKS.length} background tasks.`)
    for (const p of PEOPLE) expect(d).not.toContain(p.name)
  })

  test('a group task is described as working for the group', async () => {
    const w = await createWorld({ taskStatus: 'completed' })
    await w.db.repos.tasks.update(taskId('taskmission'), { status: 'running' })
    const d = await w.memory.digest({ threadId: MISSION, viewer: { participants: [TONY, PEPPER, RHODEY] } })
    expect(d).toBe(`- Working on a background task for the group "Mission": ${goalOf('taskmission')}`)
  })
})

// memory.remember in a group

describe('audit: memory.remember in a group', () => {
  const mission = () => VIEWERS.find((v) => v.thread === MISSION) as ViewerSpec
  const party = () => VIEWERS.find((v) => v.thread === PARTY) as ViewerSpec

  test('writes thread by default, readable by every participant and nobody else', async () => {
    const w = await createWorld()
    const r = await call(
      w.memoryTools.remember,
      { content: 'The launch is at dawn, quokka.' },
      ctx(mission()),
    )
    expect(r.error).toBeUndefined()
    const [m] = await w.memory.recall({ text: 'quokka', viewer: { participants: [TONY, PEPPER, RHODEY] } })
    expect(m).toMatchObject({ visibility: 'thread', threadId: MISSION, subjectPersonId: TONY })
    expect(await w.memory.recall({ text: 'quokka', viewer: { participants: [HAPPY] } })).toEqual([])
  })

  test('refuses household from a guest', async () => {
    const w = await createWorld()
    const asHappy: ViewerSpec = { ...party(), speaker: HAPPY }
    const r = await call(
      w.memoryTools.remember,
      { content: 'Snacks are in the kitchen.', subject: 'none', visibility: 'household' },
      ctx(asHappy),
    )
    expect(r).toEqual({ content: "Guests can't write household memories.", error: true })
  })

  test('never writes subject about another participant', async () => {
    const w = await createWorld()
    const r = await call(
      w.memoryTools.remember,
      { content: 'Pepper is allergic to strawberries.', subject: 'Pepper', visibility: 'subject' },
      ctx(mission()),
    )
    expect(r).toEqual({
      content: "In a group thread, a 'subject' memory can only be about the speaker.",
      error: true,
    })
    expect(await w.memory.recall({ text: 'strawberries', viewer: { participants: [PEPPER] } })).toEqual([])
  })

  test('a fact about another participant defaults to thread, keeping them as the subject', async () => {
    const w = await createWorld()
    await call(
      w.memoryTools.remember,
      { content: 'Pepper runs the budget, wombat.', subject: 'Pepper' },
      ctx(mission()),
    )
    const [m] = await w.memory.recall({ text: 'wombat', viewer: { participants: [TONY, PEPPER, RHODEY] } })
    expect(m).toMatchObject({ visibility: 'thread', threadId: MISSION, subjectPersonId: PEPPER })
  })
})
