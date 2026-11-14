import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import type { Sqlite } from '../eh/sql.ts'
import { dreamingRepo } from './dreaming.ts'

// The memory dreaming rows (docs/specs/dreaming.md, P35.2.1): one mode row per person, one row per run, the cadence anchor
// ignores `skipped`, the cursor comes from the latest `applied` or `staged` run, and the purge deletes both tables of a person.

const db = (): Sqlite => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

const count = (sqlite: Sqlite, table: string): number =>
  sqlite.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0

describe('dreamingRepo: modes', () => {
  test('a person without a row has no mode; setMode stores it and a second write replaces it in one row', () => {
    const sqlite = db()
    const repo = dreamingRepo(sqlite, { now: () => 100 })
    expect(repo.getMode('ana')).toBeUndefined()

    expect(repo.setMode('ana', 'propose', 'ana')).toBe('propose')
    expect(repo.setMode('ana', 'auto', 'owner')).toBe('auto')
    expect(repo.getMode('ana')).toBe('auto')
    expect(count(sqlite, 'dream_settings')).toBe(1)
    expect(
      sqlite
        .query<{ updated_by: string; updated_at: number }, []>(
          'SELECT updated_by, updated_at FROM dream_settings',
        )
        .get(),
    ).toEqual({ updated_by: 'owner', updated_at: 100 })
  })

  test('a mode outside the list is refused by the contract parse and the CHECK', () => {
    const sqlite = db()
    const repo = dreamingRepo(sqlite)
    expect(() => repo.setMode('ana', 'sometimes' as never, 'ana')).toThrow()
    expect(() =>
      sqlite.exec(
        `INSERT INTO dream_settings (person_id, mode, updated_at, updated_by) VALUES ('ana', 'bogus', 1, 'ana')`,
      ),
    ).toThrow(/CHECK constraint failed/)
    expect(count(sqlite, 'dream_settings')).toBe(0)
  })
})

describe('dreamingRepo: runs', () => {
  test('failRunning ends every running row as failed interrupted and returns them; finished rows stay', () => {
    let at = 1_000
    const sqlite = db()
    const repo = dreamingRepo(sqlite, { now: () => at })
    const old = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'propose' })
    at = 5_000
    const recent = repo.startRun({ personId: 'ana', trigger: 'manual', mode: 'propose' })
    const done = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'propose' })
    repo.endRun(done, { status: 'staged' })
    at = 6_000
    const ended = repo.failRunning()
    expect(ended.map((r) => [r.id, r.personId, r.trigger]).sort()).toEqual(
      [
        [old, 'ana', 'schedule'],
        [recent, 'ana', 'manual'],
      ].sort(),
    )
    const byId = new Map(repo.listRuns('ana').map((r) => [r.id, r]))
    expect(byId.get(old)).toMatchObject({ status: 'failed', reason: 'interrupted', endedAt: 6_000 })
    expect(byId.get(recent)).toMatchObject({ status: 'failed', reason: 'interrupted' })
    expect(byId.get(done)?.status).toBe('staged')
    expect(repo.failRunning()).toEqual([])
  })

  test('startRun inserts a running row with a UUIDv7 id; endRun sets the final state', () => {
    let at = 1_000
    const sqlite = db()
    const repo = dreamingRepo(sqlite, { now: () => at })
    const id = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'propose' })
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/)

    const started = repo.listRuns('ana')
    expect(started).toEqual([
      {
        id,
        personId: 'ana',
        trigger: 'schedule',
        mode: 'propose',
        status: 'running',
        reason: null,
        startedAt: 1_000,
        endedAt: null,
        counts: { candidates: 0, promoted: 0, merged: 0, superseded: 0, dropped: 0 },
        cursor: {},
        undoUntil: null,
      },
    ])

    at = 2_000
    expect(
      repo.endRun(id, {
        status: 'staged',
        counts: { candidates: 3, promoted: 1, merged: 0, superseded: 1, dropped: 1 },
        cursor: { s1: 'm9' },
      }),
    ).toBe(true)
    const done = repo.listRuns('ana')[0]
    expect(done).toMatchObject({
      status: 'staged',
      endedAt: 2_000,
      counts: { candidates: 3, promoted: 1, merged: 0, superseded: 1, dropped: 1 },
      cursor: { s1: 'm9' },
      undoUntil: null,
    })
  })

  test('endRun keeps the counts and cursor it was not given, and reports an unknown id', () => {
    const repo = dreamingRepo(db())
    const id = repo.startRun({ personId: 'ana', trigger: 'manual', mode: 'auto' })
    repo.endRun(id, { status: 'applied', cursor: { s1: 'm1' }, undoUntil: 604_800_000 })
    repo.endRun(id, { status: 'applied', reason: null })
    expect(repo.listRuns('ana')[0]).toMatchObject({ cursor: { s1: 'm1' }, undoUntil: null })
    expect(repo.endRun('00000000-0000-7000-8000-000000000000', { status: 'failed' })).toBe(false)
  })

  test('a status, a trigger or a mode outside the lists is refused by the CHECKs', () => {
    const sqlite = db()
    expect(() =>
      sqlite.exec(
        `INSERT INTO dream_runs (id, person_id, trigger, mode, status, started_at)
         VALUES ('r1', 'ana', 'schedule', 'auto', 'done', 1)`,
      ),
    ).toThrow(/CHECK constraint failed/)
    expect(() =>
      sqlite.exec(
        `INSERT INTO dream_runs (id, person_id, trigger, mode, status, started_at)
         VALUES ('r2', 'ana', 'hourly', 'auto', 'running', 1)`,
      ),
    ).toThrow(/CHECK constraint failed/)
  })

  test('latestStarted is the latest start of a run that is not skipped', () => {
    let at = 100
    const repo = dreamingRepo(db(), { now: () => at })
    expect(repo.latestStarted('ana')).toBeUndefined()

    const first = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(first, { status: 'applied' })
    at = 200
    const skipped = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(skipped, { status: 'skipped' })
    expect(repo.latestStarted('ana')).toBe(100)

    at = 300
    const refused = repo.startRun({ personId: 'ana', trigger: 'manual', mode: 'auto' })
    repo.endRun(refused, { status: 'refused', reason: 'too-soon' })
    expect(repo.latestStarted('ana')).toBe(300)
    expect(repo.latestStarted('bob')).toBeUndefined()
  })

  test('cursorOf is the cursor of the latest applied or staged run; refused, failed and rejected runs do not move it', () => {
    let at = 100
    const repo = dreamingRepo(db(), { now: () => at })
    expect(repo.cursorOf('ana')).toBeUndefined()

    const a = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(a, { status: 'applied', cursor: { s1: 'm1' } })
    at = 200
    const b = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'propose' })
    repo.endRun(b, { status: 'staged', cursor: { s1: 'm2', s2: 'x9' } })
    at = 300
    const c = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(c, { status: 'failed', reason: 'judge', cursor: { s1: 'm99' } })
    at = 400
    const d = repo.startRun({ personId: 'ana', trigger: 'manual', mode: 'auto' })
    repo.endRun(d, { status: 'rejected', cursor: { s1: 'm100' } })
    at = 500
    const e = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(e, { status: 'refused', reason: 'budget' })

    expect(repo.cursorOf('ana')).toEqual({ s1: 'm2', s2: 'x9' })
    expect(repo.cursorOf('bob')).toBeUndefined()
  })

  test('a failed run moves the cursor only when it holds a resume point (failedBatch); its batch is kept for one retry', () => {
    let at = 100
    const repo = dreamingRepo(db(), { now: () => at })
    const a = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(a, { status: 'applied', cursor: { s1: 'm1' } })
    at = 200
    const b = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(b, {
      status: 'failed',
      reason: 'judge',
      cursor: { s1: 'm1' },
      failedBatch: ['m2', 'm3'],
    })
    // the resume point is the cursor of the run, without the reserved key; the batch is what the judge failed on
    expect(repo.cursorOf('ana')).toEqual({ s1: 'm1' })
    expect(repo.failedBatchOf('ana')).toEqual(['m2', 'm3'])
    at = 300
    const c = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(c, { status: 'failed', reason: 'judge', cursor: { s1: 'm3' }, failedBatch: [] })
    // a skipped batch: the cursor moved, and nothing is left to retry
    expect(repo.cursorOf('ana')).toEqual({ s1: 'm3' })
    expect(repo.failedBatchOf('ana')).toBeUndefined()
    at = 400
    const d = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(d, {
      status: 'failed',
      reason: 'turn-error',
      cursor: { s1: 'm3' },
      failedBatch: ['m4'],
    })
    at = 500
    const e = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(e, { status: 'applied', cursor: { s1: 'm5' } })
    expect(repo.failedBatchOf('ana')).toBeUndefined()
    expect(repo.cursorOf('ana')).toEqual({ s1: 'm5' })
  })

  test('a plain failed run (no resume point) and a refused one leave the cursor and the batch alone', () => {
    let at = 100
    const repo = dreamingRepo(db(), { now: () => at })
    const a = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(a, { status: 'applied', cursor: { s1: 'm1' } })
    at = 200
    const b = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(b, { status: 'failed' })
    at = 300
    const c = repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.endRun(c, { status: 'refused', reason: 'budget' })
    expect(repo.cursorOf('ana')).toEqual({ s1: 'm1' })
    expect(repo.failedBatchOf('ana')).toBeUndefined()
  })

  test('listRuns is newest first and honours the limit; a run of another person is not listed', () => {
    let at = 0
    const repo = dreamingRepo(db(), { now: () => at })
    for (const n of [1, 2, 3]) {
      at = n * 10
      repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'off' })
    }
    repo.startRun({ personId: 'bob', trigger: 'schedule', mode: 'off' })
    expect(repo.listRuns('ana').map((r) => r.startedAt)).toEqual([30, 20, 10])
    expect(repo.listRuns('ana', 2)).toHaveLength(2)
  })

  test('deleteForPerson removes the mode and the runs of one person and counts them', () => {
    const sqlite = db()
    const repo = dreamingRepo(sqlite)
    repo.setMode('ana', 'auto', 'ana')
    repo.setMode('bob', 'off', 'bob')
    repo.startRun({ personId: 'ana', trigger: 'schedule', mode: 'auto' })
    repo.startRun({ personId: 'ana', trigger: 'manual', mode: 'auto' })
    repo.startRun({ personId: 'bob', trigger: 'schedule', mode: 'off' })

    expect(repo.deleteForPerson('ana')).toEqual({ settings: 1, runs: 2 })
    expect(repo.getMode('ana')).toBeUndefined()
    expect(repo.listRuns('ana')).toEqual([])
    expect(repo.getMode('bob')).toBe('off')
    expect(repo.listRuns('bob')).toHaveLength(1)
    expect(repo.deleteForPerson('ana')).toEqual({ settings: 0, runs: 0 })
  })
})
