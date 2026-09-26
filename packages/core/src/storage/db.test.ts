import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb } from './db.ts'
import { person, testId, thread } from './fixtures.ts'
import { createTestDb } from './testing.ts'

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
  test('applies every migration to a fresh file and creates all phase-1 tables', () => {
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
      'memories_fts_insert',
      'memories_fts_update',
      'memories_fts_delete',
    ]) {
      expect(names).toContain(table)
    }
    expect(migrationCount(path)).toBe(2)
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
