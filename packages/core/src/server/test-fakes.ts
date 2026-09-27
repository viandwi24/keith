// In-memory fakes of other lanes' interfaces, for server/ tests only (docs/rules/conventions.md#tests).
// Built from storage/types.ts, events/types.ts and mind/types.ts. The integration task re-runs the
// key tests against the real implementations.

import type { MessageDto, ThreadDto } from '@keith/protocol'
import type { EventMap, EventName, KeithEvent } from '@keith/sdk'
import { createFakeClock, createMemoryLogger, type FakeClock, type MemoryLogger } from '@keith/sdk/testing'
import type { KeithConfig } from '../config/types.ts'
import type { CoreEventBus } from '../events/types.ts'
import type { OpenedThread, ThreadManager } from '../mind/types.ts'
import type { PluginStatus } from '../plugins/types.ts'
import type { FileId, IdPrefix, Ids, NodeId, PersonId, ThreadId, TurnState } from '../shared/types.ts'
import type {
  AuthTokenRecord,
  FileRecord,
  MessageRecord,
  NodeRecord,
  PersonRecord,
  Repositories,
  ThreadParticipantRecord,
  ThreadRecord,
} from '../storage/types.ts'
import type { VoiceInput } from '../voice/types.ts'
import { createAttachmentRegistry, type ServerAttachmentRegistry } from './attachments.ts'
import type { ConnectionTiming } from './connection.ts'
import { createPresence, type ServerPresence } from './presence.ts'
import { createCoreServer } from './server.ts'
import type { CoreServer } from './types.ts'

// Ids

/** Deterministic prefixed ids: `<prefix>_0000…0001`, `…0002`, … (valid ULID bodies). */
export function createFakeIds(): Ids {
  let seq = 0
  return {
    next<P extends IdPrefix>(prefix: P): `${P}_${string}` {
      seq += 1
      return `${prefix}_${String(seq).padStart(26, '0')}`
    },
  }
}

export const personId = (n: number) => `per_${String(n).padStart(26, '0')}` as PersonId
export const threadId = (n: number) => `thr_${String(n).padStart(26, '0')}` as ThreadId

// Repositories

export type ServerRepos = Pick<
  Repositories,
  'persons' | 'authTokens' | 'nodes' | 'threads' | 'messages' | 'files'
>

export type FakeRepos = ServerRepos & {
  data: {
    persons: Map<PersonId, PersonRecord>
    tokens: Map<string, AuthTokenRecord>
    nodes: Map<NodeId, NodeRecord>
    threads: Map<ThreadId, ThreadRecord>
    participants: ThreadParticipantRecord[]
    messages: MessageRecord[]
    files: Map<FileId, FileRecord>
    lastSeenWrites: { ids: PersonId[]; at: number }[]
  }
}

export function createFakeRepos(): FakeRepos {
  const data: FakeRepos['data'] = {
    persons: new Map(),
    tokens: new Map(),
    nodes: new Map(),
    threads: new Map(),
    participants: [],
    messages: [],
    files: new Map(),
    lastSeenWrites: [],
  }
  return {
    data,
    persons: {
      async create(p) {
        data.persons.set(p.id, { ...p })
      },
      async get(id) {
        const p = data.persons.get(id)
        return p ? { ...p } : null
      },
      async getByUsername(username) {
        for (const p of data.persons.values()) if (p.username === username) return { ...p }
        return null
      },
      async list() {
        return [...data.persons.values()]
      },
      async setPasswordHash(id, passwordHash) {
        const p = data.persons.get(id)
        if (p) p.passwordHash = passwordHash
      },
      async setLastSeenAt(ids, at) {
        data.lastSeenWrites.push({ ids: [...ids], at })
        for (const id of ids) {
          const p = data.persons.get(id)
          if (p) p.lastSeenAt = at
        }
      },
    },
    authTokens: {
      async create(t) {
        data.tokens.set(t.tokenHash, { ...t })
      },
      async get(tokenHash) {
        const t = data.tokens.get(tokenHash)
        return t ? { ...t } : null
      },
      async setNode(tokenHash, nodeId) {
        const t = data.tokens.get(tokenHash)
        if (t) t.nodeId = nodeId
      },
      async delete(tokenHash) {
        data.tokens.delete(tokenHash)
      },
      async deleteExpired(now) {
        let n = 0
        for (const [hash, t] of data.tokens) {
          if (t.expiresAt <= now) {
            data.tokens.delete(hash)
            n += 1
          }
        }
        return n
      },
    },
    nodes: {
      async upsert(n) {
        data.nodes.set(n.id, { ...n })
      },
      async get(id) {
        const n = data.nodes.get(id)
        return n ? { ...n } : null
      },
      async touch(id, at) {
        const n = data.nodes.get(id)
        if (n) n.lastSeenAt = at
      },
    },
    threads: {
      async create(t, participants) {
        data.threads.set(t.id, { ...t })
        for (const p of participants) {
          data.participants.push({ threadId: t.id, personId: p, joinedAt: t.createdAt, leftAt: null })
        }
      },
      async get(id) {
        return data.threads.get(id) ?? null
      },
      async getBySlug(owner, slug) {
        for (const t of data.threads.values()) if (t.ownerPersonId === owner && t.slug === slug) return t
        return null
      },
      async listForPerson(person) {
        const ids = new Set(
          data.participants.filter((p) => p.personId === person && p.leftAt === null).map((p) => p.threadId),
        )
        return [...data.threads.values()]
          .filter((t) => ids.has(t.id))
          .sort((a, b) => b.updatedAt - a.updatedAt)
      },
      async participants(id) {
        return data.participants.filter((p) => p.threadId === id && p.leftAt === null)
      },
      async touch(id, updatedAt) {
        const t = data.threads.get(id)
        if (t) t.updatedAt = updatedAt
      },
    },
    messages: {
      async append(m) {
        data.messages.push(m)
      },
      async get(id) {
        return data.messages.find((m) => m.id === id) ?? null
      },
      async page(q) {
        const roles = q.roles ?? ['user', 'assistant', 'tool']
        let list = data.messages
          .filter((m) => m.threadId === q.threadId && roles.includes(m.role))
          .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
        if (q.before !== undefined) {
          const at = list.findIndex((m) => m.id === q.before)
          list = at < 0 ? [] : list.slice(0, at)
        }
        const page = list.slice(-q.limit)
        return { messages: page, hasMore: list.length > page.length }
      },
    },
    files: {
      async create(f) {
        if (data.files.has(f.id)) throw new Error('duplicate file id')
        data.files.set(f.id, { ...f })
      },
      async get(id) {
        const f = data.files.get(id)
        return f ? { ...f } : null
      },
    },
  }
}

// Event bus

export type FakeEventBus = CoreEventBus & {
  emitted: { name: string; data: unknown }[]
  named<N extends EventName>(name: N): EventMap[N][]
}

export function createFakeEventBus(clock: { now(): number }): FakeEventBus {
  const handlers = new Map<string, Set<(e: KeithEvent<EventName>) => void | Promise<void>>>()
  const emitted: { name: string; data: unknown }[] = []
  let pending: Promise<unknown>[] = []
  const bus: FakeEventBus = {
    emitted,
    named<N extends EventName>(name: N) {
      return emitted.filter((e) => e.name === name).map((e) => e.data as EventMap[N])
    },
    on(name, handler) {
      const set = handlers.get(name) ?? new Set()
      const h = handler as (e: KeithEvent<EventName>) => void | Promise<void>
      set.add(h)
      handlers.set(name, set)
      return () => {
        set.delete(h)
      }
    },
    emit(name, data) {
      emitted.push({ name, data })
      const event = { name, at: clock.now(), data } as KeithEvent<EventName>
      for (const h of handlers.get(name) ?? []) pending.push(Promise.resolve().then(() => h(event)))
    },
    define() {},
    forPlugin: () => bus,
    removeByPlugin() {},
    async idle() {
      while (pending.length > 0) {
        const batch = pending
        pending = []
        await Promise.allSettled(batch)
      }
    },
  }
  return bus
}

// ThreadManager

export type FakeThreadManager = ThreadManager & {
  calls: {
    open: Parameters<ThreadManager['open']>[0][]
    detach: { nodeId: NodeId; threadId?: ThreadId | undefined }[]
    input: { threadId: ThreadId; personId: PersonId; nodeId: NodeId; text: string }[]
    cancel: { threadId: ThreadId; nodeId: NodeId }[]
    action: Parameters<ThreadManager['action']>[0][]
    voiceActivity: Parameters<ThreadManager['voiceActivity']>[0][]
  }
  /** Messages `open` returns for a thread. */
  history: Map<ThreadId, MessageDto[]>
  /** Makes `open` throw this. */
  failOpen: Error | null
  /** Makes `action` throw this. */
  failAction: Error | null
}

/** A ThreadManager that opens the person's `main` thread (thr_…0001-style ids per person). */
export function createFakeThreadManager(repos: FakeRepos): FakeThreadManager {
  const calls: FakeThreadManager['calls'] = {
    open: [],
    detach: [],
    input: [],
    cancel: [],
    action: [],
    voiceActivity: [],
  }
  const history = new Map<ThreadId, MessageDto[]>()
  const states = new Map<ThreadId, TurnState>()
  const tm: FakeThreadManager = {
    calls,
    history,
    failOpen: null,
    failAction: null,
    async action(a) {
      calls.action.push({ ...a })
      if (tm.failAction) throw tm.failAction
    },
    voiceActivity(a) {
      calls.voiceActivity.push({ ...a })
    },
    async open(a) {
      calls.open.push({ ...a })
      if (tm.failOpen) throw tm.failOpen
      const person = repos.data.persons.get(a.personId)
      if (!person) throw new Error('unknown person')
      let thread = a.threadId ? repos.data.threads.get(a.threadId) : undefined
      if (!thread) {
        const id = a.threadId ?? (`thr_${a.personId.slice(4)}` as ThreadId)
        thread = repos.data.threads.get(id)
        if (!thread) {
          thread = {
            id,
            kind: 'direct',
            slug: 'main',
            title: 'Main',
            ownerPersonId: a.personId,
            summary: null,
            createdAt: 0,
            updatedAt: 0,
          }
          await repos.threads.create(thread, [a.personId])
        }
      }
      const dto: ThreadDto = {
        id: thread.id,
        kind: thread.kind,
        title: thread.title,
        participants: [{ id: person.id, name: person.name, tier: person.tier }],
        state: tm.state(thread.id),
        updatedAt: thread.updatedAt,
      }
      const opened: OpenedThread = { thread: dto, messages: history.get(thread.id) ?? [] }
      return opened
    },
    detach(a) {
      calls.detach.push({ ...a })
    },
    async input(a) {
      calls.input.push({ threadId: a.threadId, personId: a.personId, nodeId: a.nodeId, text: a.text })
    },
    cancel(a) {
      calls.cancel.push({ ...a })
    },
    state: (id) => states.get(id) ?? 'idle',
  }
  return tm
}

// VoiceInput

export type FakeVoiceInput = VoiceInput & {
  calls: {
    start: Parameters<VoiceInput['start']>[0][]
    chunk: Parameters<VoiceInput['chunk']>[0][]
    end: Parameters<VoiceInput['end']>[0][]
    detach: NodeId[]
  }
}

/** Accepts any `pcm16` stream; `chunk` and `end` know only streams `start` accepted. */
export function createFakeVoiceInput(): FakeVoiceInput {
  const open = new Set<string>()
  const key = (nodeId: NodeId, streamId: string) => `${nodeId}/${streamId}`
  const calls: FakeVoiceInput['calls'] = { start: [], chunk: [], end: [], detach: [] }
  return {
    calls,
    start(a) {
      calls.start.push({ ...a })
      if (a.codec !== 'pcm16') return { ok: false, code: 'INVALID_FRAME', message: 'codec not supported' }
      open.add(key(a.nodeId, a.streamId))
      return { ok: true }
    },
    chunk(a) {
      calls.chunk.push({ ...a })
      return open.has(key(a.nodeId, a.streamId))
    },
    end(a) {
      calls.end.push({ ...a })
      return open.delete(key(a.nodeId, a.streamId))
    },
    detach(nodeId) {
      calls.detach.push(nodeId)
      for (const k of open) if (k.startsWith(`${nodeId}/`)) open.delete(k)
    },
  }
}

// Config and a full test server

export function testConfig(overrides: { awayAfterMinutes?: number } = {}): KeithConfig {
  return {
    server: { host: '127.0.0.1', port: 0 },
    mind: {
      name: 'Keith',
      timezone: 'UTC',
      turn: { maxSteps: 8, stallMs: 30_000 },
      task: { maxSteps: 20, maxPerPerson: 3, timeoutMs: 600_000 },
      commitment: { ttlMs: 86_400_000 },
      arrival: {
        awayAfterMinutes: overrides.awayAfterMinutes ?? 30,
        briefing: 'on-greeting',
        holdMs: 120_000,
        graceMs: 1_500,
      },
      context: { recentMessages: 30 },
    },
    memory: { coreMaxChars: 2_000 },
    scheduler: { foreground: 4, delivery: 2, background: 2, tickMs: 30_000 },
    models: { foreground: 'fake:model', background: 'fake:model', utility: 'fake:model' },
    auth: { tokenTtlDays: 30 },
    plugins: { enabled: [], required: [], stopTimeoutMs: 5_000, sections: {} },
    services: {},
  }
}

export const OWNER_PASSWORD = 'correct horse battery staple'

export type TestServer = {
  server: CoreServer
  base: string
  wsUrl: (token: string | null) => string
  repos: FakeRepos
  events: FakeEventBus
  threads: FakeThreadManager
  attachments: ServerAttachmentRegistry
  presence: ServerPresence
  clock: FakeClock
  log: MemoryLogger
  owner: PersonRecord
  /** Stops the server (not the shared repos, so a restart can reuse them). */
  stop(): Promise<void>
}

export type TestServerOptions = {
  repos?: FakeRepos
  clock?: FakeClock
  timing?: Partial<ConnectionTiming>
  awayAfterMinutes?: number
  /** `KEITH_HOME/files` for `/v1/files`; omitted = files disabled. */
  filesDir?: string
  /** Phase 3: node audio goes here; omitted = voice off. */
  voice?: VoiceInput
  /** The plugin host's status for failed-plugin notices; omitted = none. */
  pluginStatus?: () => PluginStatus[]
  voiceConfigured?: boolean
}

let ownerHash: Promise<string> | null = null
const ownerPasswordHash = () => {
  ownerHash ??= Bun.password.hash(OWNER_PASSWORD)
  return ownerHash
}

/** Starts a real server on an OS-chosen port with fakes behind it, and an owner person `tony`. */
export async function startTestServer(opts: TestServerOptions = {}): Promise<TestServer> {
  const clock = opts.clock ?? createFakeClock(1_790_000_000_000)
  const repos = opts.repos ?? createFakeRepos()
  const log = createMemoryLogger()
  const config = testConfig(
    opts.awayAfterMinutes === undefined ? {} : { awayAfterMinutes: opts.awayAfterMinutes },
  )
  const owner: PersonRecord = repos.data.persons.get(personId(1)) ?? {
    id: personId(1),
    name: 'Tony',
    username: 'tony',
    passwordHash: await ownerPasswordHash(),
    tier: 'owner',
    lastSeenAt: null,
    createdAt: 0,
  }
  if (!repos.data.persons.has(owner.id)) await repos.persons.create(owner)
  const events = createFakeEventBus(clock)
  const threads = createFakeThreadManager(repos)
  const attachments = createAttachmentRegistry({ log })
  const presence = createPresence({ config, clock, log, events, persons: repos.persons })
  const server = createCoreServer({
    config,
    log,
    clock,
    ids: createFakeIds(),
    events,
    repos,
    threads,
    attachments,
    presence,
    version: '0.1.0',
    timing: opts.timing,
    filesDir: opts.filesDir,
    voice: opts.voice,
    pluginStatus: opts.pluginStatus,
    voiceConfigured: opts.voiceConfigured,
  })
  const { host, port } = await server.listen()
  const base = `http://${host}:${port}`
  return {
    server,
    base,
    wsUrl: (token) =>
      `ws://${host}:${port}/v1/ws${token === null ? '' : `?token=${encodeURIComponent(token)}`}`,
    repos,
    events,
    threads,
    attachments,
    presence,
    clock,
    log,
    owner,
    async stop() {
      await server.stop()
      presence.dispose()
    },
  }
}

export async function login(t: TestServer, username = 'tony', password = OWNER_PASSWORD): Promise<string> {
  const res = await fetch(`${t.base}/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const body = (await res.json()) as { token: string }
  return body.token
}

// A small WS client

export type ReceivedFrame = { type: string; id: string; re?: string; data: Record<string, unknown> }

export type TestClient = {
  ws: WebSocket
  frames: ReceivedFrame[]
  /** Binary frames received, in order. */
  binary: Uint8Array[]
  /** Resolves with the next frame of `type` not yet taken (waits up to `timeoutMs`). */
  next(type: string, timeoutMs?: number): Promise<ReceivedFrame>
  send(type: string, data: unknown, extra?: Record<string, unknown>): string
  sendRaw(text: string): void
  closed: Promise<{ code: number; reason: string }>
  /** Sends `hello` and waits for `welcome`. */
  hello(extra?: Record<string, unknown>): Promise<ReceivedFrame>
  close(): Promise<void>
}

let clientFrameSeq = 0

export async function connect(url: string): Promise<TestClient> {
  const ws = new WebSocket(url)
  ws.binaryType = 'arraybuffer'
  const frames: ReceivedFrame[] = []
  const binary: Uint8Array[] = []
  const taken = new Set<ReceivedFrame>()
  const waiters: (() => void)[] = []
  ws.addEventListener('message', (e) => {
    if (e.data instanceof ArrayBuffer) binary.push(new Uint8Array(e.data))
    else frames.push(JSON.parse(String(e.data)) as ReceivedFrame)
    for (const w of waiters.splice(0)) w()
  })
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }))
  })
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true })
    ws.addEventListener('error', () => reject(new Error('ws error')), { once: true })
    void closed.then(() => resolve())
  })
  const client: TestClient = {
    ws,
    frames,
    binary,
    async next(type, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const found = frames.find((f) => f.type === type && !taken.has(f))
        if (found) {
          taken.add(found)
          return found
        }
        const left = deadline - Date.now()
        if (left <= 0) throw new Error(`no '${type}' frame within ${timeoutMs} ms`)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, left)
          waiters.push(() => {
            clearTimeout(timer)
            resolve()
          })
        })
      }
    },
    send(type, data, extra = {}) {
      clientFrameSeq += 1
      const id = `n${clientFrameSeq}`
      ws.send(JSON.stringify({ v: 1, type, id, ts: 1_790_000_000_000, data, ...extra }))
      return id
    },
    sendRaw(text) {
      ws.send(text)
    },
    closed,
    async hello(extra = {}) {
      client.send('hello', {
        protocol: 1,
        client: { name: 'keith-test', version: '0.0.0' },
        capabilities: ['chat.text@1'],
        ...extra,
      })
      return client.next('welcome')
    },
    async close() {
      if (ws.readyState !== WebSocket.CLOSED) ws.close()
      await closed
    },
  }
  return client
}

/** Waits until `check` passes (polling), for effects of async socket handling. */
export async function eventually(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
