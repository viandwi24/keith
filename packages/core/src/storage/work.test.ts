import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Commitment, Delivery, Task, Urgency } from '../shared/types.ts'
import { seed, testId } from './fixtures.ts'
import { createTestDb, type TestDb } from './testing.ts'

let db: TestDb
beforeEach(async () => {
  db = createTestDb()
  await seed(db.repos, 2)
})
afterEach(() => db.close())

const p1 = testId('per', 1)
const p2 = testId('per', 2)
const t1 = testId('thr', 1)

function task(n: number, patch: Partial<Task> = {}): Task {
  return {
    id: testId('tsk', n),
    personId: p1,
    threadId: t1,
    agentId: 'research',
    goal: `goal ${n}`,
    status: 'queued',
    attempt: 0,
    visibility: 'subject',
    summary: null,
    detail: null,
    ui: null,
    createdAt: 100 + n,
    startedAt: null,
    finishedAt: null,
    ...patch,
  }
}

describe('tasks', () => {
  test('round-trips and patches a task', async () => {
    const t = task(1)
    await db.repos.tasks.create(t)
    expect(await db.repos.tasks.get(t.id)).toEqual(t)
    const ui = { type: 'markdown' as const, id: 'r', text: 'done' }
    await db.repos.tasks.update(t.id, { status: 'completed', summary: 'found 3', ui, finishedAt: 500 })
    expect(await db.repos.tasks.get(t.id)).toEqual({
      ...t,
      status: 'completed',
      summary: 'found 3',
      ui,
      finishedAt: 500,
    })
    await db.repos.tasks.update(t.id, { ui: null })
    expect((await db.repos.tasks.get(t.id))?.ui).toBeNull()
    await db.repos.tasks.update(t.id, {})
    expect(await db.repos.tasks.get(testId('tsk', 9))).toBeNull()
  })

  test('lists by status oldest first and counts active tasks per person', async () => {
    await db.repos.tasks.create(task(3, { status: 'running' }))
    await db.repos.tasks.create(task(1))
    await db.repos.tasks.create(task(2, { status: 'completed' }))
    await db.repos.tasks.create(task(4, { personId: p2, threadId: null }))
    expect((await db.repos.tasks.listByStatus(['queued', 'running'])).map((t) => t.id)).toEqual([
      testId('tsk', 1),
      testId('tsk', 3),
      testId('tsk', 4),
    ])
    expect(await db.repos.tasks.listByStatus([])).toEqual([])
    expect(await db.repos.tasks.countActiveFor(p1)).toBe(2)
    expect(await db.repos.tasks.countActiveFor(p2)).toBe(1)
  })
})

describe('commitments', () => {
  function commitment(n: number, patch: Partial<Commitment> = {}): Commitment {
    return {
      id: testId('cmt', n),
      threadId: t1,
      personId: p1,
      taskId: testId('tsk', 1),
      promise: `I will report back ${n}`,
      status: 'open',
      createdAt: 10 + n,
      resolvedAt: null,
      expiresAt: 1_000 + n,
      ...patch,
    }
  }

  beforeEach(async () => {
    await db.repos.tasks.create(task(1))
    await db.repos.tasks.create(task(2))
  })

  test('round-trips, finds open commitments and resolves them', async () => {
    const c = commitment(1)
    await db.repos.commitments.create(c)
    expect(await db.repos.commitments.get(c.id)).toEqual(c)
    expect(await db.repos.commitments.openForTask(testId('tsk', 1))).toEqual(c)
    expect(await db.repos.commitments.openForThread(t1)).toEqual([c])
    await db.repos.commitments.resolve(c.id, 'fulfilled', 77)
    expect(await db.repos.commitments.get(c.id)).toEqual({ ...c, status: 'fulfilled', resolvedAt: 77 })
    expect(await db.repos.commitments.openForTask(testId('tsk', 1))).toBeNull()
    expect(await db.repos.commitments.openForThread(t1)).toEqual([])
    // Resolving again does not overwrite the first resolution.
    await db.repos.commitments.resolve(c.id, 'expired', 88)
    expect((await db.repos.commitments.get(c.id))?.status).toBe('fulfilled')
  })

  test('lists open commitments whose expiry has passed', async () => {
    await db.repos.commitments.create(commitment(1, { expiresAt: 50 }))
    await db.repos.commitments.create(commitment(2, { expiresAt: 100, taskId: testId('tsk', 2) }))
    await db.repos.commitments.create(commitment(3, { expiresAt: 150 }))
    await db.repos.commitments.create(commitment(4, { expiresAt: 10, status: 'fulfilled', resolvedAt: 5 }))
    expect((await db.repos.commitments.listExpired(100)).map((c) => c.id)).toEqual([
      testId('cmt', 1),
      testId('cmt', 2),
    ])
  })
})

describe('deliveries', () => {
  function delivery(n: number, urgency: Urgency, createdAt: number, patch: Partial<Delivery> = {}): Delivery {
    return {
      id: testId('dlv', n),
      threadId: t1,
      personId: p1,
      kind: 'task_result',
      authorPersonId: null,
      source: 'core',
      urgency,
      content: `result ${n}`,
      ui: null,
      status: 'pending',
      createdAt,
      deliveredAt: null,
      ...patch,
    }
  }

  test('round-trips a delivery with a UI block', async () => {
    const d = delivery(1, 'normal', 10, {
      authorPersonId: p2,
      kind: 'relay',
      ui: { type: 'list', id: 'l', items: [{ title: 'Venue A' }] },
    })
    await db.repos.deliveries.create(d)
    expect(await db.repos.deliveries.get(d.id)).toEqual(d)
    expect(await db.repos.deliveries.get(testId('dlv', 9))).toBeNull()
  })

  test('orders pending deliveries by urgency, then age', async () => {
    await db.repos.deliveries.create(delivery(1, 'low', 1))
    await db.repos.deliveries.create(delivery(2, 'normal', 5))
    await db.repos.deliveries.create(delivery(3, 'critical', 9))
    await db.repos.deliveries.create(delivery(4, 'normal', 2))
    await db.repos.deliveries.create(delivery(5, 'high', 3))
    await db.repos.deliveries.create(delivery(6, 'critical', 1, { status: 'dismissed' }))
    expect((await db.repos.deliveries.pendingFor(t1)).map((d) => d.id)).toEqual(
      [3, 5, 4, 2, 1].map((n) => testId('dlv', n)),
    )
  })

  test('marks deliveries delivered', async () => {
    await db.repos.deliveries.create(delivery(1, 'normal', 1))
    await db.repos.deliveries.create(delivery(2, 'normal', 2))
    await db.repos.deliveries.markDelivered([testId('dlv', 1)], 99)
    await db.repos.deliveries.markDelivered([], 100)
    expect(await db.repos.deliveries.get(testId('dlv', 1))).toMatchObject({
      status: 'delivered',
      deliveredAt: 99,
    })
    expect((await db.repos.deliveries.pendingFor(t1)).map((d) => d.id)).toEqual([testId('dlv', 2)])
  })
})
