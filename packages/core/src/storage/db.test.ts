import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import type { DeliveryId, MessageId, PersonId, ThreadId } from '../shared/types.ts'
import { MIGRATIONS_FOLDER, openDb } from './db.ts'
import { person, testId, thread } from './fixtures.ts'
import { createTestDb } from './testing.ts'
import type { ThreadRecord } from './types.ts'

let dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'keith-db-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  dirs = []
})

function migrationCount(path: string): number {
  const raw = new Database(path, { readonly: true })
  try {
    const row = raw.query('select count(*) as n from __drizzle_migrations').get() as { n: number }
    return row.n
  } finally {
    raw.close()
  }
}

describe('openDb', () => {
  test('applies every migration to a fresh file and creates every table', () => {
    const path = join(tempDir(), 'keith.db')
    openDb(path).close()
    const raw = new Database(path, { readonly: true })
    const names = (
      raw.query("select name from sqlite_master where type in ('table', 'trigger')").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    raw.close()
    for (const table of [
      'persons',
      'relationships',
      'auth_tokens',
      'nodes',
      'threads',
      'thread_participants',
      'messages',
      'tasks',
      'commitments',
      'deliveries',
      'memories',
      'memories_fts',
      'plugin_data',
      'files',
      'reminders',
      'invite_links',
      'thread_invitations',
      'memories_fts_insert',
      'memories_fts_update',
      'memories_fts_delete',
    ]) {
      expect(names).toContain(table)
    }
    expect(migrationCount(path)).toBe(
      readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true }).filter((e) => e.isDirectory()).length,
    )
  })

  test('P3-H3 migration numbers existing messages gap-free in their old (created_at, id) order', async () => {
    // A database migrated only up to the last migration before `seq` existed.
    const dir = tempDir()
    const oldMigrations = join(dir, 'migrations')
    const beforeSeq = readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name < '20260927045244')
      .map((e) => e.name)
    expect(beforeSeq).toHaveLength(3)
    for (const name of beforeSeq)
      cpSync(join(MIGRATIONS_FOLDER, name), join(oldMigrations, name), { recursive: true })
    const path = join(dir, 'keith.db')
    const raw = new Database(path, { create: true, strict: true })
    migrate(drizzle({ client: raw }), { migrationsFolder: oldMigrations })
    raw.run("insert into persons (id, name, tier, created_at) values ('per_1', 'P', 'owner', 1)")
    for (const t of ['thr_a', 'thr_b']) {
      raw.run(
        `insert into threads (id, kind, slug, title, owner_person_id, created_at, updated_at)
         values ('${t}', 'direct', '${t}', 'T', 'per_1', 1, 1)`,
      )
    }
    // [id, thread, created_at], inserted out of order; old order is (created_at, id).
    const rows: [string, string, number][] = [
      ['msg_c', 'thr_a', 30],
      ['msg_a', 'thr_a', 10],
      ['msg_z', 'thr_b', 5],
      ['msg_e', 'thr_a', 20],
      ['msg_d', 'thr_a', 20],
      ['msg_y', 'thr_b', 7],
    ]
    for (const [id, threadId, createdAt] of rows) {
      raw.run(
        "insert into messages (id, thread_id, role, modality, content, created_at) values (?, ?, 'user', 'text', 'x', ?)",
        [id, threadId, createdAt],
      )
    }
    raw.run(
      `insert into deliveries (id, thread_id, person_id, kind, source, urgency, content, status, created_at)
       values ('dlv_1', 'thr_a', 'per_1', 'plugin', 'core', 'normal', 'x', 'delivered', 1)`,
    )
    raw.close()

    const db = openDb(path)
    const page = async (threadId: string) =>
      (await db.repos.messages.page({ threadId: threadId as ThreadId, limit: 10 })).messages.map((m) => [
        m.id,
        m.seq,
      ])
    expect(await page('thr_a')).toEqual([
      ['msg_a', 1],
      ['msg_d', 2],
      ['msg_e', 3],
      ['msg_c', 4],
    ])
    expect(await page('thr_b')).toEqual([
      ['msg_z', 1],
      ['msg_y', 2],
    ])
    // Old deliveries have no message; new appends continue after the backfilled seq.
    expect((await db.repos.deliveries.get('dlv_1' as DeliveryId))?.messageId).toBeNull()
    await db.repos.messages.append({
      id: 'msg_f' as MessageId,
      threadId: 'thr_a' as ThreadId,
      role: 'user',
      authorPersonId: null,
      nodeId: null,
      modality: 'text',
      content: 'new',
      meta: null,
      createdAt: 1,
    })
    expect((await db.repos.messages.get('msg_f' as MessageId))?.seq).toBe(5)
    db.close()
  })

  test('P4-S1: a phase-3 database migrates to the phase-4 schema; existing threads have null cursors', async () => {
    // A database migrated with every migration up to the end of phase 3.
    const dir = tempDir()
    const oldMigrations = join(dir, 'migrations')
    const phase3 = readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name <= '20260927045314_delivery-message-id')
      .map((e) => e.name)
    expect(phase3).toHaveLength(7)
    for (const name of phase3)
      cpSync(join(MIGRATIONS_FOLDER, name), join(oldMigrations, name), { recursive: true })
    const path = join(dir, 'keith.db')
    const raw = new Database(path, { create: true, strict: true })
    migrate(drizzle({ client: raw }), { migrationsFolder: oldMigrations })
    raw.run("insert into persons (id, name, tier, created_at) values ('per_1', 'P', 'owner', 1)")
    raw.run(
      `insert into threads (id, kind, slug, title, owner_person_id, summary, created_at, updated_at)
       values ('thr_a', 'direct', 'main', 'T', 'per_1', 'old summary', 1, 2)`,
    )
    raw.run("insert into thread_participants (thread_id, person_id, joined_at) values ('thr_a', 'per_1', 1)")
    raw.run(
      "insert into messages (id, thread_id, role, modality, content, seq, created_at) values ('msg_a', 'thr_a', 'user', 'text', 'x', 1, 1)",
    )
    raw.close()

    const db = openDb(path)
    const threadId = 'thr_a' as ThreadId
    const expected: ThreadRecord = {
      id: threadId,
      kind: 'direct',
      slug: 'main',
      title: 'T',
      ownerPersonId: 'per_1' as PersonId,
      summary: 'old summary',
      createdAt: 1,
      updatedAt: 2,
      summaryThroughSeq: null,
      reflectedThroughSeq: null,
      purpose: null,
    }
    expect(await db.repos.threads.get(threadId)).toEqual(expected)
    // The null reflection cursor counts as 0, so the old thread is due.
    expect(await db.repos.threads.listForReflection({ idleBefore: 10, limit: 5 })).toEqual([
      { thread: expected, lastSeq: 1 },
    ])
    expect(await db.repos.reminders.countPending('per_1' as PersonId)).toBe(0)
    db.close()
    expect(migrationCount(path)).toBe(
      readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true }).filter((e) => e.isDirectory()).length,
    )
  })

  test('P5-S1: a phase-4 database migrates to the phase-5 schema; existing threads have null purpose', async () => {
    const dir = tempDir()
    const oldMigrations = join(dir, 'migrations')
    const phase4 = readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name <= '20260927130302_reminders-thread-cursors')
      .map((e) => e.name)
    expect(phase4).toHaveLength(8)
    for (const name of phase4)
      cpSync(join(MIGRATIONS_FOLDER, name), join(oldMigrations, name), { recursive: true })
    const path = join(dir, 'keith.db')
    const raw = new Database(path, { create: true, strict: true })
    migrate(drizzle({ client: raw }), { migrationsFolder: oldMigrations })
    raw.run("insert into persons (id, name, tier, created_at) values ('per_1', 'Tony', 'owner', 1)")
    raw.run(
      `insert into threads (id, kind, slug, title, owner_person_id, created_at, updated_at)
       values ('thr_a', 'direct', 'main', 'T', 'per_1', 1, 2)`,
    )
    raw.run("insert into thread_participants (thread_id, person_id, joined_at) values ('thr_a', 'per_1', 1)")
    raw.close()

    const db = openDb(path)
    const threadId = 'thr_a' as ThreadId
    const personId = 'per_1' as PersonId
    expect((await db.repos.threads.get(threadId))?.purpose).toBeNull()
    expect((await db.repos.threads.listForPerson(personId)).map((t) => t.purpose)).toEqual([null])
    expect((await db.repos.persons.findByName(' tony '))?.id).toBe(personId)
    expect(await db.repos.threadInvitations.pendingForPerson(personId)).toEqual([])
    expect(await db.repos.inviteLinks.revokeFor(personId)).toBe(0)
    db.close()
    expect(migrationCount(path)).toBe(
      readdirSync(MIGRATIONS_FOLDER, { withFileTypes: true }).filter((e) => e.isDirectory()).length,
    )
  })

  test('deleting a message clears deliveries.message_id (on delete set null)', async () => {
    const path = join(tempDir(), 'keith.db')
    const db = openDb(path)
    const p = person(1)
    await db.repos.persons.create(p)
    await db.repos.threads.create(thread(1, p.id), [p.id])
    const threadId = testId('thr', 1)
    await db.repos.messages.append({
      id: testId('msg', 1),
      threadId,
      role: 'assistant',
      authorPersonId: null,
      nodeId: null,
      modality: 'text',
      content: 'done',
      meta: null,
      toolCalls: null,
      ui: null,
      createdAt: 1,
    })
    const deliveryId = testId('dlv', 1)
    await db.repos.deliveries.create({
      id: deliveryId,
      threadId,
      personId: p.id,
      kind: 'plugin',
      authorPersonId: null,
      source: 'core',
      urgency: 'normal',
      content: 'x',
      ui: null,
      status: 'pending',
      createdAt: 1,
      deliveredAt: null,
    })
    await db.repos.deliveries.markDelivered([deliveryId], 2, testId('msg', 1))
    db.close()
    const raw = new Database(path)
    raw.run('PRAGMA foreign_keys = ON')
    raw.run('delete from messages where id = ?', [testId('msg', 1)])
    raw.close()
    const reopened = openDb(path)
    expect(await reopened.repos.deliveries.get(deliveryId)).toMatchObject({
      status: 'delivered',
      messageId: null,
    })
    reopened.close()
  })

  test('opening an already migrated file applies nothing', () => {
    const path = join(tempDir(), 'keith.db')
    openDb(path).close()
    const before = migrationCount(path)
    openDb(path).close()
    expect(migrationCount(path)).toBe(before)
  })

  test('switches the file to WAL mode', () => {
    const path = join(tempDir(), 'keith.db')
    const db = openDb(path)
    db.close()
    const raw = new Database(path)
    expect((raw.query('pragma journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal')
    raw.close()
  })

  test('enforces foreign keys', async () => {
    using db = createTestDb()
    await expect(db.repos.threads.create(thread(1, testId('per', 99)), [])).rejects.toThrow()
  })

  test('S-3: data survives closing and reopening the file', async () => {
    const path = join(tempDir(), 'keith.db')
    const first = openDb(path)
    const p = person(1)
    await first.repos.persons.create(p)
    await first.repos.threads.create(thread(1, p.id), [p.id])
    await first.repos.messages.append({
      id: testId('msg', 1),
      threadId: testId('thr', 1),
      role: 'user',
      authorPersonId: p.id,
      nodeId: null,
      modality: 'text',
      content: 'remember the river venue',
      meta: null,
      createdAt: 5_000,
    })
    first.close()

    const second = openDb(path)
    expect(await second.repos.persons.get(p.id)).toEqual(p)
    const page = await second.repos.messages.page({ threadId: testId('thr', 1), limit: 10 })
    expect(page.messages.map((m) => m.content)).toEqual(['remember the river venue'])
    second.close()
  })
})

describe('createTestDb', () => {
  test('removes its temp folder on close', async () => {
    const db = createTestDb()
    await db.repos.persons.create(person(1))
    expect(await Bun.file(db.path).exists()).toBe(true)
    db.close()
    expect(await Bun.file(db.path).exists()).toBe(false)
  })
})
