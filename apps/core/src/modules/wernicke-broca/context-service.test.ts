import { describe, expect, test } from 'bun:test'
import type { FrontGenerationsRepo } from '@keith/db'
import type { HarnessAgent, HarnessUIMessage, InboxStats, PendingState } from 'eharness'
import type { ActivityStore } from 'eharness/activity'
import {
  ChatContextError,
  type ContextServiceDeps,
  createContextService,
} from './context-service.ts'
import { frontGenerations } from './generations.ts'

// The context service (docs/specs/chat-context.md "Service", "Refusals", "Flush"; ADR-0030 §3 to §6, §9). The harness is a
// fake: a session has stored messages, a busy flag, a pending state, a `flush()` (the reset, eharness 0.14.0) and a
// `compact()` (/compact) that write an `eh.flush` record the way the flush of eharness does. The tests read the calls the service makes, the generation map and the audit and activity rows.

interface FakeSession {
  messages: HarnessUIMessage[]
  busy: boolean
  pending: PendingState | null
  compactCalls: unknown[]
  /** Calls of `session.flush()` (the reset's flush, spec 06 §5.2a rule 11). */
  flushCalls: number
  /** Runs inside `compact()` or `flush()` before the flush record is written (a turn started during the flush). */
  duringCompact?: () => void
  /**
   * The flush the compaction runs with the manual abort policy (eharness 0.13.0, spec 06 §5.2a rule 9a): `ok` saves and
   * summarises; `error` writes a failed `eh.flush` record and rejects `EH_COMPACTION_FAILED` (`reason: 'flush'`) with no
   * marker; `skipped` (the flush window) rejects the same way without a record; `none` is no hook at all (no record).
   * `flush()` answers with a result instead: `flushed`, `failed` (with the failed record), `skipped` `window` or `no-hook`.
   */
  flush?: 'ok' | 'error' | 'skipped' | 'none'
  /** The compaction throws this error instead of writing a summary. */
  compactThrows?: unknown
  /** `flush()` throws this error (storage, lock). */
  flushThrows?: unknown
}

let counter = 0
const nextId = (): string => `m${String(++counter).padStart(6, '0')}`

const msg = (
  role: 'user' | 'assistant',
  text: string,
  at: number,
  extra: Record<string, unknown> = {},
): HarnessUIMessage =>
  ({
    id: nextId(),
    role,
    parts: [{ type: 'text', text }],
    metadata: { eharness: { v: 1, createdAt: at, ...extra } },
  }) as unknown as HarnessUIMessage

const flushRecord = (error?: string): HarnessUIMessage =>
  ({
    id: nextId(),
    role: 'assistant',
    parts: [{ type: 'data-eh.flush', data: error === undefined ? {} : { error } }],
    metadata: { eharness: { v: 1, createdAt: 0, kind: 'eh.flush' } },
  }) as unknown as HarnessUIMessage

/** The error eharness rejects a manual compaction with when its abort-on-flush policy stops the summary. */
const flushRefusal = (flush: 'failed' | 'skipped'): Error =>
  Object.assign(new Error('Compaction was not run: the pre-compaction flush did not save'), {
    code: 'EH_COMPACTION_FAILED',
    details: { reason: 'flush', flush },
  })

const hasMarker = (s: FakeSession): boolean =>
  s.messages.some(
    (m) => (m.metadata as { eharness?: { kind?: string } }).eharness?.kind === 'eh.compaction',
  )

const compactionMarker = (trigger: 'auto' | 'manual' | 'turn'): HarnessUIMessage =>
  ({
    id: nextId(),
    role: 'user',
    parts: [{ type: 'data-eh.compaction', data: { summary: 'earlier', trigger } }],
    metadata: { eharness: { v: 1, createdAt: 0, kind: 'eh.compaction' } },
  }) as unknown as HarnessUIMessage

const EMPTY_PENDING: PendingState = {
  messageId: 'x',
  approvals: [],
  clientTools: [],
  externals: [],
} as unknown as PendingState

function world(options: { tasks?: number; inbox?: Partial<InboxStats> } = {}) {
  const sessions = new Map<string, FakeSession>()
  const sessionOf = (id: string): FakeSession => {
    let s = sessions.get(id)
    if (s === undefined) {
      s = { messages: [], busy: false, pending: null, compactCalls: [], flushCalls: 0 }
      sessions.set(id, s)
    }
    return s
  }
  const lead = {
    peek: (id: string) => ({
      busy: async () => (sessionOf(id).busy ? { scope: 'local', turnId: 't' } : null),
      pending: async () => sessionOf(id).pending,
      messages: async (q: { limit?: number } = {}) => {
        const all = sessionOf(id).messages
        return q.limit === undefined ? [...all] : all.slice(Math.max(0, all.length - q.limit))
      },
    }),
    session: (id: string) => ({
      compact: async (options: unknown = {}) => {
        const s = sessionOf(id)
        s.compactCalls.push(options)
        if (s.compactThrows !== undefined) throw s.compactThrows
        s.duringCompact?.()
        if (s.flush === 'error') {
          s.messages.push(flushRecord('the model failed'))
          throw flushRefusal('failed')
        }
        if (s.flush === 'skipped') throw flushRefusal('skipped')
        // the marker the API compaction leaves in the transcript (eharness: trigger 'manual' for /compact)
        s.messages.push(compactionMarker('manual'))
        if (s.flush === 'none') return null
        s.messages.push(flushRecord())
        return null
      },
      flush: async () => {
        const s = sessionOf(id)
        s.flushCalls++
        if (s.flushThrows !== undefined) throw s.flushThrows
        s.duringCompact?.()
        if (s.flush === 'error') {
          s.messages.push(flushRecord('the model failed'))
          return { status: 'failed', reason: 'flush', error: 'the model failed' }
        }
        if (s.flush === 'skipped') return { status: 'skipped', reason: 'window' }
        if (s.flush === 'none') return { status: 'skipped', reason: 'no-hook' }
        s.messages.push(flushRecord())
        return { status: 'flushed' }
      },
    }),
  } as unknown as HarnessAgent

  const repo = new Map<string, { generation: number; updatedAt: number }>()
  const generationsRepo: FrontGenerationsRepo = {
    get: (personId) => {
      const row = repo.get(personId)
      return row === undefined ? undefined : { personId, ...row }
    },
    bump: (personId, at) => {
      const next = (repo.get(personId)?.generation ?? 0) + 1
      repo.set(personId, { generation: next, updatedAt: at })
      return next
    },
    list: () => [...repo.entries()].map(([personId, row]) => ({ personId, ...row })),
    delete: (personId) => repo.delete(personId),
  }
  const generations = frontGenerations(generationsRepo)
  generations.load()

  const audit: { kind: string; actor: string; via: string; detail?: Record<string, unknown> }[] = []
  const activity: { sessionId: string | null; type: string; payload: unknown }[] = []
  const store = {
    append: async (event: { sessionId: string | null; type: string; payload: unknown }) => {
      activity.push(event)
      return undefined
    },
  } as unknown as ActivityStore

  const stats: InboxStats = { ready: 0, claimed: 0, delayed: 0, dead: 0, ...options.inbox }
  const deps: ContextServiceDeps = {
    lead: () => lead,
    lock: {} as ContextServiceDeps['lock'],
    inbox: { stats: async () => stats },
    tasks: { list: () => Array.from({ length: options.tasks ?? 0 }, () => ({})) as never },
    generations,
    audit: { record: (event) => void audit.push(event as (typeof audit)[number]) },
    store,
    now: () => 1000,
  }
  return {
    service: createContextService(deps),
    sessions,
    sessionOf,
    generations,
    audit,
    activity,
    repo,
  }
}

const ALICE = { by: 'alice', via: 'local' as const }
const BOB = { by: 'bob', via: 'local' as const }
const aliceId = (g = 0) => (g === 0 ? 'front:alice' : `front:alice:g${g}`)

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise
    return undefined
  } catch (error) {
    expect(error).toBeInstanceOf(ChatContextError)
    return (error as ChatContextError).reason
  }
}

describe('newContext refusals (ADR-0030 §3, in order)', () => {
  test('turn-running: a live turn refuses, nothing is compacted or bumped', async () => {
    const w = world()
    w.sessionOf(aliceId()).busy = true
    w.sessionOf(aliceId()).messages.push(msg('user', 'hi', 1))
    expect(await reasonOf(w.service.newContext(ALICE, { flush: true }))).toBe('turn-running')
    expect(w.sessionOf(aliceId()).flushCalls).toBe(0)
    expect(w.generations.current('alice')).toBe(0)
    expect(w.audit).toHaveLength(0)
  })

  test('approval-pending: a parked approval refuses', async () => {
    const w = world()
    w.sessionOf(aliceId()).pending = {
      ...EMPTY_PENDING,
      approvals: [{ approvalId: 'a1', toolCallId: 'c1', toolName: 'shell.exec' }],
    } as PendingState
    expect(await reasonOf(w.service.newContext(ALICE, { flush: false }))).toBe('approval-pending')
    expect(w.generations.current('alice')).toBe(0)
  })

  test('task-running: a queued or running worker of the session refuses', async () => {
    const w = world({ tasks: 1 })
    expect(await reasonOf(w.service.newContext(ALICE, { flush: false }))).toBe('task-running')
    expect(w.generations.current('alice')).toBe(0)
  })

  test('task-running: an unread inbox item (ready, claimed or delayed) refuses', async () => {
    const w = world({ inbox: { delayed: 1 } })
    expect(await reasonOf(w.service.newContext(ALICE, { flush: false }))).toBe('task-running')
    const dead = world({ inbox: { dead: 3 } })
    await dead.service.newContext(ALICE, { flush: false })
    expect(dead.generations.current('alice')).toBe(1)
  })
})

describe('newContext flush (ADR-0030 §3, chat-context.md "Flush")', () => {
  test('flush failed: refused, nothing changed: no summary, no marker, no bump, no audit row, no activity', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'remember me', 1))
    s.flush = 'error'
    const before = s.messages.length
    expect(await reasonOf(w.service.newContext(ALICE, { flush: true }))).toBe('flush-failed')
    expect(w.generations.current('alice')).toBe(0)
    expect(w.repo.size).toBe(0)
    expect(w.audit).toHaveLength(0)
    expect(w.activity.filter((r) => r.type === 'chat.context.changed')).toHaveLength(0)
    // a flush-only call (spec 06 §5.2a rule 11): the old context is never summarised
    expect(s.flushCalls).toBe(1)
    expect(s.compactCalls).toHaveLength(0)
    expect(hasMarker(s)).toBe(false)
    // only the failed flush record was added; the stored history is untouched
    expect(s.messages).toHaveLength(before + 1)
  })

  test('flush skipped by the window: refused as flush-failed, nothing changes', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'a long talk', 1))
    s.flush = 'skipped'
    expect(await reasonOf(w.service.newContext(ALICE, { flush: true }))).toBe('flush-failed')
    expect(w.generations.current('alice')).toBe(0)
    expect(hasMarker(s)).toBe(false)
    expect(w.audit).toHaveLength(0)
  })

  test('the refused reset can be retried with --no-flush: it starts fresh and the stored history is still there', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'remember me', 1))
    s.flush = 'error'
    expect(await reasonOf(w.service.newContext(ALICE, { flush: true }))).toBe('flush-failed')
    expect(await w.service.newContext(ALICE, { flush: false })).toEqual({
      generation: 1,
      flushed: false,
    })
    expect(hasMarker(s)).toBe(false)
  })

  test('a flush that did not run (no record, a short transcript) is not a refusal: the reset goes on with flushed false', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    s.flush = 'none'
    expect(await w.service.newContext(ALICE, { flush: true })).toEqual({
      generation: 1,
      flushed: false,
    })
    expect(w.generations.current('alice')).toBe(1)
    expect(w.audit[0]?.detail).toEqual({ subject: 'alice', generation: 1, flushed: false })
    expect(w.activity.filter((r) => r.type === 'chat.context.changed')).toHaveLength(1)
  })

  test('a flush that throws (storage, lock) refuses as flush-failed, nothing changes', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    s.flushThrows = new Error('EH_STORAGE')
    expect(await reasonOf(w.service.newContext(ALICE, { flush: true }))).toBe('flush-failed')
    expect(w.generations.current('alice')).toBe(0)
    expect(w.audit).toHaveLength(0)
  })

  test('a short transcript with nothing to drop (eharness skips it, no record) resets without a refusal', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1), msg('assistant', 'hello', 2))
    s.flush = 'none'
    const out = await w.service.newContext(ALICE, { flush: true })
    expect(out).toEqual({ generation: 1, flushed: false })
    expect(s.flushCalls).toBe(1)
  })

  test('/compact on a short session is not an error: flushed false, the generation stays', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    s.flush = 'none'
    expect(await w.service.compact(ALICE, {})).toEqual({ generation: 0, flushed: false })
    expect(w.audit[0]?.detail).toEqual({ subject: 'alice', generation: 0, flushed: false })
  })

  test('flush: false makes no flush call and records flushed false', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    const out = await w.service.newContext(ALICE, { flush: false })
    expect(out).toEqual({ generation: 1, flushed: false })
    expect(s.flushCalls).toBe(0)
    expect(w.audit[0]?.detail).toEqual({ subject: 'alice', generation: 1, flushed: false })
  })

  test('an empty session has nothing to save: no flush call, the reset goes on', async () => {
    const w = world()
    const out = await w.service.newContext(ALICE, { flush: true })
    expect(out).toEqual({ generation: 1, flushed: false })
    expect(w.sessionOf(aliceId()).flushCalls).toBe(0)
  })

  test('the re-check catches a turn started during the flush: refused, no bump', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    s.duringCompact = () => {
      s.busy = true
    }
    expect(await reasonOf(w.service.newContext(ALICE, { flush: true }))).toBe('turn-running')
    expect(w.generations.current('alice')).toBe(0)
  })

  test('a flush that succeeds: the flush runs under the session, no summary, then the bump, the record and audit', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    const out = await w.service.newContext(ALICE, { flush: true })
    expect(out).toEqual({ generation: 1, flushed: true })
    expect(s.flushCalls).toBe(1)
    expect(s.compactCalls).toHaveLength(0)
    expect(hasMarker(s)).toBe(false)
    expect(w.generations.current('alice')).toBe(1)
    // the activity record names the old session and the new generation
    expect(w.activity.filter((r) => r.type === 'chat.context.changed')).toEqual([
      expect.objectContaining({
        sessionId: aliceId(0),
        type: 'chat.context.changed',
        payload: expect.objectContaining({ generation: 1 }),
      }),
    ])
  })
})

describe('pending records of a context change (P34.3.2)', () => {
  // emit stamps the person into every payload; the record's own fields are what these tests read
  const pendingOf = (w: ReturnType<typeof world>) =>
    w.activity
      .filter((r) => r.type === 'chat.context.pending')
      .map((r) => {
        const { personId: _person, ...payload } = r.payload as Record<string, unknown>
        return { sessionId: r.sessionId, payload }
      })

  test('a reset with a flush: one start before the flush, one end after the bump, both on the old session', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    const seenDuringFlush: string[][] = []
    s.duringCompact = () => {
      seenDuringFlush.push(w.activity.map((r) => r.type))
    }
    await w.service.newContext(ALICE, { flush: true })
    // the start was written before the flush call
    expect(seenDuringFlush).toEqual([['chat.context.pending']])
    expect(w.activity.map((r) => r.type)).toEqual([
      'chat.context.pending',
      'chat.context.changed',
      'chat.context.pending',
    ])
    expect(pendingOf(w)).toEqual([
      { sessionId: aliceId(0), payload: { kind: 'new', state: 'start' } },
      { sessionId: aliceId(0), payload: { kind: 'new', state: 'end', ok: true } },
    ])
  })

  test('a flush that throws ends the reset as not ok, and refuses it', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    s.flushThrows = new Error('EH_STORAGE')
    expect(await reasonOf(w.service.newContext(ALICE, { flush: true }))).toBe('flush-failed')
    expect(pendingOf(w).map((p) => p.payload)).toEqual([
      { kind: 'new', state: 'start' },
      { kind: 'new', state: 'end', ok: false },
    ])
  })

  test('a refused reset writes no pending record at all', async () => {
    const w = world()
    w.sessionOf(aliceId()).busy = true
    expect(await reasonOf(w.service.newContext(ALICE, { flush: true }))).toBe('turn-running')
    expect(pendingOf(w)).toEqual([])
  })

  test('a compact: one start before the compaction, one end ok, on the current session', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    const seen: string[][] = []
    s.duringCompact = () => {
      seen.push(w.activity.map((r) => r.type))
    }
    await w.service.compact(ALICE, {})
    expect(seen).toEqual([['chat.context.pending']])
    expect(pendingOf(w)).toEqual([
      { sessionId: aliceId(0), payload: { kind: 'compact', state: 'start' } },
      { sessionId: aliceId(0), payload: { kind: 'compact', state: 'end', ok: true } },
    ])
  })

  test('a compact that throws ends as not ok', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    s.compactThrows = new Error('EH_STORAGE')
    await expect(w.service.compact(ALICE, {})).rejects.toThrow('EH_STORAGE')
    expect(pendingOf(w).map((p) => p.payload)).toEqual([
      { kind: 'compact', state: 'start' },
      { kind: 'compact', state: 'end', ok: false },
    ])
  })
})

describe('compact (ADR-0030 §4)', () => {
  test('a running turn refuses; the generation does not change', async () => {
    const w = world()
    w.sessionOf(aliceId()).busy = true
    expect(await reasonOf(w.service.compact(ALICE, {}))).toBe('turn-running')
    expect(w.audit).toHaveLength(0)
  })

  test('a failed flush refuses /compact as flush-failed: no marker, the generation stays, no audit row', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    s.flush = 'error'
    expect(await reasonOf(w.service.compact(ALICE, {}))).toBe('flush-failed')
    expect(hasMarker(s)).toBe(false)
    expect(w.generations.current('alice')).toBe(0)
    expect(w.audit).toHaveLength(0)
  })

  test('a flush skipped by the window refuses /compact as flush-failed, no marker', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    s.flush = 'skipped'
    expect(await reasonOf(w.service.compact(ALICE, {}))).toBe('flush-failed')
    expect(hasMarker(s)).toBe(false)
    expect(w.audit).toHaveLength(0)
  })

  test('a summarizer failure (not the flush) on /compact is not the flush refusal', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    s.compactThrows = Object.assign(new Error('empty summary'), {
      code: 'EH_COMPACTION_FAILED',
      details: { reason: 'empty' },
    })
    await expect(w.service.compact(ALICE, {})).rejects.toThrow('empty summary')
  })

  test('compacts the current generation with keepLast, keeps the generation, writes one audit row', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'hi', 1))
    const out = await w.service.compact(ALICE, { keepLast: 2 })
    expect(out).toEqual({ generation: 0, flushed: true })
    expect(s.compactCalls).toEqual([{ keepLast: 2 }])
    expect(w.generations.current('alice')).toBe(0)
    expect(w.audit).toEqual([
      expect.objectContaining({
        kind: 'chat.context.compact',
        actor: 'alice',
        detail: { subject: 'alice', generation: 0, flushed: true },
      }),
    ])
  })
})

describe('generations and history (ADR-0030 §6)', () => {
  test('generations lists the chain of the caller, oldest first, with counts', async () => {
    const w = world()
    w.sessionOf(aliceId()).messages.push(msg('user', 'old', 10))
    await w.service.newContext(ALICE, { flush: false })
    w.sessionOf(aliceId(1)).messages.push(msg('user', 'new', 20))
    const list = await w.service.generations(ALICE)
    expect(list).toEqual([
      { generation: 0, startedAt: 10, messages: 1, compactions: 0 },
      { generation: 1, startedAt: 20, messages: 1, compactions: 0 },
    ])
  })

  test('generations counts the /compact runs of each generation; automatic compactions are not counted', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(msg('user', 'one', 10))
    await w.service.compact(ALICE, {})
    await w.service.compact(ALICE, {})
    // an automatic compaction of eharness is not a /compact run
    s.messages.push(compactionMarker('auto'))
    await w.service.newContext(ALICE, { flush: false })
    w.sessionOf(aliceId(1)).messages.push(msg('user', 'two', 20))
    await w.service.compact(ALICE, {})
    const list = await w.service.generations(ALICE)
    expect(list.map((g) => g.compactions)).toEqual([2, 1])
    expect(list[0]?.messages).toBe(1)
  })

  test('history reads one old generation as its messages, as the person sees them', async () => {
    const w = world()
    const s = w.sessionOf(aliceId())
    s.messages.push(
      msg('user', 'first', 1),
      msg('assistant', 'answer', 2),
      {
        ...msg('user', 'hidden tail', 3, { augmented: 1 }),
        parts: [
          { type: 'text', text: 'shown' },
          { type: 'text', text: 'reminder for the model' },
        ],
      } as unknown as HarnessUIMessage,
      flushRecord(),
    )
    await w.service.newContext(ALICE, { flush: false })
    const lines = await w.service.history(ALICE, { generation: 0 })
    expect(lines).toEqual([
      { seq: 1, role: 'user', text: 'first', at: 1 },
      { seq: 2, role: 'assistant', text: 'answer', at: 2 },
      { seq: 3, role: 'user', text: 'shown', at: 3 },
    ])
  })

  test('an unknown generation is NOT_FOUND', async () => {
    const w = world()
    let code: string | undefined
    try {
      await w.service.history(ALICE, { generation: 5 })
    } catch (error) {
      code = (error as ChatContextError).code
    }
    expect(code).toBe('NOT_FOUND')
  })

  test('another person has their own chain: bob cannot see alice generation 0', async () => {
    const w = world()
    w.sessionOf(aliceId()).messages.push(msg('user', 'alice secret', 1))
    await w.service.newContext(ALICE, { flush: false })
    // bob has one generation (0), empty: alice's generation 1 does not exist for him
    let code: string | undefined
    try {
      await w.service.history(BOB, { generation: 1 })
    } catch (error) {
      code = (error as ChatContextError).code
    }
    expect(code).toBe('NOT_FOUND')
    expect(await w.service.history(BOB, { generation: 0 })).toEqual([])
  })

  test('the audit rows hold the subject, the generation and the flag only', async () => {
    const w = world()
    w.sessionOf(aliceId()).messages.push(msg('user', 'my planted words', 1))
    await w.service.newContext(ALICE, { flush: true })
    await w.service.compact(ALICE, {})
    for (const row of w.audit) {
      expect(Object.keys(row.detail ?? {}).sort()).toEqual(['flushed', 'generation', 'subject'])
      expect(JSON.stringify(row)).not.toContain('planted words')
    }
  })
})
