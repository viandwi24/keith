import { describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { assertOwnTables, drizzleConfigOf, generate, parseArgs } from './plugin-db-generate.ts'

const root = resolve(import.meta.dir, '..')
const fixtures = join(root, 'packages/host/src/testing/fixtures')

describe('plugin:db:generate', () => {
  test('the config scopes tables and the journal table to the plugin', () => {
    const config = drizzleConfigOf(
      { id: 'beta-two', dir: '/p/beta-two', out: '/p/beta-two/migrations' },
      '/p/db',
    )
    expect(config).toMatchObject({
      dialect: 'sqlite',
      schema: '/p/beta-two/schema.ts',
      tablesFilter: ['plg_beta_two_*'],
      migrations: { table: '__plg_beta_two_migrations' },
    })
  })

  test('arguments: an id is required, the default folder is plugins/<id>', () => {
    expect(() => parseArgs([], root)).toThrow('usage')
    expect(() => parseArgs(['Bad_Id'], root)).toThrow('usage')
    const o = parseArgs(['notes'], root)
    expect(o.dir).toBe(join(root, 'plugins/notes'))
    expect(o.out).toBe(join(root, 'plugins/notes/migrations'))
  })

  test('a schema with a table outside plg_<id>_ is refused before anything is written', async () => {
    await expect(
      assertOwnTables({ id: 'stray', dir: join(fixtures, 'stray'), out: '/nowhere' }),
    ).rejects.toThrow('plg_stray_')
    await assertOwnTables({ id: 'alpha', dir: join(fixtures, 'alpha'), out: '/nowhere' })
  })

  test('the committed fixture migrations are up to date with the schema (no drift)', async () => {
    const out = mkdtempSync(join(tmpdir(), 'keith-drift-'))
    cpSync(join(fixtures, 'alpha/migrations'), out, { recursive: true })
    const before = readdirSync(out).sort()
    const code = await generate({ id: 'alpha', dir: join(fixtures, 'alpha'), out }, root)
    expect(code).toBe(0)
    expect(readdirSync(out).sort()).toEqual(before)
  }, 60_000)
})
