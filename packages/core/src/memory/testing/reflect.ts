// Fakes and a harness for the reflection job's tests, built from the interfaces it consumes
// (storage, scheduler, RunLoop). Test-only.

import {
  isProviderError,
  KeithError,
  type LlmEvent,
  type LlmMessage,
  type LlmProvider,
  type LlmRequest,
} from '@keith/sdk'
import { createFakeLlm, type FakeLlm, type FakeLlmTurn } from '@keith/sdk/testing'
import type { KeithConfig } from '../../config/types.ts'
import type { RunLoop, RunLoopArgs } from '../../mind/types.ts'
import type { Scheduler } from '../../scheduler/types.ts'
import type { Lane, Memory, MessageId, PersonId, ThreadId } from '../../shared/types.ts'
import type {
  MessageMeta,
  MessageRecord,
  MessagesRepository,
  RelationshipRecord,
  RelationshipsRepository,
} from '../../storage/types.ts'
import { createReflection, type Reflection, type ReflectionDeps } from '../reflect/index.ts'
import { createFakeIds, type FakeThreadsRepository, fixedId } from './fakes.ts'
import { createHousehold, type Household } from './fixture.ts'

/** Messages with `seq`; `append` also records the thread's last seq and bumps its `updatedAt`. */
export class FakeMessagesRepository implements MessagesRepository {
  readonly rows: MessageRecord[] = []
  private readonly seqs = new Map<ThreadId, number>()

  constructor(private readonly threads?: FakeThreadsRepository) {}

  async append(m: MessageRecord): Promise<void> {
    const seq = (this.seqs.get(m.threadId) ?? 0) + 1
    this.seqs.set(m.threadId, seq)
    this.rows.push({ ...m, seq })
    this.threads?.lastSeqs.set(m.threadId, seq)
    await this.threads?.touch(m.threadId, m.createdAt)
  }
  async get(id: MessageId): Promise<MessageRecord | null> {
    return this.rows.find((r) => r.id === id) ?? null
  }
  async page(q: {
    threadId: ThreadId
    before?: MessageId | undefined
    limit: number
    roles?: MessageRecord['role'][] | undefined
  }): Promise<{ messages: MessageRecord[]; hasMore: boolean }> {
    let rows = this.rows.filter((r) => r.threadId === q.threadId && (!q.roles || q.roles.includes(r.role)))
    const cut = q.before === undefined ? -1 : rows.findIndex((r) => r.id === q.before)
    if (cut >= 0) rows = rows.slice(0, cut)
    return { messages: rows.slice(-q.limit), hasMore: rows.length > q.limit }
  }
  async range(q: {
    threadId: ThreadId
    afterSeq: number
    limit: number
    roles?: MessageRecord['role'][] | undefined
  }): Promise<MessageRecord[]> {
    return this.rows
      .filter(
        (r) =>
          r.threadId === q.threadId && (r.seq ?? 0) > q.afterSeq && (!q.roles || q.roles.includes(r.role)),
      )
      .slice(0, q.limit)
      .map((r) => ({ ...r }))
  }
  async lastSeq(threadId: ThreadId): Promise<number> {
    return this.seqs.get(threadId) ?? 0
  }
}

export class FakeRelationshipsRepository implements RelationshipsRepository {
  readonly rows = new Map<PersonId, RelationshipRecord>()
  async get(personId: PersonId): Promise<RelationshipRecord | null> {
    const r = this.rows.get(personId)
    return r ? { ...r, blockedRelayFrom: [...r.blockedRelayFrom] } : null
  }
  async upsert(r: RelationshipRecord): Promise<void> {
    this.rows.set(r.personId, { ...r, blockedRelayFrom: [...r.blockedRelayFrom] })
  }
}

/** Runs jobs at once and records the lane of each. */
export type FakeScheduler = Pick<Scheduler, 'run'> & { readonly lanes: Lane[] }

export function createFakeScheduler(): FakeScheduler {
  const lanes: Lane[] = []
  return {
    lanes,
    run<T>(lane: Lane, job: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
      lanes.push(lane)
      return job(signal ?? new AbortController().signal)
    },
  }
}

/**
 * A RunLoop for tool-less, one-step calls, played by a fake LLM (the real one lives in mind/). It
 * keeps the parts reflection relies on: text is collected, an abort ends with `cancelled`, and a
 * provider error is thrown as `PROVIDER_ERROR`. `calls` records every argument set.
 */
export function createUtilityRunLoop(llm: LlmProvider): RunLoop & { calls: RunLoopArgs[] } {
  const calls: RunLoopArgs[] = []
  const run = async (a: RunLoopArgs) => {
    calls.push(a)
    let text = ''
    const req: LlmRequest = { model: 'fake-utility', system: a.system, messages: a.messages }
    try {
      for await (const ev of llm.stream(req, a.signal)) {
        if (ev.type === 'text.delta') text += ev.text
      }
    } catch (error) {
      if (a.signal.aborted) return { text, steps: 1, stoppedBy: 'cancelled' as const }
      if (isProviderError(error)) throw new KeithError('PROVIDER_ERROR', error.message, { cause: error })
      throw error
    }
    return { text, steps: 1, stoppedBy: 'stop' as const }
  }
  return Object.assign(run, { calls })
}

/** A JSON reply as the utility model would send it. */
export function jsonTurn(value: unknown): LlmEvent[] {
  return [{ type: 'text.delta', text: JSON.stringify(value) }]
}

/** The text of every message the utility model was sent, system prompt included. */
export function promptText(req: LlmRequest): string {
  return [req.system, ...req.messages.map((m: LlmMessage) => m.content)].join('\n')
}

export type ReflectionHarness = Household & {
  llm: FakeLlm
  runLoop: ReturnType<typeof createUtilityRunLoop>
  messages: FakeMessagesRepository
  relationships: FakeRelationshipsRepository
  scheduler: FakeScheduler
  config: Pick<KeithConfig, 'memory' | 'mind'>
  deps: ReflectionDeps
  reflection: Reflection
  /** Appends a message at the current clock time. */
  say(threadId: ThreadId, author: PersonId | null, content: string, extra?: Partial<Extra>): Promise<number>
  /** Seeds a stored memory with id `mem_…(500 + n)`, clear of the ids `write` hands out. */
  seedMemory(n: number, m: Partial<Memory> & { content: string }): Promise<Memory>
}

type Extra = { meta: MessageMeta; toolCalls: boolean; role: 'user' | 'assistant' }

export async function createReflectionHarness(
  opts: { script?: FakeLlmTurn[]; reflect?: Partial<KeithConfig['memory']['reflect']> } = {},
): Promise<ReflectionHarness> {
  const h = await createHousehold()
  const llm = createFakeLlm(opts.script ?? [])
  const runLoop = createUtilityRunLoop(llm)
  const messages = new FakeMessagesRepository(h.threads)
  const relationships = new FakeRelationshipsRepository()
  const scheduler = createFakeScheduler()
  const config: Pick<KeithConfig, 'memory' | 'mind'> = {
    memory: {
      coreMaxChars: 1500,
      reflect: { enabled: true, idleMinutes: 20, maxMessages: 200, cardMaxChars: 1000, ...opts.reflect },
      summary: { enabled: true, minMessages: 20, maxChars: 2000 },
    },
    mind: {
      name: 'Keith',
      timezone: 'UTC',
      turn: { maxSteps: 8, stallMs: 30_000 },
      task: { maxSteps: 20, maxPerPerson: 3, timeoutMs: 600_000 },
      commitment: { ttlMs: 86_400_000 },
      arrival: { awayAfterMinutes: 30, briefing: 'auto', holdMs: 1500, graceMs: 5000 },
      context: { recentMessages: 30 },
      reminder: { maxPerPerson: 50 },
      group: { maxParticipants: 8, autoJoin: false, addressing: 'rules+utility' },
    },
  }
  const deps: ReflectionDeps = {
    config,
    repos: {
      threads: h.threads,
      messages,
      memories: h.memories,
      relationships,
      persons: h.persons,
    },
    memory: h.memory,
    runLoop,
    scheduler,
    events: h.events,
    clock: h.clock,
    ids: createFakeIds(),
    log: h.log,
  }
  let msgN = 0
  return {
    ...h,
    llm,
    runLoop,
    messages,
    relationships,
    scheduler,
    config,
    deps,
    reflection: createReflection(deps),
    async say(threadId, author, content, extra = {}) {
      msgN++
      const base = {
        id: fixedId('msg', msgN),
        threadId,
        authorPersonId: author,
        nodeId: null,
        modality: 'text' as const,
        content,
        meta: extra.meta ?? null,
        createdAt: h.clock.now(),
      }
      const role = extra.role ?? (author === null ? 'assistant' : 'user')
      await messages.append(
        role === 'user'
          ? { ...base, role }
          : {
              ...base,
              role,
              toolCalls: extra.toolCalls ? [{ id: `call_${msgN}`, name: 'memory.recall', args: {} }] : null,
              ui: null,
            },
      )
      return msgN
    },
    async seedMemory(n, m) {
      const memory: Memory = {
        id: fixedId('mem', 500 + n),
        subjectPersonId: null,
        visibility: 'thread',
        threadId: null,
        source: 'inferred',
        authorPersonId: null,
        pinned: false,
        createdAt: n,
        updatedAt: n,
        lastRecalledAt: null,
        ...m,
      }
      await h.memories.create(memory)
      return memory
    },
  }
}
