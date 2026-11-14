import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alphaPlugin, betaTwoPlugin, FIXTURES_DIR, memoryHost } from '../testing/index.ts'
import { createPluginStorage } from './index.ts'
import { assertPluginStorageMigrated, migratePluginStorage } from './migrate.ts'
import { assertMigrationSql, assertScopedSql, migrationsTableOf, tablePrefix } from './sql-scope.ts'

const foreign = new Set(['people', 'settings', 'eh_messages', 'plugin_kv', 'plg_beta_two_notes'])
const ok = (sql: string) => assertScopedSql(sql, 'alpha', foreign)
const refused = (sql: string) => expect(() => ok(sql)).toThrow()

describe('scoped SQL', () => {
  test('data statements on own tables pass', () => {
    ok('select "id", "title" from "plg_alpha_items" where "id" = ?')
    ok('insert into "plg_alpha_items" ("id") values (?) returning "id"')
    ok('update plg_alpha_items set title = ? where id = ?')
    ok('delete from plg_alpha_items')
    ok("select * from plg_alpha_items where title = 'people'") // a string is not a name
    ok('begin')
    ok('commit')
  })

  test('core tables, other plugins, schema tricks and DDL are refused', () => {
    refused('select * from people')
    refused('select * from "PEOPLE"')
    refused('select * from main.people')
    refused('select * from `people`')
    refused('select * from [people]')
    refused('select * from plg_alpha_items, settings')
    refused('select * from plg_alpha_items join eh_messages on 1')
    refused('select (select count(*) from people) from plg_alpha_items')
    refused('with x as (select * from people) select * from x')
    refused('select * from /* hidden */ people')
    refused('select * from plg_beta_two_notes')
    refused('select * from plg_gamma_whatever')
    refused('select * from sqlite_master')
    refused('select * from pragma_table_info("plg_alpha_items")')
    refused('select * from __drizzle_migrations')
    refused('drop table plg_alpha_items')
    refused('create table plg_alpha_x (a)')
    refused('alter table plg_alpha_items add column z')
    refused('attach database "x" as y')
    refused('pragma foreign_keys = off')
    refused('select 1; drop table plg_alpha_items')
    refused('select load_extension("x")')
  })

  test('prefix of a hyphenated id', () => {
    expect(tablePrefix('beta-two')).toBe('plg_beta_two_')
    expect(migrationsTableOf('beta-two')).toBe('__plg_beta_two_migrations')
  })
})

describe('migration SQL', () => {
  const sql = (s: string) => () => assertMigrationSql(s, 'alpha')
  test('its own fts5 index passes, any other virtual table does not', () => {
    sql('CREATE VIRTUAL TABLE `plg_alpha_fts` USING fts5(title, body);')()
    expect(sql('CREATE VIRTUAL TABLE `plg_alpha_r` USING rtree(id, a, b);')).toThrow()
    expect(sql('CREATE VIRTUAL TABLE `people_fts` USING fts5(title);')).toThrow()
    expect(sql('CREATE VIRTUAL TABLE `plg_beta_two_fts` USING fts5(title);')).toThrow()
  })
  test('generated shapes pass', () => {
    sql('CREATE TABLE `plg_alpha_items` (`id` text PRIMARY KEY NOT NULL);')()
    sql('CREATE INDEX `plg_alpha_x` ON `plg_alpha_items` (`id`);')()
    sql('CREATE UNIQUE INDEX `plg_alpha_u` ON `plg_alpha_items` (`id`);')()
    sql('ALTER TABLE `plg_alpha_items` ADD `done` integer DEFAULT 0 NOT NULL;')()
    sql('ALTER TABLE `plg_alpha_items` RENAME COLUMN `a` TO `b`;')()
    sql('PRAGMA foreign_keys=OFF;')()
    sql(
      'CREATE TABLE `__new_plg_alpha_items` (`id` text, FOREIGN KEY (`id`) REFERENCES `plg_alpha_other`(`id`));',
    )()
    sql('INSERT INTO `__new_plg_alpha_items`(`id`) SELECT `id` FROM `plg_alpha_items`;')()
    sql('DROP TABLE `plg_alpha_items`;')()
    sql('ALTER TABLE `__new_plg_alpha_items` RENAME TO `plg_alpha_items`;')()
  })
  test('anything outside the prefix is refused', () => {
    for (const bad of [
      'DROP TABLE `people`;',
      'CREATE TABLE `people_copy` (`id` text);',
      'ALTER TABLE `people` ADD `x` text;',
      'CREATE INDEX `ix` ON `plg_alpha_items` (`id`);',
      'CREATE INDEX `plg_alpha_ix` ON `people` (`id`);',
      'INSERT INTO `plg_alpha_items` SELECT * FROM `people`;',
      'UPDATE `people` SET `name` = 1;',
      'DELETE FROM `eh_messages`;',
      'CREATE TABLE `plg_alpha_a` (`x` text REFERENCES `people`(`id`));',
      'CREATE TRIGGER plg_alpha_t AFTER INSERT ON plg_alpha_items BEGIN SELECT 1; END;',
      'PRAGMA writable_schema = 1;',
      'ATTACH DATABASE "x" AS y;',
    ])
      expect(sql(bad), bad).toThrow()
  })
})

describe('plugin migrations', () => {
  test('migrationsTable is honoured: two plugins, two journals, independent and idempotent', () => {
    const sqlite = new Database(':memory:', { strict: true })
    const alpha = alphaPlugin()
    const beta = betaTwoPlugin()
    migratePluginStorage(sqlite, [alpha])
    const rows = (table: string) =>
      sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM "${table}"`).get()?.n
    expect(rows('__plg_alpha_migrations')).toBe(2)
    expect(
      sqlite.query("SELECT 1 FROM sqlite_master WHERE name = '__plg_beta_two_migrations'").get(),
    ).toBeNull()
    expect(
      sqlite.query("SELECT 1 FROM sqlite_master WHERE name = '__drizzle_migrations'").get(),
    ).toBeNull()
    expect(() => assertPluginStorageMigrated(sqlite, [alpha, beta])).toThrow('plugin beta-two')

    migratePluginStorage(sqlite, [alpha, beta])
    migratePluginStorage(sqlite, [beta, alpha]) // again, other order: nothing to do
    expect(rows('__plg_alpha_migrations')).toBe(2)
    expect(rows('__plg_beta_two_migrations')).toBe(1)
    expect(() => assertPluginStorageMigrated(sqlite, [alpha, beta])).not.toThrow()
    const tables = sqlite
      .query<{ name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
      .all()
      .map((t) => t.name)
    expect(tables).toEqual([
      '__plg_alpha_migrations',
      '__plg_beta_two_migrations',
      'plg_alpha_items',
      'plg_beta_two_notes',
      'sqlite_sequence',
    ])
    expect(sqlite.query('PRAGMA table_info(plg_alpha_items)').all().length).toBe(3) // `done` came from migration 2
  })

  test('a migration that touches a core table is refused before anything runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'keith-evil-'))
    cpSync(`${FIXTURES_DIR}/alpha/migrations`, join(dir, 'migrations'), { recursive: true })
    const journal = JSON.parse(
      readFileSync(join(dir, 'migrations/meta/_journal.json'), 'utf8'),
    ) as { entries: Array<{ tag: string }> }
    writeFileSync(join(dir, 'migrations/0002_evil.sql'), 'DROP TABLE `people`;')
    journal.entries.push({
      ...(journal.entries[1] as object),
      tag: '0002_evil',
      idx: 2,
      when: Date.now() + 1,
    } as never)
    writeFileSync(join(dir, 'migrations/meta/_journal.json'), JSON.stringify(journal))
    const sqlite = new Database(':memory:', { strict: true })
    sqlite.exec('CREATE TABLE people (id text)')
    const plugin = {
      ...alphaPlugin(),
      manifest: { ...alphaPlugin().manifest, storage: { migrations: join(dir, 'migrations') } },
    }
    expect(() => migratePluginStorage(sqlite, [plugin as never])).toThrow('migration refused')
    expect(
      sqlite.query("SELECT 1 FROM sqlite_master WHERE name = 'plg_alpha_items'").get(),
    ).toBeNull()
  })
})

describe('ctx.db and ctx.kv through the guard', () => {
  const setup = () => {
    const host = memoryHost({ plugins: [alphaPlugin(), betaTwoPlugin()] })
    host.add('ana')
    return host
  }

  test('a plugin reads and writes its own tables', async () => {
    const host = setup()
    await host.call('alpha', 'add', { id: 'a', title: 'first' }, 'ana')
    await host.call('alpha', 'add', { id: 'b', title: 'second' }, 'ana')
    expect(await host.call('alpha', 'titles', {}, 'ana')).toEqual({ titles: ['first', 'second'] })
    expect(await host.call('alpha', 'rename', { id: 'a', title: 'x' }, 'ana')).toEqual({
      changed: 1,
    })
  })

  test('a plugin cannot touch core tables, another plugin or the schema', async () => {
    const host = setup()
    host.sqlite.exec("CREATE TABLE people (id text); INSERT INTO people VALUES ('o')")
    const probe = async (sql: string) =>
      (await host.call('alpha', 'probe', { sql }, 'ana')) as { ok: boolean; message: string }
    for (const sql of [
      'select * from people',
      'delete from people',
      'select * from plugin_kv',
      'select * from plg_beta_two_notes',
      'select * from sqlite_master',
      'drop table plg_alpha_items',
      'pragma writable_schema = 1',
    ])
      expect((await probe(sql)).ok, sql).toBe(false)
    expect((await probe('select * from plg_alpha_items')).ok).toBe(true)
    expect(host.sqlite.query('SELECT count(*) AS n FROM people').get()).toEqual({ n: 1 })
  })

  test('the refusal names the table, never its content', async () => {
    const host = setup()
    host.sqlite.exec('CREATE TABLE people (id text)')
    const r = (await host.call('alpha', 'probe', { sql: 'select * from people' }, 'ana')) as {
      message: string
    }
    expect(r.message).toContain('not a table of this plugin')
  })

  test('kv is namespaced by plugin', async () => {
    const host = setup()
    await host.call('alpha', 'kv', { key: 'a.b', value: 'one' }, 'ana')
    const second = await host.call('alpha', 'kv', { key: 'c', value: 'two' }, 'ana')
    expect(second).toEqual({ value: 'two', keys: ['a.b', 'c'] })
    const rows = host.sqlite.query<{ plugin: string }, []>('SELECT plugin FROM plugin_kv').all()
    expect(rows.every((r) => r.plugin === 'alpha')).toBe(true)
  })

  test('kv refuses bad keys, big values and too many keys', () => {
    const sqlite = new Database(':memory:', { strict: true })
    sqlite.exec(
      'CREATE TABLE plugin_kv (plugin text NOT NULL, key text NOT NULL, value text NOT NULL, updated_at integer NOT NULL, PRIMARY KEY (plugin, key))',
    )
    const kv = createPluginStorage(sqlite)('alpha').kv
    expect(() => kv.set('bad key', 1)).toThrow('bad key')
    expect(() => kv.set('k', 'x'.repeat(70_000))).toThrow('value over')
    kv.set('k', { a: 1 })
    expect(kv.get('k')).toEqual({ a: 1 })
    expect(kv.delete('k')).toBe(true)
    expect(kv.delete('k')).toBe(false)
    kv.set('p_x', 1)
    kv.set('pax', 2)
    expect(kv.list({ prefix: 'p_' }).map((e) => e.key)).toEqual(['p_x'])
  })
})
