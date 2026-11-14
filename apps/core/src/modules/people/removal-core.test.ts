import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateDatabase, openDatabase, type Sqlite } from '@keith/db'
import { CORE_TABLES, coreRemoval } from './removal-core.ts'
import { createRemoval, type RemovalService, removedFolderOf } from './removed.ts'

// The core's own rows of a removed person (FD11-04): every table that names a person by session or id.
let dataDir: string
let sqlite: Sqlite
let stopped: { id: string; statusAtStop: string | undefined }[]

const count = (sql: string, ...args: string[]): number =>
  (sqlite.query(`SELECT COUNT(*) AS n FROM (${sql})`).get(...args) as { n: number }).n

/** Rows of one person, in every table the removal covers (session prefix, or the id column). */
const rowsOf = (personId: string): number => {
  const front = `front:${personId}`
  const session = `(session_id = '${front}' OR substr(session_id, 1, ${front.length + 1}) = '${front}:')`
  const parent = `(parent_session_id = '${front}' OR substr(parent_session_id, 1, ${front.length + 1}) = '${front}:')`
  return (
    count(`SELECT 1 FROM tasks WHERE ${parent}`) +
    count(`SELECT 1 FROM owner_reviews WHERE requester = ?`, personId) +
    count(`SELECT 1 FROM eh_inbox WHERE ${session}`) +
    count(`SELECT 1 FROM eh_inbox_keys WHERE ${session}`) +
    count(`SELECT 1 FROM eh_state WHERE ${session}`) +
    count(`SELECT 1 FROM eh_locks WHERE ${session}`) +
    count(`SELECT 1 FROM eh_schedules WHERE ${session}`) +
    count(`SELECT 1 FROM eh_stream_log WHERE ${session}`) +
    count(`SELECT 1 FROM eh_stream_chunks WHERE ${session}`) +
    count(`SELECT 1 FROM events WHERE ${session}`) +
    count(`SELECT 1 FROM person_pair_codes WHERE person_id = ?`, personId) +
    count(`SELECT 1 FROM eh_messages WHERE ${session}`)
  )
}

function seed(): void {
  const q = (sql: string, ...args: (string | number | null)[]) => sqlite.query(sql).run(...args)
  const people: [string, string, string][] = [
    ['owner', 'Owner', 'owner'],
    ['ana', 'Ana', 'member'],
    ['bob', 'Bob', 'member'],
  ]
  for (const [id, name, role] of people)
    q(
      "INSERT INTO people (id, name, role, created_at, username, status, updated_at) VALUES (?, ?, ?, 1, ?, 'active', 1)",
      id,
      name,
      role,
      id,
    )
  for (const who of ['ana', 'bob']) {
    const front = `front:${who}`
    q(
      "INSERT INTO tasks (id, parent_session_id, agent, description, status, steps, created_at, updated_at) VALUES (?, ?, 'cortex.research', 'read', 'running', 1, 1, 1)",
      `${who}-run`,
      who === 'ana' ? `${front}` : front,
    )
    q(
      "INSERT INTO tasks (id, parent_session_id, agent, description, status, steps, created_at, updated_at) VALUES (?, ?, 'cortex.general', 'done', 'done', 1, 1, 1)",
      `${who}-done`,
      `${front}:agent:c1`,
    )
    q(
      "INSERT INTO owner_reviews (id, requester, plugin, operation, payload, status, created_at, expires_at) VALUES (?, ?, 'p', 'o', '{\"n\":1}', 'pending', 1, 9)",
      `${who}-review`,
      who,
    )
    q(
      "INSERT INTO eh_inbox (id, session_id, kind, item) VALUES (?, ?, 'k', '{}')",
      `${who}-inbox`,
      front,
    )
    q(
      'INSERT INTO eh_inbox_keys (session_id, dedupe_key, item_id) VALUES (?, ?, ?)',
      front,
      `${who}-key`,
      `${who}-inbox`,
    )
    q("INSERT INTO eh_state (session_id, state, rev, updated_at) VALUES (?, '{}', 1, 1)", front)
    q("INSERT INTO eh_locks (session_id, owner, until) VALUES (?, 'x', 1)", front)
    q(
      "INSERT INTO eh_schedules (id, session_id, state, version, doc) VALUES (?, ?, 'active', 1, '{}')",
      `${who}-sched`,
      front,
    )
    q(
      "INSERT INTO eh_stream_log (session_id, turn_id, status, length, ttl_ms, expires_at) VALUES (?, 't1', 'done', 1, 1000, 9999999999999)",
      `${front}:agent:c1`,
    )
    q(
      "INSERT INTO eh_stream_chunks (session_id, turn_id, idx, chunk) VALUES (?, 't1', 0, 'c')",
      `${front}:agent:c1`,
    )
    q("INSERT INTO events (type, session_id, payload, created_at) VALUES ('x', ?, '{}', 1)", front)
    q(
      'INSERT INTO person_pair_codes (hash, person_id, expires_at, created_at) VALUES (?, ?, 9, 1)',
      `${who}-pair`,
      who,
    )
    q(
      'INSERT INTO pairing_codes (hash, created_by, expires_at, created_at) VALUES (?, ?, 9, 1)',
      `${who}-node-code`,
      who,
    )
    q(
      'INSERT INTO groups (id, name, created_by, created_at) VALUES (?, ?, ?, 1)',
      `${who}-group`,
      `${who}-team`,
      who,
    )
    q(
      "INSERT INTO eh_messages (session_id, id, role, parts, created_at) VALUES (?, '01', 'user', '[]', 1)",
      front,
    )
  }
}

function service(): RemovalService {
  const svc = createRemoval({ dataDir, keepMs: 1000, sqlite, now: () => 5 })
  svc.registry.registerRemoval({
    module: 'core-tables',
    onPersonRemoved: coreRemoval({
      sqlite,
      dataDir,
      heirOf: async () => 'owner',
      stopWorker: async (task) => {
        const row = sqlite.query('SELECT status FROM tasks WHERE id = ?').get(task.id) as {
          status: string
        } | null
        stopped.push({ id: task.id, statusAtStop: row?.status })
      },
    }),
  })
  return svc
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-core-removal-'))
  mkdirSync(join(dataDir, 'memory'), { recursive: true })
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  stopped = []
  seed()
})
afterEach(() => {
  sqlite.close()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('removing a person takes every core row of theirs', () => {
  test('a SQL scan finds no row of the removed person; the other person is untouched', async () => {
    const bobBefore = rowsOf('bob')
    expect(rowsOf('ana')).toBeGreaterThan(0)
    await service().keep({ id: 'ana', username: 'ana', name: 'Ana' })
    expect(rowsOf('ana')).toBe(0)
    expect(rowsOf('bob')).toBe(bobBefore)
  })

  test('a running worker of the person is stopped before anything is kept', async () => {
    await service().keep({ id: 'ana', username: 'ana', name: 'Ana' })
    // the active task was stopped while its row still said running; the done one was not touched
    expect(stopped).toEqual([{ id: 'ana-run', statusAtStop: 'running' }])
  })

  test('tasks and reviews are kept in data.json, mode 0600, and deleted from the database', async () => {
    await service().keep({ id: 'ana', username: 'ana', name: 'Ana' })
    const file = join(removedFolderOf(dataDir, 'ana'), 'data.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    const data = JSON.parse(readFileSync(file, 'utf8')) as {
      tasks: { id: string }[]
      reviews: { id: string; payload: string }[]
    }
    expect(data.tasks.map((t) => t.id).sort()).toEqual(['ana-done', 'ana-run'])
    expect(data.reviews.map((r) => r.id)).toEqual(['ana-review'])
    expect(data.reviews[0]?.payload).toBe('{"n":1}')
  })

  test('the rows that name the person as creator move to the owner; the budget and audit are not touched', async () => {
    await service().keep({ id: 'ana', username: 'ana', name: 'Ana' })
    const pair = sqlite
      .query("SELECT created_by FROM pairing_codes WHERE hash = 'ana-node-code'")
      .get() as {
      created_by: string
    }
    const group = sqlite.query("SELECT created_by FROM groups WHERE id = 'ana-group'").get() as {
      created_by: string
    }
    expect(pair.created_by).toBe('owner')
    expect(group.created_by).toBe('owner')
    const bob = sqlite
      .query("SELECT created_by FROM pairing_codes WHERE hash = 'bob-node-code'")
      .get() as {
      created_by: string
    }
    expect(bob.created_by).toBe('bob')
  })

  test('undo puts every row back and removes data.json', async () => {
    const before = rowsOf('ana')
    const kept = await service().keep({ id: 'ana', username: 'ana', name: 'Ana' })
    await kept.undo()
    expect(rowsOf('ana')).toBe(before)
    expect(existsSync(join(removedFolderOf(dataDir, 'ana'), 'data.json'))).toBe(false)
    expect(
      (
        sqlite.query("SELECT created_by FROM groups WHERE id = 'ana-group'").get() as {
          created_by: string
        }
      ).created_by,
    ).toBe('ana')
  })

  test('export of a removed person writes the same data.json, and export of a live one reads the rows', async () => {
    const svc = service()
    const live = join(dataDir, 'live')
    mkdirSync(live)
    await svc.exportData('bob', live)
    const bobData = JSON.parse(readFileSync(join(live, 'data.json'), 'utf8')) as {
      tasks: unknown[]
    }
    expect(bobData.tasks.length).toBe(2)
    await svc.keep({ id: 'ana', username: 'ana', name: 'Ana' })
    const kept = join(dataDir, 'kept')
    mkdirSync(kept)
    await svc.exportData('ana', kept)
    const anaData = JSON.parse(readFileSync(join(kept, 'data.json'), 'utf8')) as {
      tasks: { id: string }[]
      reviews: unknown[]
    }
    expect(anaData.tasks.map((t) => t.id).sort()).toEqual(['ana-done', 'ana-run'])
    expect(anaData.reviews.length).toBe(1)
  })
})

describe('the table inventory', () => {
  // a table that names a person by session, requester, parent session or creator must be handled here, or be
  // listed with the reason another module handles it; a new table with such a column fails this test
  const HANDLED_ELSEWHERE: Record<string, string> = {
    eh_messages: 'the conversation part of the removal (removed.ts, conversationRemoval)',
    people: 'a creator reference on another person (who added whom): not the removed person’s data',
    person_identifiers: 'deleted by the store with the person (person-store.ts delete)',
    nodes: 'the creator of a node is the owner who paired it: nodes are not per person',
    protocols:
      'protocols a person owns, with their runs, proposals and agenda: the hypothalamus removal (hypothalamus/removal.ts)',
    llm_calls:
      'the activity logs part (audit/activity-logs/removal.ts): the figures stay until their period, purge deletes the sessions’ calls',
    resource_acl:
      'ACL entries move with the resources (acl.removePerson, the store’s beforeDelete)',
  }

  test('every table with a session, requester, parent session or creator column is handled', () => {
    const names = (
      sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
        name: string
      }[]
    ).map((r) => r.name)
    const person = new Set(['session_id', 'parent_session_id', 'requester', 'created_by'])
    const withColumn = names.filter((name) => {
      const cols = sqlite.query(`PRAGMA table_info(${name})`).all() as { name: string }[]
      return cols.some((c) => person.has(c.name))
    })
    const missing = withColumn.filter(
      (name) => !CORE_TABLES.includes(name) && HANDLED_ELSEWHERE[name] === undefined,
    )
    expect(missing).toEqual([])
    // and nothing is listed twice for no reason: every core table exists
    for (const table of CORE_TABLES) expect(names).toContain(table)
  })
})
