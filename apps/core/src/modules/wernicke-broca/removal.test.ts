import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { frontGenerationsRepo, migrateDatabase, openDatabase, type Sqlite } from '@keith/db'
import { createRemoval, type RemovalService, removedFolderOf } from '../people/index.ts'
import { type FrontGenerations, frontGenerations } from './generations.ts'
import { wernickeBrocaRemoval } from './removal.ts'

// The wernicke-broca share of a removed person (P34.2.4, ADR-0030 §11): keep leaves the generation row, purge deletes it,
// and the kept conversations hold the messages of every generation of the person (g0 and g1) and nobody else's.

const DAY = 86_400_000
let dataDir: string
let sqlite: Sqlite
let clock: number
let removal: RemovalService
let map: FrontGenerations

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-wb-rm-'))
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  clock = 1_000
  removal = createRemoval({ dataDir, keepMs: 30 * DAY, sqlite, now: () => clock })
  const repo = frontGenerationsRepo(sqlite)
  map = frontGenerations(repo)
  map.load()
  removal.registry.registerRemoval({
    module: 'wernicke-broca',
    onPersonRemoved: wernickeBrocaRemoval({ generations: repo, map }),
  })
  const insert = sqlite.query(
    'INSERT INTO eh_messages (session_id, id, role, parts, metadata, created_at) VALUES (?, ?, ?, ?, NULL, 1)',
  )
  insert.run('front:ana', '01', 'user', '[{"text":"g0 ana"}]')
  insert.run('front:ana:g1', '02', 'user', '[{"text":"g1 ana"}]')
  insert.run('front:ana:g1:agent:c1', '03', 'assistant', '[{"text":"g1 worker"}]')
  insert.run('front:anab', '04', 'user', '[{"text":"bob-like other person"}]')
  map.bump('ana', 500)
  map.bump('ana', 600)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

const rowOf = (personId: string) =>
  sqlite
    .query<{ n: number }, [string]>(
      'SELECT COUNT(*) AS n FROM front_generations WHERE person_id = ?',
    )
    .get(personId)?.n

describe('keep and purge of the generation rows', () => {
  test('keep leaves the generation row where it is', async () => {
    const folder = removedFolderOf(dataDir, 'ana')
    await removal.keep({ id: 'ana', username: 'ana', name: 'Ana' })
    expect(existsSync(folder)).toBe(true)
    expect(rowOf('ana')).toBe(1)
    expect(map.current('ana')).toBe(2)
  })

  test('purge deletes the row and drops the person from the map', async () => {
    await removal.keep({ id: 'ana', username: 'ana', name: 'Ana' })
    clock += 31 * DAY
    const result = await removal.purge()
    expect(result.purged).toEqual(['ana'])
    expect(rowOf('ana')).toBe(0)
    expect(map.current('ana')).toBe(0)
  })
})

describe('the conversations of every generation', () => {
  test('conversation.jsonl holds the messages of g0 and g1 (and their workers), not another person', async () => {
    await removal.keep({ id: 'ana', username: 'ana', name: 'Ana' })
    const lines = readFileSync(join(removedFolderOf(dataDir, 'ana'), 'conversation.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { session_id: string })
    expect(lines.map((row) => row.session_id).sort()).toEqual([
      'front:ana',
      'front:ana:g1',
      'front:ana:g1:agent:c1',
    ])
  })
})
