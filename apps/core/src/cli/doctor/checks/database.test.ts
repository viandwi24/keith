import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDatabase, openDatabase } from '@keith/db'
import { migrateKeithDatabase } from '../../../platform/db.ts'
import type { DoctorCtx } from '../types.ts'
import { databaseCheck } from './database.ts'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

/** A data folder with a database made by `setup`: `extra` runs after the migrations, to make it ahead or diverged. */
function ctxFor(extra?: string): DoctorCtx {
  const dataDir = mkdtempSync(join(tmpdir(), 'keith-doctor-db-'))
  dirs.push(dataDir)
  const dbFile = join(dataDir, 'keith.db')
  migrateKeithDatabase(dataDir, dbFile)
  const sqlite = openDatabase(dbFile)
  if (extra !== undefined) sqlite.exec(extra)
  sqlite.close()
  return { config: { dataDir, dbFile }, checks: [] } as unknown as DoctorCtx
}

describe('doctor: database', () => {
  test('a migrated database is ok', () => {
    expect(databaseCheck(ctxFor())).toEqual([{ level: 'ok', name: 'database', hint: 'migrated' }])
  })

  test('a database a newer build wrote is one failing line that says why', () => {
    const [line] = databaseCheck(
      ctxFor("INSERT INTO __drizzle_migrations (hash, created_at) VALUES ('newer', 1)"),
    ) as Array<{ level: string; hint: string }>
    expect(line?.level).toBe('fail')
    expect(line?.hint).toContain('migrated by a newer Keith (')
    expect(line?.hint).toContain('keith-core restore')
  })

  test('a database that cannot be read is one failing line that points at backups', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'keith-doctor-db-'))
    dirs.push(dataDir)
    const dbFile = join(dataDir, 'keith.db')
    // a rollback-journal file (the default): an exclusive lock held here blocks every reader
    const locker = new Database(dbFile, { create: true })
    migrateDatabase(locker)
    locker.exec('BEGIN EXCLUSIVE')
    try {
      const ctx = { config: { dataDir, dbFile }, checks: [] } as unknown as DoctorCtx
      const [line] = databaseCheck(ctx) as Array<{ level: string; hint: string }>
      expect(line?.level).toBe('fail')
      expect(line?.hint).toContain('cannot be read')
      expect(line?.hint).toContain(join(dataDir, 'backups'))
      expect(line?.hint).not.toContain('db migrate')
    } finally {
      locker.exec('ROLLBACK')
      locker.close()
    }
  })
})
