// In-memory fakes of the interfaces memory/ consumes, built from their types.ts (the real
// implementations belong to other lanes). Test-only.

import type { EventBus, EventHandler, EventMap, EventName, KeithEvent, Unsubscribe } from '@keith/sdk'
import type { CoreEventBus } from '../../events/types.ts'
import type {
  IdPrefix,
  Ids,
  Memory,
  MemoryId,
  PersonId,
  Task,
  TaskId,
  TaskStatus,
  ThreadId,
  Tier,
} from '../../shared/types.ts'
import type {
  MemoriesRepository,
  MemoryFilter,
  MemoryPatch,
  PersonRecord,
  PersonsRepository,
  TaskPatch,
  TasksRepository,
  ThreadParticipantRecord,
  ThreadRecord,
  ThreadsRepository,
} from '../../storage/types.ts'

/** Deterministic ids with valid ULID bodies: `mem_00000000000000000000000001`, ... */
export function createFakeIds(): Ids {
  let n = 0
  return {
    next<P extends IdPrefix>(prefix: P): `${P}_${string}` {
      n++
      return `${prefix}_${String(n).padStart(26, '0')}`
    },
  }
}

/** A fixed, valid id for fixtures: `id('per', 1)` → `per_00000000000000000000000001`. */
export function fixedId<P extends IdPrefix>(prefix: P, n: number): `${P}_${string}` {
  return `${prefix}_${String(n).padStart(26, '0')}`
}

/** The storage SQL from storage.md, as a predicate. */
export function matchesFilter(m: Memory, f: MemoryFilter): boolean {
  switch (m.visibility) {
    case 'household':
      return f.allowHousehold
    case 'owner':
      return f.allowOwner
    case 'subject':
      return f.subjectPersonId !== null && m.subjectPersonId === f.subjectPersonId
    case 'thread':
      return m.threadId !== null && f.threadIds.includes(m.threadId)
  }
}

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? []
}

export class FakeMemoriesRepository implements MemoriesRepository {
  readonly rows = new Map<MemoryId, Memory>()
  /** When true, `search` and `list` ignore the filter (a storage bug, for defense-in-depth tests). */
  ignoreFilter = false

  async create(m: Memory): Promise<void> {
    this.rows.set(m.id, { ...m })
  }
  async get(id: MemoryId): Promise<Memory | null> {
    const m = this.rows.get(id)
    return m ? { ...m } : null
  }
  async update(id: MemoryId, patch: MemoryPatch): Promise<void> {
    const m = this.rows.get(id)
    if (m) this.rows.set(id, { ...m, ...patch })
  }
  async delete(id: MemoryId): Promise<void> {
    this.rows.delete(id)
  }
  /** Token overlap instead of BM25; ties broken by recency. */
  async search(text: string, filter: MemoryFilter, opts?: { limit?: number | undefined }): Promise<Memory[]> {
    const q = new Set(words(text))
    return [...this.rows.values()]
      .filter((m) => this.ignoreFilter || matchesFilter(m, filter))
      .map((m) => ({ m, score: words(m.content).filter((w) => q.has(w)).length }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || b.m.createdAt - a.m.createdAt)
      .slice(0, opts?.limit ?? 8)
      .map((r) => ({ ...r.m }))
  }
  async list(
    filter: MemoryFilter,
    opts?: { pinned?: boolean | undefined; limit?: number | undefined },
  ): Promise<Memory[]> {
    return [...this.rows.values()]
      .filter((m) => this.ignoreFilter || matchesFilter(m, filter))
      .filter((m) => opts?.pinned === undefined || m.pinned === opts.pinned)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, opts?.limit ?? Number.POSITIVE_INFINITY)
      .map((m) => ({ ...m }))
  }
  async touchRecalled(ids: MemoryId[], at: number): Promise<void> {
    for (const id of ids) {
      const m = this.rows.get(id)
      if (m) this.rows.set(id, { ...m, lastRecalledAt: at })
    }
  }
}

export class FakePersonsRepository implements PersonsRepository {
  readonly rows = new Map<PersonId, PersonRecord>()

  /** Fixture helper. */
  add(id: PersonId, name: string, tier: Tier): PersonRecord {
    const p: PersonRecord = {
      id,
      name,
      username: name.toLowerCase(),
      passwordHash: null,
      tier,
      lastSeenAt: null,
      createdAt: 0,
    }
    this.rows.set(id, p)
    return p
  }
  async create(p: PersonRecord): Promise<void> {
    this.rows.set(p.id, { ...p })
  }
  async get(id: PersonId): Promise<PersonRecord | null> {
    return this.rows.get(id) ?? null
  }
  async getByUsername(username: string): Promise<PersonRecord | null> {
    return [...this.rows.values()].find((p) => p.username === username) ?? null
  }
  async list(): Promise<PersonRecord[]> {
    return [...this.rows.values()]
  }
  async setPasswordHash(id: PersonId, passwordHash: string): Promise<void> {
    const p = this.rows.get(id)
    if (p) p.passwordHash = passwordHash
  }
  async setLastSeenAt(ids: PersonId[], at: number): Promise<void> {
    for (const id of ids) {
      const p = this.rows.get(id)
      if (p) p.lastSeenAt = at
    }
  }
}

export class FakeThreadsRepository implements ThreadsRepository {
  readonly rows = new Map<ThreadId, ThreadRecord>()
  readonly members: ThreadParticipantRecord[] = []

  /** Fixture helper. */
  async add(id: ThreadId, title: string, participants: PersonId[]): Promise<ThreadRecord> {
    const t: ThreadRecord = {
      id,
      kind: participants.length > 1 ? 'group' : 'direct',
      slug: participants.length > 1 ? null : 'main',
      title,
      ownerPersonId: participants[0] ?? null,
      summary: null,
      createdAt: 0,
      updatedAt: 0,
    }
    await this.create(t, participants)
    return t
  }
  async create(t: ThreadRecord, participants: PersonId[]): Promise<void> {
    this.rows.set(t.id, { ...t })
    for (const personId of participants) {
      this.members.push({ threadId: t.id, personId, joinedAt: t.createdAt, leftAt: null })
    }
  }
  async get(id: ThreadId): Promise<ThreadRecord | null> {
    return this.rows.get(id) ?? null
  }
  async getBySlug(ownerPersonId: PersonId, slug: string): Promise<ThreadRecord | null> {
    return [...this.rows.values()].find((t) => t.ownerPersonId === ownerPersonId && t.slug === slug) ?? null
  }
  async listForPerson(personId: PersonId): Promise<ThreadRecord[]> {
    const ids = new Set(
      this.members.filter((m) => m.personId === personId && m.leftAt === null).map((m) => m.threadId),
    )
    return [...this.rows.values()].filter((t) => ids.has(t.id)).sort((a, b) => b.updatedAt - a.updatedAt)
  }
  async participants(threadId: ThreadId): Promise<ThreadParticipantRecord[]> {
    return this.members.filter((m) => m.threadId === threadId && m.leftAt === null)
  }
  async touch(id: ThreadId, updatedAt: number): Promise<void> {
    const t = this.rows.get(id)
    if (t) t.updatedAt = updatedAt
  }
  /** Fixture: each thread's highest message `seq` (this fake stores no messages). */
  readonly lastSeqs = new Map<ThreadId, number>()
  async setSummary(id: ThreadId, s: { summary: string; throughSeq: number }): Promise<void> {
    const t = this.rows.get(id)
    if (t) this.rows.set(id, { ...t, summary: s.summary, summaryThroughSeq: s.throughSeq })
  }
  async setReflectedThrough(id: ThreadId, seq: number): Promise<void> {
    const t = this.rows.get(id)
    if (t) this.rows.set(id, { ...t, reflectedThroughSeq: seq })
  }
  async listForReflection(q: {
    idleBefore: number
    limit: number
  }): Promise<{ thread: ThreadRecord; lastSeq: number }[]> {
    return [...this.rows.values()]
      .map((thread) => ({ thread, lastSeq: this.lastSeqs.get(thread.id) ?? 0 }))
      .filter((r) => r.thread.updatedAt <= q.idleBefore && r.lastSeq > (r.thread.reflectedThroughSeq ?? 0))
      .sort((a, b) => a.thread.updatedAt - b.thread.updatedAt || a.thread.id.localeCompare(b.thread.id))
      .slice(0, q.limit)
      .map((r) => ({ thread: { ...r.thread }, lastSeq: r.lastSeq }))
  }
}

export class FakeTasksRepository implements TasksRepository {
  readonly rows = new Map<TaskId, Task>()

  async create(t: Task): Promise<void> {
    this.rows.set(t.id, { ...t })
  }
  async get(id: TaskId): Promise<Task | null> {
    return this.rows.get(id) ?? null
  }
  async update(id: TaskId, patch: TaskPatch): Promise<void> {
    const t = this.rows.get(id)
    if (t) this.rows.set(id, { ...t, ...patch })
  }
  async listByStatus(statuses: TaskStatus[]): Promise<Task[]> {
    return [...this.rows.values()]
      .filter((t) => statuses.includes(t.status))
      .sort((a, b) => a.createdAt - b.createdAt)
  }
  async countActiveFor(personId: PersonId): Promise<number> {
    return [...this.rows.values()].filter(
      (t) => t.personId === personId && (t.status === 'queued' || t.status === 'running'),
    ).length
  }
}

type AnyHandler = (event: KeithEvent<EventName>) => void | Promise<void>

/** Handlers run in a microtask after `emit`, like the real bus. `emitted` records every event. */
export class FakeEventBus implements CoreEventBus {
  readonly emitted: { name: string; data: unknown }[] = []
  private readonly handlers = new Map<string, Set<AnyHandler>>()
  private pending: Promise<void> = Promise.resolve()

  on<N extends EventName>(name: N, handler: EventHandler<N>): Unsubscribe {
    const set = this.handlers.get(name) ?? new Set<AnyHandler>()
    this.handlers.set(name, set)
    const h = handler as unknown as AnyHandler
    set.add(h)
    return () => {
      set.delete(h)
    }
  }
  emit<N extends EventName>(name: N, data: EventMap[N]): void {
    this.emitted.push({ name, data })
    const event = { name, at: 0, data } as unknown as KeithEvent<EventName>
    for (const h of this.handlers.get(name) ?? []) {
      this.pending = this.pending.then(() => h(event))
    }
  }
  define(): void {}
  async idle(): Promise<void> {
    await this.pending
  }
  forPlugin(): EventBus {
    return this
  }
  removeByPlugin(): void {}
}
