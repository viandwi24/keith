import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  assertMigrated,
  journalStateOf,
  MIGRATIONS_DIR,
  migrateDatabase,
  openDatabase,
} from './connection.ts'

test('an unmigrated database is refused with the command to run', async () => {
  const sqlite = openDatabase(':memory:')
  await expect(assertMigrated(sqlite)).rejects.toThrow('bun run db:migrate')
  migrateDatabase(sqlite)
  await expect(assertMigrated(sqlite)).resolves.toBeUndefined()
  migrateDatabase(sqlite) // idempotent
  sqlite.close()
})

test('a journal with more rows than shipped is ahead; a changed row is diverged (P26.1.6)', async () => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  const journal = () => journalStateOf(sqlite, '__drizzle_migrations', MIGRATIONS_DIR)
  expect(journal().kind).toBe('ready')
  const first = '(SELECT min(created_at) FROM __drizzle_migrations)'
  const hash = sqlite
    .query<{ hash: string }, []>(
      `SELECT hash FROM __drizzle_migrations WHERE created_at = ${first}`,
    )
    .get()?.hash
  sqlite.exec(`UPDATE __drizzle_migrations SET hash = 'not-this-build' WHERE created_at = ${first}`)
  expect(journal().kind).toBe('diverged')
  await expect(assertMigrated(sqlite)).rejects.toThrow('migrated by a newer Keith')
  sqlite.exec(`UPDATE __drizzle_migrations SET hash = '${hash}' WHERE created_at = ${first}`)
  expect(journal().kind).toBe('ready')
  sqlite.exec(
    "INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('from-a-newer-build', 1)",
  )
  expect(journal().kind).toBe('ahead')
  await expect(assertMigrated(sqlite)).rejects.toThrow(
    'this database was migrated by a newer Keith (',
  )
  sqlite.close()
})

test('a database another process holds for a moment is waited for, not refused as locked', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'keith-busy-'))
  try {
    const file = join(dir, 'keith.db')
    openDatabase(file).close()
    // another process takes an exclusive lock (as a closing core or a CLI command can) and lets go after 400 ms
    const holder = Bun.spawn(
      [
        process.execPath,
        '-e',
        "const { Database } = require('bun:sqlite'); const db = new Database(process.argv[1]); db.exec('PRAGMA journal_mode = DELETE'); db.exec('BEGIN EXCLUSIVE'); console.log('held'); setTimeout(() => { db.exec('COMMIT'); db.close() }, 400)",
        file,
      ],
      { stdout: 'pipe' },
    )
    const reader = (holder.stdout as ReadableStream<Uint8Array>).getReader()
    await reader.read() // 'held'
    const sqlite = openDatabase(file)
    expect(
      sqlite.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode,
    ).toBe('wal')
    sqlite.close()
    await holder.exited
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
