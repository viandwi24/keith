/**
 * Plugin storage in a real core database (docs/specs/db.md, "Plugin storage"): a database built from the
 * existing migrations, with data in it, gains plugin tables without touching a core table; the plugins keep
 * separate journals; a core that boots behind its plugins is refused; a plugin's handle cannot reach the core.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { credentialsRepo, migrateDatabase, openDatabase, type Sqlite } from '@keith/db'
import { alphaPlugin, betaTwoPlugin } from '@keith/host/testing'
import { createCredential } from './modules/auth/index.ts'
import { loadConfig } from './platform/config.ts'
import { isMigrated, migrateKeithDatabase, openKeithDatabase } from './platform/db.ts'
import { type BootedCore, bootCore } from './testing/boot-core.ts'

const plugins = [alphaPlugin(), betaTwoPlugin()]
const isPlugin = (name: string) => name.includes('plg_') // tables, journals and their autoindexes

/** Every core table and index as (type, name, sql), and the number of rows of each table. */
function coreShape(sqlite: Sqlite) {
  const entries = sqlite
    .query<{ type: string; name: string; sql: string | null }, []>(
      'SELECT type, name, sql FROM sqlite_master ORDER BY type, name',
    )
    .all()
    .filter((e) => !isPlugin(e.name) && e.name !== 'sqlite_sequence')
  const rows = Object.fromEntries(
    entries
      .filter((e) => e.type === 'table')
      .map((e) => [
        e.name,
        sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${e.name}"`).get()?.n,
      ]),
  )
  return { entries, rows }
}

describe('migrating a database that holds data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'keith-plgdb-'))
  const file = join(dir, 'keith.db')

  test('the core migrations first (a database as it is today), with data in it', () => {
    const sqlite = openDatabase(file)
    migrateDatabase(sqlite)
    const now = Date.now()
    sqlite
      .query("INSERT INTO settings (key, value, updated_at) VALUES ('model.front', '\"x\"', ?)")
      .run(now)
    sqlite.close()
  })

  test("without the plugins' tables the database is behind", async () => {
    expect(await isMigrated(file, [])).toBe(true)
    expect(await isMigrated(file, plugins)).toBe(false)
    await expect(openKeithDatabase(dir, file, plugins)).rejects.toThrow('plugin alpha')
  })

  test('plugin tables arrive; every core table, index and row stays as it was', () => {
    const before = openDatabase(file)
    const shape = coreShape(before)
    const journal = () => (sqlite: Sqlite) =>
      sqlite.query<{ n: number }, []>('SELECT count(*) AS n FROM __drizzle_migrations').get()?.n
    const coreJournal = journal()(before)
    before.close()
    migrateKeithDatabase(dir, file, plugins)
    migrateKeithDatabase(dir, file, plugins) // idempotent
    const sqlite = openDatabase(file)
    expect(coreShape(sqlite)).toEqual(shape)
    const names = sqlite
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((t) => t.name)
    for (const name of ['plg_alpha_items', 'plg_beta_two_notes', '__plg_alpha_migrations'])
      expect(names).toContain(name)
    // the core journal is the core's alone
    expect(journal()(sqlite)).toBe(coreJournal)
    sqlite.close()
  })

  test('a database with its plugins migrated opens', async () => {
    expect(await isMigrated(file, plugins)).toBe(true)
    const sqlite = await openKeithDatabase(dir, file, plugins)
    sqlite.close()
  })
})

describe('a booted core with storage plugins', () => {
  let booted: BootedCore
  let db: Sqlite
  beforeAll(async () => {
    booted = await bootCore({}, { plugins })
    db = openDatabase(loadConfig({ KEITH_DATA_DIR: booted.dir, KEITH_BUILD_SHA: 'test' }).dbFile)
  })
  afterAll(async () => {
    db.close()
    await booted.stop()
  })
  const post = async (path: string, token: string, body: unknown) =>
    fetch(`${booted.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  async function bearer(username: string): Promise<string> {
    const person = await booted.local.rpc.admin.people.get({ person: username })
    return (
      await createCredential(credentialsRepo(db), {
        personId: person.id,
        kind: 'token',
        label: 't',
      })
    ).token
  }

  test('operations write the plugin tables through ctx.db and ctx.kv', async () => {
    await booted.local.rpc.admin.people.add({ username: 'ana', name: 'Ana' })
    const token = await bearer('ana')
    expect((await post('/plugins/alpha/add', token, { id: 'a', title: 'one' })).status).toBe(200)
    const titles = await post('/plugins/alpha/titles', token, {})
    expect(await titles.json()).toEqual({ titles: ['one'] })
    const kv = await post('/plugins/alpha/kv', token, { key: 'k', value: 'v' })
    expect(await kv.json()).toEqual({ value: 'v', keys: ['k'] })
    expect(await (await post('/plugins/beta-two/note', token, { body: 'n' })).json()).toEqual({
      count: 1,
    })
    expect(db.query('SELECT plugin, key FROM plugin_kv').all()).toEqual([
      { plugin: 'alpha', key: 'k' },
    ])
  })

  test('a plugin that probes the core database over the real handle is refused and nothing changes', async () => {
    const token = await bearer('ana')
    const before = db.query<{ n: number }, []>('SELECT count(*) AS n FROM people').get()?.n
    for (const sql of [
      'delete from people',
      'select * from credentials',
      'update settings set value = 1',
      'select * from plg_beta_two_notes',
      'drop table plg_alpha_items',
    ]) {
      const r = (await (await post('/plugins/alpha/probe', token, { sql })).json()) as {
        ok: boolean
      }
      expect(r.ok, sql).toBe(false)
    }
    expect(db.query<{ n: number }, []>('SELECT count(*) AS n FROM people').get()?.n).toBe(before)
  })
})
