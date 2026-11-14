import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  type DreamingRepo,
  dreamingRepo,
  migrateDatabase,
  openDatabase,
  type Sqlite,
} from '@keith/db'
import { stagedFileOf } from './files.ts'
import { dreamingRemoval, KEPT_DREAMS_DIR } from './removal.ts'

// The dreaming removal part (P35.5.6, ADR-0031 §8): the `dreams/<personId>/` folder moves into the kept folder on removal and
// goes back on undo; the rows of `dream_settings` and `dream_runs` are deleted at purge, and only that person's.

const PERSON = 'ana'
const OTHER = 'bob'

let dataDir: string
let kept: string
let sqlite: Sqlite
let repo: DreamingRepo

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'keith-dream-removal-'))
  kept = mkdtempSync(join(tmpdir(), 'keith-dream-kept-'))
  sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  repo = dreamingRepo(sqlite)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(kept, { recursive: true, force: true })
})

const hooks = () => dreamingRemoval({ dataDir, repo })

function writeFile(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
}

describe('dreamingRemoval', () => {
  test('keep moves the dreams folder into the kept folder; its undo moves it back', async () => {
    writeFile(stagedFileOf(dataDir, PERSON, 'run-1'), '{"plan":true}')
    const undo = await hooks().keep(PERSON, kept)

    expect(existsSync(join(dataDir, 'dreams', PERSON))).toBe(false)
    expect(readFileSync(join(kept, KEPT_DREAMS_DIR, 'staged', 'run-1.json'), 'utf8')).toBe(
      '{"plan":true}',
    )

    await undo?.()
    expect(existsSync(stagedFileOf(dataDir, PERSON, 'run-1'))).toBe(true)
    expect(existsSync(join(kept, KEPT_DREAMS_DIR))).toBe(false)
  })

  test('keep with no dreams folder keeps nothing and returns no undo', async () => {
    expect(await hooks().keep(PERSON, kept)).toBeUndefined()
    expect(existsSync(join(kept, KEPT_DREAMS_DIR))).toBe(false)
  })

  test('keep leaves the other person folder where it is', async () => {
    writeFile(stagedFileOf(dataDir, OTHER, 'run-2'), '{}')
    await hooks().keep(PERSON, kept)
    expect(existsSync(stagedFileOf(dataDir, OTHER, 'run-2'))).toBe(true)
  })

  test('purge deletes both tables rows of that person and the kept folder, and no other person row', async () => {
    const runOf = (personId: string) =>
      repo.startRun({ personId, trigger: 'schedule', mode: 'propose' })
    repo.endRun(runOf(PERSON), { status: 'staged' })
    repo.endRun(runOf(OTHER), { status: 'staged' })
    repo.setMode(PERSON, 'propose', PERSON)
    repo.setMode(OTHER, 'auto', OTHER)
    writeFile(join(kept, KEPT_DREAMS_DIR, 'staged', 'run-1.json'), '{}')

    hooks().purge(PERSON, kept)

    expect(repo.listRuns(PERSON)).toEqual([])
    expect(repo.getMode(PERSON)).toBeUndefined()
    expect(repo.listRuns(OTHER)).toHaveLength(1)
    expect(repo.getMode(OTHER)).toBe('auto')
    expect(existsSync(join(kept, KEPT_DREAMS_DIR))).toBe(false)
  })

  test('the rows stay in the database until purge (no foreign key; keep does not touch them)', async () => {
    const id = repo.startRun({ personId: PERSON, trigger: 'manual', mode: 'auto' })
    repo.endRun(id, { status: 'applied' })
    repo.setMode(PERSON, 'auto', PERSON)
    await hooks().keep(PERSON, kept)
    expect(repo.listRuns(PERSON)).toHaveLength(1)
    expect(repo.getMode(PERSON)).toBe('auto')
  })
})
