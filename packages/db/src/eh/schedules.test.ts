import { afterAll, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { createScheduler } from 'eharness/scheduler'
import { schemaSql } from 'eharness/sqlite'
import { assertMigrated, migrateDatabase, openDatabase } from '../connection.ts'
import { cleanMigrationDirs, migrationsBefore } from '../testing/migrations.ts'
import { sqliteSchedules } from './schedules.ts'

afterAll(cleanMigrationDirs)

const shape = (sqlite: ReturnType<typeof openDatabase>, table: string) => ({
  columns: sqlite
    .query<{ name: string; type: string; notnull: number; pk: number }, []>(
      `PRAGMA table_info(${table})`,
    )
    .all()
    .map((c) => `${c.name}:${c.type}:${c.notnull}:${c.pk}`),
  indexes: sqlite
    .query<{ name: string }, []>(`PRAGMA index_list(${table})`)
    .all()
    .filter((i) => !i.name.startsWith('sqlite_autoindex'))
    .map((i) => ({
      name: i.name,
      cols: sqlite
        .query<{ name: string }, []>(`PRAGMA index_info(${i.name})`)
        .all()
        .map((c) => c.name),
    }))
    .sort((a, b) => a.name.localeCompare(b.name)),
})

describe('eh_schedules', () => {
  test('migration 0012 builds the table of eharness/sqlite (columns and indexes)', () => {
    const ours = openDatabase(':memory:')
    migrateDatabase(ours)
    const theirs = openDatabase(':memory:')
    for (const m of schemaSql({ prefix: 'eh_' })) theirs.exec(m.sql)
    expect(shape(ours, 'eh_schedules')).toEqual(shape(theirs, 'eh_schedules'))
  })

  test('an existing database gains the empty table without losing a row', async () => {
    const sqlite = openDatabase(':memory:')
    migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0012_') })
    expect(
      sqlite.query("SELECT name FROM sqlite_master WHERE name = 'eh_schedules'").all(),
    ).toEqual([])
    sqlite.exec("INSERT INTO settings (key, value, updated_at) VALUES ('model.front', '\"x\"', 1)")
    migrateDatabase(sqlite)
    await assertMigrated(sqlite)
    expect(sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM settings').get()?.n).toBe(1)
    expect(sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM eh_schedules').get()?.n).toBe(
      0,
    )
  })

  test('the store works over the migrated table: create, tick, fire once', async () => {
    const sqlite = openDatabase(':memory:')
    migrateDatabase(sqlite)
    const clock = { t: 1_790_000_000_000 }
    const fired: string[] = []
    const scheduler = createScheduler({
      store: sqliteSchedules(sqlite),
      now: () => clock.t,
      fire: ({ fireId }) => void fired.push(fireId),
    })
    await scheduler.create({
      id: 's1',
      sessionId: 'plugin:x',
      spec: { kind: 'once', at: clock.t + 1000 },
      catchUp: 'once',
    })
    clock.t += 5000
    await scheduler.tick()
    await scheduler.tick()
    expect(fired).toEqual([`sched:s1:${1_790_000_001_000}`])
  })
})
