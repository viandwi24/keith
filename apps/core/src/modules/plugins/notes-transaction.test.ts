/**
 * Notes create and delete are atomic over the core's SQLite ACL (ADR-0027 §19, plugins.md Context `k`): a failed
 * insert leaves no ACL resource, a failed delete leaves the resource and the note. A real database with the core's
 * migrations and the notes journal is used, because the in-memory ACL of the test host does not roll back.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineKinds } from '@keith/acl'
import { type Sqlite, sqliteAcl } from '@keith/db'
import { type ActorDirectory, createGuard, type KeithPlugin } from '@keith/host'
import { createPluginStorage } from '@keith/host/storage'
import { fakeActor, fakeClock } from '@keith/host/testing'
import { migrateKeithDatabase, openKeithDatabase } from '../../platform/db.ts'
import { BUILTIN_PLUGINS } from './builtin.ts'

const NOTES = BUILTIN_PLUGINS.find((p) => p.id === 'notes') as KeithPlugin
const OLGA = 'olga'
const FRONT = { id: null, kind: 'api' as const, method: null, elevated: false }

let dir: string
let sqlite: Sqlite
let run: (op: string, input: unknown) => Promise<unknown>

const resources = (): number =>
  (sqlite.query("SELECT count(*) AS n FROM resources WHERE kind = 'note'").get() as { n: number }).n
const notes = (): number =>
  (sqlite.query('SELECT count(*) AS n FROM plg_notes_items').get() as { n: number }).n

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'keith-notes-tx-'))
  const file = join(dir, 'keith.db')
  migrateKeithDatabase(dir, file, [NOTES])
  sqlite = await openKeithDatabase(dir, file, [NOTES])
  sqlite.run(
    "INSERT INTO people (id, name, role, created_at, username, status) VALUES ('olga', 'Olga', 'member', 0, 'olga', 'active')",
  )
  const clock = fakeClock()
  const kinds = defineKinds({ ...(NOTES.manifest.resources ?? {}) })
  const directory: ActorDirectory = {
    resolve(id) {
      if (id !== OLGA) return undefined
      return {
        actor: fakeActor({ personId: id, principalId: id, role: 'member' }),
        status: 'active',
        capabilities: new Set(['notes.use']),
      }
    },
  }
  const guard = createGuard({
    directory,
    acl: sqliteAcl(sqlite, { kinds, now: clock.now }),
    audit: { record: () => undefined },
    clock,
    storage: createPluginStorage(sqlite, clock),
    transaction: (fn) => sqlite.transaction(fn).immediate(),
    plugin: (id) => (id === NOTES.id ? NOTES : undefined),
  })
  run = (op, input) =>
    guard.run(NOTES.operation(op) as NonNullable<ReturnType<KeithPlugin['operation']>>, input, {
      principal: { id: OLGA },
      session: FRONT,
    })
})

afterAll(() => {
  sqlite.close()
  rmSync(dir, { recursive: true, force: true })
})

const fails = async (p: Promise<unknown>): Promise<void> => {
  let threw = false
  try {
    await p
  } catch {
    threw = true
  }
  expect(threw).toBe(true)
}

describe('notes create and delete are one transaction', () => {
  test('a create whose note row fails leaves no ACL resource behind', async () => {
    const before = { resources: resources(), notes: notes() }
    sqlite.run(
      "CREATE TRIGGER fail_note_insert BEFORE INSERT ON plg_notes_items BEGIN SELECT RAISE(ABORT, 'disk full'); END",
    )
    try {
      await fails(run('create', { title: 'Tax plan', body: 'a body' }))
    } finally {
      sqlite.run('DROP TRIGGER fail_note_insert')
    }
    expect({ resources: resources(), notes: notes() }).toEqual(before)
  })

  test('a create that succeeds writes the resource and the note together', async () => {
    const out = (await run('create', { title: 'Plan', body: 'text' })) as { id: string }
    expect(resources()).toBe(1)
    expect(notes()).toBe(1)
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('a delete whose note row fails leaves both the resource and the note', async () => {
    const id = (sqlite.query('SELECT id FROM plg_notes_items').get() as { id: string }).id
    sqlite.run(
      "CREATE TRIGGER fail_note_delete BEFORE DELETE ON plg_notes_items BEGIN SELECT RAISE(ABORT, 'locked'); END",
    )
    try {
      await fails(run('delete', { id }))
    } finally {
      sqlite.run('DROP TRIGGER fail_note_delete')
    }
    expect(resources()).toBe(1)
    expect(notes()).toBe(1)
  })

  test('a delete that succeeds removes both', async () => {
    const id = (sqlite.query('SELECT id FROM plg_notes_items').get() as { id: string }).id
    await run('delete', { id })
    expect(resources()).toBe(0)
    expect(notes()).toBe(0)
  })
})
