// The core's own rows of a removed person (ADR-0027 §26, FD11-04, docs/specs/people.md "Where a person's data
// lives"). A person's rows are found by session prefix (`front:<id>` and the workers `front:<id>:...`) or by
// their id. The removal keeps the tasks and reviews in `data.json` in the kept folder, deletes every row in one
// immediate transaction, and moves the rows that name the person as creator to the owner. The budget ledger,
// the audit log and the ACL moves stay as they are (people.md).
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Sqlite } from '@keith/db'
import type { PersonRemovalHooks, RemovalUndo } from './removal-registry.ts'
import { removedFolderOf } from './removed.ts'

/** A table's rows of one person. */
interface Part {
  table: string
  where: string
  args: (string | number)[]
}

type Row = Record<string, unknown>

const frontOf = (personId: string): string => `front:${personId}`

/** Rows whose session is the person's front session or one of its workers (`front:<id>:...`). */
const sessionPart = (table: string, column: string, personId: string): Part => {
  const front = frontOf(personId)
  return {
    table,
    where: `(${column} = ? OR substr(${column}, 1, ?) = ?)`,
    args: [front, front.length + 1, `${front}:`],
  }
}

/** Rows that name the person in a column. */
const personPart = (table: string, column: string, personId: string): Part => ({
  table,
  where: `${column} = ?`,
  args: [personId],
})

/** Every table of the core that holds a person's rows and is deleted with the removal. */
export function personParts(personId: string): Part[] {
  return [
    sessionPart('tasks', 'parent_session_id', personId),
    personPart('owner_reviews', 'requester', personId),
    sessionPart('eh_inbox', 'session_id', personId),
    sessionPart('eh_inbox_keys', 'session_id', personId),
    sessionPart('eh_state', 'session_id', personId),
    sessionPart('eh_locks', 'session_id', personId),
    sessionPart('eh_schedules', 'session_id', personId),
    sessionPart('eh_stream_log', 'session_id', personId),
    sessionPart('eh_stream_chunks', 'session_id', personId),
    sessionPart('events', 'session_id', personId),
    // the store's delete removes these too; listed so the table test sees them
    personPart('person_pair_codes', 'person_id', personId),
  ]
}

/** Rows that name the person as creator: they move to the owner (the heir), like the ACL move. */
export const CREATOR_TABLES: readonly { table: string; key: string }[] = [
  { table: 'pairing_codes', key: 'hash' },
  { table: 'groups', key: 'id' },
]

/** The tables this module answers for (the table test reads it). */
export const CORE_TABLES: readonly string[] = [
  'tasks',
  'owner_reviews',
  'eh_inbox',
  'eh_inbox_keys',
  'eh_state',
  'eh_locks',
  'eh_schedules',
  'eh_stream_log',
  'eh_stream_chunks',
  'events',
  'person_pair_codes',
  ...CREATOR_TABLES.map((t) => t.table),
]

/** A worker that is still working: the statuses that `tasks.stop` acts on. */
const ACTIVE = ['queued', 'running', 'waiting']

export interface CoreRemovalOptions {
  sqlite: Sqlite
  dataDir: string
  /** The owner's id now: the creator of a row that names the removed person moves to them. */
  heirOf(): Promise<string | undefined>
  /** Ask the running worker of a task to stop; resolves when the stop was requested. */
  stopWorker(task: { id: string; agent: string }): Promise<void>
}

/** The rows `data.json` holds: a person's tasks and the reviews they asked for. */
function dataOf(sqlite: Sqlite, personId: string): { tasks: Row[]; reviews: Row[] } {
  const rowsOf = (part: Part): Row[] =>
    sqlite.query(`SELECT * FROM ${part.table} WHERE ${part.where}`).all(...part.args) as Row[]
  const parts = personParts(personId)
  return {
    tasks: rowsOf(parts.find((p) => p.table === 'tasks') as Part),
    reviews: rowsOf(parts.find((p) => p.table === 'owner_reviews') as Part),
  }
}

/** The core's rows of a person: stopped first, kept in `data.json`, deleted in one immediate transaction. */
export function coreRemoval(options: CoreRemovalOptions): PersonRemovalHooks {
  const { sqlite } = options
  return {
    async stop(personId) {
      const part = sessionPart('tasks', 'parent_session_id', personId)
      const active = sqlite
        .query(
          `SELECT id, agent FROM tasks WHERE ${part.where} AND status IN (${ACTIVE.map(() => '?').join(',')})`,
        )
        .all(...part.args, ...ACTIVE) as { id: string; agent: string }[]
      for (const task of active) {
        await options.stopWorker(task)
        sqlite
          .query(
            "UPDATE tasks SET status = 'stopped', error = 'person removed', finished_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running', 'waiting')",
          )
          .run(Date.now(), Date.now(), task.id)
      }
    },
    async keep(personId, folder): Promise<RemovalUndo> {
      const heir = await options.heirOf()
      const data = dataOf(sqlite, personId)
      const file = join(folder, 'data.json')
      writeFileSync(file, `${JSON.stringify({ personId, ...data }, null, 2)}\n`, { mode: 0o600 })

      const parts = personParts(personId)
      const deleted = parts.map((part) => ({
        table: part.table,
        rows: sqlite
          .query(`SELECT * FROM ${part.table} WHERE ${part.where}`)
          .all(...part.args) as Row[],
      }))
      const creators = CREATOR_TABLES.map((t) => ({
        ...t,
        rows: sqlite
          .query(`SELECT ${t.key} AS key FROM ${t.table} WHERE created_by = ?`)
          .all(personId) as {
          key: string
        }[],
      }))
      try {
        sqlite
          .transaction(() => {
            for (const part of parts)
              sqlite.query(`DELETE FROM ${part.table} WHERE ${part.where}`).run(...part.args)
            if (heir !== undefined && heir !== personId)
              for (const t of CREATOR_TABLES)
                sqlite
                  .query(`UPDATE ${t.table} SET created_by = ? WHERE created_by = ?`)
                  .run(heir, personId)
          })
          .immediate()
      } catch (error) {
        if (existsSync(file)) unlinkSync(file)
        throw error
      }

      return () => {
        if (existsSync(file)) unlinkSync(file)
        sqlite
          .transaction(() => {
            for (const { table, rows } of deleted)
              for (const row of rows) {
                const columns = Object.keys(row)
                sqlite
                  .query(
                    `INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
                  )
                  .run(...(columns.map((c) => row[c]) as never[]))
              }
            for (const t of creators)
              for (const row of t.rows)
                sqlite
                  .query(`UPDATE ${t.table} SET created_by = ? WHERE ${t.key} = ?`)
                  .run(personId, row.key as never)
          })
          .immediate()
      }
    },
    async export(personId, dest) {
      const target = join(dest, 'data.json')
      const folder = removedFolderOf(options.dataDir, personId)
      if (existsSync(join(folder, 'manifest.json'))) {
        if (existsSync(join(folder, 'data.json')))
          writeFileSync(target, readFileSync(join(folder, 'data.json')), { mode: 0o600 })
        return
      }
      writeFileSync(
        target,
        `${JSON.stringify({ personId, ...dataOf(sqlite, personId) }, null, 2)}\n`,
        {
          mode: 0o600,
        },
      )
    },
    purge() {},
  }
}
