/**
 * P26.1.4: an upgrade drill on a seeded database. A database at the previous schema (every core migration but
 * the last, every plugin journal applied) gets people, notes, reminders, a running worker and a pending approval;
 * then `migrateWithBackup` runs and the counts, the snapshot and boot recovery are checked. Temp dirs only.
 */
import type { Database } from 'bun:sqlite'
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MIGRATIONS_DIR,
  openDatabase,
  reviewsRepo,
  sqliteActivityStore,
  tasksRepo,
} from '@keith/db'
import { cleanMigrationDirs, migrateFolder, migrationsBefore } from '@keith/db/testing'
import { migratePluginStorage } from '@keith/host/storage'
import { BUILTIN_PLUGINS } from '../modules/plugins/index.ts'
import { applyReconcile } from '../modules/tasks/index.ts'
import { dbState, migrateWithBackup, openReadOnlyDatabase } from './db.ts'
import { silentLogger } from './logger.ts'

const roots: string[] = []
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  cleanMigrationDirs()
})

const NOW = Date.parse('2026-11-01T10:00:00Z')
const DAY = 86_400_000

/** The shipped journal: its tags in order (the last one is the migration the drill upgrades to). */
const journal = JSON.parse(readFileSync(join(MIGRATIONS_DIR, 'meta/_journal.json'), 'utf8')) as {
  entries: { tag: string }[]
}
const SHIPPED = journal.entries.length
const LATEST = journal.entries[SHIPPED - 1]?.tag ?? ''

/** The tables the seed fills; their row counts must not change across the upgrade. */
const SEEDED = [
  'people',
  'plg_notes_items',
  'plg_reminders_items',
  'tasks',
  'owner_reviews',
] as const

function counts(db: Database): Record<string, number> {
  return Object.fromEntries(
    SEEDED.map((table) => [
      table,
      db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? 0,
    ]),
  )
}

function appliedCore(db: Database): number {
  return db.query<{ n: number }, []>('SELECT count(*) AS n FROM __drizzle_migrations').get()?.n ?? 0
}

/** The previous build's database: every core migration but the last, every plugin journal, then the rows. */
function previousSchemaDatabase(dbFile: string): void {
  const db = openDatabase(dbFile)
  try {
    migrateFolder(db, migrationsBefore(LATEST))
    migratePluginStorage(db, BUILTIN_PLUGINS)
    expect(appliedCore(db)).toBe(SHIPPED - 1)
    db.exec(`
      INSERT INTO people (id, name, role, created_at, status, updated_at) VALUES
        ('owner', 'Ana', 'owner', ${NOW}, 'active', ${NOW}),
        ('member-1', 'Budi', 'member', ${NOW}, 'active', ${NOW});
      INSERT INTO plg_notes_items (id, author_id, title, body, created_at, updated_at) VALUES
        ('note-1', 'owner', 'Groceries', 'milk, eggs', ${NOW}, ${NOW}),
        ('note-2', 'member-1', 'Plan', 'draft of the trip', ${NOW}, ${NOW});
      INSERT INTO plg_reminders_items
        (id, creator_id, recipient_id, text, when_kind, when_at, status, fire_count, created_at, updated_at)
      VALUES
        ('rem-1', 'owner', 'owner', 'call the dentist', 'once', ${NOW + 3_600_000}, 'active', 0, ${NOW}, ${NOW});
      INSERT INTO tasks (id, parent_session_id, agent, description, status, steps, created_at, updated_at) VALUES
        ('child-1', 'front:owner', 'cortex.research', 'find the invoice', 'running', 2, ${NOW}, ${NOW});
      INSERT INTO owner_reviews (id, requester, plugin, operation, payload, status, created_at, expires_at) VALUES
        ('rev-1', 'member-1', 'notes', 'delete', '{"id":"note-2"}', 'pending', ${NOW}, ${NOW + DAY});
    `)
  } finally {
    db.close()
  }
}

function tempDataDir(): { dataDir: string; dbFile: string } {
  const root = mkdtempSync(join(tmpdir(), 'keith-upgrade-drill-'))
  roots.push(root)
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { mode: 0o700 })
  return { dataDir, dbFile: join(dataDir, 'keith.db') }
}

test('an upgrade from the previous schema keeps every row, snapshots the old content and recovers the worker', () => {
  const config = tempDataDir()
  previousSchemaDatabase(config.dbFile)

  const before = (() => {
    const db = openReadOnlyDatabase(config.dbFile)
    try {
      return counts(db)
    } finally {
      db.close()
    }
  })()
  expect(before.people).toBe(2)
  expect(before.tasks).toBe(1)

  const outcome = migrateWithBackup(config, BUILTIN_PLUGINS, silentLogger, 'local')
  expect(outcome.kind).toBe('migrated')
  if (outcome.kind !== 'migrated') return
  expect(outcome.tags).toEqual([LATEST])
  expect(dbState(config.dbFile, BUILTIN_PLUGINS)).toEqual({ kind: 'ready' })

  // the snapshot is the database as it was before the upgrade: same rows, previous schema, owner-only
  expect(statSync(outcome.backup).mode & 0o777).toBe(0o600)
  const snapshot = openReadOnlyDatabase(outcome.backup)
  try {
    expect(counts(snapshot)).toEqual(before)
    expect(appliedCore(snapshot)).toBe(SHIPPED - 1)
    expect(
      snapshot.query<{ status: string }, []>("SELECT status FROM tasks WHERE id = 'child-1'").get(),
    ).toEqual({ status: 'running' })
  } finally {
    snapshot.close()
  }

  // the migrated copy: same counts, the new migration applied, one db.migrated audit row
  const db = openDatabase(config.dbFile)
  try {
    expect(counts(db)).toEqual(before)
    expect(appliedCore(db)).toBe(SHIPPED)
    expect(
      db
        .query<{ name: string }, []>("SELECT name FROM pragma_table_info('nodes')")
        .all()
        .map((c) => c.name),
    ).toContain('token_issued_at')
    expect(
      db
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM audit_events WHERE kind = 'db.migrated'",
        )
        .get()?.n,
    ).toBe(1)

    // boot recovery on the migrated copy: the reconcile reports the worker that died as interrupted, and the
    // board repairs its row (the eharness reconcile itself needs a live child, so its entry is given here)
    applyReconcile(tasksRepo(db), sqliteActivityStore(db), [
      { sessionId: 'child-1', outcome: 'reported', status: 'interrupted' },
    ])
    expect(tasksRepo(db).get('child-1')).toMatchObject({
      status: 'interrupted',
      error: 'the core restarted while the worker was running',
    })
    // the approval survives the upgrade and the recovery, still waiting for the owner
    expect(reviewsRepo(db).get('rev-1')).toMatchObject({ status: 'pending', requester: 'member-1' })
    expect(counts(db)).toEqual(before)
  } finally {
    db.close()
  }
})

test('a second run after the upgrade finds nothing to do and takes no new snapshot', () => {
  const config = tempDataDir()
  previousSchemaDatabase(config.dbFile)
  expect(migrateWithBackup(config, BUILTIN_PLUGINS, silentLogger, 'local').kind).toBe('migrated')
  expect(migrateWithBackup(config, BUILTIN_PLUGINS, silentLogger, 'local').kind).toBe('current')
  expect(readdirSync(join(config.dataDir, 'backups'))).toHaveLength(1)
})
