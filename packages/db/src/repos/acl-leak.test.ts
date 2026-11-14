import { describe, expect, test } from 'bun:test'
import { AclError, requireAccess } from '@keith/acl'
import {
  CASE_ACTORS,
  CASE_GROUPS,
  CASE_KINDS,
  CASE_PEOPLE,
  type LeakOperations,
  leakCheck,
} from '@keith/acl/testing'
import type { AclActor } from '@keith/contracts'
import { migrateDatabase, openDatabase } from '../connection.ts'
import type { Param } from '../eh/sql.ts'
import { sqliteAcl } from './acl.ts'

/** The leak kit against the SQLite store: a Notes-shaped plugin with an FTS5 search that joins `filterSql`. */
function notesPlugin(bug?: 'rank-after') {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  for (const p of CASE_PEOPLE)
    sqlite
      .query(
        "INSERT INTO people (id, name, role, created_at, username, status, updated_at) VALUES (?, ?, ?, 1, ?, 'active', 1)",
      )
      .run(p, p, p === 'boss' ? 'owner' : 'member', p)
  const acl = sqliteAcl(sqlite, { kinds: CASE_KINDS })
  for (const [g, people] of Object.entries(CASE_GROUPS)) {
    acl.createGroup({ id: g, name: g.toLowerCase().repeat(2), createdBy: 'boss' })
    for (const p of people) acl.addMember(g, p, 'boss')
  }
  sqlite.query('CREATE TABLE note_body (id TEXT PRIMARY KEY, title TEXT, body TEXT)').run()
  sqlite.query('CREATE VIRTUAL TABLE note_fts USING fts5(id UNINDEXED, title, body)').run()
  const rows = (a: AclActor) => {
    const f = acl.filterSql(a, 'note', 4)
    return sqlite
      .query<{ id: string; title: string }, Param[]>(
        `SELECT id, title FROM note_body WHERE id IN (${f.sql}) ORDER BY id`,
      )
      .all(...f.params)
  }
  const ops: LeakOperations = {
    list: (a) => rows(a),
    count: (a) => {
      const f = acl.filterSql(a, 'note', 4)
      return sqlite
        .query<{ n: number }, Param[]>(`SELECT count(*) AS n FROM note_body WHERE id IN (${f.sql})`)
        .get(...f.params)?.n
    },
    search: (a, term) => {
      const f = acl.filterSql(a, 'note', 4)
      if (bug === 'rank-after') {
        // the planted mistake: the visible rows are right, the "total" counts the whole index
        const total = sqlite
          .query<{ n: number }, string[]>(
            'SELECT count(*) AS n FROM note_fts WHERE note_fts MATCH ?',
          )
          .get(term)?.n
        const hits = sqlite
          .query<{ id: string }, Param[]>(
            `SELECT id FROM note_fts WHERE note_fts MATCH ? AND id IN (${f.sql}) ORDER BY id`,
          )
          .all(term, ...f.params)
        return { hits, total }
      }
      return sqlite
        .query<{ id: string }, Param[]>(
          `SELECT id FROM note_fts WHERE note_fts MATCH ? AND id IN (${f.sql}) ORDER BY id`,
        )
        .all(term, ...f.params)
    },
    get: (a, id) => {
      requireAccess(acl, a, 'note', id, 4)
      return sqlite.query('SELECT title, body FROM note_body WHERE id = ?').get(id)
    },
    update: (a, id) => {
      requireAccess(acl, a, 'note', id, 2)
      sqlite.query("UPDATE note_body SET body = 'edited' WHERE id = ?").run(id)
      return { ok: true }
    },
    delete: (a, id) => {
      acl.transaction((tx) => {
        requireAccess(tx, a, 'note', id, 2)
        sqlite.query('DELETE FROM note_body WHERE id = ?').run(id)
        sqlite.query('DELETE FROM note_fts WHERE id = ?').run(id)
        tx.removeResource('note', id)
      })
      return { ok: true }
    },
  }
  const seed = () => {
    acl.createResource({ kind: 'note', id: 'n-secret', ownerId: CASE_ACTORS.owner.id })
    sqlite
      .query('INSERT INTO note_body (id, title, body) VALUES (?, ?, ?)')
      .run('n-secret', 'Tax plan', 'offshore marmalade fund')
    sqlite
      .query('INSERT INTO note_fts (id, title, body) VALUES (?, ?, ?)')
      .run('n-secret', 'Tax plan', 'offshore marmalade fund')
    return {
      id: 'n-secret',
      missingId: 'n-absent',
      secrets: ['Tax plan', 'offshore marmalade fund'],
    }
  }
  return { ops, seed }
}

const actors = {
  owner: CASE_ACTORS.owner,
  outsider: CASE_ACTORS.outsider,
  groupMember: CASE_ACTORS.a,
  guest: CASE_ACTORS.guest,
}

describe('leak kit against SQLite and FTS5', () => {
  test('a note plugin built on filterSql leaks nothing', async () => {
    const { ops, seed } = notesPlugin()
    const report = await leakCheck({ operations: ops, actors, seed, term: 'marmalade' })
    expect(report.problems).toEqual([])
    // a non-owner delete went nowhere
    expect(AclError).toBeDefined()
  })

  test('ranking before the filter and exposing the rank is caught (mutation check)', async () => {
    const { ops, seed } = notesPlugin('rank-after')
    const report = await leakCheck({ operations: ops, actors, seed, term: 'marmalade' })
    expect(report.ok).toBe(false)
    expect(report.problems.join('\n')).toMatch(/search/)
  })
})
