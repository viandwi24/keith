import { describe, expect, test } from 'bun:test'
import { type PersonStatus, parseBrainEvent } from '@keith/contracts'
import { uuidv7 } from 'eharness'
import { inMemoryActivityStore } from 'eharness/activity'
import { expireApprovals, expiredReason } from './expiry.ts'

const HOUR = 3_600_000
const NOW = 1_700_000_000_000

/** A message id whose UUIDv7 time is `ms` (the attention item's `createdAt`). */
const messageAt = (ms: number): string => {
  const hex = ms.toString(16).padStart(12, '0')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-${'0'.repeat(11)}1`
}

interface Waiting {
  approvalId: string
  toolCallId: string
  toolName: string
  input?: unknown
}

/**
 * A fake attention queue: sessions with parked approvals, and a `respond` that records the answer and
 * removes the approval from the pending state, the way eharness does.
 */
function queue(initial: Record<string, { messageId: string; waiting: Waiting[] }>) {
  const state = new Map<string, { messageId: string; approvals: unknown[] }>()
  for (const [sid, value] of Object.entries(initial)) {
    state.set(sid, {
      messageId: value.messageId,
      approvals: value.waiting.map((w) => ({ ...w, risk: 'write' })),
    })
  }
  const responds: Array<{ sessionId: string; approvals: unknown[]; options?: unknown }> = []
  const peek = (sessionId: string) => ({
    pending: async () => {
      const entry = state.get(sessionId)
      return entry === undefined || entry.approvals.length === 0
        ? null
        : { messageId: entry.messageId, approvals: entry.approvals, clientTools: [] }
    },
    children: async () => [],
    messages: async () => [],
  })
  const open = (sessionId: string) => ({
    respond(response: { approvals: Array<{ id: string }> }, options?: unknown) {
      responds.push({ sessionId, approvals: response.approvals, options })
      const entry = state.get(sessionId)
      if (entry !== undefined) {
        entry.approvals = entry.approvals.filter(
          (a) => !response.approvals.some((r) => r.id === (a as { approvalId: string }).approvalId),
        )
      }
      return { result: Promise.resolve({ stop: 'complete' }) }
    },
    resolveWait: async () => ({ status: 'recorded' }),
  })
  return { state, responds, peek, open }
}

const PEOPLE: { id: string; status: PersonStatus }[] = [
  { id: 'ana', status: 'active' },
  { id: 'owner', status: 'active' },
]

const approvalsWith = (hours: number) => ({
  ttlHours: () => hours,
  ttlMs: () => hours * HOUR,
})

function deps(q: ReturnType<typeof queue>, hours = 24) {
  const store = inMemoryActivityStore()
  const audits: Array<{
    kind: string
    actor: string
    via: string
    detail?: Record<string, unknown>
  }> = []
  const warnings: string[] = []
  return {
    store,
    audits,
    warnings,
    deps: {
      people: async () => PEOPLE,
      peek: q.peek as never,
      open: q.open as never,
      approvals: approvalsWith(hours),
      store,
      audit: {
        record: (event: {
          kind: string
          actor: string
          via: string
          detail?: Record<string, unknown>
        }) => audits.push(event),
      },
      now: () => NOW,
      warn: (message: string) => warnings.push(message),
      settleMs: 1,
      generations: { current: () => 0 },
    },
  }
}

const oldApproval = (approvalId: string, ageHours: number, toolName = 'motor_remote') => ({
  messageId: messageAt(NOW - ageHours * HOUR),
  waiting: [
    {
      approvalId,
      toolCallId: `call-${approvalId}`,
      toolName,
      input: { node: 'nas', capability: 'shell.exec', command: 'rm -rf build' },
    },
  ],
})

describe('expireApprovals', () => {
  test('an approval 25 h old is denied as expired; one 23 h old is untouched', async () => {
    const q = queue({
      'front:ana': oldApproval('a25', 25),
      'front:owner': oldApproval('a23', 23),
    })
    const { deps: d, audits, store } = deps(q)
    expect(await expireApprovals(d)).toBe(1)
    expect(q.responds).toHaveLength(1)
    expect(q.responds[0]).toMatchObject({
      sessionId: 'front:ana',
      approvals: [{ id: 'a25', approved: false, reason: expiredReason(24) }],
    })
    expect(audits).toEqual([
      {
        kind: 'approval.expired',
        actor: 'system',
        via: 'local',
        detail: {
          sessionId: 'front:ana',
          approvalId: 'a25',
          ageHours: 25,
          capability: 'shell.exec',
        },
      },
    ])
    expect(JSON.stringify(audits)).not.toContain('rm -rf')
    const events = await store.read({ after: 0, limit: 10 })
    const expired = events.find((e) => e.type === 'brain.amygdala.expired')
    expect(parseBrainEvent(expired as never)).toMatchObject({
      type: 'brain.amygdala.expired',
      payload: { sessionId: 'front:ana', approvalId: 'a25' },
    })
  })

  test('a denied item cannot be answered later: it is gone from the queue, and a second sweep does nothing', async () => {
    const q = queue({ 'front:ana': oldApproval('a30', 30) })
    const { deps: d } = deps(q)
    expect(await expireApprovals(d)).toBe(1)
    expect(await expireApprovals(d)).toBe(0)
    expect(q.responds).toHaveLength(1)
    expect(q.state.get('front:ana')?.approvals).toEqual([])
  })

  test('the lifetime is read at each sweep: lowering it to 1 h denies a 2 h old approval', async () => {
    const q = queue({ 'front:ana': oldApproval('a2', 2) })
    const first = deps(q, 24)
    expect(await expireApprovals(first.deps)).toBe(0)
    const second = deps(q, 1)
    expect(await expireApprovals(second.deps)).toBe(1)
    expect(second.audits[0]?.detail).toMatchObject({ approvalId: 'a2' })
  })

  test('an approval without a readable age (no UUIDv7 message id) is left alone', async () => {
    const q = queue({
      'front:ana': { messageId: 'not-a-uuid', waiting: oldApproval('a9', 0).waiting },
    })
    const { deps: d } = deps(q)
    expect(await expireApprovals(d)).toBe(0)
    expect(q.responds).toEqual([])
  })

  test('a failing answer is warned about and the rest of the queue is still swept', async () => {
    const q = queue({
      'front:ana': oldApproval('bad', 40),
      'front:owner': oldApproval('good', 40),
    })
    const original = q.open
    q.open = ((sessionId: string) => {
      if (sessionId === 'front:ana') throw new Error('session gone')
      return original(sessionId)
    }) as typeof q.open
    const { deps: d, warnings } = deps(q)
    expect(await expireApprovals(d)).toBe(1)
    expect(warnings.some((w) => w.includes('bad') && w.includes('session gone'))).toBe(true)
    expect(q.responds.map((r) => r.sessionId)).toEqual(['front:owner'])
  })

  test('the roots are the people `recover` counts: a suspended person still expires', async () => {
    const q = queue({ 'front:ana': oldApproval('a1', 30), 'front:ben': oldApproval('a2', 30) })
    const d = deps(q)
    d.deps.people = async () => [
      { id: 'ana', status: 'active' },
      { id: 'ben', status: 'suspended' },
    ]
    expect(await expireApprovals(d.deps)).toBe(2)
    expect(q.responds.map((r) => r.sessionId).sort()).toEqual(['front:ana', 'front:ben'])
  })

  test('the id helper is a real UUIDv7 (the sweep reads the age from it)', () => {
    expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)
  })
})
