import { describe, expect, test } from 'bun:test'
import { AclError, check, memoryAcl, requireAccess } from '@keith/acl'
import {
  CASE_ACTOR_NAMES,
  CASE_ACTORS,
  CASE_GROUPS,
  CASE_KINDS,
  CASE_PEOPLE,
  SHARING_CASES,
} from '@keith/acl/testing'
import { type AclActor, Bits, type Entry } from '@keith/contracts'
import { migrateDatabase, openDatabase } from '../connection.ts'
import type { Sqlite } from '../eh/sql.ts'
import { type SqliteAcl, sqliteAcl } from './acl.ts'

function world(): { sqlite: Sqlite; acl: SqliteAcl } {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  for (const p of CASE_PEOPLE) {
    sqlite
      .query(
        "INSERT INTO people (id, name, role, created_at, username, status, updated_at) VALUES (?, ?, ?, 1, ?, 'active', 1)",
      )
      .run(p, p, p === 'boss' ? 'owner' : 'member', p)
  }
  const acl = sqliteAcl(sqlite, { kinds: CASE_KINDS })
  for (const [group, people] of Object.entries(CASE_GROUPS)) {
    acl.createGroup({ id: group, name: group.toLowerCase().repeat(2), createdBy: 'boss' })
    for (const p of people) acl.addMember(group, p, 'boss')
  }
  return { sqlite, acl }
}

const setStatus = (sqlite: Sqlite, id: string, status: string) =>
  sqlite.query('UPDATE people SET status = ? WHERE id = ?').run(status, id)

describe('the six cases against SQLite: check, visibleIds and filterSql agree', () => {
  for (const c of SHARING_CASES) {
    test(c.name, () => {
      const { sqlite, acl } = world()
      acl.createResource({
        kind: 'note',
        id: 'n1',
        ownerId: 'olga',
        mode: c.mode,
        entries: c.entries,
      })
      for (const name of CASE_ACTOR_NAMES) {
        const actor = CASE_ACTORS[name]
        const expected = c.readers.includes(name) || name === 'boss'
        expect(acl.check(actor, 'note', 'n1', Bits.R).allowed).toBe(expected)
        expect(acl.visibleIds(actor, 'note', Bits.R)).toEqual(expected ? ['n1'] : [])
        expect(acl.check(actor, 'note', 'n1', Bits.W).allowed).toBe(name === 'owner')
        expect(acl.visibleIds(actor, 'note', Bits.W)).toEqual(name === 'owner' ? ['n1'] : [])
        // the audit hint: rows only the root read shows
        const f = acl.filterSql(actor, 'note', Bits.R, { rootAccess: false })
        const rows = sqlite.query<{ id: string }, never[]>(f.sql).all(...(f.params as never[]))
        expect(rows.length === 1).toBe(c.readers.includes(name))
      }
    })
  }
})

describe('SQL equals the evaluator over random resources, every bit combination', () => {
  function rng(seed: number): () => number {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }
  test('1200 resources, nine actors plus a suspended one, all wants', () => {
    const { sqlite, acl } = world()
    setStatus(sqlite, 'duta', 'suspended')
    const next = rng(150)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T
    const subjects = [
      ...CASE_PEOPLE.map((p) => `user:${p}`),
      'user:ghost',
      'group:A',
      'group:B',
      'group:C',
      '@users',
      '@public',
    ]
    const valid: Record<string, number> = { note: 6, notebook: 7, tool: 5, reminder: 7 }
    const kinds = Object.keys(valid)
    for (let i = 0; i < 1200; i++) {
      const kind = pick(kinds)
      const v = valid[kind] as number
      const entries: Entry[] = []
      for (let k = 0, n = Math.floor(next() * 5); k < n; k++) {
        entries.push({
          subject: pick(subjects),
          bits: (1 + Math.floor(next() * 7)) & v || v,
          effect: next() < 0.3 ? 'deny' : 'allow',
        })
      }
      const b = () => Math.floor(next() * 8) & v
      acl.createResource({
        kind,
        id: `r${i}`,
        ownerId: pick(CASE_PEOPLE),
        groupId: next() < 0.5 ? pick(['A', 'B', 'C']) : null,
        mode: (b() << 6) | (b() << 3) | b(),
        entries,
      })
    }
    const actors: AclActor[] = [
      ...CASE_ACTOR_NAMES.map((n) => CASE_ACTORS[n]),
      { kind: 'user', id: 'ghost', role: 'owner' },
      { kind: 'guest', id: 'guest:2', role: null },
    ]
    for (const actor of actors) {
      for (const kind of kinds) {
        for (let want = 0; want <= 8; want++) {
          const expected: string[] = []
          for (let i = 0; i < 1200; i++) {
            const r = acl.getResource(kind, `r${i}`)
            if (r === undefined) continue
            const d = check({ actor, resource: r, want, kinds: CASE_KINDS, membership: acl })
            expect(acl.check(actor, kind, r.id, want)).toEqual(d)
            if (d.allowed) expected.push(r.id)
          }
          expect(acl.visibleIds(actor, kind, want)).toEqual(expected.sort())
        }
      }
    }
  })
})

describe('a Notes-shaped table: filters apply before order, limit, count and ranking', () => {
  function notes() {
    const { sqlite, acl } = world()
    sqlite.exec(`
      CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE VIRTUAL TABLE notes_fts USING fts5(title, body, content='notes', content_rowid='rowid');
    `)
    const add = (
      id: string,
      title: string,
      body: string,
      at: number,
      owner: string,
      mode: number,
      entries: Entry[] = [],
    ) => {
      sqlite
        .query('INSERT INTO notes (id, title, body, created_at) VALUES (?, ?, ?, ?)')
        .run(id, title, body, at)
      sqlite.exec(
        `INSERT INTO notes_fts (rowid, title, body) SELECT rowid, title, body FROM notes WHERE id = '${id}'`,
      )
      acl.createResource({ kind: 'note', id, ownerId: owner, mode, entries })
    }
    // olga's private notes rank best for "harbor"; duta's shared one ranks lower
    add('hidden1', 'harbor harbor harbor', 'harbor harbor secret plan', 10, 'olga', 0o600)
    add('hidden2', 'harbor secret', 'harbor harbor', 20, 'olga', 0o600)
    add('shared1', 'harbor trip', 'a harbor visit', 30, 'olga', 0o600, [
      { subject: 'user:duta', bits: 4, effect: 'allow' },
    ])
    add('mine1', 'harbor list', 'harbor notes', 40, 'duta', 0o600)
    add('pub1', 'harbor public', 'open harbor', 50, 'olga', 0o604)
    return { sqlite, acl }
  }
  const duta = CASE_ACTORS.duta

  test('ordering and limit apply after the filter: top-k is filled by visible rows only', () => {
    const { sqlite, acl } = notes()
    const f = acl.filterSql(duta, 'note', Bits.R)
    const rows = sqlite
      .query<{ id: string }, never[]>(
        `SELECT id FROM notes WHERE id IN (${f.sql}) ORDER BY created_at DESC LIMIT 2`,
      )
      .all(...(f.params as never[]))
    expect(rows.map((r) => r.id)).toEqual(['pub1', 'mine1'])
    // a post-filter of the global top 2 would have returned fewer
    const global = sqlite
      .query<{ id: string }, []>('SELECT id FROM notes ORDER BY created_at ASC LIMIT 2')
      .all()
    expect(global.map((r) => r.id)).toEqual(['hidden1', 'hidden2'])
  })

  test('cursors page through visible rows only, with no gaps or hidden ids', () => {
    const { sqlite, acl } = notes()
    const f = acl.filterSql(duta, 'note', Bits.R)
    const seen: string[] = []
    let cursor = 0
    for (;;) {
      const page = sqlite
        .query<{ id: string; created_at: number }, never[]>(
          `SELECT id, created_at FROM notes WHERE id IN (${f.sql}) AND created_at > ? ORDER BY created_at LIMIT 2`,
        )
        .all(...([...f.params, cursor] as never[]))
      if (page.length === 0) break
      seen.push(...page.map((p) => p.id))
      cursor = page[page.length - 1]?.created_at ?? cursor
    }
    expect(seen).toEqual(['shared1', 'mine1', 'pub1'])
  })

  test('counts count visible rows only', () => {
    const { sqlite, acl } = notes()
    const count = (actor: AclActor) => {
      const f = acl.filterSql(actor, 'note', Bits.R)
      return sqlite
        .query<{ n: number }, never[]>(`SELECT count(*) AS n FROM notes WHERE id IN (${f.sql})`)
        .get(...(f.params as never[]))?.n
    }
    expect(count(duta)).toBe(3)
    expect(count(CASE_ACTORS.owner)).toBe(4) // olga owns four, duta's is not hers
    expect(count(CASE_ACTORS.guest)).toBe(1)
    expect(count(CASE_ACTORS.outsider)).toBe(1)
  })

  test('FTS ranking, snippet and top-k never touch a hidden row', () => {
    const { sqlite, acl } = notes()
    const f = acl.filterSql(duta, 'note', Bits.R)
    const rows = sqlite
      .query<{ id: string; snip: string }, never[]>(
        `SELECT n.id AS id, snippet(notes_fts, 1, '[', ']', '…', 6) AS snip
           FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
          WHERE notes_fts MATCH ? AND n.id IN (${f.sql})
          ORDER BY bm25(notes_fts) LIMIT 2`,
      )
      .all(...(['harbor', ...f.params] as never[]))
    expect(rows).toHaveLength(2) // filled from visible rows, not cut to fewer by a post-filter
    for (const r of rows) {
      expect(['shared1', 'mine1', 'pub1']).toContain(r.id)
      expect(r.snip).not.toContain('secret')
    }
    // the same query for an outsider never returns duta's or olga's private notes
    const g = acl.filterSql(CASE_ACTORS.outsider, 'note', Bits.R)
    const other = sqlite
      .query<{ id: string }, never[]>(
        `SELECT n.id AS id FROM notes_fts JOIN notes n ON n.rowid = notes_fts.rowid
          WHERE notes_fts MATCH ? AND n.id IN (${g.sql}) ORDER BY bm25(notes_fts)`,
      )
      .all(...(['secret', ...g.params] as never[]))
    expect(other).toEqual([])
  })

  test('a denied read looks exactly like a missing one', () => {
    const { acl } = notes()
    const grab = (id: string) => {
      try {
        requireAccess(acl, duta, 'note', id, Bits.R)
      } catch (e) {
        return e as AclError
      }
      throw new Error('allowed')
    }
    const denied = grab('hidden1')
    const missing = grab('no-such-note')
    expect([denied.code, denied.message, denied.name]).toEqual([
      missing.code,
      missing.message,
      missing.name,
    ])
    expect(denied.message).not.toContain('hidden1')
  })

  test('bound parameters only: a hostile id or kind cannot change the statement', () => {
    const { sqlite, acl } = notes()
    const hostile: AclActor = { kind: 'user', id: "x' OR '1'='1", role: 'member' }
    const f = acl.filterSql(hostile, 'note', Bits.R)
    expect(f.sql).not.toContain("OR '1'")
    expect(sqlite.query(`SELECT id FROM (${f.sql})`).all(...(f.params as never[]))).toEqual([])
    expect(acl.filterSql(duta, "note' OR 1=1 --", Bits.R).sql).toContain('WHERE 0')
    expect(acl.visibleIds(duta, "note' OR 1=1 --", Bits.R)).toEqual([])
  })
})

describe('writes, groups and transactions', () => {
  test('create and entries survive a round trip; deleting the resource deletes its entries', () => {
    const { sqlite, acl } = world()
    acl.createResource({ kind: 'note', id: 'n1', ownerId: 'olga' })
    acl.setEntry('note', 'n1', { subject: 'group:A', bits: 4, effect: 'allow' }, 'olga')
    acl.setEntry('note', 'n1', { subject: 'user:duta', bits: 4, effect: 'deny' }, 'olga')
    acl.setEntry('note', 'n1', { subject: 'user:duta', bits: 4, effect: 'deny' }, 'olga') // replaced
    expect(acl.getResource('note', 'n1')?.entries).toHaveLength(2)
    expect(acl.groupUsage('A')).toBe(1)
    expect(() => acl.deleteGroup('A')).toThrow(AclError)
    expect(acl.removeResource('note', 'n1')).toBe(true)
    expect(sqlite.query('SELECT count(*) AS n FROM resource_acl').get()).toEqual({ n: 0 })
    expect(acl.deleteGroup('A')).toBe(true)
    expect(acl.members('A')).toEqual([])
  })

  test('refusals: x on a leaf, unknown kind, duplicate id, unknown group', () => {
    const { acl } = world()
    const code = (fn: () => unknown) => {
      try {
        fn()
      } catch (e) {
        return (e as AclError).code
      }
      return 'ok'
    }
    expect(
      code(() => acl.createResource({ kind: 'note', id: 'n', ownerId: 'olga', mode: 0o610 })),
    ).toBe('INVALID')
    expect(code(() => acl.createResource({ kind: 'mystery', id: 'n', ownerId: 'olga' }))).toBe(
      'INVALID',
    )
    expect(
      code(() =>
        acl.createResource({
          kind: 'note',
          id: 'n',
          ownerId: 'olga',
          groupId: 'nope',
          mode: 0o640,
        }),
      ),
    ).toBe('INVALID')
    acl.createResource({ kind: 'note', id: 'n', ownerId: 'olga' })
    expect(code(() => acl.createResource({ kind: 'note', id: 'n', ownerId: 'olga' }))).toBe(
      'CONFLICT',
    )
    expect(code(() => acl.createGroup({ id: 'z', name: 'aa', createdBy: 'boss' }))).toBe('CONFLICT')
    expect(code(() => acl.addMember('nope', 'olga', 'boss'))).toBe('INVALID')
  })

  test('membership and status are read at check time', () => {
    const { sqlite, acl } = world()
    acl.createResource({
      kind: 'note',
      id: 'n1',
      ownerId: 'olga',
      entries: [{ subject: 'group:A', bits: 4, effect: 'allow' }],
    })
    const a = CASE_ACTORS.a
    expect(acl.check(a, 'note', 'n1', Bits.R).allowed).toBe(true)
    acl.removeMember('A', 'mia')
    expect(acl.visibleIds(a, 'note', Bits.R)).toEqual([])
    acl.addMember('A', 'mia', 'boss')
    expect(acl.visibleIds(a, 'note', Bits.R)).toEqual(['n1'])
    setStatus(sqlite, 'mia', 'suspended')
    expect(acl.check(a, 'note', 'n1', Bits.R).allowed).toBe(false)
    expect(acl.visibleIds(a, 'note', Bits.R)).toEqual([])
  })

  test('a transaction rolls back every write on a throw, and a check inside sees pending writes', () => {
    const { acl } = world()
    expect(() =>
      acl.transaction((tx) => {
        tx.createResource({ kind: 'note', id: 'n1', ownerId: 'olga' })
        tx.setEntry('note', 'n1', { subject: 'user:duta', bits: 4, effect: 'allow' }, 'olga')
        expect(tx.check(CASE_ACTORS.duta, 'note', 'n1', Bits.R).allowed).toBe(true)
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(acl.getResource('note', 'n1')).toBeUndefined()
    acl.transaction((tx) => {
      tx.createResource({ kind: 'note', id: 'n2', ownerId: 'olga' })
      // nested calls reuse the surrounding transaction instead of opening another
      tx.setMode('note', 'n2', 0o640)
    })
    expect(acl.getResource('note', 'n2')?.mode).toBe(0o640)
  })

  test('removePerson hands resources to the heir and drops entries and memberships', () => {
    for (const mk of [() => world().acl, () => memoryAcl({ kinds: CASE_KINDS })]) {
      const acl = mk()
      if ('activate' in acl)
        for (const p of CASE_PEOPLE) (acl as { activate(p: string): void }).activate(p)
      acl.createGroup({ id: 'Z', name: 'zz', createdBy: 'boss' })
      acl.addMember('Z', 'duta', 'boss')
      acl.createResource({ kind: 'note', id: 'n1', ownerId: 'duta' })
      acl.createResource({
        kind: 'note',
        id: 'n2',
        ownerId: 'olga',
        entries: [{ subject: 'user:duta', bits: 4, effect: 'allow' }],
      })
      expect(acl.removePerson('duta', 'boss')).toBe(1)
      expect(acl.getResource('note', 'n1')?.ownerId).toBe('boss')
      expect(acl.getResource('note', 'n2')?.entries).toEqual([])
      expect(acl.members('Z')).toEqual([])
    }
  })

  test('the in-memory store and SQLite give the same answers for the cases', () => {
    for (const c of SHARING_CASES) {
      const { acl } = world()
      const mem = memoryAcl({ kinds: CASE_KINDS })
      for (const p of CASE_PEOPLE) mem.activate(p)
      for (const [g, people] of Object.entries(CASE_GROUPS)) {
        mem.createGroup({ id: g, name: g.toLowerCase().repeat(2), createdBy: 'boss' })
        for (const p of people) mem.addMember(g, p, 'boss')
      }
      for (const s of [acl, mem]) {
        s.createResource({
          kind: 'note',
          id: 'n1',
          ownerId: 'olga',
          mode: c.mode,
          entries: c.entries,
        })
      }
      for (const name of CASE_ACTOR_NAMES) {
        for (const want of [1, 2, 4, 6]) {
          expect(acl.check(CASE_ACTORS[name], 'note', 'n1', want)).toEqual(
            mem.check(CASE_ACTORS[name], 'note', 'n1', want),
          )
        }
      }
    }
  })
})
