import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { Memory, MemoryId } from '../shared/types.ts'
import { seed, testId, thread } from './fixtures.ts'
import { toFtsQuery } from './memories.ts'
import { createTestDb, type TestDb } from './testing.ts'
import type { MemoryFilter } from './types.ts'

let db: TestDb
beforeEach(async () => {
  db = createTestDb()
  await seed(db.repos, 2)
  await db.repos.threads.create(thread(3, null, { kind: 'group', slug: null }), [p1, p2])
})
afterEach(() => db.close())

const p1 = testId('per', 1)
const p2 = testId('per', 2)
const t1 = testId('thr', 1)
const t3 = testId('thr', 3)

function memory(n: number, patch: Partial<Memory> = {}): Memory {
  return {
    id: testId('mem', n),
    content: `fact ${n}`,
    subjectPersonId: null,
    visibility: 'household',
    threadId: null,
    source: 'stated',
    authorPersonId: null,
    pinned: false,
    createdAt: 100 + n,
    updatedAt: 100 + n,
    lastRecalledAt: null,
    ...patch,
  }
}

const nothing: MemoryFilter = {
  allowHousehold: false,
  allowOwner: false,
  subjectPersonId: null,
  threadIds: [],
}
const ids = (ms: Memory[]) => ms.map((m) => m.id)
const mem = (n: number): MemoryId => testId('mem', n)

describe('memories', () => {
  test('round-trips, patches and deletes a memory', async () => {
    const m = memory(1, { subjectPersonId: p1, visibility: 'subject', authorPersonId: p1, pinned: true })
    await db.repos.memories.create(m)
    expect(await db.repos.memories.get(m.id)).toEqual(m)
    await db.repos.memories.update(m.id, { content: 'new fact', visibility: 'household', updatedAt: 500 })
    expect(await db.repos.memories.get(m.id)).toEqual({
      ...m,
      content: 'new fact',
      visibility: 'household',
      updatedAt: 500,
    })
    await db.repos.memories.touchRecalled([m.id], 900)
    expect((await db.repos.memories.get(m.id))?.lastRecalledAt).toBe(900)
    await db.repos.memories.delete(m.id)
    expect(await db.repos.memories.get(m.id)).toBeNull()
  })

  test('search finds by keyword, with stemming, and ignores FTS syntax in the text', async () => {
    await db.repos.memories.create(memory(1, { content: 'Tony prefers venues near the river' }))
    await db.repos.memories.create(memory(2, { content: 'The car needs new tyres' }))
    const all = { ...nothing, allowHousehold: true }
    expect(ids(await db.repos.memories.search('river', all))).toEqual([mem(1)])
    expect(ids(await db.repos.memories.search('Which VENUE does Tony prefer?', all))).toEqual([mem(1)])
    expect(ids(await db.repos.memories.search('tyres" AND car* NOT(', all))).toEqual([mem(2)])
    expect(await db.repos.memories.search('  ?!  ', all)).toEqual([])
    expect(await db.repos.memories.search('piano', all)).toEqual([])
  })

  test('search keeps the index in sync with updates and deletes', async () => {
    const all = { ...nothing, allowHousehold: true }
    await db.repos.memories.create(memory(1, { content: 'likes jazz' }))
    await db.repos.memories.update(mem(1), { content: 'likes opera' })
    expect(await db.repos.memories.search('jazz', all)).toEqual([])
    expect(ids(await db.repos.memories.search('opera', all))).toEqual([mem(1)])
    await db.repos.memories.delete(mem(1))
    expect(await db.repos.memories.search('opera', all)).toEqual([])
  })

  test('search ranks by BM25, then recency, and honors the limit', async () => {
    const all = { ...nothing, allowHousehold: true }
    await db.repos.memories.create(memory(1, { content: 'river walk on sunday', updatedAt: 300 }))
    await db.repos.memories.create(memory(2, { content: 'river river river cruise', updatedAt: 100 }))
    await db.repos.memories.create(memory(3, { content: 'river walk on sunday', updatedAt: 200 }))
    await db.repos.memories.create(memory(4, { content: 'mountain hike' }))
    expect(ids(await db.repos.memories.search('river', all))).toEqual([mem(2), mem(1), mem(3)])
    expect(ids(await db.repos.memories.search('river', all, { limit: 1 }))).toEqual([mem(2)])
  })

  test('search returns at most 8 memories by default', async () => {
    for (let n = 1; n <= 10; n++) await db.repos.memories.create(memory(n, { content: 'river' }))
    expect(await db.repos.memories.search('river', { ...nothing, allowHousehold: true })).toHaveLength(8)
  })

  test('list returns admitted memories newest first, filtered by pinned, with a limit', async () => {
    await db.repos.memories.create(memory(1, { pinned: true }))
    await db.repos.memories.create(memory(2))
    await db.repos.memories.create(memory(3, { pinned: true }))
    const all = { ...nothing, allowHousehold: true }
    expect(ids(await db.repos.memories.list(all))).toEqual([mem(3), mem(2), mem(1)])
    expect(ids(await db.repos.memories.list(all, { pinned: true }))).toEqual([mem(3), mem(1)])
    expect(ids(await db.repos.memories.list(all, { pinned: false }))).toEqual([mem(2)])
    expect(ids(await db.repos.memories.list(all, { limit: 2 }))).toEqual([mem(3), mem(2)])
  })

  describe('MemoryFilter SQL (storage.md#memory-search-filter)', () => {
    beforeEach(async () => {
      const content = 'shared keyword river'
      await db.repos.memories.create(memory(1, { content, visibility: 'household' }))
      await db.repos.memories.create(memory(2, { content, visibility: 'owner' }))
      await db.repos.memories.create(memory(3, { content, visibility: 'subject', subjectPersonId: p1 }))
      await db.repos.memories.create(memory(4, { content, visibility: 'subject', subjectPersonId: p2 }))
      await db.repos.memories.create(memory(5, { content, visibility: 'thread', threadId: t1 }))
      await db.repos.memories.create(memory(6, { content, visibility: 'thread', threadId: t3 }))
      // A household memory about p2 is admitted by allowHousehold, whatever its subject.
      await db.repos.memories.create(memory(7, { content, visibility: 'household', subjectPersonId: p2 }))
    })

    const cases: { name: string; filter: MemoryFilter; expected: number[] }[] = [
      { name: 'admits nothing when every field is off', filter: nothing, expected: [] },
      {
        name: 'allowHousehold admits household only',
        filter: { ...nothing, allowHousehold: true },
        expected: [1, 7],
      },
      { name: 'allowOwner admits owner only', filter: { ...nothing, allowOwner: true }, expected: [2] },
      {
        name: 'I-4: subjectPersonId admits only that subject’s subject memories',
        filter: { ...nothing, subjectPersonId: p1 },
        expected: [3],
      },
      {
        name: 'threadIds admits memories of those threads',
        filter: { ...nothing, threadIds: [t1] },
        expected: [5],
      },
      {
        name: 'threadIds with several threads',
        filter: { ...nothing, threadIds: [t1, t3] },
        expected: [5, 6],
      },
      {
        name: 'fields combine with OR',
        filter: { allowHousehold: true, allowOwner: true, subjectPersonId: p1, threadIds: [t1] },
        expected: [1, 2, 3, 5, 7],
      },
      {
        name: 'I-4: group viewer (no subject, shared thread only) sees no subject memories',
        filter: { allowHousehold: true, allowOwner: false, subjectPersonId: null, threadIds: [t3] },
        expected: [1, 6, 7],
      },
    ]

    for (const { name, filter, expected } of cases) {
      test(`search: ${name}`, async () => {
        const found = ids(await db.repos.memories.search('river', filter, { limit: 50 }))
        expect(found.sort()).toEqual(expected.map(mem))
      })
      test(`list: ${name}`, async () => {
        const found = ids(await db.repos.memories.list(filter))
        expect(found.sort()).toEqual(expected.map(mem))
      })
    }
  })
})

describe('toFtsQuery', () => {
  test('quotes each distinct word and joins with OR', () => {
    expect(toFtsQuery('River "walk" river-walk*')).toBe('"river" OR "walk"')
    expect(toFtsQuery('café 42')).toBe('"café" OR "42"')
    expect(toFtsQuery(' .,; ')).toBeNull()
  })
})
