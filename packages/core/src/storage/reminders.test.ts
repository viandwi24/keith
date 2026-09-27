import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Reminder } from '../shared/types.ts'
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

function reminder(n: number, dueAt: number, patch: Partial<Reminder> = {}): Reminder {
  return {
    id: testId('rem', n),
    personId: p1,
    threadId: null,
    text: `reminder ${n}`,
    dueAt,
    status: 'pending',
    createdAt: 100,
    firedAt: null,
    cancelledAt: null,
    deliveryId: null,
    ...patch,
  }
}

async function createDelivery(n: number): Promise<void> {
  await db.repos.deliveries.create({
    id: testId('dlv', n),
    threadId: testId('thr', 1),
    personId: p1,
    kind: 'reminder',
    authorPersonId: null,
    source: 'core',
    urgency: 'normal',
    content: 'x',
    ui: null,
    status: 'pending',
    createdAt: 1,
    deliveredAt: null,
  })
}

/** Runs a statement on the raw file with foreign keys on (as the core does). */
function rawRun(statement: string, params: string[]): void {
  const raw = new Database(db.path)
  try {
    raw.run('PRAGMA foreign_keys = ON')
    raw.run(statement, params)
  } finally {
    raw.close()
  }
}

describe('reminders', () => {
  test('round-trips a reminder; an unknown id is null', async () => {
    const r = reminder(1, 5_000, { threadId: testId('thr', 1) })
    await db.repos.reminders.create(r)
    expect(await db.repos.reminders.get(r.id)).toEqual(r)
    expect(await db.repos.reminders.get(testId('rem', 99))).toBeNull()
  })

  test('listDue orders soonest first and excludes fired, cancelled and future reminders', async () => {
    await createDelivery(1)
    await db.repos.reminders.create(reminder(1, 3_000))
    await db.repos.reminders.create(reminder(2, 1_000, { personId: p2 }))
    await db.repos.reminders.create(reminder(3, 3_000))
    await db.repos.reminders.create(reminder(4, 9_000)) // future
    await db.repos.reminders.create(reminder(5, 500))
    await db.repos.reminders.create(reminder(6, 500))
    await db.repos.reminders.create(reminder(7, 2_000)) // due exactly at now
    await db.repos.reminders.markFired(testId('rem', 5), 600, testId('dlv', 1))
    await db.repos.reminders.cancel(testId('rem', 6), 600)
    const now = 3_000
    expect((await db.repos.reminders.listDue(now)).map((r) => r.id)).toEqual(
      [2, 7, 1, 3].map((n) => testId('rem', n)),
    )
    expect((await db.repos.reminders.listDue(now, 2)).map((r) => r.id)).toEqual(
      [2, 7].map((n) => testId('rem', n)),
    )
    expect(await db.repos.reminders.listDue(now, 0)).toEqual([])
  })

  test('listPending and countPending cover only the person’s pending reminders, soonest first', async () => {
    await db.repos.reminders.create(reminder(1, 9_000))
    await db.repos.reminders.create(reminder(2, 1_000))
    await db.repos.reminders.create(reminder(3, 5_000))
    await db.repos.reminders.create(reminder(4, 2_000, { personId: p2 }))
    await db.repos.reminders.cancel(testId('rem', 3), 10)
    expect((await db.repos.reminders.listPending(p1)).map((r) => r.id)).toEqual(
      [2, 1].map((n) => testId('rem', n)),
    )
    expect(await db.repos.reminders.countPending(p1)).toBe(2)
    expect(await db.repos.reminders.countPending(p2)).toBe(1)
    expect(await db.repos.reminders.countPending(testId('per', 99))).toBe(0)
  })

  test('markFired changes a pending reminder once; a second call returns false and changes nothing', async () => {
    await createDelivery(1)
    await createDelivery(2)
    const r = reminder(1, 1_000)
    await db.repos.reminders.create(r)
    expect(await db.repos.reminders.markFired(r.id, 1_500, testId('dlv', 1))).toBe(true)
    const fired: Reminder = { ...r, status: 'fired', firedAt: 1_500, deliveryId: testId('dlv', 1) }
    expect(await db.repos.reminders.get(r.id)).toEqual(fired)
    expect(await db.repos.reminders.markFired(r.id, 2_000, testId('dlv', 2))).toBe(false)
    expect(await db.repos.reminders.cancel(r.id, 2_000)).toBe(false)
    expect(await db.repos.reminders.get(r.id)).toEqual(fired)
    expect(await db.repos.reminders.markFired(testId('rem', 99), 1, testId('dlv', 1))).toBe(false)
  })

  test('cancel changes a pending reminder once; a second call returns false and changes nothing', async () => {
    await createDelivery(1)
    const r = reminder(1, 1_000)
    await db.repos.reminders.create(r)
    expect(await db.repos.reminders.cancel(r.id, 700)).toBe(true)
    const cancelled: Reminder = { ...r, status: 'cancelled', cancelledAt: 700 }
    expect(await db.repos.reminders.get(r.id)).toEqual(cancelled)
    expect(await db.repos.reminders.cancel(r.id, 800)).toBe(false)
    expect(await db.repos.reminders.markFired(r.id, 800, testId('dlv', 1))).toBe(false)
    expect(await db.repos.reminders.get(r.id)).toEqual(cancelled)
    expect(await db.repos.reminders.cancel(testId('rem', 99), 1)).toBe(false)
  })

  test('deleting a person cascades to their reminders', async () => {
    await db.repos.reminders.create(reminder(1, 1_000, { personId: p2 }))
    await db.repos.reminders.create(reminder(2, 1_000))
    // Person 2's main thread references them without cascade; remove it first.
    rawRun('delete from threads where id = ?', [testId('thr', 2)])
    rawRun('delete from persons where id = ?', [p2])
    expect(await db.repos.reminders.get(testId('rem', 1))).toBeNull()
    expect(await db.repos.reminders.get(testId('rem', 2))).not.toBeNull()
  })

  test('deleting a thread cascades to reminders delivered there', async () => {
    await db.repos.reminders.create(reminder(1, 1_000, { threadId: testId('thr', 1) }))
    await db.repos.reminders.create(reminder(2, 1_000))
    rawRun('delete from threads where id = ?', [testId('thr', 1)])
    expect(await db.repos.reminders.get(testId('rem', 1))).toBeNull()
    expect(await db.repos.reminders.get(testId('rem', 2))).not.toBeNull()
  })

  test('deleting the delivery sets delivery_id to null', async () => {
    await createDelivery(1)
    const r = reminder(1, 1_000)
    await db.repos.reminders.create(r)
    await db.repos.reminders.markFired(r.id, 1_500, testId('dlv', 1))
    rawRun('delete from deliveries where id = ?', [testId('dlv', 1)])
    expect(await db.repos.reminders.get(r.id)).toEqual({
      ...r,
      status: 'fired',
      firedAt: 1_500,
      deliveryId: null,
    })
  })
})
