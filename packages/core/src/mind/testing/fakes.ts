// In-memory fakes of other lanes' interfaces (storage, scheduler, deliveries, memory, registries,
// server), built from their types.ts for the mind's tests. The phase-1 integration task re-runs the
// key tests against the real implementations.

import type { CoreFrame } from '@keith/protocol'
import {
  type EventHandler,
  type EventMap,
  type EventName,
  isKeithError,
  KeithError,
  type KeithEvent,
  type LlmProvider,
  type Skill,
  type Tool,
  type ToolResult,
} from '@keith/sdk'
import { createMemoryLogger } from '@keith/sdk/testing'
import type { KeithConfig } from '../../config/types.ts'
import type { MemoryService } from '../../memory/types.ts'
import type {
  CoreProviderRegistries,
  CoreSkillRegistry,
  CoreToolRegistry,
  RegisteredTool,
  ToolFilter,
} from '../../plugins/types.ts'
import type { CommitmentService, DeliveryQueue, Scheduler } from '../../scheduler/types.ts'
import type { NodeSink, Presence } from '../../server/types.ts'
import type {
  Clock,
  Commitment,
  Delivery,
  DeliveryId,
  IdPrefix,
  Ids,
  Lane,
  Memory,
  MessageId,
  NodeId,
  PersonId,
  ThreadId,
  Tier,
  Urgency,
} from '../../shared/types.ts'
import type {
  MessageRecord,
  NodeRecord,
  PersonRecord,
  RelationshipRecord,
  Repositories,
  ThreadParticipantRecord,
  ThreadRecord,
} from '../../storage/types.ts'
import type { SpeechHandle, VoiceOutput } from '../../voice/types.ts'

/** Deterministic ids: `<prefix>_000…<n>` (valid ULID bodies, increasing). */
export function createFakeIds(): Ids {
  let n = 0
  return {
    next<P extends IdPrefix>(prefix: P): `${P}_${string}` {
      n++
      return `${prefix}_${String(n).padStart(26, '0')}`
    },
  }
}

export type FakeRepos = Pick<Repositories, 'persons' | 'relationships' | 'threads' | 'messages' | 'nodes'> & {
  all: { messages: MessageRecord[]; threads: ThreadRecord[] }
}

export function createFakeRepos(): FakeRepos {
  const persons = new Map<PersonId, PersonRecord>()
  const relationships = new Map<PersonId, RelationshipRecord>()
  const threads: ThreadRecord[] = []
  const participants: ThreadParticipantRecord[] = []
  const messages: MessageRecord[] = []
  const nodes = new Map<NodeId, NodeRecord>()
  const lastSeqOf = (threadId: ThreadId): number => {
    let last = 0
    for (const m of messages) if (m.threadId === threadId) last = Math.max(last, m.seq ?? 0)
    return last
  }

  return {
    all: { messages, threads },
    persons: {
      async create(p) {
        persons.set(p.id, p)
      },
      async get(id) {
        return persons.get(id) ?? null
      },
      async getByUsername(username) {
        return [...persons.values()].find((p) => p.username === username) ?? null
      },
      async list() {
        return [...persons.values()]
      },
      async setPasswordHash(id, passwordHash) {
        const p = persons.get(id)
        if (p) persons.set(id, { ...p, passwordHash })
      },
      async setLastSeenAt(ids, at) {
        for (const id of ids) {
          const p = persons.get(id)
          if (p) persons.set(id, { ...p, lastSeenAt: at })
        }
      },
      async findByName(name) {
        const key = name.trim().toLowerCase()
        if (key === '') return null
        const all = [...persons.values()]
        return (
          all.find((p) => p.name.toLowerCase() === key) ??
          all.find((p) => p.username?.toLowerCase() === key) ??
          null
        )
      },
      async setTier(id, tier) {
        const p = persons.get(id)
        if (p) persons.set(id, { ...p, tier })
      },
      async setCredentials(id, c) {
        const p = persons.get(id)
        if (p) persons.set(id, { ...p, ...c })
      },
      async remove() {
        throw new Error('fake persons.remove is not modeled')
      },
    },
    relationships: {
      async get(personId) {
        return relationships.get(personId) ?? null
      },
      async upsert(r) {
        relationships.set(r.personId, r)
      },
    },
    threads: {
      async create(t, ps) {
        threads.push(t)
        for (const personId of ps)
          participants.push({ threadId: t.id, personId, joinedAt: t.createdAt, leftAt: null })
      },
      async get(id) {
        return threads.find((t) => t.id === id) ?? null
      },
      async getBySlug(owner, slug) {
        return threads.find((t) => t.ownerPersonId === owner && t.slug === slug) ?? null
      },
      async listForPerson(personId) {
        const mine = new Set(
          participants.filter((p) => p.personId === personId && p.leftAt === null).map((p) => p.threadId),
        )
        return threads.filter((t) => mine.has(t.id)).sort((a, b) => b.updatedAt - a.updatedAt)
      },
      async participants(threadId) {
        return participants.filter((p) => p.threadId === threadId && p.leftAt === null)
      },
      async touch(id, updatedAt) {
        const i = threads.findIndex((t) => t.id === id)
        const t = threads[i]
        if (t) threads[i] = { ...t, updatedAt }
      },
      async addParticipant(threadId, personId, at) {
        const i = participants.findIndex((p) => p.threadId === threadId && p.personId === personId)
        const row = participants[i]
        if (!row) {
          participants.push({ threadId, personId, joinedAt: at, leftAt: null })
          return true
        }
        if (row.leftAt === null) return false
        participants[i] = { ...row, joinedAt: at, leftAt: null }
        return true
      },
      async removeParticipant(threadId, personId, at) {
        const i = participants.findIndex(
          (p) => p.threadId === threadId && p.personId === personId && p.leftAt === null,
        )
        const row = participants[i]
        if (!row) return false
        participants[i] = { ...row, leftAt: at }
        return true
      },
      async formerParticipants(threadId) {
        return participants
          .filter((p) => p.threadId === threadId && p.leftAt !== null)
          .sort((a, b) => (b.leftAt ?? 0) - (a.leftAt ?? 0) || a.personId.localeCompare(b.personId))
      },
      async setSummary(id, s) {
        const i = threads.findIndex((t) => t.id === id)
        const t = threads[i]
        if (t) threads[i] = { ...t, summary: s.summary, summaryThroughSeq: s.throughSeq }
      },
      async setReflectedThrough(id, seq) {
        const i = threads.findIndex((t) => t.id === id)
        const t = threads[i]
        if (t) threads[i] = { ...t, reflectedThroughSeq: seq }
      },
      async listForReflection(q) {
        return threads
          .map((thread) => ({ thread, lastSeq: lastSeqOf(thread.id) }))
          .filter(
            (r) => r.thread.updatedAt <= q.idleBefore && r.lastSeq > (r.thread.reflectedThroughSeq ?? 0),
          )
          .sort((a, b) => a.thread.updatedAt - b.thread.updatedAt || a.thread.id.localeCompare(b.thread.id))
          .slice(0, q.limit)
      },
    },
    messages: {
      // Like storage: `seq` is per thread, assigned on insert (a passed value is ignored), and
      // defines order.
      async append(m) {
        let last = 0
        for (const x of messages) if (x.threadId === m.threadId) last = Math.max(last, x.seq ?? 0)
        messages.push({ ...m, seq: last + 1 })
        const i = threads.findIndex((t) => t.id === m.threadId)
        const t = threads[i]
        if (t) threads[i] = { ...t, updatedAt: m.createdAt }
      },
      async get(id) {
        return messages.find((m) => m.id === id) ?? null
      },
      async page(q) {
        let list = messages
          .filter((m) => m.threadId === q.threadId && (!q.roles || q.roles.includes(m.role)))
          .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
        if (q.before) {
          const i = list.findIndex((m) => m.id === q.before)
          if (i >= 0) list = list.slice(0, i)
        }
        const start = Math.max(0, list.length - q.limit)
        return { messages: list.slice(start), hasMore: start > 0 }
      },
      async range(q) {
        return messages
          .filter(
            (m) =>
              m.threadId === q.threadId &&
              (m.seq ?? 0) > q.afterSeq &&
              (!q.roles || q.roles.includes(m.role)),
          )
          .sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
          .slice(0, Math.max(0, q.limit))
      },
      async lastSeq(threadId) {
        return lastSeqOf(threadId)
      },
    },
    nodes: {
      async upsert(n) {
        nodes.set(n.id, n)
      },
      async get(id) {
        return nodes.get(id) ?? null
      },
      async touch(id, at) {
        const n = nodes.get(id)
        if (n) nodes.set(id, { ...n, lastSeenAt: at })
      },
    },
  }
}

/** A bus with the real contract's async delivery: handlers run after `emit` returns. */
export type FakeBus = {
  on<N extends EventName>(name: N, handler: EventHandler<N>): () => void
  emit<N extends EventName>(name: N, data: EventMap[N]): void
  idle(): Promise<void>
  readonly emitted: { name: EventName; data: unknown }[]
  named<N extends EventName>(name: N): EventMap[N][]
}

export function createFakeBus(clock: Clock): FakeBus {
  const handlers = new Map<string, Set<(e: KeithEvent<EventName>) => void | Promise<void>>>()
  const emitted: { name: EventName; data: unknown }[] = []
  const pending = new Set<Promise<void>>()
  return {
    emitted,
    on(name, handler) {
      const set = handlers.get(name) ?? new Set()
      const h = handler as unknown as (e: KeithEvent<EventName>) => void | Promise<void>
      set.add(h)
      handlers.set(name, set)
      return () => set.delete(h)
    },
    emit(name, data) {
      emitted.push({ name, data })
      for (const h of handlers.get(name) ?? []) {
        const p = Promise.resolve().then(() => h({ name, at: clock.now(), data } as KeithEvent<EventName>))
        pending.add(p)
        void p.finally(() => pending.delete(p))
      }
    },
    async idle() {
      while (pending.size > 0) await Promise.all([...pending])
    },
    named<N extends EventName>(name: N) {
      return emitted.filter((e) => e.name === name).map((e) => e.data as EventMap[N])
    },
  }
}

export type RecordingSink = NodeSink & {
  attach(nodeId: NodeId, threadId: ThreadId): void
  detach(nodeId: NodeId): void
  /** Frames sent to one node, in order. */
  framesOf(nodeId: NodeId): CoreFrame[]
  /** Frame types sent to one node, with `thread.state` shown as `thread.state(<state>)`. */
  typesOf(nodeId: NodeId): string[]
}

export function createRecordingSink(): RecordingSink {
  const attached = new Map<ThreadId, NodeId[]>()
  const frames = new Map<NodeId, CoreFrame[]>()
  return {
    attach(nodeId, threadId) {
      const list = attached.get(threadId) ?? []
      if (!list.includes(nodeId)) list.push(nodeId)
      attached.set(threadId, list)
    },
    detach(nodeId) {
      for (const [t, list] of attached)
        attached.set(
          t,
          list.filter((n) => n !== nodeId),
        )
    },
    attachedTo(threadId) {
      return [...(attached.get(threadId) ?? [])]
    },
    send(nodeId, frame) {
      const list = frames.get(nodeId) ?? []
      list.push(frame)
      frames.set(nodeId, list)
    },
    framesOf(nodeId) {
      return frames.get(nodeId) ?? []
    },
    typesOf(nodeId) {
      return (frames.get(nodeId) ?? []).map((f) =>
        f.type === 'thread.state' ? `thread.state(${f.data.state})` : f.type,
      )
    },
  }
}

export type FakePresence = Pick<Presence, 'isPresent'> & { set(personId: PersonId, present: boolean): void }

export function createFakePresence(): FakePresence {
  const present = new Set<PersonId>()
  return {
    isPresent: (id) => present.has(id),
    set(id, p) {
      if (p) present.add(id)
      else present.delete(id)
    },
  }
}

export type FakeScheduler = Scheduler & { readonly lanes: Lane[]; readonly maxConcurrent: number }

/** Runs every job at once (no pool limits) and records the lane of each. */
export function createFakeScheduler(): FakeScheduler {
  const lanes: Lane[] = []
  let running = 0
  let maxConcurrent = 0
  return {
    lanes,
    get maxConcurrent() {
      return maxConcurrent
    },
    async run(lane, job, signal) {
      lanes.push(lane)
      if (signal?.aborted) throw new KeithError('INTERNAL', 'job aborted before start')
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      try {
        return await job(signal ?? new AbortController().signal)
      } finally {
        running--
      }
    },
  }
}

const URGENCY_RANK: Record<Urgency, number> = { critical: 0, high: 1, normal: 2, low: 3 }

export type FakeDeliveryQueue = DeliveryQueue & {
  readonly all: Delivery[]
  readonly marked: { ids: DeliveryId[]; messageId: MessageId }[]
}

export function createFakeDeliveryQueue(deps: {
  ids: Ids
  clock: Clock
  bus: FakeBus
  mainThreadOf: (personId: PersonId) => ThreadId
}): FakeDeliveryQueue {
  const all: Delivery[] = []
  const marked: { ids: DeliveryId[]; messageId: MessageId }[] = []
  return {
    all,
    marked,
    async enqueue(d) {
      const delivery: Delivery = {
        id: deps.ids.next('dlv'),
        threadId: d.threadId ?? deps.mainThreadOf(d.personId),
        personId: d.personId,
        kind: d.kind,
        authorPersonId: d.authorPersonId ?? null,
        source: d.source ?? 'core',
        urgency: d.urgency ?? 'normal',
        content: d.content,
        ui: d.ui ?? null,
        status: 'pending',
        createdAt: deps.clock.now(),
        deliveredAt: null,
      }
      all.push(delivery)
      deps.bus.emit('delivery.enqueued', {
        deliveryId: delivery.id,
        threadId: delivery.threadId,
        kind: delivery.kind,
        urgency: delivery.urgency,
      })
      return delivery
    },
    async pendingFor(threadId) {
      return all
        .filter((d) => d.threadId === threadId && d.status === 'pending')
        .sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || a.createdAt - b.createdAt)
    },
    async markDelivered(ids, messageId) {
      marked.push({ ids: [...ids], messageId })
      for (const [i, d] of all.entries()) {
        if (ids.includes(d.id)) all[i] = { ...d, status: 'delivered', deliveredAt: deps.clock.now() }
      }
    },
  }
}

export type FakeMemory = MemoryService & {
  coreMemories: Memory[]
  indexEntries: string[]
  digestText: string
}

export function createFakeMemory(): FakeMemory {
  const m: FakeMemory = {
    coreMemories: [],
    indexEntries: [],
    digestText: '',
    async write() {
      throw new KeithError('INTERNAL', 'fake memory does not write')
    },
    async recall() {
      return []
    },
    async core() {
      return m.coreMemories
    },
    async index() {
      return m.indexEntries
    },
    async digest() {
      return m.digestText
    },
  }
  return m
}

export function createFakeCommitments(open: Commitment[] = []): Pick<CommitmentService, 'openFor'> {
  return { openFor: async (threadId) => open.filter((c) => c.threadId === threadId && c.status === 'open') }
}

const TIER_RANK: Record<Tier, number> = { guest: 0, member: 1, owner: 2 }

export type FakeToolRegistry = Pick<CoreToolRegistry, 'get' | 'list' | 'invoke'> & {
  add(tool: Tool, pluginId?: string | null): void
}

/**
 * Follows the CoreToolRegistry contract: `invoke` never throws for tool problems, and with `events`
 * it emits one `tool.called` / `tool.completed` pair per invocation, refused ones included.
 */
export function createFakeToolRegistry(
  tools: Tool[] = [],
  events?: Pick<FakeBus, 'emit'> | undefined,
): FakeToolRegistry {
  const map = new Map<string, RegisteredTool>()
  const attempt = async (
    name: string,
    rawArgs: unknown,
    call: Parameters<CoreToolRegistry['invoke']>[2],
  ): Promise<ToolResult> => {
    const registered = map.get(name)
    if (!registered) return { content: `Unknown tool '${name}'.`, error: true }
    const parsed = registered.tool.input.safeParse(rawArgs)
    if (!parsed.success) return { content: `Invalid input: ${parsed.error.message}`, error: true }
    const lowest = Math.min(...call.participants.map((p) => TIER_RANK[p.tier]))
    if (TIER_RANK[registered.tool.minTier] > lowest) return { content: 'Not allowed.', error: true }
    try {
      return await registered.tool.run(parsed.data, {
        person: call.person,
        participants: call.participants,
        threadId: call.threadId,
        taskId: call.taskId,
        signal: call.signal,
        log: createMemoryLogger(),
        services: {
          get: () => {
            throw new KeithError('SERVICE_MISSING', 'no services in fake')
          },
          find: () => undefined,
        },
      })
    } catch (error) {
      const message = isKeithError(error) || error instanceof Error ? error.message : String(error)
      return { content: `Tool ${name} failed: ${message}`, error: true }
    }
  }
  const reg: FakeToolRegistry = {
    add(tool, pluginId = null) {
      map.set(tool.name, { tool, pluginId })
    },
    get: (name) => map.get(name),
    list(filter: ToolFilter = {}) {
      return [...map.values()].filter(({ tool, pluginId }) => {
        if (filter.tier && TIER_RANK[tool.minTier] > TIER_RANK[filter.tier]) return false
        if (filter.capabilities && !(tool.requires ?? []).every((c) => filter.capabilities?.includes(c)))
          return false
        if (filter.names && !filter.names.includes(tool.name)) return false
        if (filter.excludeBuiltins && pluginId === null) return false
        return true
      })
    },
    async invoke(name, rawArgs, call): Promise<ToolResult> {
      const { threadId, taskId, toolCallId } = call
      events?.emit('tool.called', { threadId, taskId, toolCallId, name })
      const result = await attempt(name, rawArgs, call)
      events?.emit('tool.completed', { toolCallId, name, ok: result.error !== true, ms: 0 })
      return result
    },
  }
  for (const t of tools) reg.add(t)
  return reg
}

export function createFakeSkills(skills: Skill[] = []): Pick<CoreSkillRegistry, 'get' | 'list'> {
  return {
    get: (name) => {
      const skill = skills.find((s) => s.name === name)
      return skill ? { skill, pluginId: null } : undefined
    },
    list: () => skills.map((skill) => ({ skill, pluginId: null })),
  }
}

export function createFakeProviders(llm: LlmProvider): Pick<CoreProviderRegistries, 'llm'> {
  return {
    llm: {
      resolve: () => ({ provider: llm, model: 'test-model', ref: `${llm.id}:test-model` }),
      get: (id) => (id === llm.id ? llm : undefined),
      list: () => [llm],
    },
  }
}

/** `mind` and `memory` with the config defaults; `memory.summary` overrides go in `memory`. */
export function testConfig(
  mind: Partial<KeithConfig['mind']> = {},
  memory: { summary?: Partial<KeithConfig['memory']['summary']> } = {},
): Pick<KeithConfig, 'mind' | 'memory'> {
  return {
    mind: {
      name: 'Keith',
      timezone: 'UTC',
      turn: { maxSteps: 8, stallMs: 120_000 },
      task: { maxSteps: 20, maxPerPerson: 3, timeoutMs: 1_800_000 },
      commitment: { ttlMs: 604_800_000 },
      arrival: { awayAfterMinutes: 30, briefing: 'on-greeting', holdMs: 120_000, graceMs: 1_500 },
      context: { recentMessages: 40 },
      reminder: { maxPerPerson: 50 },
      group: { maxParticipants: 8, autoJoin: false, addressing: 'rules+utility' },
      ...mind,
    },
    memory: {
      coreMaxChars: 1_500,
      reflect: { enabled: true, idleMinutes: 20, maxMessages: 200, cardMaxChars: 1_000 },
      summary: { enabled: true, minMessages: 20, maxChars: 2_000, ...memory.summary },
    },
  }
}

// Voice output (voice/types.ts)

export type FakeSpeech = SpeechHandle & {
  nodeId: NodeId
  messageId: MessageId
  pushed: string
  ended: boolean
  stopCalls: number
  /** What `stop()` returns. Default: every pushed character. */
  spokenChars: number | null
  /** Settles `done` (a real handle does it when the last frame was sent). */
  finish(): void
}

export type FakeVoiceOutput = VoiceOutput & {
  speeches: FakeSpeech[]
  /** `done` settles right after `end()`. Default true; false holds it until `finish()`. */
  autoFinish: boolean
}

/** Returns a handle for every `begin` (the Mind checks `audio.out@1` itself). */
export function createFakeVoiceOutput(): FakeVoiceOutput {
  const voice: FakeVoiceOutput = {
    speeches: [],
    autoFinish: true,
    begin(a) {
      let settle: () => void = () => {}
      const done = new Promise<void>((resolve) => {
        settle = resolve
      })
      let stopped: number | null = null
      const speech: FakeSpeech = {
        nodeId: a.nodeId,
        messageId: a.messageId,
        pushed: '',
        ended: false,
        stopCalls: 0,
        spokenChars: null,
        done,
        push(text) {
          if (!speech.ended && stopped === null) speech.pushed += text
        },
        end() {
          speech.ended = true
          if (voice.autoFinish) settle()
        },
        stop() {
          speech.stopCalls += 1
          stopped ??= speech.spokenChars ?? speech.pushed.length
          settle()
          return stopped
        },
        finish: () => settle(),
      }
      voice.speeches.push(speech)
      return speech
    },
  }
  return voice
}
