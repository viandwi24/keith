import { describe, expect, test } from 'bun:test'
import { migrateDatabase, openDatabase } from '../connection.ts'
import type { Sqlite } from '../eh/sql.ts'
import { successionRepo } from './succession.ts'

// The succession state row (docs/specs/succession.md, "States"): the idle default, one start per run, the compare-and-set
// of every move, the rollback of a transaction, and the two CHECK constraints of the table.

const db = (): Sqlite => {
  const sqlite = openDatabase(':memory:')
  migrateDatabase(sqlite)
  return sqlite
}

const START = { runId: 'run-1', heir: 'ana', startedAt: 1_000, lastSignAt: 900 }

describe('successionRepo', () => {
  test('no row reads as idle, and nothing is written by reading it', () => {
    const sqlite = db()
    const repo = successionRepo(sqlite)
    expect(repo.get()).toEqual({
      state: 'idle',
      runId: null,
      heir: null,
      startedAt: null,
      graceStartedAt: null,
      claimableAt: null,
      lastSignAt: null,
      updatedAt: 0,
    })
    expect(sqlite.query('SELECT COUNT(*) AS n FROM succession_state').get()).toEqual({ n: 0 })
  })

  test('a run starts once: a second start while it is active writes nothing', () => {
    const repo = successionRepo(db())
    expect(repo.start(START, 2_000)).toBe(true)
    expect(repo.get()).toMatchObject({
      state: 'check-in',
      runId: 'run-1',
      heir: 'ana',
      startedAt: 1_000,
      updatedAt: 2_000,
    })
    expect(repo.start({ ...START, runId: 'run-2' }, 3_000)).toBe(false)
    expect(repo.get()).toMatchObject({ runId: 'run-1', updatedAt: 2_000 })
  })

  test('a move applies only from the state the caller read', () => {
    const repo = successionRepo(db())
    repo.start(START, 2_000)
    // a claim cannot skip the grace: check-in does not move to claimable
    expect(repo.move('grace', 'claimable', 3_000, { claimableAt: 3_000 })).toBe(false)
    expect(repo.get()).toMatchObject({ state: 'check-in', claimableAt: null, updatedAt: 2_000 })
    expect(repo.move('check-in', 'grace', 3_000, { graceStartedAt: 3_000 })).toBe(true)
    expect(repo.get()).toMatchObject({ state: 'grace', graceStartedAt: 3_000, updatedAt: 3_000 })
  })

  test('the states move in order and a finished run lets the next one start', () => {
    const repo = successionRepo(db())
    repo.start(START, 1)
    expect(repo.move('check-in', 'grace', 2, { graceStartedAt: 2 })).toBe(true)
    expect(repo.move('grace', 'claimable', 3, { claimableAt: 3 })).toBe(true)
    expect(repo.move('claimable', 'claimed', 4)).toBe(true)
    expect(repo.get()).toMatchObject({ state: 'claimed', graceStartedAt: 2, claimableAt: 3 })
    // the last outcome stays readable, and a new run may start from it
    expect(repo.start({ ...START, runId: 'run-2' }, 5)).toBe(true)
    expect(repo.get()).toMatchObject({
      state: 'check-in',
      runId: 'run-2',
      graceStartedAt: null,
      claimableAt: null,
    })
  })

  test('a cancel returns the row to idle, and a move from idle is refused', () => {
    const repo = successionRepo(db())
    repo.start(START, 1)
    expect(repo.move('check-in', 'idle', 2)).toBe(true)
    expect(repo.get().state).toBe('idle')
    expect(repo.move('check-in', 'grace', 3, { graceStartedAt: 3 })).toBe(false)
  })

  test('a transaction that throws rolls back its state change', () => {
    const repo = successionRepo(db())
    repo.start(START, 1)
    expect(() =>
      repo.transaction(() => {
        repo.move('check-in', 'grace', 2, { graceStartedAt: 2 })
        throw new Error('the transfer failed')
      }),
    ).toThrow('the transfer failed')
    expect(repo.get()).toMatchObject({ state: 'check-in', graceStartedAt: null, updatedAt: 1 })
  })

  test('the table holds one row in a known state (CHECK)', () => {
    const sqlite = db()
    expect(() =>
      sqlite.exec("INSERT INTO succession_state (id, state, updated_at) VALUES (2, 'idle', 1)"),
    ).toThrow(/CHECK constraint failed/)
    expect(() =>
      sqlite.exec("INSERT INTO succession_state (id, state, updated_at) VALUES (1, 'running', 1)"),
    ).toThrow(/CHECK constraint failed/)
  })
})
