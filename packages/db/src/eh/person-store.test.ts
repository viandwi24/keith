import { afterEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { drizzle } from 'drizzle-orm/bun-sqlite'
import { migrate } from 'drizzle-orm/bun-sqlite/migrator'
import { isIdentityError } from 'eharness/identity'
import { MIGRATIONS_DIR, migrateDatabase, openDatabase } from '../connection.ts'
import { credentialsRepo } from '../repos/credentials.ts'
import { tokensRepo } from '../repos/tokens.ts'
import { sqlitePersonStore } from './person-store.ts'
import type { Sqlite } from './sql.ts'

const open: Sqlite[] = []
const dirs: string[] = []
afterEach(() => {
  for (const s of open.splice(0)) s.close()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function fresh() {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  open.push(sqlite)
  return sqlite
}
const T = 1_790_000_000_000

describe('ids and usernames', () => {
  test('new people get UUIDv7 ids; a given id is kept', async () => {
    const store = sqlitePersonStore(fresh())
    const a = await store.create({ displayName: 'Ana', username: 'ana' }, 'owner', T)
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(a.role).toBe('member')
    expect(a.status).toBe('active')
    expect(a.createdBy).toBe('owner')
    const o = await store.create(
      { id: 'owner', displayName: 'Vian', username: 'owner', role: 'owner' },
      null,
      T,
    )
    expect(o.id).toBe('owner')
  })

  test('a username is unique, changeable, and byUsername finds it', async () => {
    const store = sqlitePersonStore(fresh())
    const a = await store.create({ displayName: 'Ana', username: 'ana' }, null, T)
    await store.create({ displayName: 'Budi', username: 'budi' }, null, T)
    const dup = await store.create({ displayName: 'X', username: 'ana' }, null, T).catch((e) => e)
    expect(isIdentityError(dup, 'INVALID_PERSON')).toBe(true)
    const clash = await store.update(a.id, { username: 'budi' }, null, T).catch((e) => e)
    expect(isIdentityError(clash, 'INVALID_PERSON')).toBe(true)
    await store.update(a.id, { username: 'ana2' }, 'owner', T + 1)
    expect((await store.byUsername('ana2'))?.id).toBe(a.id)
    expect(await store.byUsername('ana')).toBeUndefined()
    const ev = (await store.events(a.id))[0]
    expect(ev).toMatchObject({
      kind: 'update',
      actor: 'owner',
      detail: { from: 'ana', to: 'ana2' },
    })
  })
})

describe('a username never shadows a sign-in identifier', () => {
  const insertAlias = (sqlite: Sqlite, personId: string, value: string) =>
    sqlite
      .query(
        "INSERT INTO person_identifiers (person_id, kind, value_norm, created_at) VALUES (?, 'phone', ?, 1)",
      )
      .run(personId, value)

  test('create refuses a username equal to an alias or another id; a plain name works', async () => {
    const sqlite = fresh()
    const store = sqlitePersonStore(sqlite)
    const ana = await store.create({ displayName: 'Ana', username: 'ana' }, 'owner', T)
    insertAlias(sqlite, ana.id, '6281234567890')
    const refused = await store
      .create({ displayName: 'Mallory', username: '6281234567890' }, 'owner', T)
      .catch((e) => e)
    expect(isIdentityError(refused, 'INVALID_PERSON')).toBe(true)
    const byId = await store
      .create({ displayName: 'Eve', username: ana.id }, 'owner', T)
      .catch((e) => e)
    expect(isIdentityError(byId, 'INVALID_PERSON')).toBe(true)
    expect((await store.list()).total).toBe(1)
    expect((await store.create({ displayName: 'Bob', username: 'a1' }, 'owner', T)).username).toBe(
      'a1',
    )
  })

  test('a rename to an alias value is refused in the same transaction and changes nothing', async () => {
    const sqlite = fresh()
    const store = sqlitePersonStore(sqlite)
    const ana = await store.create({ displayName: 'Ana', username: 'ana' }, 'owner', T)
    const bob = await store.create({ displayName: 'Bob', username: 'bob' }, 'owner', T)
    insertAlias(sqlite, ana.id, '6281234567890')
    const refused = await store
      .update(bob.id, { username: '6281234567890' }, 'owner', T)
      .catch((e) => e)
    expect(isIdentityError(refused, 'INVALID_PERSON')).toBe(true)
    expect((await store.get(bob.id))?.username).toBe('bob')
    expect((await store.update(bob.id, { username: 'robert' }, 'owner', T)).username).toBe('robert')
  })
})

describe('owner', () => {
  test('exactly one owner at the database level; transfer is atomic', async () => {
    const store = sqlitePersonStore(fresh())
    const o = await store.create(
      { id: 'owner', displayName: 'Vian', username: 'owner', role: 'owner' },
      null,
      T,
    )
    const a = await store.create({ displayName: 'Ana', username: 'ana' }, null, T)
    const second = await store
      .create({ displayName: 'Z', username: 'z', role: 'owner' }, null, T)
      .catch((e) => e)
    expect(second).toBeInstanceOf(Error)
    const moved = await store.transferOwner(o.id, a.id, 'owner', T + 1)
    expect(moved.owner.id).toBe(a.id)
    expect(moved.previousOwner).toMatchObject({ id: 'owner', role: 'member' })
    expect((await store.owner())?.id).toBe(a.id)
    // the new owner cannot be transferred to again, and a non-owner cannot hand over
    expect(
      isIdentityError(
        await store.transferOwner(a.id, a.id, null, T + 2).catch((e) => e),
        'INVALID_PERSON',
      ),
    ).toBe(true)
    expect(
      isIdentityError(
        await store.transferOwner(o.id, a.id, null, T + 2).catch((e) => e),
        'INVALID_PERSON',
      ),
    ).toBe(true)
    expect((await store.events(a.id))[0]).toMatchObject({
      kind: 'role',
      detail: { from: 'member', to: 'owner' },
    })
  })

  test('a transfer to a suspended person is refused and changes nothing', async () => {
    const store = sqlitePersonStore(fresh())
    await store.create(
      { id: 'owner', displayName: 'Vian', username: 'owner', role: 'owner' },
      null,
      T,
    )
    const a = await store.create({ displayName: 'Ana', username: 'ana' }, null, T)
    await store.update(a.id, { status: 'suspended' }, null, T + 1)
    expect(
      isIdentityError(
        await store.transferOwner('owner', a.id, null, T + 2).catch((e) => e),
        'INVALID_PERSON',
      ),
    ).toBe(true)
    expect((await store.owner())?.id).toBe('owner')
  })
})

describe('delete', () => {
  test('revokes (removes) credentials and legacy tokens and keeps the events', async () => {
    const sqlite = fresh()
    const store = sqlitePersonStore(sqlite)
    const a = await store.create({ displayName: 'Ana', username: 'ana' }, 'owner', T)
    const credentials = credentialsRepo(sqlite)
    credentials.create({ id: 'c1', personId: a.id, kind: 'token', label: 'x', secretHash: 'h' })
    tokensRepo(sqlite).addToken({ id: 't1', personId: a.id, label: 'old', hash: 'hh' })
    expect(await store.delete(a.id, 'owner', T + 1)).toBe(true)
    expect(credentials.find('c1')).toBeUndefined()
    expect(tokensRepo(sqlite).findByHash('hh')).toBeUndefined()
    const events = await store.events(a.id)
    expect(events.map((e) => e.kind)).toEqual(['delete', 'create'])
    expect(events[0]?.detail).toMatchObject({ credentialsRevoked: 2, username: 'ana' })
  })
})

describe('beforeDelete', () => {
  test('runs inside the delete transaction: a throw keeps the person, success hands over the heir', async () => {
    const sqlite = fresh()
    const calls: Array<[string, string]> = []
    let fail = true
    sqlite.query('CREATE TABLE probe (id TEXT)').run()
    const store = sqlitePersonStore(sqlite, {
      beforeDelete: (id, heir) => {
        calls.push([id, heir])
        sqlite.query('INSERT INTO probe (id) VALUES (?)').run(id)
        if (fail) throw new Error('boom')
      },
    })
    await store.create(
      { id: 'owner', displayName: 'Vian', username: 'owner', role: 'owner' },
      null,
      T,
    )
    const a = await store.create({ displayName: 'Ana', username: 'ana' }, 'owner', T)
    await expect(store.delete(a.id, 'owner', T + 1)).rejects.toThrow('boom')
    expect(await store.get(a.id)).toBeDefined()
    expect(sqlite.query('SELECT count(*) AS n FROM probe').get()).toEqual({ n: 0 })
    fail = false
    expect(await store.withVia('tcp').delete(a.id, 'owner', T + 2)).toBe(true)
    expect(calls.at(-1)).toEqual([a.id, 'owner'])
    expect(await store.get(a.id)).toBeUndefined()
  })
})

describe('events go to audit_events', () => {
  test('person.<kind> rows with the via of the store, kept after delete', async () => {
    const sqlite = fresh()
    const store = sqlitePersonStore(sqlite, { via: 'tcp' })
    const a = await store.create({ displayName: 'Ana', username: 'ana' }, 'owner', T)
    await store.update(a.id, { role: 'admin', status: 'suspended' }, 'owner', T + 1)
    await store.delete(a.id, 'owner', T + 2)
    const rows = sqlite
      .query<{ kind: string; via: string; actor: string }, []>(
        "SELECT kind, via, actor FROM audit_events WHERE kind LIKE 'person.%' ORDER BY id",
      )
      .all()
    expect(rows.map((r) => r.kind)).toEqual([
      'person.create',
      'person.role',
      'person.status',
      'person.delete',
    ])
    expect(new Set(rows.map((r) => r.via))).toEqual(new Set(['tcp']))
    expect(store.withVia('local')).not.toBe(store)
  })
})

describe('migration from a P8 database', () => {
  test('the owner row gets username owner and updated_at; a second run changes nothing', async () => {
    // a migrations folder with only the P8 migrations (0000..0004)
    const dir = mkdtempSync(join(tmpdir(), 'keith-p8-'))
    dirs.push(dir)
    cpSync(MIGRATIONS_DIR, dir, { recursive: true })
    const journalPath = join(dir, 'meta/_journal.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: unknown[] }
    journal.entries = journal.entries.slice(0, 5)
    writeFileSync(journalPath, JSON.stringify(journal))
    const sqlite = openDatabase(':memory:')
    open.push(sqlite)
    migrate(drizzle({ client: sqlite }), { migrationsFolder: dir })
    sqlite
      .query(
        "INSERT INTO people (id, name, role, created_at) VALUES ('owner', 'Vian', 'owner', 1234)",
      )
      .run()
    migrateDatabase(sqlite)
    migrateDatabase(sqlite)
    const row = sqlite
      .query<{ username: string; status: string; updated_at: number }, []>('SELECT * FROM people')
      .get()
    expect(row).toMatchObject({ username: 'owner', status: 'active', updated_at: 1234 })
    expect((await sqlitePersonStore(sqlite).byUsername('owner'))?.id).toBe('owner')
  })
})
