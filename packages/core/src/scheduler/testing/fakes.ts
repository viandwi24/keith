// In-memory fakes built from other lanes' types.ts interfaces, for scheduler tests only. The
// phase-1 integration task re-runs the key tests against the real implementations.

import type { Agent, EventMap, EventName, KeithEvent } from '@keith/sdk'
import type { KeithConfig } from '../../config/types.ts'
import type { CoreEventBus } from '../../events/types.ts'
import type { RunLoop, RunLoopArgs, RunLoopResult } from '../../mind/types.ts'
import type { CoreAgentRegistry } from '../../plugins/types.ts'
import type {
  Clock,
  Commitment,
  Delivery,
  IdPrefix,
  Ids,
  PersonId,
  Reminder,
  Task,
  ThreadId,
  Tier,
  Urgency,
} from '../../shared/types.ts'
import type {
  CommitmentsRepository,
  DeliveriesRepository,
  DeliveryRecord,
  PersonRecord,
  PersonsRepository,
  RelationshipRecord,
  RelationshipsRepository,
  RemindersRepository,
  Repositories,
  TasksRepository,
  ThreadParticipantRecord,
  ThreadRecord,
  ThreadsRepository,
} from '../../storage/types.ts'

export function createTestConfig(
  overrides: {
    scheduler?: Partial<KeithConfig['scheduler']>
    task?: Partial<KeithConfig['mind']['task']>
    commitmentTtlMs?: number
  } = {},
): KeithConfig {
  return {
    server: { host: '127.0.0.1', port: 4824 },
    mind: {
      name: 'Keith',
      timezone: 'UTC',
      turn: { maxSteps: 8, stallMs: 120_000 },
      task: { maxSteps: 20, maxPerPerson: 3, timeoutMs: 1_800_000, ...overrides.task },
      commitment: { ttlMs: overrides.commitmentTtlMs ?? 604_800_000 },
      arrival: { awayAfterMinutes: 30, briefing: 'on-greeting', holdMs: 120_000, graceMs: 1_500 },
      context: { recentMessages: 40 },
      reminder: { maxPerPerson: 50 },
      group: { maxParticipants: 8, autoJoin: false, addressing: 'rules+utility' },
    },
    memory: {
      coreMaxChars: 4000,
      reflect: { enabled: true, idleMinutes: 20, maxMessages: 200, cardMaxChars: 1_000 },
      summary: { enabled: true, minMessages: 20, maxChars: 2_000 },
    },
    scheduler: { foreground: 4, delivery: 2, background: 2, tickMs: 30_000, ...overrides.scheduler },
    models: { foreground: 'fake:fg', background: 'fake:bg', utility: 'fake:util' },
    auth: { tokenTtlDays: 30, inviteTtlHours: 72 },
    plugins: { enabled: [], required: [], stopTimeoutMs: 5000, sections: {} },
    services: {},
  }
}

/** Deterministic ids: `<prefix>_` + a zero-padded counter (valid ULID characters). */
export function createFakeIds(): Ids {
  let n = 0
  return {
    next<P extends IdPrefix>(prefix: P): `${P}_${string}` {
      n++
      return `${prefix}_${String(n).padStart(26, '0')}`
    },
  }
}

export type EmittedEvent = { [N in EventName]: { name: N; data: EventMap[N] } }[EventName]

export type FakeEventBus = CoreEventBus & {
  readonly emitted: EmittedEvent[]
  /** Payloads of every emitted event with this name, in order. */
  of<N extends EventName>(name: N): EventMap[N][]
}

/** Handlers run asynchronously after `emit`, like the real bus; `idle()` waits for them. */
export function createFakeEventBus(clock: Clock): FakeEventBus {
  const handlers = new Map<string, Set<(e: KeithEvent<EventName>) => void | Promise<void>>>()
  const emitted: EmittedEvent[] = []
  let pending: Promise<unknown>[] = []
  const bus: FakeEventBus = {
    emitted,
    of<N extends EventName>(name: N): EventMap[N][] {
      return emitted.filter((e) => e.name === name).map((e) => e.data as EventMap[N])
    },
    on(name, handler) {
      const set = handlers.get(name) ?? new Set()
      handlers.set(name, set)
      const h = handler as (e: KeithEvent<EventName>) => void | Promise<void>
      set.add(h)
      return () => {
        set.delete(h)
      }
    },
    emit(name, data) {
      emitted.push({ name, data } as EmittedEvent)
      const event = { name, at: clock.now(), data } as KeithEvent<EventName>
      for (const h of handlers.get(name) ?? []) {
        pending.push(Promise.resolve().then(() => h(event)))
      }
    },
    define() {},
    forPlugin() {
      return bus
    },
    removeByPlugin() {},
    async idle() {
      while (pending.length > 0) {
        const batch = pending
        pending = []
        await Promise.all(batch)
      }
    },
  }
  return bus
}

const URGENCY_RANK: Record<Urgency, number> = { critical: 0, high: 1, normal: 2, low: 3 }

export type FakeRepos = Pick<
  Repositories,
  'tasks' | 'commitments' | 'deliveries' | 'threads' | 'persons' | 'relationships' | 'reminders'
> & {
  readonly taskRows: Map<string, Task>
  readonly commitmentRows: Map<string, Commitment>
  readonly deliveryRows: Map<string, DeliveryRecord>
  readonly reminderRows: Map<string, Reminder>
}

const byDue = (a: Reminder, b: Reminder) => a.dueAt - b.dueAt || a.id.localeCompare(b.id)

/** The `RemindersRepository` contract from storage/types.ts, in memory. */
export function createFakeRemindersRepository(rows = new Map<string, Reminder>()): RemindersRepository {
  return {
    async create(r) {
      rows.set(r.id, { ...r })
    },
    async get(id) {
      const r = rows.get(id)
      return r ? { ...r } : null
    },
    async listDue(now, limit) {
      return [...rows.values()]
        .filter((r) => r.status === 'pending' && r.dueAt <= now)
        .sort(byDue)
        .slice(0, limit ?? Number.POSITIVE_INFINITY)
        .map((r) => ({ ...r }))
    },
    async listPending(personId) {
      return [...rows.values()]
        .filter((r) => r.personId === personId && r.status === 'pending')
        .sort(byDue)
        .map((r) => ({ ...r }))
    },
    async countPending(personId) {
      return [...rows.values()].filter((r) => r.personId === personId && r.status === 'pending').length
    },
    async markFired(id, at, deliveryId) {
      const r = rows.get(id)
      if (r?.status !== 'pending') return false
      rows.set(id, { ...r, status: 'fired', firedAt: at, deliveryId })
      return true
    },
    async cancel(id, at) {
      const r = rows.get(id)
      if (r?.status !== 'pending') return false
      rows.set(id, { ...r, status: 'cancelled', cancelledAt: at })
      return true
    },
  }
}

export function createFakeRepos(): FakeRepos {
  const taskRows = new Map<string, Task>()
  const commitmentRows = new Map<string, Commitment>()
  const deliveryRows = new Map<string, DeliveryRecord>()
  const threadRows = new Map<string, ThreadRecord>()
  const participantRows: ThreadParticipantRecord[] = []
  const personRows = new Map<string, PersonRecord>()
  const relationshipRows = new Map<string, RelationshipRecord>()
  const reminderRows = new Map<string, Reminder>()

  const tasks: TasksRepository = {
    async create(t) {
      taskRows.set(t.id, { ...t })
    },
    async get(id) {
      const t = taskRows.get(id)
      return t ? { ...t } : null
    },
    async update(id, patch) {
      const t = taskRows.get(id)
      if (t) taskRows.set(id, { ...t, ...patch })
    },
    async listByStatus(statuses) {
      return [...taskRows.values()]
        .filter((t) => statuses.includes(t.status))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((t) => ({ ...t }))
    },
    async countActiveFor(personId) {
      return [...taskRows.values()].filter(
        (t) => t.personId === personId && (t.status === 'queued' || t.status === 'running'),
      ).length
    },
  }

  const commitments: CommitmentsRepository = {
    async create(c) {
      commitmentRows.set(c.id, { ...c })
    },
    async get(id) {
      const c = commitmentRows.get(id)
      return c ? { ...c } : null
    },
    async resolve(id, status, resolvedAt) {
      const c = commitmentRows.get(id)
      if (c) commitmentRows.set(id, { ...c, status, resolvedAt })
    },
    async openForTask(taskId) {
      const c = [...commitmentRows.values()].find((x) => x.taskId === taskId && x.status === 'open')
      return c ? { ...c } : null
    },
    async openForThread(threadId) {
      return [...commitmentRows.values()].filter((x) => x.threadId === threadId && x.status === 'open')
    },
    async listExpired(now) {
      return [...commitmentRows.values()].filter((x) => x.status === 'open' && x.expiresAt <= now)
    },
  }

  const deliveries: DeliveriesRepository = {
    async create(d) {
      deliveryRows.set(d.id, { ...d })
    },
    // Read-back matches storage: `get` always sets `messageId`, `pendingFor` returns plain items.
    async get(id) {
      const d = deliveryRows.get(id)
      return d ? { ...d, messageId: d.messageId ?? null } : null
    },
    async pendingFor(threadId) {
      return [...deliveryRows.values()]
        .filter((d) => d.threadId === threadId && d.status === 'pending')
        .sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || a.createdAt - b.createdAt)
        .map(({ messageId: _, ...d }): Delivery => d)
    },
    async markDelivered(ids, deliveredAt, messageId) {
      for (const id of ids) {
        const d = deliveryRows.get(id)
        // Like storage: only pending rows change, and each keeps the message that delivered it.
        if (d && d.status === 'pending') {
          deliveryRows.set(id, { ...d, status: 'delivered', deliveredAt, messageId: messageId ?? null })
        }
      }
    },
  }

  const threads: ThreadsRepository = {
    async create(t, participants) {
      threadRows.set(t.id, { ...t })
      for (const personId of participants) {
        participantRows.push({ threadId: t.id, personId, joinedAt: t.createdAt, leftAt: null })
      }
    },
    async get(id) {
      return threadRows.get(id) ?? null
    },
    async getBySlug(ownerPersonId, slug) {
      return (
        [...threadRows.values()].find((t) => t.ownerPersonId === ownerPersonId && t.slug === slug) ?? null
      )
    },
    async listForPerson(personId) {
      const ids = new Set(
        participantRows.filter((p) => p.personId === personId && p.leftAt === null).map((p) => p.threadId),
      )
      return [...threadRows.values()].filter((t) => ids.has(t.id))
    },
    async participants(threadId) {
      return participantRows.filter((p) => p.threadId === threadId && p.leftAt === null)
    },
    async touch(id, updatedAt) {
      const t = threadRows.get(id)
      if (t) threadRows.set(id, { ...t, updatedAt })
    },
    async addParticipant(threadId, personId, at) {
      const i = participantRows.findIndex((p) => p.threadId === threadId && p.personId === personId)
      const row = participantRows[i]
      if (!row) {
        participantRows.push({ threadId, personId, joinedAt: at, leftAt: null })
        return true
      }
      if (row.leftAt === null) return false
      participantRows[i] = { ...row, joinedAt: at, leftAt: null }
      return true
    },
    async removeParticipant(threadId, personId, at) {
      const i = participantRows.findIndex(
        (p) => p.threadId === threadId && p.personId === personId && p.leftAt === null,
      )
      const row = participantRows[i]
      if (!row) return false
      participantRows[i] = { ...row, leftAt: at }
      return true
    },
    async formerParticipants(threadId) {
      return participantRows
        .filter((p) => p.threadId === threadId && p.leftAt !== null)
        .sort((a, b) => (b.leftAt ?? 0) - (a.leftAt ?? 0) || a.personId.localeCompare(b.personId))
    },
    async setSummary(id, s) {
      const t = threadRows.get(id)
      if (t) threadRows.set(id, { ...t, summary: s.summary, summaryThroughSeq: s.throughSeq })
    },
    async setReflectedThrough(id, seq) {
      const t = threadRows.get(id)
      if (t) threadRows.set(id, { ...t, reflectedThroughSeq: seq })
    },
    // These fakes store no messages, so no thread is ever due for reflection.
    async listForReflection() {
      return []
    },
  }

  const persons: PersonsRepository = {
    async create(p) {
      personRows.set(p.id, { ...p })
    },
    async get(id) {
      return personRows.get(id) ?? null
    },
    async getByUsername(username) {
      return [...personRows.values()].find((p) => p.username === username) ?? null
    },
    async list() {
      return [...personRows.values()]
    },
    async setPasswordHash(id, passwordHash) {
      const p = personRows.get(id)
      if (p) personRows.set(id, { ...p, passwordHash })
    },
    async setLastSeenAt(ids, at) {
      for (const id of ids) {
        const p = personRows.get(id)
        if (p) personRows.set(id, { ...p, lastSeenAt: at })
      }
    },
    async findByName(name) {
      const key = name.trim().toLowerCase()
      if (key === '') return null
      const all = [...personRows.values()]
      return (
        all.find((p) => p.name.toLowerCase() === key) ??
        all.find((p) => p.username?.toLowerCase() === key) ??
        null
      )
    },
    async setTier(id, tier) {
      const p = personRows.get(id)
      if (p) personRows.set(id, { ...p, tier })
    },
    async setCredentials(id, c) {
      const p = personRows.get(id)
      if (p) personRows.set(id, { ...p, ...c })
    },
    async remove() {
      throw new Error('fake persons.remove is not modeled')
    },
  }

  const relationships: RelationshipsRepository = {
    async get(personId) {
      return relationshipRows.get(personId) ?? null
    },
    async upsert(r) {
      relationshipRows.set(r.personId, { ...r })
    },
  }

  return {
    tasks,
    commitments,
    deliveries,
    threads,
    persons,
    relationships,
    reminders: createFakeRemindersRepository(reminderRows),
    taskRows,
    commitmentRows,
    deliveryRows,
    reminderRows,
  }
}

/** Adds a person with a `main` direct thread and a relationship. Returns both ids. */
export async function seedPerson(
  repos: FakeRepos,
  ids: Ids,
  p: { name: string; tier?: Tier; tone?: string; notes?: string },
): Promise<{ personId: PersonId; threadId: ThreadId }> {
  const personId = ids.next('per')
  const threadId = ids.next('thr')
  await repos.persons.create({
    id: personId,
    name: p.name,
    username: p.name.toLowerCase(),
    passwordHash: null,
    tier: p.tier ?? 'owner',
    lastSeenAt: null,
    createdAt: 0,
  })
  await repos.relationships.upsert({
    personId,
    tone: p.tone ?? '',
    notes: p.notes ?? '',
    blockedRelayFrom: [],
  })
  await repos.threads.create(
    {
      id: threadId,
      kind: 'direct',
      slug: 'main',
      title: 'Main',
      ownerPersonId: personId,
      summary: null,
      createdAt: 0,
      updatedAt: 0,
    },
    [personId],
  )
  return { personId, threadId }
}

/** Adds a group thread with these participants; `left` are added, then marked as having left. */
export async function seedGroup(
  repos: FakeRepos,
  ids: Ids,
  g: { title: string; participants: PersonId[]; left?: PersonId[] },
): Promise<ThreadId> {
  const threadId = ids.next('thr')
  const left = g.left ?? []
  await repos.threads.create(
    {
      id: threadId,
      kind: 'group',
      slug: null,
      title: g.title,
      ownerPersonId: g.participants[0] ?? null,
      summary: null,
      createdAt: 0,
      updatedAt: 0,
    },
    [...g.participants, ...left],
  )
  for (const personId of left) await repos.threads.removeParticipant(threadId, personId, 1)
  return threadId
}

export function createFakeAgents(agents: Agent[]): Pick<CoreAgentRegistry, 'get'> {
  return { get: (id) => agents.find((a) => a.id === id) }
}

export const GENERAL_TEST_AGENT: Agent = {
  id: 'general',
  description: 'General background worker',
  system: 'You are a careful background worker.',
  tools: ['memory.recall'],
  modelRole: 'background',
}

export type PendingRun = {
  args: RunLoopArgs
  resolve(r: Partial<RunLoopResult> & { text: string }): void
  reject(error: unknown): void
}

export type ControlledRunLoop = {
  runLoop: RunLoop
  /** Calls not settled yet, oldest first. */
  readonly pending: PendingRun[]
  readonly calls: RunLoopArgs[]
  /** Resolves when at least `n` calls have been made in total. */
  waitForCalls(n: number): Promise<void>
}

/**
 * A RunLoop whose calls stay open until the test settles them. An aborted signal rejects the
 * call with the signal's reason, like the real loop honoring R-10.
 */
export function createControlledRunLoop(): ControlledRunLoop {
  const pending: PendingRun[] = []
  const calls: RunLoopArgs[] = []
  const waiters: { n: number; resolve: () => void }[] = []
  const runLoop: RunLoop = (args) => {
    calls.push(args)
    for (const w of [...waiters]) {
      if (calls.length >= w.n) {
        waiters.splice(waiters.indexOf(w), 1)
        w.resolve()
      }
    }
    return new Promise<RunLoopResult>((resolve, reject) => {
      const settle = (): boolean => {
        const i = pending.indexOf(entry)
        if (i < 0) return false
        pending.splice(i, 1)
        return true
      }
      const entry: PendingRun = {
        args,
        resolve: (r) => {
          if (settle()) resolve({ steps: 1, stoppedBy: 'stop', ...r })
        },
        reject: (error) => {
          if (settle()) reject(error)
        },
      }
      pending.push(entry)
      args.signal.addEventListener('abort', () => entry.reject(args.signal.reason), { once: true })
    })
  }
  return {
    runLoop,
    pending,
    calls,
    waitForCalls(n) {
      if (calls.length >= n) return Promise.resolve()
      return new Promise((resolve) => waiters.push({ n, resolve }))
    },
  }
}

/** Lets pending promise callbacks run (a few macrotask-free turns of the microtask queue). */
export async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** Spins the microtask queue until `cond` holds. Works under fake timers. */
export async function waitFor(cond: () => boolean | Promise<boolean>, label = 'condition'): Promise<void> {
  for (let i = 0; i < 2000; i++) {
    if (await cond()) return
    await Promise.resolve()
  }
  throw new Error(`timed out waiting for ${label}`)
}
