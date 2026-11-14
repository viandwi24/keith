import { afterAll, describe, expect, test } from 'bun:test'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { assertMigrated, migrateDatabase, openDatabase } from '../connection.ts'
import { cleanMigrationDirs, migrationsBefore } from '../testing/migrations.ts'
import { reviewsRepo } from './reviews.ts'

afterAll(cleanMigrationDirs)

const DAY = 86_400_000
function setup() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  let t = 1_790_000_000_000
  const clock = {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
  return { sqlite, clock, repo: reviewsRepo(sqlite, { now: clock.now }) }
}
const input = (id: string, requester = 'ana') => ({
  id,
  requester,
  plugin: 'reminders',
  operation: 'create',
  payload: '{"text":"x"}',
  reason: null,
  ttlMs: 7 * DAY,
})

describe('owner_reviews repo', () => {
  test('create, get, list newest first, and the per-requester pending cap', () => {
    const { repo } = setup()
    for (const id of ['a', 'b', 'c']) expect(repo.create(input(id), 3)).toEqual({ ok: true })
    expect(repo.create(input('d'), 3)).toEqual({ ok: false, reason: 'cap' })
    expect(repo.create(input('e', 'ben'), 3)).toEqual({ ok: true }) // another requester has their own cap
    expect(repo.get('a')?.status).toBe('pending')
    expect(repo.list({ requester: 'ana' }).map((r) => r.id)).toEqual(['c', 'b', 'a'])
    expect(repo.get('nope')).toBeUndefined()
  })

  test('decide acts once, only on a pending review that has not expired', () => {
    const { repo, clock } = setup()
    repo.create(input('a'), 5)
    repo.create(input('b'), 5)
    expect(repo.decide('a', 'approved', 'owner')).toBe(true)
    expect(repo.decide('a', 'denied', 'owner')).toBe(false)
    expect(repo.get('a')).toMatchObject({ status: 'approved', decidedBy: 'owner' })
    clock.advance(8 * DAY)
    expect(repo.decide('b', 'approved', 'owner')).toBe(false)
    repo.setOutcome('a', 'ok')
    expect(repo.get('a')?.outcome).toBe('ok')
  })

  test('the sweep expires old pending reviews once and frees the cap; purge removes decided ones', () => {
    const { repo, clock } = setup()
    repo.create(input('a'), 1)
    expect(repo.create(input('b'), 1)).toEqual({ ok: false, reason: 'cap' })
    clock.advance(8 * DAY)
    expect(repo.create(input('b'), 1)).toEqual({ ok: true }) // expired rows no longer count
    expect(repo.expire().map((r) => [r.id, r.status])).toEqual([['a', 'expired']])
    expect(repo.expire()).toEqual([])
    expect(repo.get('a')?.status).toBe('expired')
    expect(repo.purge(clock.now() + 1)).toBe(1)
    expect(repo.get('a')).toBeUndefined()
    expect(repo.get('b')?.status).toBe('pending')
  })

  test('purge judges the decision, not the request: 31 days decided goes, 29 days decided stays, pending stays', () => {
    const { repo, clock } = setup()
    repo.create(input('old'), 5)
    repo.create(input('pending', 'cy'), 5)
    repo.decide('old', 'denied', 'owner')
    clock.advance(29 * DAY)
    repo.create(input('recent', 'bo'), 5) // asked on day 29, decided on day 29
    repo.decide('recent', 'approved', 'owner')
    clock.advance(2 * DAY)
    // 'old' was decided 31 days ago, 'recent' 2 days ago; 'pending' was asked on day 0 and never decided
    expect(repo.purge(clock.now() - 30 * DAY)).toBe(1)
    expect(repo.get('old')).toBeUndefined()
    expect(repo.get('recent')?.status).toBe('approved')
    expect(repo.get('pending')?.status).toBe('pending')
  })
})

test('migration 0011 only adds owner_reviews: an older database keeps every row', async () => {
  const sqlite = openDatabase(':memory:')
  migrate(drizzle({ client: sqlite }), { migrationsFolder: migrationsBefore('0011_') })
  const now = 1_790_000_000_000
  sqlite.exec(
    `INSERT INTO people (id, name, role, created_at, username, status, updated_at) VALUES ('owner', 'Owner', 'owner', ${now}, 'owner', 'active', ${now})`,
  )
  sqlite.exec(`INSERT INTO settings (key, value, updated_at) VALUES ('model.front', '"x"', ${now})`)
  expect(sqlite.query("SELECT 1 FROM sqlite_master WHERE name = 'owner_reviews'").get()).toBeNull()
  migrateDatabase(sqlite)
  await assertMigrated(sqlite)
  const n = (t: string) =>
    sqlite.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${t}`).get()?.n
  expect([n('people'), n('settings'), n('owner_reviews')]).toEqual([1, 1, 0])
})
